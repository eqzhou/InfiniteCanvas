package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/codexbridge"
)

const maxCodexBody = 256 << 10
const maxCodexAttachmentBytes = 30 << 20
const codexHistoryLimit = 128
const codexSubscriberBuffer = codexHistoryLimit + 64
const codexStartupTimeout = 15 * time.Second
const codexTurnStartTimeout = 30 * time.Second

var errCodexHistoryGap = errors.New("Codex event history is no longer available")

type codexManager struct {
	mu                  sync.RWMutex
	sessions            map[string]*codexSession
	profiles            map[string]string
	creating            map[string]*codexCreation
	activeTurnSessionID string
}

type codexCreation struct {
	done     chan struct{}
	snapshot codexSessionSnapshot
	status   int
	err      string
}

type codexSession struct {
	id                 string
	profile            string
	threadID           string
	turnID             string
	turnStarting       bool
	completedTurnID    string
	client             *codexbridge.Client
	cmd                *exec.Cmd
	cancel             context.CancelFunc
	mu                 sync.Mutex
	subs               map[chan codexEvent]struct{}
	history            []codexEvent
	closed             bool
	pendingAttachments map[string]codexAttachment
	activeAttachments  []codexAttachment
	runtimeClientID    string
	releaseRuntime     func()
	eventSequence      uint64
}

type codexSessionSnapshot struct {
	ID              string `json:"id"`
	ThreadID        string `json:"threadId,omitempty"`
	Profile         string `json:"profile"`
	Reused          bool   `json:"reused"`
	Running         bool   `json:"running"`
	RuntimeClientID string `json:"runtimeClientId,omitempty"`
}

type codexAttachment struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Bytes    int64  `json:"bytes"`
	Path     string `json:"-"`
}

type codexEvent struct {
	Sequence uint64          `json:"sequence"`
	Type     string          `json:"type"`
	Method   string          `json:"method,omitempty"`
	ID       json.RawMessage `json:"id,omitempty"`
	Params   json.RawMessage `json:"params,omitempty"`
	Data     any             `json:"data,omitempty"`
}

func newCodexManager() *codexManager {
	return &codexManager{
		sessions: make(map[string]*codexSession),
		profiles: make(map[string]string),
		creating: make(map[string]*codexCreation),
	}
}

func (m *codexManager) claimTurn(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.activeTurnSessionID != "" && m.activeTurnSessionID != sessionID {
		return false
	}
	m.activeTurnSessionID = sessionID
	return true
}

func (m *codexManager) releaseTurn(sessionID string) {
	m.mu.Lock()
	if m.activeTurnSessionID == sessionID {
		m.activeTurnSessionID = ""
	}
	m.mu.Unlock()
}

func randomID(prefix string) string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + hex.EncodeToString(b[:])
}

func (s *Server) createCodexSession(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxCodexBody)
	var req struct {
		CWD     string `json:"cwd"`
		Profile string `json:"profile"`
		Fresh   bool   `json:"fresh"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "invalid codex session request", http.StatusBadRequest)
		return
	}
	cwd := strings.TrimSpace(req.CWD)
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	profile := strings.TrimSpace(req.Profile)
	if profile == "" {
		profile = "default"
	}
	if !projectIDPattern.MatchString(profile) {
		http.Error(w, "invalid codex profile", http.StatusBadRequest)
		return
	}
	s.codex.mu.Lock()
	if creating := s.codex.creating[profile]; creating != nil {
		s.codex.mu.Unlock()
		select {
		case <-creating.done:
			if creating.err != "" {
				http.Error(w, creating.err, creating.status)
				return
			}
			snapshot := creating.snapshot
			snapshot.Reused = true
			writeJSON(w, snapshot)
		case <-r.Context().Done():
			http.Error(w, "codex session request cancelled", http.StatusRequestTimeout)
		}
		return
	}
	existingID := s.codex.profiles[profile]
	existing := s.codex.sessions[existingID]
	if existing != nil && !existing.isClosed() {
		if req.Fresh && existing.snapshot(false).Running {
			s.codex.mu.Unlock()
			http.Error(w, "codex turn is already running", http.StatusConflict)
			return
		}
		if !req.Fresh {
			snapshot := existing.snapshot(true)
			writeJSON(w, snapshot)
			s.codex.mu.Unlock()
			return
		}
	}
	s.codex.mu.Unlock()
	creation := &codexCreation{done: make(chan struct{})}
	s.codex.mu.Lock()
	// A creator could have appeared while the prior session state was inspected.
	if current := s.codex.creating[profile]; current != nil {
		s.codex.mu.Unlock()
		select {
		case <-current.done:
			if current.err != "" {
				http.Error(w, current.err, current.status)
				return
			}
			snapshot := current.snapshot
			snapshot.Reused = true
			writeJSON(w, snapshot)
		case <-r.Context().Done():
			http.Error(w, "codex session request cancelled", http.StatusRequestTimeout)
		}
		return
	}
	latestID := s.codex.profiles[profile]
	latest := s.codex.sessions[latestID]
	if latestID != existingID && latest != nil && !latest.isClosed() {
		snapshot := latest.snapshot(true)
		writeJSON(w, snapshot)
		s.codex.mu.Unlock()
		return
	}
	s.codex.creating[profile] = creation
	s.codex.mu.Unlock()
	// The HTTP request context ends as soon as this response is sent. A Codex
	// session must outlive the request and is cancelled explicitly on close.
	session, err := startCodexSession(context.Background(), cwd)
	if err != nil {
		message := "codex app-server unavailable: " + err.Error()
		http.Error(w, message, http.StatusServiceUnavailable)
		s.codex.mu.Lock()
		creation.status = http.StatusServiceUnavailable
		creation.err = message
		delete(s.codex.creating, profile)
		close(creation.done)
		s.codex.mu.Unlock()
		return
	}
	session.profile = profile
	s.codex.mu.Lock()
	previousID := s.codex.profiles[profile]
	previous := s.codex.sessions[previousID]
	s.codex.sessions[session.id] = session
	s.codex.profiles[profile] = session.id
	if previous != nil {
		delete(s.codex.sessions, previous.id)
	}
	s.codex.mu.Unlock()
	if previous != nil {
		previous.close()
	}
	snapshot := session.snapshot(false)
	writeJSON(w, snapshot)
	s.codex.mu.Lock()
	creation.snapshot = snapshot
	delete(s.codex.creating, profile)
	close(creation.done)
	s.codex.mu.Unlock()
}

func (s *Server) getCodexSession(w http.ResponseWriter, r *http.Request) {
	profile := strings.TrimSpace(r.URL.Query().Get("profile"))
	if profile == "" {
		profile = "default"
	}
	if !projectIDPattern.MatchString(profile) {
		http.Error(w, "invalid codex profile", http.StatusBadRequest)
		return
	}
	s.codex.mu.RLock()
	session := s.codex.sessions[s.codex.profiles[profile]]
	s.codex.mu.RUnlock()
	if session == nil || session.isClosed() {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	writeJSON(w, session.snapshot(true))
}

func (s *codexSession) snapshot(reused bool) codexSessionSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotLocked(reused)
}

func (s *codexSession) snapshotLocked(reused bool) codexSessionSnapshot {
	return codexSessionSnapshot{
		ID: s.id, ThreadID: s.threadID, Profile: s.profile, Reused: reused,
		Running: s.turnStarting || s.turnID != "", RuntimeClientID: s.runtimeClientID,
	}
}

func (s *codexSession) stateEventLocked() codexEvent {
	return codexEvent{Type: "notification", Method: "openboard/session_state", Data: s.snapshotLocked(true)}
}

func startCodexSession(parent context.Context, cwd string) (*codexSession, error) {
	bin := strings.TrimSpace(os.Getenv("OPENBOARD_CODEX_BIN"))
	if bin == "" {
		bin = "codex"
	}
	if err := parent.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	startupContext, finishStartup := context.WithTimeout(parent, codexStartupTimeout)
	defer finishStartup()
	cmd := exec.CommandContext(ctx, bin, "app-server", "--stdio")
	cmd.Dir = cwd
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	go io.Copy(io.Discard, stderr)
	client := codexbridge.NewClient(stdout, stdin)
	session := &codexSession{
		id: randomID("codex"), client: client, cmd: cmd, cancel: cancel,
		subs: make(map[chan codexEvent]struct{}), pendingAttachments: make(map[string]codexAttachment),
	}
	var initResult map[string]any
	if err := client.Call(startupContext, "initialize", map[string]any{"clientInfo": map[string]any{"name": "openboard", "version": "0.1.0"}}, &initResult); err != nil {
		_ = client.Close()
		cancel()
		return nil, err
	}
	// The app-server protocol uses a notification to complete initialization.
	_ = client.Notify(startupContext, "initialized", map[string]any{})
	var thread map[string]any
	if err := client.Call(startupContext, "thread/start", map[string]any{"cwd": cwd}, &thread); err != nil {
		_ = client.Close()
		cancel()
		return nil, err
	}
	if v, ok := thread["thread"]; ok {
		if obj, ok := v.(map[string]any); ok {
			session.threadID, _ = obj["id"].(string)
		}
	}
	if session.threadID == "" {
		session.threadID, _ = thread["id"].(string)
	}
	go session.consume()
	go func() { _ = cmd.Wait(); session.close() }()
	return session, nil
}

func (s *codexSession) consume() {
	for {
		select {
		case n, ok := <-s.client.Notifications():
			if !ok {
				return
			}
			stateChanged := s.trackTurnNotification(n.Method, n.Params)
			s.publish(codexEvent{Type: "notification", Method: n.Method, Params: n.Params})
			if stateChanged {
				s.publishState()
			}
		case req, ok := <-s.client.Requests():
			if !ok {
				return
			}
			s.publish(codexEvent{Type: "approval", Method: req.Method, ID: req.ID, Params: req.Params})
		}
	}
}

func (s *codexSession) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func (s *codexSession) trackTurnNotification(method string, params json.RawMessage) bool {
	var payload struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	_ = json.Unmarshal(params, &payload)
	if payload.Turn.ID != "" && !projectIDPattern.MatchString(payload.Turn.ID) {
		return false
	}
	s.mu.Lock()
	if payload.Turn.ID != "" && (method == "turn/started" || method == "turn_started") {
		s.turnID = payload.Turn.ID
		s.mu.Unlock()
		return true
	}
	completed := method == "turn/completed" || method == "turn_completed" || method == "turn/failed" || method == "turn_failed"
	if completed {
		if payload.Turn.ID != "" && s.turnID != "" && s.turnID != payload.Turn.ID {
			s.mu.Unlock()
			return false
		}
		if s.turnID == "" && payload.Turn.ID != "" {
			if !s.turnStarting {
				s.mu.Unlock()
				return false
			}
			s.completedTurnID = payload.Turn.ID
		}
		s.turnID = ""
		s.turnStarting = false
		attachments := s.activeAttachments
		s.activeAttachments = nil
		release := s.releaseRuntime
		s.releaseRuntime = nil
		s.runtimeClientID = ""
		s.mu.Unlock()
		removeCodexAttachments(attachments)
		if release != nil {
			release()
		}
		return true
	}
	s.mu.Unlock()
	return false
}

func (s *codexSession) publish(event codexEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.history = append(s.history, event)
	s.eventSequence++
	event.Sequence = s.eventSequence
	s.history[len(s.history)-1] = event
	if len(s.history) > codexHistoryLimit {
		s.history = append([]codexEvent(nil), s.history[len(s.history)-codexHistoryLimit:]...)
	}
	for ch := range s.subs {
		select {
		case ch <- event:
		default:
			delete(s.subs, ch)
			close(ch)
		}
	}
}

func (s *codexSession) publishState() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	event := s.stateEventLocked()
	s.mu.Unlock()
	s.publish(event)
}

func (s *codexSession) subscribe() (chan codexEvent, func()) {
	ch, unsubscribe, _ := s.subscribeAfter(0)
	return ch, unsubscribe
}

func (s *codexSession) subscribeAfter(afterSequence uint64) (chan codexEvent, func(), error) {
	// Match the bounded replay history so a subscriber can be initialized
	// without blocking while the session mutex is held.
	ch := make(chan codexEvent, codexSubscriberBuffer)
	s.mu.Lock()
	if s.closed {
		close(ch)
		s.mu.Unlock()
		return ch, func() {}, nil
	}
	if afterSequence > s.eventSequence || (afterSequence > 0 && len(s.history) > 0 && s.history[0].Sequence > afterSequence+1) {
		close(ch)
		s.mu.Unlock()
		return ch, func() {}, errCodexHistoryGap
	}
	for _, event := range s.history {
		if event.Sequence > afterSequence {
			ch <- event
		}
	}
	state := s.stateEventLocked()
	state.Sequence = s.eventSequence
	ch <- state
	s.subs[ch] = struct{}{}
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		if _, ok := s.subs[ch]; ok {
			delete(s.subs, ch)
			close(ch)
		}
		s.mu.Unlock()
	}, nil
}

func (s *codexSession) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	attachments := make([]codexAttachment, 0, len(s.pendingAttachments)+len(s.activeAttachments))
	release := s.releaseRuntime
	s.releaseRuntime = nil
	s.runtimeClientID = ""
	for _, attachment := range s.pendingAttachments {
		attachments = append(attachments, attachment)
	}
	attachments = append(attachments, s.activeAttachments...)
	s.pendingAttachments = make(map[string]codexAttachment)
	s.activeAttachments = nil
	for ch := range s.subs {
		close(ch)
	}
	s.subs = make(map[chan codexEvent]struct{})
	s.mu.Unlock()
	if release != nil {
		release()
	}
	removeCodexAttachments(attachments)
	_ = s.client.Close()
	if s.cancel != nil {
		s.cancel()
	}
}

func (s *Server) findCodex(id string) (*codexSession, bool) {
	s.codex.mu.RLock()
	v, ok := s.codex.sessions[id]
	s.codex.mu.RUnlock()
	return v, ok && !v.isClosed()
}

func (s *Server) sendCodexMessage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxCodexBody)
	var req struct {
		SessionID     string   `json:"sessionId"`
		Text          string   `json:"text"`
		AttachmentIDs []string `json:"attachmentIds"`
		ClientID      string   `json:"clientId"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&req) != nil || strings.TrimSpace(req.SessionID) == "" || strings.TrimSpace(req.Text) == "" {
		http.Error(w, "sessionId and text are required", http.StatusBadRequest)
		return
	}
	session, ok := s.findCodex(req.SessionID)
	if !ok {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	session.mu.Lock()
	sessionClosed := session.closed
	turnRunning := session.turnID != "" || session.turnStarting
	if !turnRunning && !sessionClosed {
		session.turnStarting = true
	}
	session.mu.Unlock()
	if sessionClosed {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	if turnRunning {
		http.Error(w, "codex turn is already running", http.StatusConflict)
		return
	}
	if !s.codex.claimTurn(session.id) {
		session.cancelTurnStart()
		http.Error(w, "another codex turn is already running", http.StatusConflict)
		return
	}
	requestedClientID := strings.TrimSpace(req.ClientID)
	clientID, clientClaimed := s.runtime.claimClient(requestedClientID)
	if requestedClientID != "" && !clientClaimed {
		s.codex.releaseTurn(session.id)
		session.cancelTurnStart()
		http.Error(w, "requested browser runtime is not connected", http.StatusConflict)
		return
	}
	releaseTurn := func() {
		s.codex.releaseTurn(session.id)
		s.runtime.unpin(session.id)
	}
	session.mu.Lock()
	session.releaseRuntime = releaseTurn
	session.mu.Unlock()
	if clientID != "" {
		s.runtime.pin(session.id, clientID)
		session.mu.Lock()
		session.runtimeClientID = clientID
		session.mu.Unlock()
	}
	session.publishState()
	input := []any{map[string]any{"type": "text", "text": req.Text}}
	attachments, err := session.takeAttachments(req.AttachmentIDs)
	if err != nil {
		session.cancelTurnStart()
		session.publishState()
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	for _, attachment := range attachments {
		input = append(input, map[string]any{"type": "localImage", "path": attachment.Path})
	}
	session.reserveTurnAttachments(attachments)
	params := map[string]any{"threadId": session.threadID, "input": input}
	session.publish(codexEvent{
		Type: "notification", Method: "openboard/user_message",
		Data: map[string]any{"id": randomID("message"), "text": strings.TrimSpace(req.Text)},
	})
	var turn map[string]any
	turnContext, cancelTurnStart := context.WithTimeout(context.Background(), codexTurnStartTimeout)
	err = session.client.Call(turnContext, "turn/start", params, &turn)
	cancelTurnStart()
	if err != nil {
		s.discardCodexSession(session)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if !session.activateTurn(turn) {
		s.discardCodexSession(session)
		http.Error(w, "Codex turn/start returned an invalid turn id", http.StatusBadGateway)
		return
	}
	session.publishState()
	writeJSON(w, map[string]any{"ok": true})
}

func (s *codexSession) takeAttachments(ids []string) ([]codexAttachment, error) {
	if len(ids) > 10 {
		return nil, errors.New("at most 10 Codex attachments are allowed")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	attachments := make([]codexAttachment, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if _, duplicate := seen[id]; duplicate {
			return nil, errors.New("duplicate Codex attachment id")
		}
		attachment, ok := s.pendingAttachments[id]
		if !ok {
			return nil, errors.New("Codex attachment was not found")
		}
		seen[id] = struct{}{}
		attachments = append(attachments, attachment)
	}
	for _, attachment := range attachments {
		delete(s.pendingAttachments, attachment.ID)
	}
	return attachments, nil
}

func (s *codexSession) reserveTurnAttachments(attachments []codexAttachment) {
	s.mu.Lock()
	s.activeAttachments = append(s.activeAttachments, attachments...)
	s.mu.Unlock()
}

func (s *codexSession) activateTurn(turn map[string]any) bool {
	turnID := ""
	if value, ok := turn["turn"].(map[string]any); ok {
		turnID, _ = value["id"].(string)
	}
	if turnID == "" {
		turnID, _ = turn["id"].(string)
	}
	if !projectIDPattern.MatchString(turnID) {
		turnID = ""
	}
	s.mu.Lock()
	if turnID == "" {
		if projectIDPattern.MatchString(s.turnID) {
			s.turnStarting = false
			s.mu.Unlock()
			return true
		}
		if projectIDPattern.MatchString(s.completedTurnID) {
			s.completedTurnID = ""
			s.turnStarting = false
			s.mu.Unlock()
			return true
		}
		s.mu.Unlock()
		return false
	}
	if turnID != "" && s.completedTurnID == turnID {
		s.completedTurnID = ""
		s.turnStarting = false
		s.turnID = ""
		s.mu.Unlock()
		return true
	}
	if s.completedTurnID != "" {
		s.mu.Unlock()
		return false
	}
	if s.turnID != "" && s.turnID != turnID {
		s.mu.Unlock()
		return false
	}
	s.turnStarting = false
	s.turnID = turnID
	s.mu.Unlock()
	return true
}

func (s *Server) discardCodexSession(session *codexSession) {
	s.codex.mu.Lock()
	if s.codex.sessions[session.id] == session {
		delete(s.codex.sessions, session.id)
	}
	if s.codex.profiles[session.profile] == session.id {
		delete(s.codex.profiles, session.profile)
	}
	s.codex.mu.Unlock()
	session.close()
}

func (s *codexSession) cancelTurnStart() {
	s.mu.Lock()
	s.turnStarting = false
	release := s.releaseRuntime
	s.releaseRuntime = nil
	s.runtimeClientID = ""
	s.mu.Unlock()
	if release != nil {
		release()
	}
}

func (s *Server) interruptCodex(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxCodexBody)
	var req struct {
		SessionID string `json:"sessionId"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&req) != nil || ensureJSONEOF(decoder) != nil || req.SessionID == "" {
		http.Error(w, "sessionId is required", http.StatusBadRequest)
		return
	}
	session, ok := s.findCodex(req.SessionID)
	if !ok {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	session.mu.Lock()
	turnID := session.turnID
	threadID := session.threadID
	session.mu.Unlock()
	if turnID == "" {
		http.Error(w, "codex turn is not running", http.StatusConflict)
		return
	}
	if err := session.client.Call(r.Context(), "turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID}, nil); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) respondCodexApproval(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxCodexBody)
	var req struct {
		SessionID string          `json:"sessionId"`
		ID        json.RawMessage `json:"id"`
		Approve   bool            `json:"approve"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&req) != nil || req.SessionID == "" || len(req.ID) == 0 {
		http.Error(w, "sessionId and id are required", http.StatusBadRequest)
		return
	}
	session, ok := s.findCodex(req.SessionID)
	if !ok {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	result := map[string]any{"decision": "decline"}
	if req.Approve {
		result["decision"] = "accept"
	}
	if err := session.client.Respond(r.Context(), req.ID, result, nil); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	session.publish(codexEvent{
		Type: "notification", Method: "openboard/approval_resolved",
		ID:   append(json.RawMessage(nil), req.ID...),
		Data: map[string]any{"approved": req.Approve},
	})
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) codexEvents(w http.ResponseWriter, r *http.Request) {
	session, ok := s.findCodex(r.URL.Query().Get("sessionId"))
	if !ok {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	afterSequence := uint64(0)
	if raw := strings.TrimSpace(r.URL.Query().Get("afterSequence")); raw != "" {
		parsed, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			http.Error(w, "invalid Codex event sequence", http.StatusBadRequest)
			return
		}
		afterSequence = parsed
	}
	ch, unsubscribe, err := session.subscribeAfter(afterSequence)
	if errors.Is(err, errCodexHistoryGap) {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher.Flush()
	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()
	for {
		select {
		case event, ok := <-ch:
			if !ok {
				return
			}
			data, _ := json.Marshal(event)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
			flusher.Flush()
		case <-keepAlive.C:
			// SSE comments keep idle connections alive without creating a
			// business event for clients to process.
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (s *Server) closeCodexSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.codex.mu.Lock()
	session, ok := s.codex.sessions[id]
	if ok {
		delete(s.codex.sessions, id)
		if s.codex.profiles[session.profile] == id {
			delete(s.codex.profiles, session.profile)
		}
	}
	s.codex.mu.Unlock()
	if !ok {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	session.close()
	w.WriteHeader(http.StatusNoContent)
}
