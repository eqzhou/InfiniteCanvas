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
	mu                   sync.RWMutex
	sessions             map[string]*codexSession
	profiles             map[agentProfileKey]string
	creating             map[agentProfileKey]*codexCreation
	activeTurnSessionIDs map[agentScope]string
	closed               bool
	root                 context.Context
	cancel               context.CancelFunc
	startupWG            sync.WaitGroup
}

type codexCreation struct {
	done     chan struct{}
	once     sync.Once
	mu       sync.Mutex
	snapshot codexSessionSnapshot
	status   int
	err      string
}

func (c *codexCreation) complete(snapshot codexSessionSnapshot, status int, message string) {
	c.once.Do(func() {
		c.mu.Lock()
		c.snapshot = snapshot
		c.status = status
		c.err = message
		c.mu.Unlock()
		close(c.done)
	})
}

func (c *codexCreation) result() (codexSessionSnapshot, int, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshot, c.status, c.err
}

type codexSession struct {
	id                 string
	scope              agentScope
	profile            string
	cwd                string
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
	historyStore       *codexHistoryStore
	historyID          string
}

type codexSessionSnapshot struct {
	ID              string `json:"id"`
	ThreadID        string `json:"threadId,omitempty"`
	Profile         string `json:"profile"`
	HistoryID       string `json:"historyId,omitempty"`
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
	root, cancel := context.WithCancel(context.Background())
	return &codexManager{
		sessions:             make(map[string]*codexSession),
		profiles:             make(map[agentProfileKey]string),
		creating:             make(map[agentProfileKey]*codexCreation),
		activeTurnSessionIDs: make(map[agentScope]string),
		root:                 root,
		cancel:               cancel,
	}
}

func (m *codexManager) claimTurn(scope agentScope, sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if active := m.activeTurnSessionIDs[scope]; active != "" && active != sessionID {
		return false
	}
	m.activeTurnSessionIDs[scope] = sessionID
	return true
}

func (m *codexManager) releaseTurn(scope agentScope, sessionID string) {
	m.mu.Lock()
	if m.activeTurnSessionIDs[scope] == sessionID {
		delete(m.activeTurnSessionIDs, scope)
	}
	m.mu.Unlock()
}

func (m *codexManager) closeAll() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		m.startupWG.Wait()
		return
	}
	m.closed = true
	m.cancel()
	sessions := make([]*codexSession, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.sessions = make(map[string]*codexSession)
	m.profiles = make(map[agentProfileKey]string)
	for _, creation := range m.creating {
		creation.complete(codexSessionSnapshot{}, http.StatusServiceUnavailable, "codex manager is closed")
	}
	m.creating = make(map[agentProfileKey]*codexCreation)
	m.activeTurnSessionIDs = make(map[agentScope]string)
	m.mu.Unlock()
	for _, session := range sessions {
		session.close()
	}
	m.startupWG.Wait()
}

func randomID(prefix string) string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + hex.EncodeToString(b[:])
}

func (s *Server) createCodexSession(w http.ResponseWriter, r *http.Request) {
	if !authorizeAccountAgentExecution(w, r) {
		return
	}
	scope := requestAgentScope(r)
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
	cwd, err := resolveAgentCWD(req.CWD)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	profile := strings.TrimSpace(req.Profile)
	if profile == "" {
		profile = "default"
	}
	if !projectIDPattern.MatchString(profile) {
		http.Error(w, "invalid codex profile", http.StatusBadRequest)
		return
	}
	profileKey := agentProfileKey{scope: scope, profile: profile}
	s.codex.mu.Lock()
	if s.codex.closed {
		s.codex.mu.Unlock()
		http.Error(w, "codex manager is closed", http.StatusServiceUnavailable)
		return
	}
	if creating := s.codex.creating[profileKey]; creating != nil {
		s.codex.mu.Unlock()
		select {
		case <-creating.done:
			snapshot, status, message := creating.result()
			if message != "" {
				http.Error(w, message, status)
				return
			}
			snapshot.Reused = true
			writeJSON(w, snapshot)
		case <-r.Context().Done():
			http.Error(w, "codex session request cancelled", http.StatusRequestTimeout)
		}
		return
	}
	existingID := s.codex.profiles[profileKey]
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
	if s.codex.closed {
		s.codex.mu.Unlock()
		http.Error(w, "codex manager is closed", http.StatusServiceUnavailable)
		return
	}
	if current := s.codex.creating[profileKey]; current != nil {
		s.codex.mu.Unlock()
		select {
		case <-current.done:
			snapshot, status, message := current.result()
			if message != "" {
				http.Error(w, message, status)
				return
			}
			snapshot.Reused = true
			writeJSON(w, snapshot)
		case <-r.Context().Done():
			http.Error(w, "codex session request cancelled", http.StatusRequestTimeout)
		}
		return
	}
	latestID := s.codex.profiles[profileKey]
	latest := s.codex.sessions[latestID]
	if latestID != existingID && latest != nil && !latest.isClosed() {
		snapshot := latest.snapshot(true)
		writeJSON(w, snapshot)
		s.codex.mu.Unlock()
		return
	}
	s.codex.creating[profileKey] = creation
	s.codex.startupWG.Add(1)
	managerRoot := s.codex.root
	s.codex.mu.Unlock()
	defer s.codex.startupWG.Done()
	// The HTTP request context ends as soon as this response is sent. A Codex
	// session must outlive the request and is cancelled explicitly on close.
	session, err := startCodexSessionForScopeWithThreadAndDebug(managerRoot, scope, cwd, "", s.debugWriter)
	if err != nil {
		message := "codex app-server unavailable: " + err.Error()
		http.Error(w, message, http.StatusServiceUnavailable)
		s.codex.mu.Lock()
		delete(s.codex.creating, profileKey)
		creation.complete(codexSessionSnapshot{}, http.StatusServiceUnavailable, message)
		s.codex.mu.Unlock()
		return
	}
	session.profile = profile
	session.scope = scope
	session.cwd = cwd
	session.historyStore = s.codexHistory
	session.historyID = randomID("history")
	createdAt := time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.codexHistory.put(scope, codexHistoryRecord{
		ID: session.historyID, Profile: profile, ThreadID: session.threadID,
		Title: "新对话", CreatedAt: createdAt, UpdatedAt: createdAt,
		Status: "idle", CWD: cwd,
	}); err != nil {
		session.close()
		s.codex.mu.Lock()
		delete(s.codex.creating, profileKey)
		creation.complete(codexSessionSnapshot{}, http.StatusInternalServerError, "failed to persist Codex history")
		s.codex.mu.Unlock()
		http.Error(w, "failed to persist Codex history", http.StatusInternalServerError)
		return
	}
	s.codex.mu.Lock()
	if s.codex.closed {
		delete(s.codex.creating, profileKey)
		creation.complete(codexSessionSnapshot{}, http.StatusServiceUnavailable, "codex manager is closed")
		s.codex.mu.Unlock()
		session.close()
		http.Error(w, "codex manager is closed", http.StatusServiceUnavailable)
		return
	}
	previousID := s.codex.profiles[profileKey]
	previous := s.codex.sessions[previousID]
	s.codex.sessions[session.id] = session
	s.codex.profiles[profileKey] = session.id
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
	delete(s.codex.creating, profileKey)
	creation.complete(snapshot, 0, "")
	s.codex.mu.Unlock()
}

func (s *Server) getCodexSession(w http.ResponseWriter, r *http.Request) {
	scope := requestAgentScope(r)
	profile := strings.TrimSpace(r.URL.Query().Get("profile"))
	if profile == "" {
		profile = "default"
	}
	if !projectIDPattern.MatchString(profile) {
		http.Error(w, "invalid codex profile", http.StatusBadRequest)
		return
	}
	s.codex.mu.RLock()
	session := s.codex.sessions[s.codex.profiles[agentProfileKey{scope: scope, profile: profile}]]
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
		ID: s.id, ThreadID: s.threadID, Profile: s.profile, HistoryID: s.historyID, Reused: reused,
		Running: s.turnStarting || s.turnID != "", RuntimeClientID: s.runtimeClientID,
	}
}

func (s *codexSession) stateEventLocked() codexEvent {
	return codexEvent{Type: "notification", Method: "openboard/session_state", Data: s.snapshotLocked(true)}
}

func startCodexSession(parent context.Context, cwd string) (*codexSession, error) {
	return startCodexSessionForScope(parent, agentScope{}, cwd)
}

func startCodexSessionForScope(parent context.Context, scope agentScope, cwd string) (*codexSession, error) {
	return startCodexSessionForScopeWithThread(parent, scope, cwd, "")
}

func startCodexSessionForScopeWithThread(parent context.Context, scope agentScope, cwd, resumeThreadID string) (*codexSession, error) {
	return startCodexSessionForScopeWithThreadAndDebug(parent, scope, cwd, resumeThreadID, nil)
}

func startCodexSessionForScopeWithThreadAndDebug(parent context.Context, scope agentScope, cwd, resumeThreadID string, debugWriter io.Writer) (*codexSession, error) {
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
	cmd.Env = agentProcessEnvironment(scope, os.Environ())
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
	stderrWriter := io.Writer(io.Discard)
	if debugWriter != nil {
		stderrWriter = debugWriter
	}
	go func() { _, _ = io.Copy(stderrWriter, stderr) }()
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
	threadMethod := "thread/start"
	threadParams := map[string]any{"cwd": cwd}
	if resumeThreadID != "" {
		threadMethod = "thread/resume"
		threadParams = map[string]any{"threadId": resumeThreadID}
	}
	if err := client.Call(startupContext, threadMethod, threadParams, &thread); err != nil {
		if resumeThreadID == "" {
			_ = client.Close()
			cancel()
			return nil, err
		}
		// Older app-server versions may not expose thread/resume. Falling back
		// keeps the archived transcript usable while starting a fresh live thread.
		thread = nil
		if fallbackErr := client.Call(startupContext, "thread/start", map[string]any{"cwd": cwd}, &thread); fallbackErr != nil {
			_ = client.Close()
			cancel()
			return nil, fallbackErr
		}
	}
	if v, ok := thread["thread"]; ok {
		if obj, ok := v.(map[string]any); ok {
			session.threadID, _ = obj["id"].(string)
		}
	}
	if session.threadID == "" {
		session.threadID, _ = thread["id"].(string)
	}
	if session.threadID == "" {
		session.threadID = resumeThreadID
	}
	session.cwd = cwd
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
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.history = append(s.history, event)
	s.eventSequence++
	event.Sequence = s.eventSequence
	s.history[len(s.history)-1] = event
	if len(s.history) > codexHistoryLimit {
		s.history = append([]codexEvent(nil), s.history[len(s.history)-codexHistoryLimit:]...)
	}
	historyStore := s.historyStore
	historyID := s.historyID
	historyProfile := s.profile
	historyScope := s.scope
	for ch := range s.subs {
		select {
		case ch <- event:
		default:
			delete(s.subs, ch)
			close(ch)
		}
	}
	if historyStore != nil && historyID != "" && event.Method != "openboard/session_state" {
		_ = historyStore.appendEvent(historyScope, historyProfile, historyID, event)
	}
	s.mu.Unlock()
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
	historyStore := s.historyStore
	historyScope := s.scope
	historyProfile := s.profile
	historyID := s.historyID
	historyStatus := "completed"
	if s.turnStarting || s.turnID != "" {
		historyStatus = "failed"
	}
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
	if s.client != nil {
		_ = s.client.Close()
	}
	if s.cancel != nil {
		s.cancel()
	}
	if historyStore != nil && historyID != "" {
		_ = historyStore.finish(historyScope, historyProfile, historyID, historyStatus)
	}
}

func (s *Server) findCodex(id string) (*codexSession, bool) {
	return s.findCodexForScope(agentScope{}, id)
}

func (s *Server) findCodexForScope(scope agentScope, id string) (*codexSession, bool) {
	s.codex.mu.RLock()
	v, ok := s.codex.sessions[id]
	s.codex.mu.RUnlock()
	return v, ok && v.scope == scope && !v.isClosed()
}

func (s *Server) sendCodexMessage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxCodexBody)
	var req struct {
		SessionID       string   `json:"sessionId"`
		Text            string   `json:"text"`
		AttachmentIDs   []string `json:"attachmentIds"`
		ClientID        string   `json:"clientId"`
		ClientMessageID string   `json:"clientMessageId"`
		PermissionMode  string   `json:"permissionMode"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&req) != nil || strings.TrimSpace(req.SessionID) == "" || strings.TrimSpace(req.Text) == "" {
		http.Error(w, "sessionId and text are required", http.StatusBadRequest)
		return
	}
	permissionParams, err := codexTurnPermissionParams(req.PermissionMode)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	clientMessageID := strings.TrimSpace(req.ClientMessageID)
	if clientMessageID != "" && !projectIDPattern.MatchString(clientMessageID) {
		http.Error(w, "invalid Codex client message id", http.StatusBadRequest)
		return
	}
	scope := requestAgentScope(r)
	session, ok := s.findCodexForScope(scope, req.SessionID)
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
	if !s.codex.claimTurn(scope, session.id) {
		session.cancelTurnStart()
		http.Error(w, "another codex turn is already running", http.StatusConflict)
		return
	}
	requestedClientID := strings.TrimSpace(req.ClientID)
	clientID, clientClaimed := s.runtime.claimClient(scope, requestedClientID)
	if requestedClientID != "" && !clientClaimed {
		s.codex.releaseTurn(scope, session.id)
		session.cancelTurnStart()
		http.Error(w, "requested browser runtime is not connected", http.StatusConflict)
		return
	}
	releaseTurn := func() {
		s.codex.releaseTurn(scope, session.id)
		s.runtime.unpin(scope, session.id)
	}
	session.mu.Lock()
	session.releaseRuntime = releaseTurn
	session.mu.Unlock()
	if clientID != "" {
		s.runtime.pin(scope, session.id, clientID)
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
	params := map[string]any{
		"threadId":       session.threadID,
		"input":          input,
		"approvalPolicy": permissionParams["approvalPolicy"],
		"sandboxPolicy":  permissionParams["sandboxPolicy"],
	}
	messageID := clientMessageID
	if messageID == "" {
		messageID = randomID("message")
	}
	session.publish(codexEvent{
		Type: "notification", Method: "openboard/user_message",
		Data: map[string]any{
			"id":   messageID,
			"text": strings.TrimSpace(req.Text),
		},
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

func codexTurnPermissionParams(mode string) (map[string]any, error) {
	switch strings.TrimSpace(mode) {
	case "read-only":
		return map[string]any{
			"approvalPolicy": "on-request",
			"sandboxPolicy": map[string]any{
				"type":          "readOnly",
				"networkAccess": false,
			},
		}, nil
	case "", "workspace-auto":
		return map[string]any{
			"approvalPolicy": "never",
			"sandboxPolicy": map[string]any{
				"type":                "workspaceWrite",
				"writableRoots":       []string{},
				"networkAccess":       false,
				"excludeTmpdirEnvVar": false,
				"excludeSlashTmp":     false,
			},
		}, nil
	case "full-access":
		return map[string]any{
			"approvalPolicy": "never",
			"sandboxPolicy": map[string]any{
				"type": "dangerFullAccess",
			},
		}, nil
	default:
		return nil, errors.New("invalid Codex permission mode")
	}
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
	profileKey := agentProfileKey{scope: session.scope, profile: session.profile}
	if s.codex.profiles[profileKey] == session.id {
		delete(s.codex.profiles, profileKey)
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
	session, ok := s.findCodexForScope(requestAgentScope(r), req.SessionID)
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
	session, ok := s.findCodexForScope(requestAgentScope(r), req.SessionID)
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
	session, ok := s.findCodexForScope(requestAgentScope(r), r.URL.Query().Get("sessionId"))
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
	scope := requestAgentScope(r)
	s.codex.mu.Lock()
	session, ok := s.codex.sessions[id]
	if ok && session.scope == scope {
		delete(s.codex.sessions, id)
		key := agentProfileKey{scope: scope, profile: session.profile}
		if s.codex.profiles[key] == id {
			delete(s.codex.profiles, key)
		}
	} else {
		ok = false
	}
	s.codex.mu.Unlock()
	if !ok {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	session.close()
	w.WriteHeader(http.StatusNoContent)
}
