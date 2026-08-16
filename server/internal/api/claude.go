package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

const (
	maxClaudeBody           = 256 << 10
	claudeHistoryLimit      = 128
	claudeSubscriberBuffer  = claudeHistoryLimit + 64
	claudeDefaultBinaryHint = "claude"
)

type claudeManager struct {
	mu       sync.RWMutex
	sessions map[string]*claudeSession
	profiles map[agentProfileKey]string
	closed   bool
}

type claudeSub struct {
	ch   chan claudeEvent
	once sync.Once
}

func (sub *claudeSub) close() {
	sub.once.Do(func() { close(sub.ch) })
}

type claudeSession struct {
	id              string
	scope           agentScope
	profile         string
	claudeSessionID string
	cwd             string
	running         bool
	cmd             *exec.Cmd
	cancel          context.CancelFunc
	mu              sync.Mutex
	subs            map[*claudeSub]struct{}
	history         []claudeEvent
	closed          bool
	eventSequence   uint64
	runtimeClientID string
}

type claudeSessionSnapshot struct {
	ID              string `json:"id"`
	ClaudeSessionID string `json:"claudeSessionId,omitempty"`
	Profile         string `json:"profile"`
	Reused          bool   `json:"reused"`
	Running         bool   `json:"running"`
	RuntimeClientID string `json:"runtimeClientId,omitempty"`
	Available       bool   `json:"available"`
}

type claudeEvent struct {
	Sequence uint64 `json:"sequence"`
	Type     string `json:"type"`
	Method   string `json:"method,omitempty"`
	Params   any    `json:"params,omitempty"`
	Data     any    `json:"data,omitempty"`
}

func newClaudeManager() *claudeManager {
	return &claudeManager{
		sessions: make(map[string]*claudeSession),
		profiles: make(map[agentProfileKey]string),
	}
}

func (m *claudeManager) closeAll() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	sessions := make([]*claudeSession, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.sessions = make(map[string]*claudeSession)
	m.profiles = make(map[agentProfileKey]string)
	m.mu.Unlock()
	for _, session := range sessions {
		session.close()
	}
}

func claudeBinary() string {
	if custom := strings.TrimSpace(os.Getenv("OPENBOARD_CLAUDE_BIN")); custom != "" {
		return custom
	}
	if path, err := exec.LookPath(claudeDefaultBinaryHint); err == nil {
		return path
	}
	return ""
}

func claudeAvailable() bool {
	return claudeBinary() != ""
}

// claudePermissionMode controls Claude Code tool approval behavior for headless turns.
// Headless Claude must never bypass approvals. acceptEdits remains an explicit
// opt-in for auth-off local installations only; account-backed deployments fail safe.
func claudePermissionMode() string {
	mode := strings.TrimSpace(os.Getenv("OPENBOARD_CLAUDE_PERMISSION_MODE"))
	switch mode {
	case "default", "plan":
		return mode
	case "acceptEdits":
		if authMode() == "off" {
			return mode
		}
		return "default"
	default:
		return "default"
	}
}

func (s *Server) createClaudeSession(w http.ResponseWriter, r *http.Request) {
	if !authorizeAccountAgentExecution(w, r) {
		return
	}
	scope := requestAgentScope(r)
	r.Body = http.MaxBytesReader(w, r.Body, maxClaudeBody)
	var req struct {
		CWD     string `json:"cwd"`
		Profile string `json:"profile"`
		Fresh   bool   `json:"fresh"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "invalid claude session request", http.StatusBadRequest)
		return
	}
	if !claudeAvailable() {
		http.Error(w, "claude CLI not found; install Claude Code and ensure `claude` is on PATH (or set OPENBOARD_CLAUDE_BIN)", http.StatusServiceUnavailable)
		return
	}
	cwd, err := resolveAgentCWD(req.CWD)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	profile := strings.TrimSpace(req.Profile)
	if profile == "" {
		profile = "claude-default"
	}
	if !projectIDPattern.MatchString(profile) {
		http.Error(w, "invalid claude profile", http.StatusBadRequest)
		return
	}
	profileKey := agentProfileKey{scope: scope, profile: profile}
	s.claude.mu.RLock()
	managerClosed := s.claude.closed
	s.claude.mu.RUnlock()
	if managerClosed {
		http.Error(w, "claude manager is closed", http.StatusServiceUnavailable)
		return
	}

	if !req.Fresh {
		if existing, ok := s.findClaudeByProfileForScope(scope, profile); ok {
			writeJSON(w, existing.snapshot(true))
			return
		}
	}

	session := &claudeSession{
		id: randomID("claude"), scope: scope, profile: profile, cwd: cwd,
		subs: make(map[*claudeSub]struct{}),
	}
	s.claude.mu.Lock()
	if s.claude.closed {
		s.claude.mu.Unlock()
		http.Error(w, "claude manager is closed", http.StatusServiceUnavailable)
		return
	}
	if prevID, ok := s.claude.profiles[profileKey]; ok {
		if prev, exists := s.claude.sessions[prevID]; exists {
			go prev.close()
		}
		delete(s.claude.sessions, prevID)
	}
	s.claude.sessions[session.id] = session
	s.claude.profiles[profileKey] = session.id
	s.claude.mu.Unlock()

	session.publish(claudeEvent{
		Type:   "status",
		Method: "openboard/claude_ready",
		Data: map[string]any{
			"message": "Claude session created. Send a prompt to start a local Claude Code turn.",
			"binary":  claudeBinary(),
		},
	})
	writeJSON(w, session.snapshot(false))
}

func (s *Server) getClaudeSession(w http.ResponseWriter, r *http.Request) {
	scope := requestAgentScope(r)
	profile := strings.TrimSpace(r.URL.Query().Get("profile"))
	if profile == "" {
		profile = "claude-default"
	}
	if session, ok := s.findClaudeByProfileForScope(scope, profile); ok {
		writeJSON(w, session.snapshot(true))
		return
	}
	http.Error(w, "claude session not found", http.StatusNotFound)
}

func (s *Server) sendClaudeMessage(w http.ResponseWriter, r *http.Request) {
	if !authorizeAccountAgentExecution(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxClaudeBody)
	var req struct {
		SessionID       string `json:"sessionId"`
		Prompt          string `json:"prompt"`
		RuntimeClientID string `json:"runtimeClientId"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "invalid claude message request", http.StatusBadRequest)
		return
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		http.Error(w, "prompt is required", http.StatusBadRequest)
		return
	}
	session, ok := s.findClaudeForScope(requestAgentScope(r), req.SessionID)
	if !ok {
		http.Error(w, "claude session not found", http.StatusNotFound)
		return
	}
	if err := session.startTurn(prompt, strings.TrimSpace(req.RuntimeClientID)); err != nil {
		if errors.Is(err, errClaudeTurnRunning) {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "sessionId": session.id})
}

func (s *Server) interruptClaude(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxClaudeBody)
	var req struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	session, ok := s.findClaudeForScope(requestAgentScope(r), req.SessionID)
	if !ok {
		http.Error(w, "claude session not found", http.StatusNotFound)
		return
	}
	session.interrupt()
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) claudeEvents(w http.ResponseWriter, r *http.Request) {
	session, ok := s.findClaudeForScope(requestAgentScope(r), r.URL.Query().Get("sessionId"))
	if !ok {
		http.Error(w, "claude session not found", http.StatusNotFound)
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
			http.Error(w, "invalid Claude event sequence", http.StatusBadRequest)
			return
		}
		afterSequence = parsed
	}
	ch, unsubscribe := session.subscribeAfter(afterSequence)
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
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (s *Server) closeClaudeSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	scope := requestAgentScope(r)
	s.claude.mu.Lock()
	session, ok := s.claude.sessions[id]
	if ok && session.scope == scope {
		delete(s.claude.sessions, id)
		key := agentProfileKey{scope: scope, profile: session.profile}
		if s.claude.profiles[key] == id {
			delete(s.claude.profiles, key)
		}
	} else {
		ok = false
	}
	s.claude.mu.Unlock()
	if !ok {
		http.Error(w, "claude session not found", http.StatusNotFound)
		return
	}
	session.close()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) findClaude(id string) (*claudeSession, bool) {
	return s.findClaudeForScope(agentScope{}, id)
}

func (s *Server) findClaudeForScope(scope agentScope, id string) (*claudeSession, bool) {
	s.claude.mu.RLock()
	defer s.claude.mu.RUnlock()
	session, ok := s.claude.sessions[id]
	return session, ok && session.scope == scope && !session.isClosed()
}

func (s *Server) findClaudeByProfile(profile string) (*claudeSession, bool) {
	return s.findClaudeByProfileForScope(agentScope{}, profile)
}

func (s *Server) findClaudeByProfileForScope(scope agentScope, profile string) (*claudeSession, bool) {
	s.claude.mu.RLock()
	defer s.claude.mu.RUnlock()
	id, ok := s.claude.profiles[agentProfileKey{scope: scope, profile: profile}]
	if !ok {
		return nil, false
	}
	session, ok := s.claude.sessions[id]
	return session, ok && session.scope == scope && !session.isClosed()
}

func (session *claudeSession) isClosed() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.closed
}

func (session *claudeSession) snapshot(reused bool) claudeSessionSnapshot {
	session.mu.Lock()
	defer session.mu.Unlock()
	return claudeSessionSnapshot{
		ID:              session.id,
		ClaudeSessionID: session.claudeSessionID,
		Profile:         session.profile,
		Reused:          reused,
		Running:         session.running,
		RuntimeClientID: session.runtimeClientID,
		Available:       claudeAvailable(),
	}
}

func (session *claudeSession) publish(event claudeEvent) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return
	}
	session.eventSequence++
	event.Sequence = session.eventSequence
	session.history = append(session.history, event)
	if len(session.history) > claudeHistoryLimit {
		session.history = session.history[len(session.history)-claudeHistoryLimit:]
	}
	for sub := range session.subs {
		select {
		case sub.ch <- event:
		default:
		}
	}
}

func (session *claudeSession) subscribeAfter(after uint64) (<-chan claudeEvent, func()) {
	sub := &claudeSub{ch: make(chan claudeEvent, claudeSubscriberBuffer)}
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		sub.close()
		return sub.ch, func() {}
	}
	session.subs[sub] = struct{}{}
	for _, event := range session.history {
		if event.Sequence > after {
			select {
			case sub.ch <- event:
			default:
			}
		}
	}
	session.mu.Unlock()
	return sub.ch, func() {
		session.mu.Lock()
		delete(session.subs, sub)
		session.mu.Unlock()
		// Safe if session.close() already closed or races with it.
		sub.close()
	}
}

var errClaudeTurnRunning = errors.New("claude turn is already running")

func (session *claudeSession) startTurn(prompt, runtimeClientID string) error {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return errors.New("claude session closed")
	}
	if session.running {
		session.mu.Unlock()
		return errClaudeTurnRunning
	}
	session.running = true
	session.runtimeClientID = runtimeClientID
	session.mu.Unlock()

	session.publish(claudeEvent{
		Type:   "notification",
		Method: "openboard/user_message",
		Params: map[string]any{"text": prompt},
	})
	session.publish(claudeEvent{
		Type:   "status",
		Method: "openboard/turn_started",
		Data:   map[string]any{"prompt": prompt},
	})

	go session.runTurn(prompt)
	return nil
}

func (session *claudeSession) interrupt() {
	session.mu.Lock()
	cancel := session.cancel
	cmd := session.cmd
	session.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Signal(os.Interrupt)
	}
	session.publish(claudeEvent{
		Type:   "status",
		Method: "openboard/turn_interrupted",
		Data:   map[string]any{"message": "interrupt requested"},
	})
}

func (session *claudeSession) close() {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.closed = true
	cancel := session.cancel
	cmd := session.cmd
	subs := session.subs
	session.subs = nil
	session.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	for sub := range subs {
		sub.close()
	}
}

func (session *claudeSession) runTurn(prompt string) {
	defer func() {
		session.mu.Lock()
		session.running = false
		session.cmd = nil
		session.cancel = nil
		session.mu.Unlock()
		session.publish(claudeEvent{
			Type:   "status",
			Method: "openboard/turn_completed",
		})
	}()

	session.mu.Lock()
	if session.closed || !session.running {
		session.running = false
		session.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	session.cancel = cancel
	claudeSessionID := session.claudeSessionID
	cwd := session.cwd
	session.mu.Unlock()

	bin := claudeBinary()
	if bin == "" {
		session.publish(claudeEvent{Type: "error", Data: map[string]any{"message": "claude binary not found"}})
		cancel()
		return
	}

	permMode := claudePermissionMode()
	args := []string{
		"-p",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-mode", permMode,
	}
	if mcpConfig := buildOpenBoardMCPConfig(session.scope, session.id); mcpConfig != "" {
		args = append(args, "--mcp-config", mcpConfig)
		defer os.Remove(mcpConfig)
	}
	if claudeSessionID != "" {
		args = append(args, "--resume", claudeSessionID)
	}
	args = append(args, prompt)

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = cwd
	cmd.Env = append(agentProcessEnvironment(session.scope, os.Environ()), "CLAUDE_CODE_ENTRYPOINT=openboard")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		session.publish(claudeEvent{Type: "error", Data: map[string]any{"message": err.Error()}})
		cancel()
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		session.publish(claudeEvent{Type: "error", Data: map[string]any{"message": err.Error()}})
		cancel()
		return
	}
	if err := cmd.Start(); err != nil {
		session.publish(claudeEvent{Type: "error", Data: map[string]any{"message": "failed to start claude: " + err.Error()}})
		cancel()
		return
	}
	session.mu.Lock()
	session.cmd = cmd
	session.mu.Unlock()

	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			session.publish(claudeEvent{
				Type:   "notification",
				Method: "openboard/log",
				Params: map[string]any{"text": line},
			})
		}
	}()

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)
	// Only whether any assistant text was emitted matters, so tracking a flag
	// avoids retaining the whole streamed response for the length of the turn.
	sawAssistantText := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			session.publish(claudeEvent{
				Type:   "notification",
				Method: "openboard/log",
				Params: map[string]any{"text": line},
			})
			continue
		}
		session.handleStreamObject(raw, &sawAssistantText)
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, context.Canceled) {
		session.publish(claudeEvent{Type: "error", Data: map[string]any{"message": err.Error()}})
	}
	_ = cmd.Wait()
	cancel()
}

func (session *claudeSession) handleStreamObject(raw map[string]any, sawAssistantText *bool) {
	typ, _ := raw["type"].(string)
	switch typ {
	case "system":
		if subtype, _ := raw["subtype"].(string); subtype == "init" {
			if sid, ok := raw["session_id"].(string); ok && sid != "" {
				session.mu.Lock()
				session.claudeSessionID = sid
				session.mu.Unlock()
				session.publish(claudeEvent{
					Type:   "status",
					Method: "openboard/session_bound",
					Data:   map[string]any{"claudeSessionId": sid},
				})
			}
		}
		session.publish(claudeEvent{Type: "notification", Method: "claude/system", Params: raw})
	case "assistant":
		text := extractClaudeText(raw)
		if text != "" {
			*sawAssistantText = true
			session.publish(claudeEvent{
				Type:   "notification",
				Method: "agent/message",
				Params: map[string]any{"text": text, "role": "assistant"},
			})
		} else {
			session.publish(claudeEvent{Type: "notification", Method: "claude/assistant", Params: raw})
		}
	case "stream_event", "content_block_delta":
		delta := extractClaudeDelta(raw)
		if delta != "" {
			*sawAssistantText = true
			session.publish(claudeEvent{
				Type:   "notification",
				Method: "agent/message_delta",
				Params: map[string]any{"text": delta, "role": "assistant"},
			})
		}
	case "user":
	case "result":
		if sid, ok := raw["session_id"].(string); ok && sid != "" {
			session.mu.Lock()
			session.claudeSessionID = sid
			session.mu.Unlock()
		}
		if result, ok := raw["result"].(string); ok && result != "" && !*sawAssistantText {
			session.publish(claudeEvent{
				Type:   "notification",
				Method: "agent/message",
				Params: map[string]any{"text": result, "role": "assistant"},
			})
		}
		session.publish(claudeEvent{Type: "notification", Method: "claude/result", Params: raw})
	case "error":
		msg, _ := raw["error"].(string)
		if msg == "" {
			msg = fmt.Sprintf("%v", raw)
		}
		session.publish(claudeEvent{Type: "error", Data: map[string]any{"message": msg}})
	default:
		session.publish(claudeEvent{Type: "notification", Method: "claude/" + typ, Params: raw})
	}
}

func extractClaudeText(raw map[string]any) string {
	if message, ok := raw["message"].(map[string]any); ok {
		if content, ok := message["content"].([]any); ok {
			var b strings.Builder
			for _, item := range content {
				part, ok := item.(map[string]any)
				if !ok {
					continue
				}
				if partType, _ := part["type"].(string); partType == "text" {
					if text, ok := part["text"].(string); ok {
						b.WriteString(text)
					}
				}
			}
			return b.String()
		}
	}
	if text, ok := raw["result"].(string); ok {
		return text
	}
	return ""
}

func extractClaudeDelta(raw map[string]any) string {
	if event, ok := raw["event"].(map[string]any); ok {
		if delta, ok := event["delta"].(map[string]any); ok {
			if text, ok := delta["text"].(string); ok {
				return text
			}
		}
		if text, ok := event["text"].(string); ok {
			return text
		}
	}
	if delta, ok := raw["delta"].(map[string]any); ok {
		if text, ok := delta["text"].(string); ok {
			return text
		}
	}
	if text, ok := raw["text"].(string); ok {
		return text
	}
	return ""
}

func buildOpenBoardMCPConfig(scope agentScope, sessionID string) string {
	// The connection file contains a machine capability, not a tenant identity.
	// Never expose it to an account-owned session until a turn-scoped grant exists.
	if scope != (agentScope{}) {
		return ""
	}
	mcpBin, err := exec.LookPath("openboard-mcp")
	if err != nil {
		home, _ := os.UserHomeDir()
		candidate := filepath.Join(home, ".local", "share", "openboard", "bin", "openboard-mcp")
		if _, err := os.Stat(candidate); err == nil {
			mcpBin = candidate
		} else {
			return ""
		}
	}
	connectionFile := os.Getenv("OPENBOARD_CONNECTION_FILE")
	if connectionFile == "" {
		home, _ := os.UserHomeDir()
		connectionFile = filepath.Join(home, "Library", "Application Support", "OpenBoard", "data", "connection.json")
		if _, err := os.Stat(connectionFile); err != nil {
			connectionFile = filepath.Join(home, ".config", "OpenBoard", "data", "connection.json")
		}
	}
	payload := map[string]any{
		"mcpServers": map[string]any{
			"openboard": map[string]any{
				"command": mcpBin,
				"env": map[string]string{
					"OPENBOARD_CONNECTION_FILE": connectionFile,
				},
			},
		},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	path := filepath.Join(os.TempDir(), fmt.Sprintf("openboard-claude-mcp-%s.json", sessionID))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return ""
	}
	return path
}
