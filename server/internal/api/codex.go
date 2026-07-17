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
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/codexbridge"
)

const maxCodexBody = 256 << 10
const maxCodexAttachmentBytes = 30 << 20

type codexManager struct {
	mu       sync.RWMutex
	sessions map[string]*codexSession
	profiles map[string]string
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
}

type codexAttachment struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Bytes    int64  `json:"bytes"`
	Path     string `json:"-"`
}

type codexEvent struct {
	Type   string          `json:"type"`
	Method string          `json:"method,omitempty"`
	ID     json.RawMessage `json:"id,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Data   any             `json:"data,omitempty"`
}

func newCodexManager() *codexManager {
	return &codexManager{sessions: make(map[string]*codexSession), profiles: make(map[string]string)}
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
	if !req.Fresh {
		s.codex.mu.RLock()
		existingID := s.codex.profiles[profile]
		existing := s.codex.sessions[existingID]
		s.codex.mu.RUnlock()
		if existing != nil && !existing.isClosed() {
			writeJSON(w, map[string]any{"id": existing.id, "threadId": existing.threadID, "profile": profile, "reused": true})
			return
		}
	}
	// The HTTP request context ends as soon as this response is sent. A Codex
	// session must outlive the request and is cancelled explicitly on close.
	session, err := startCodexSession(context.Background(), cwd)
	if err != nil {
		http.Error(w, "codex app-server unavailable: "+err.Error(), http.StatusServiceUnavailable)
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
	writeJSON(w, map[string]any{"id": session.id, "threadId": session.threadID, "profile": profile, "reused": false})
}

func startCodexSession(parent context.Context, cwd string) (*codexSession, error) {
	bin := strings.TrimSpace(os.Getenv("OPENBOARD_CODEX_BIN"))
	if bin == "" {
		bin = "codex"
	}
	ctx, cancel := context.WithCancel(parent)
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
	if err := client.Call(ctx, "initialize", map[string]any{"clientInfo": map[string]any{"name": "openboard", "version": "0.1.0"}}, &initResult); err != nil {
		_ = client.Close()
		cancel()
		return nil, err
	}
	// The app-server protocol uses a notification to complete initialization.
	_ = client.Notify(ctx, "initialized", map[string]any{})
	var thread map[string]any
	if err := client.Call(ctx, "thread/start", map[string]any{"cwd": cwd}, &thread); err != nil {
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
			s.trackTurnNotification(n.Method, n.Params)
			s.publish(codexEvent{Type: "notification", Method: n.Method, Params: n.Params})
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

func (s *codexSession) trackTurnNotification(method string, params json.RawMessage) {
	var payload struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	_ = json.Unmarshal(params, &payload)
	s.mu.Lock()
	if payload.Turn.ID != "" && (method == "turn/started" || method == "turn_started") {
		s.turnID = payload.Turn.ID
	}
	completed := method == "turn/completed" || method == "turn_completed" || method == "turn/failed" || method == "turn_failed"
	if completed {
		if payload.Turn.ID != "" && s.turnID != "" && s.turnID != payload.Turn.ID {
			s.mu.Unlock()
			return
		}
		if s.turnID == "" && payload.Turn.ID != "" {
			if !s.turnStarting {
				s.mu.Unlock()
				return
			}
			s.completedTurnID = payload.Turn.ID
		}
		s.turnID = ""
		s.turnStarting = false
		attachments := s.activeAttachments
		s.activeAttachments = nil
		s.mu.Unlock()
		removeCodexAttachments(attachments)
		return
	}
	s.mu.Unlock()
}

func (s *codexSession) publish(event codexEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.history = append(s.history, event)
	if len(s.history) > 128 {
		s.history = append([]codexEvent(nil), s.history[len(s.history)-128:]...)
	}
	for ch := range s.subs {
		select {
		case ch <- event:
		default:
		}
	}
}

func (s *codexSession) subscribe() (chan codexEvent, func()) {
	// Match the bounded replay history so a subscriber can be initialized
	// without blocking while the session mutex is held.
	ch := make(chan codexEvent, 128)
	s.mu.Lock()
	if s.closed {
		close(ch)
		s.mu.Unlock()
		return ch, func() {}
	}
	for _, event := range s.history {
		ch <- event
	}
	s.subs[ch] = struct{}{}
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		if _, ok := s.subs[ch]; ok {
			delete(s.subs, ch)
			close(ch)
		}
		s.mu.Unlock()
	}
}

func (s *codexSession) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	attachments := make([]codexAttachment, 0, len(s.pendingAttachments)+len(s.activeAttachments))
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
	removeCodexAttachments(attachments)
	_ = s.client.Close()
	if s.cancel != nil {
		s.cancel()
	}
}

func (s *Server) findCodex(id string) (*codexSession, bool) {
	s.codex.mu.RLock()
	defer s.codex.mu.RUnlock()
	v, ok := s.codex.sessions[id]
	return v, ok
}

func (s *Server) sendCodexMessage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxCodexBody)
	var req struct {
		SessionID     string   `json:"sessionId"`
		Text          string   `json:"text"`
		AttachmentIDs []string `json:"attachmentIds"`
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
	turnRunning := session.turnID != "" || session.turnStarting
	if !turnRunning {
		session.turnStarting = true
	}
	session.mu.Unlock()
	if turnRunning {
		http.Error(w, "codex turn is already running", http.StatusConflict)
		return
	}
	input := []any{map[string]any{"type": "text", "text": req.Text}}
	attachments, err := session.takeAttachments(req.AttachmentIDs)
	if err != nil {
		session.cancelTurnStart()
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	for _, attachment := range attachments {
		input = append(input, map[string]any{"type": "localImage", "path": attachment.Path})
	}
	params := map[string]any{"threadId": session.threadID, "input": input}
	var turn map[string]any
	if err := session.client.Call(r.Context(), "turn/start", params, &turn); err != nil {
		session.cancelTurnStart()
		removeCodexAttachments(attachments)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	session.activateTurn(turn, attachments)
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

func (s *codexSession) activateTurn(turn map[string]any, attachments []codexAttachment) {
	turnID := ""
	if value, ok := turn["turn"].(map[string]any); ok {
		turnID, _ = value["id"].(string)
	}
	if turnID == "" {
		turnID, _ = turn["id"].(string)
	}
	s.mu.Lock()
	if turnID != "" && s.completedTurnID == turnID {
		s.completedTurnID = ""
		s.turnStarting = false
		s.turnID = ""
		s.mu.Unlock()
		removeCodexAttachments(attachments)
		return
	}
	s.turnStarting = false
	s.turnID = turnID
	s.activeAttachments = append(s.activeAttachments, attachments...)
	s.mu.Unlock()
}

func (s *codexSession) cancelTurnStart() {
	s.mu.Lock()
	s.turnStarting = false
	s.mu.Unlock()
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
	ch, unsubscribe := session.subscribe()
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
