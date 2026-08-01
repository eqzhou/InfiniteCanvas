package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
)

const (
	maxCodexHistoryRecords  = 200
	maxCodexHistoryMessages = 512
	maxCodexHistoryEvents   = 2_048
	maxCodexHistoryText     = 100_000
	maxCodexHistoryIDs      = 100
	maxCodexHistoryEvent    = 64 << 10
	maxCodexHistoryFile     = 32 << 20
)

type codexHistoryMessage struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	Text      string `json:"text"`
	CreatedAt string `json:"createdAt"`
}

type codexHistorySummary struct {
	ID           string `json:"id"`
	Profile      string `json:"profile"`
	ThreadID     string `json:"threadId"`
	Title        string `json:"title"`
	Preview      string `json:"preview,omitempty"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
	Status       string `json:"status"`
	MessageCount int    `json:"messageCount"`
}

type codexHistoryRecord struct {
	ID           string                `json:"id"`
	Profile      string                `json:"profile"`
	ThreadID     string                `json:"threadId"`
	Title        string                `json:"title"`
	Preview      string                `json:"preview,omitempty"`
	CreatedAt    string                `json:"createdAt"`
	UpdatedAt    string                `json:"updatedAt"`
	Status       string                `json:"status"`
	MessageCount int                   `json:"messageCount"`
	CWD          string                `json:"cwd,omitempty"`
	Messages     []codexHistoryMessage `json:"messages"`
	Events       []codexEvent          `json:"events"`
}

type codexHistoryFile struct {
	Version int                  `json:"version"`
	Items   []codexHistoryRecord `json:"items"`
}

type codexHistoryStore struct {
	root string
	mu   sync.Mutex
}

func newCodexHistoryStore(dataDir string) *codexHistoryStore {
	return &codexHistoryStore{root: filepath.Join(dataDir, "codex-history")}
}

func historyScopeFilename(scope agentScope) string {
	sum := sha256.Sum256([]byte(scope.tenantID + "\x00" + scope.userID))
	return hex.EncodeToString(sum[:]) + ".json"
}

func (s *codexHistoryStore) path(scope agentScope) string {
	return filepath.Join(s.root, historyScopeFilename(scope))
}

func (s *codexHistoryStore) readLocked(scope agentScope) (codexHistoryFile, error) {
	path := s.path(scope)
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return codexHistoryFile{Version: 1, Items: []codexHistoryRecord{}}, nil
	}
	if err != nil {
		return codexHistoryFile{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxCodexHistoryFile {
		return codexHistoryFile{}, errors.New("invalid Codex history file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return codexHistoryFile{}, err
	}
	var file codexHistoryFile
	if err := json.Unmarshal(data, &file); err != nil || file.Version != 1 || len(file.Items) > maxCodexHistoryRecords {
		return codexHistoryFile{}, errors.New("invalid Codex history file")
	}
	if file.Items == nil {
		file.Items = []codexHistoryRecord{}
	}
	for _, item := range file.Items {
		if err := validateCodexHistoryRecord(item); err != nil {
			return codexHistoryFile{}, err
		}
	}
	return file, nil
}

func (s *codexHistoryStore) writeLocked(scope agentScope, file codexHistoryFile) error {
	if len(file.Items) > maxCodexHistoryRecords {
		sort.SliceStable(file.Items, func(i, j int) bool {
			return file.Items[i].UpdatedAt > file.Items[j].UpdatedAt
		})
		file.Items = append([]codexHistoryRecord(nil), file.Items[:maxCodexHistoryRecords]...)
	}
	if len(file.Items) == 0 {
		if err := os.Remove(s.path(scope)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return err
	}
	body, err := json.Marshal(file)
	if err != nil {
		return err
	}
	if len(body) > maxCodexHistoryFile {
		return errors.New("Codex history file exceeds size limit")
	}
	return atomicWriteFile(s.path(scope), body, 0o600)
}

func validateCodexHistoryRecord(record codexHistoryRecord) error {
	if !projectIDPattern.MatchString(record.ID) || !projectIDPattern.MatchString(record.Profile) ||
		(record.ThreadID != "" && !projectIDPattern.MatchString(record.ThreadID)) || record.Title == "" || len(record.Title) > 256 ||
		len(record.CreatedAt) > 128 || len(record.UpdatedAt) > 128 || len(record.Preview) > maxCodexHistoryText || len(record.CWD) > 4_096 ||
		len(record.Messages) > maxCodexHistoryMessages || len(record.Events) > maxCodexHistoryEvents {
		return errors.New("invalid Codex history record")
	}
	if record.Status == "" {
		return errors.New("invalid Codex history record")
	}
	for _, message := range record.Messages {
		if !projectIDPattern.MatchString(message.ID) || (message.Role != "user" && message.Role != "assistant") || len(message.Text) > maxCodexHistoryText || len(message.CreatedAt) > 128 {
			return errors.New("invalid Codex history message")
		}
	}
	for _, event := range record.Events {
		if _, err := boundCodexHistoryEvent(event); err != nil {
			return errors.New("invalid Codex history event")
		}
	}
	return nil
}

func (s *codexHistoryStore) put(scope agentScope, record codexHistoryRecord) error {
	if record.Title == "" {
		record.Title = "新对话"
	}
	if record.Status == "" {
		record.Status = "completed"
	}
	if err := validateCodexHistoryRecord(record); err != nil {
		return err
	}
	record.MessageCount = len(record.Messages)
	if record.Preview == "" {
		record.Preview = historyPreview(record.Messages)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.readLocked(scope)
	if err != nil {
		return err
	}
	replaced := false
	for index, item := range file.Items {
		if item.ID == record.ID {
			file.Items[index] = cloneCodexHistoryRecord(record)
			replaced = true
			break
		}
	}
	if !replaced {
		file.Items = append(file.Items, cloneCodexHistoryRecord(record))
	}
	return s.writeLocked(scope, file)
}

func cloneCodexHistoryRecord(record codexHistoryRecord) codexHistoryRecord {
	clone := record
	clone.Messages = append([]codexHistoryMessage(nil), record.Messages...)
	clone.Events = append([]codexEvent(nil), record.Events...)
	return clone
}

func (s *codexHistoryStore) get(scope agentScope, profile, id string) (codexHistoryRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.readLocked(scope)
	if err != nil {
		return codexHistoryRecord{}, err
	}
	for _, item := range file.Items {
		if item.Profile == profile && item.ID == id {
			return cloneCodexHistoryRecord(item), nil
		}
	}
	return codexHistoryRecord{}, os.ErrNotExist
}

func (s *codexHistoryStore) list(scope agentScope, profile string) ([]codexHistorySummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.readLocked(scope)
	if err != nil {
		return nil, err
	}
	items := make([]codexHistorySummary, 0, len(file.Items))
	for _, item := range file.Items {
		if item.Profile != profile {
			continue
		}
		items = append(items, historySummary(item))
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].UpdatedAt == items[j].UpdatedAt {
			return items[i].ID > items[j].ID
		}
		return items[i].UpdatedAt > items[j].UpdatedAt
	})
	return items, nil
}

func historySummary(record codexHistoryRecord) codexHistorySummary {
	return codexHistorySummary{
		ID: record.ID, Profile: record.Profile, ThreadID: record.ThreadID, Title: record.Title,
		Preview: record.Preview, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt,
		Status: record.Status, MessageCount: len(record.Messages),
	}
}

func (s *codexHistoryStore) delete(scope agentScope, profile, id string) (bool, error) {
	deleted, err := s.bulkDelete(scope, profile, []string{id})
	return deleted > 0, err
}

func (s *codexHistoryStore) bulkDelete(scope agentScope, profile string, ids []string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.readLocked(scope)
	if err != nil {
		return 0, err
	}
	selected := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		selected[id] = struct{}{}
	}
	remaining := make([]codexHistoryRecord, 0, len(file.Items))
	deleted := 0
	for _, item := range file.Items {
		if item.Profile == profile {
			if _, ok := selected[item.ID]; ok {
				deleted++
				continue
			}
		}
		remaining = append(remaining, item)
	}
	file.Items = remaining
	return deleted, s.writeLocked(scope, file)
}

func (s *codexHistoryStore) appendEvent(scope agentScope, profile, id string, event codexEvent) error {
	boundedEvent, err := boundCodexHistoryEvent(event)
	if err != nil {
		return err
	}
	event = boundedEvent
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.readLocked(scope)
	if err != nil {
		return err
	}
	for index, item := range file.Items {
		if item.ID != id || item.Profile != profile {
			continue
		}
		item = cloneCodexHistoryRecord(item)
		item.Events = append(item.Events, event)
		if len(item.Events) > maxCodexHistoryEvents {
			item.Events = append([]codexEvent(nil), item.Events[len(item.Events)-maxCodexHistoryEvents:]...)
		}
		applyCodexHistoryEvent(&item, event)
		item.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		item.MessageCount = len(item.Messages)
		item.Preview = historyPreview(item.Messages)
		file.Items[index] = item
		return s.writeLocked(scope, file)
	}
	return os.ErrNotExist
}

func boundCodexHistoryEvent(event codexEvent) (codexEvent, error) {
	if len(event.Method) > 256 {
		event.Method = "codex/oversized_event"
	}
	if len(event.ID) > 4_096 {
		event.ID = nil
	}
	if len(event.Params) > maxCodexHistoryEvent {
		event.Params = nil
	}
	if event.Data != nil {
		data, err := json.Marshal(event.Data)
		if err != nil || len(data) > maxCodexHistoryEvent {
			event.Data = nil
		}
	}
	body, err := json.Marshal(event)
	if err != nil {
		return codexEvent{}, err
	}
	if len(body) > maxCodexHistoryEvent {
		event.Params = nil
		event.Data = nil
		body, err = json.Marshal(event)
		if err != nil {
			return codexEvent{}, err
		}
	}
	if len(body) > maxCodexHistoryEvent {
		return codexEvent{}, errors.New("Codex history event exceeds size limit")
	}
	return event, nil
}

func (s *codexHistoryStore) finish(scope agentScope, profile, id, status string) error {
	if status != "completed" && status != "failed" {
		return errors.New("invalid Codex history finish status")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.readLocked(scope)
	if err != nil {
		return err
	}
	for index, item := range file.Items {
		if item.ID != id || item.Profile != profile || item.Status != "running" {
			continue
		}
		item = cloneCodexHistoryRecord(item)
		item.Status = status
		item.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		file.Items[index] = item
		return s.writeLocked(scope, file)
	}
	return nil
}

func applyCodexHistoryEvent(record *codexHistoryRecord, event codexEvent) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if event.Method == "openboard/user_message" {
		var data struct {
			ID   string `json:"id"`
			Text string `json:"text"`
		}
		if jsonBytes, err := json.Marshal(event.Data); err == nil && json.Unmarshal(jsonBytes, &data) == nil {
			text := strings.TrimSpace(data.Text)
			if data.ID != "" && text != "" && len(text) <= maxCodexHistoryText {
				duplicate := false
				for _, message := range record.Messages {
					if message.ID == data.ID && message.Role == "user" {
						duplicate = true
						break
					}
				}
				if !duplicate {
					record.Messages = appendBoundedHistoryMessage(record.Messages, codexHistoryMessage{ID: data.ID, Role: "user", Text: text, CreatedAt: now})
				}
				if record.Title == "" || record.Title == "新对话" {
					record.Title = truncateHistoryTitle(text)
				}
			}
		}
	}
	method := strings.ToLower(event.Method)
	if strings.Contains(method, "agent_message") || strings.Contains(method, "agentmessage") || strings.Contains(method, "agent/message") {
		var params struct {
			Delta string `json:"delta"`
			Text  string `json:"text"`
		}
		if json.Unmarshal(event.Params, &params) == nil {
			text := params.Delta
			if text == "" {
				text = params.Text
			}
			if text != "" {
				appendCodexAssistantHistory(record, text, now)
			}
		}
	}
	switch event.Method {
	case "turn/completed", "turn_completed":
		record.Status = "completed"
	case "turn/failed", "turn_failed", "error":
		record.Status = "failed"
	case "turn/started", "turn_started":
		record.Status = "running"
	}
}

func appendCodexAssistantHistory(record *codexHistoryRecord, text, createdAt string) {
	if len(text) > maxCodexHistoryText {
		text = truncateHistoryUTF8Bytes(text, maxCodexHistoryText)
	}
	messages := record.Messages
	if len(messages) > 0 && messages[len(messages)-1].Role == "assistant" {
		messages[len(messages)-1].Text = truncateHistorySuffixUTF8Bytes(messages[len(messages)-1].Text+text, maxCodexHistoryText)
		record.Messages = messages
		return
	}
	record.Messages = appendBoundedHistoryMessage(messages, codexHistoryMessage{
		ID: randomID("assistant"), Role: "assistant", Text: text, CreatedAt: createdAt,
	})
}

func appendBoundedHistoryMessage(messages []codexHistoryMessage, message codexHistoryMessage) []codexHistoryMessage {
	result := append(append([]codexHistoryMessage(nil), messages...), message)
	if len(result) > maxCodexHistoryMessages {
		result = append([]codexHistoryMessage(nil), result[len(result)-maxCodexHistoryMessages:]...)
	}
	return result
}

func historyPreview(messages []codexHistoryMessage) string {
	for index := len(messages) - 1; index >= 0; index-- {
		if text := strings.TrimSpace(messages[index].Text); text != "" {
			return truncateHistoryTitle(text)
		}
	}
	return ""
}

func truncateHistoryTitle(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if len([]rune(value)) <= 80 {
		return value
	}
	return truncateHistoryRunes(value, 77) + "..."
}

func truncateHistoryRunes(value string, maxRunes int) string {
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}

func truncateHistorySuffix(value string, maxRunes int) string {
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[len(runes)-maxRunes:])
}

func truncateHistoryUTF8Bytes(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes
	for end > 0 {
		runeValue, size := utf8.DecodeLastRuneInString(value[:end])
		if runeValue != utf8.RuneError || size != 1 {
			break
		}
		end--
	}
	return value[:end]
}

func truncateHistorySuffixUTF8Bytes(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	start := len(value) - maxBytes
	for start < len(value) {
		runeValue, size := utf8.DecodeRuneInString(value[start:])
		if runeValue != utf8.RuneError || size != 1 {
			break
		}
		start++
	}
	return value[start:]
}

func (s *Server) codexHistoryProfile(r *http.Request) (string, bool) {
	profile := strings.TrimSpace(r.URL.Query().Get("profile"))
	if profile == "" {
		profile = "default"
	}
	if !projectIDPattern.MatchString(profile) {
		return "", false
	}
	return profile, true
}

func (s *Server) listCodexHistory(w http.ResponseWriter, r *http.Request) {
	profile, ok := s.codexHistoryProfile(r)
	if !ok {
		http.Error(w, "invalid Codex profile", http.StatusBadRequest)
		return
	}
	items, err := s.codexHistory.list(requestAgentScope(r), profile)
	if err != nil {
		http.Error(w, "failed to list Codex history", http.StatusInternalServerError)
		return
	}
	writeJSON(w, items)
}

func (s *Server) getCodexHistory(w http.ResponseWriter, r *http.Request) {
	profile, ok := s.codexHistoryProfile(r)
	if !ok || !projectIDPattern.MatchString(chi.URLParam(r, "id")) {
		http.Error(w, "invalid Codex history id", http.StatusBadRequest)
		return
	}
	record, err := s.codexHistory.get(requestAgentScope(r), profile, chi.URLParam(r, "id"))
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Codex history not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to read Codex history", http.StatusInternalServerError)
		return
	}
	writeJSON(w, record)
}

func (s *Server) deleteCodexHistory(w http.ResponseWriter, r *http.Request) {
	profile, ok := s.codexHistoryProfile(r)
	id := chi.URLParam(r, "id")
	if !ok || !projectIDPattern.MatchString(id) {
		http.Error(w, "invalid Codex history id", http.StatusBadRequest)
		return
	}
	if s.codexHistoryRunning(requestAgentScope(r), profile, id) {
		http.Error(w, "running Codex history cannot be deleted", http.StatusConflict)
		return
	}
	deleted, err := s.codexHistory.delete(requestAgentScope(r), profile, id)
	if err != nil {
		http.Error(w, "failed to delete Codex history", http.StatusInternalServerError)
		return
	}
	if !deleted {
		http.Error(w, "Codex history not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) bulkDeleteCodexHistory(w http.ResponseWriter, r *http.Request) {
	profile, ok := s.codexHistoryProfile(r)
	if !ok {
		http.Error(w, "invalid Codex profile", http.StatusBadRequest)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32*1024)
	var request struct {
		IDs []string `json:"ids"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || ensureJSONEOF(decoder) != nil || len(request.IDs) == 0 || len(request.IDs) > maxCodexHistoryIDs {
		http.Error(w, "ids must contain between 1 and 100 history records", http.StatusBadRequest)
		return
	}
	ids := make([]string, 0, len(request.IDs))
	seen := make(map[string]struct{}, len(request.IDs))
	for _, id := range request.IDs {
		if !projectIDPattern.MatchString(id) {
			http.Error(w, "invalid Codex history id", http.StatusBadRequest)
			return
		}
		if _, exists := seen[id]; !exists {
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}
	for _, id := range ids {
		if s.codexHistoryRunning(requestAgentScope(r), profile, id) {
			http.Error(w, "running Codex history cannot be deleted", http.StatusConflict)
			return
		}
	}
	deleted, err := s.codexHistory.bulkDelete(requestAgentScope(r), profile, ids)
	if err != nil {
		http.Error(w, "failed to delete Codex history", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"deleted": deleted})
}

func (s *Server) codexHistoryRunning(scope agentScope, profile, historyID string) bool {
	session := s.codexSessionForProfile(scope, profile)
	if session == nil {
		return false
	}
	snapshot := session.snapshot(false)
	return snapshot.HistoryID == historyID && snapshot.Profile == profile && snapshot.Running
}

func (s *Server) codexSessionForProfile(scope agentScope, profile string) *codexSession {
	s.codex.mu.RLock()
	session := s.codex.sessions[s.codex.profiles[agentProfileKey{scope: scope, profile: profile}]]
	s.codex.mu.RUnlock()
	if session == nil || session.isClosed() {
		return nil
	}
	return session
}

func (s *Server) restoreCodexHistory(w http.ResponseWriter, r *http.Request) {
	if !authorizeAccountAgentExecution(w, r) {
		return
	}
	profile, ok := s.codexHistoryProfile(r)
	id := chi.URLParam(r, "id")
	if !ok || !projectIDPattern.MatchString(id) {
		http.Error(w, "invalid Codex history id", http.StatusBadRequest)
		return
	}
	scope := requestAgentScope(r)
	record, err := s.codexHistory.get(scope, profile, id)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Codex history not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to read Codex history", http.StatusInternalServerError)
		return
	}
	if current := s.codexSessionForProfile(scope, profile); current != nil {
		snapshot := current.snapshot(false)
		if snapshot.Running {
			if snapshot.HistoryID == id {
				writeJSON(w, map[string]any{"session": snapshot, "history": record})
				return
			}
			http.Error(w, "a Codex turn is already running", http.StatusConflict)
			return
		}
	}
	cwd, err := resolveAgentCWD(record.CWD)
	if err != nil {
		cwd, err = resolveAgentCWD("")
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	session, err := startCodexSessionForScopeWithThreadAndDebug(s.codex.root, scope, cwd, record.ThreadID, s.debugWriter)
	if err != nil {
		http.Error(w, "codex app-server unavailable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	session.profile = profile
	session.scope = scope
	s.applyStoredCodexPreferences(session)
	session.cwd = cwd
	session.historyStore = s.codexHistory
	session.historyID = record.ID
	if session.threadID != record.ThreadID || record.CWD != cwd {
		record.ThreadID = session.threadID
		record.CWD = cwd
		if err := s.codexHistory.put(scope, record); err != nil {
			session.close()
			http.Error(w, "failed to persist restored Codex history", http.StatusInternalServerError)
			return
		}
	}
	s.codex.mu.Lock()
	previousID := s.codex.profiles[agentProfileKey{scope: scope, profile: profile}]
	previous := s.codex.sessions[previousID]
	s.codex.sessions[session.id] = session
	s.codex.profiles[agentProfileKey{scope: scope, profile: profile}] = session.id
	if previous != nil {
		delete(s.codex.sessions, previous.id)
	}
	s.codex.mu.Unlock()
	if previous != nil {
		previous.close()
	}
	writeJSON(w, map[string]any{"session": session.snapshot(false), "history": record})
}
