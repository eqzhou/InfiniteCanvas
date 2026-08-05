package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
)

const (
	defaultCodexSkillsDirectory = ".codex/skills"
	codexSkillMaxCount          = 256
	codexSkillMaxBytes          = 160 * 1024
	codexSkillMaxTotalBytes     = 64 * 1024 * 1024
	codexSkillMaxNameBytes      = 128
	codexSkillMaxDescription    = 512
	codexSkillFileName          = "SKILL.md"
	codexSkillDisabledFileName  = "SKILL.md.disabled"
)

var codexSkillIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

var (
	errCodexSkillNotFound = errors.New("codex skill not found")
	errCodexSkillConflict = errors.New("codex skill changed concurrently")
	errCodexSkillInvalid  = errors.New("invalid codex skill")
)

type codexSkillResponse struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	UpdatedAt   string `json:"updatedAt"`
	Bytes       int    `json:"bytes"`
	Version     string `json:"version"`
	Content     string `json:"content,omitempty"`
}

type codexSkillWriteRequest struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

type codexSkillToggleRequest struct {
	Enabled *bool `json:"enabled"`
}

type codexSkillFile struct {
	response codexSkillResponse
	path     string
}

func resolveCodexSkillsRoot() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("OPENBOARD_CODEX_SKILLS_ROOT")); configured != "" {
		root, err := filepath.Abs(configured)
		if err != nil {
			return "", fmt.Errorf("resolve Codex skills root: %w", err)
		}
		return filepath.Clean(root), nil
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return "", errors.New("Codex skills root is unavailable")
	}
	return filepath.Join(home, defaultCodexSkillsDirectory), nil
}

func (s *Server) codexSkillsRoot() (string, error) {
	if s.codexSkillsRootPath == "" {
		if s.codexSkillsRootErr != nil {
			return "", s.codexSkillsRootErr
		}
		return "", errors.New("Codex skills root is unavailable")
	}
	return s.codexSkillsRootPath, nil
}

func authorizeCodexSkills(w http.ResponseWriter, r *http.Request) bool {
	if !authorizeAccountAgentExecution(w, r) {
		return false
	}
	if _, ok := authUserFrom(r.Context()); ok {
		http.Error(w, "host Codex skills are unavailable to account sessions", http.StatusForbidden)
		return false
	}
	return true
}

func validateCodexSkillID(id string) bool {
	return codexSkillIDPattern.MatchString(id)
}

func codexSkillDirectory(root, id string) (string, error) {
	if !validateCodexSkillID(id) {
		return "", errCodexSkillInvalid
	}
	directory := filepath.Join(root, id)
	relative, err := filepath.Rel(root, directory)
	if err != nil || relative != id {
		return "", errCodexSkillInvalid
	}
	return directory, nil
}

func ensureCodexSkillsRoot(root string) error {
	if err := validateCodexSkillsRoot(root); err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("create Codex skills root: %w", err)
	}
	return validateCodexSkillsRoot(root)
}

func validateCodexSkillsRoot(root string) error {
	info, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errCodexSkillInvalid
	}
	return nil
}

func regularCodexSkillFile(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errCodexSkillInvalid
	}
	return info, nil
}

func readCodexSkillContent(path string) ([]byte, error) {
	expected, err := regularCodexSkillFile(path)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(expected, opened) {
		return nil, errCodexSkillInvalid
	}
	current, err := regularCodexSkillFile(path)
	if err != nil || !os.SameFile(expected, current) {
		return nil, errCodexSkillInvalid
	}
	content, err := io.ReadAll(io.LimitReader(file, codexSkillMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(content) == 0 || len(content) > codexSkillMaxBytes || !utf8.Valid(content) {
		return nil, errCodexSkillInvalid
	}
	return content, nil
}

func codexSkillVersion(content string, enabled bool) string {
	hash := sha256.New()
	if enabled {
		_, _ = hash.Write([]byte("enabled\x00"))
	} else {
		_, _ = hash.Write([]byte("disabled\x00"))
	}
	_, _ = hash.Write([]byte(content))
	return hex.EncodeToString(hash.Sum(nil))
}

func parseCodexSkillMetadata(id, content string) (string, string) {
	name := id
	description := ""
	lines := strings.Split(content, "\n")
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		for _, line := range lines[1:] {
			trimmed := strings.TrimSpace(line)
			if trimmed == "---" {
				break
			}
			key, value, ok := strings.Cut(trimmed, ":")
			if !ok {
				continue
			}
			value = strings.TrimSpace(value)
			switch strings.ToLower(strings.TrimSpace(key)) {
			case "name":
				if value != "" && len(value) <= codexSkillMaxNameBytes {
					name = value
				}
			case "description":
				if len(value) <= codexSkillMaxDescription {
					description = value
				}
			}
		}
	}
	if description == "" {
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "#") {
				continue
			}
			trimmed = strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
			if trimmed != "" {
				description = truncateCodexSkillText(trimmed, codexSkillMaxDescription)
				break
			}
		}
	}
	return name, description
}

func truncateCodexSkillText(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes
	for end > 0 && !utf8.ValidString(value[:end]) {
		end--
	}
	return value[:end]
}

func readCodexSkill(root, id string, includeContent bool) (codexSkillFile, error) {
	if err := validateCodexSkillsRoot(root); err != nil {
		return codexSkillFile{}, err
	}
	directory, err := codexSkillDirectory(root, id)
	if err != nil {
		return codexSkillFile{}, err
	}
	directoryInfo, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return codexSkillFile{}, errCodexSkillNotFound
	}
	if err != nil || directoryInfo.Mode()&os.ModeSymlink != 0 || !directoryInfo.IsDir() {
		return codexSkillFile{}, errCodexSkillNotFound
	}

	activePath := filepath.Join(directory, codexSkillFileName)
	disabledPath := filepath.Join(directory, codexSkillDisabledFileName)
	activeInfo, activeErr := regularCodexSkillFile(activePath)
	disabledInfo, disabledErr := regularCodexSkillFile(disabledPath)
	activeExists := activeErr == nil
	disabledExists := disabledErr == nil
	if activeErr != nil && !errors.Is(activeErr, os.ErrNotExist) && !errors.Is(activeErr, errCodexSkillInvalid) {
		return codexSkillFile{}, activeErr
	}
	if disabledErr != nil && !errors.Is(disabledErr, os.ErrNotExist) && !errors.Is(disabledErr, errCodexSkillInvalid) {
		return codexSkillFile{}, disabledErr
	}
	if activeExists == disabledExists {
		return codexSkillFile{}, errCodexSkillNotFound
	}

	path := activePath
	info := activeInfo
	enabled := true
	if !activeExists {
		path = disabledPath
		info = disabledInfo
		enabled = false
	}
	contentBytes, err := readCodexSkillContent(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return codexSkillFile{}, errCodexSkillNotFound
		}
		return codexSkillFile{}, err
	}
	if len(contentBytes) == 0 || len(contentBytes) > codexSkillMaxBytes || !utf8.Valid(contentBytes) {
		return codexSkillFile{}, errCodexSkillInvalid
	}
	content := string(contentBytes)
	name, description := parseCodexSkillMetadata(id, content)
	response := codexSkillResponse{
		ID: id, Name: name, Description: description, Enabled: enabled,
		UpdatedAt: info.ModTime().UTC().Format(time.RFC3339Nano), Bytes: len(contentBytes),
		Version: codexSkillVersion(content, enabled),
	}
	if includeContent {
		response.Content = content
	}
	return codexSkillFile{response: response, path: path}, nil
}

func listCodexSkills(root string) ([]codexSkillResponse, error) {
	if err := validateCodexSkillsRoot(root); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return []codexSkillResponse{}, nil
	}
	if err != nil {
		return nil, err
	}
	items := make([]codexSkillResponse, 0, len(entries))
	for _, entry := range entries {
		if len(items) >= codexSkillMaxCount || entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			continue
		}
		item, err := readCodexSkill(root, entry.Name(), false)
		if err != nil {
			continue
		}
		items = append(items, item.response)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items, nil
}

func codexSkillsTotalBytes(root string) (int, error) {
	items, err := listCodexSkills(root)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, item := range items {
		total += item.Bytes
		if total > codexSkillMaxTotalBytes {
			return total, errCodexSkillInvalid
		}
	}
	return total, nil
}

func validateCodexSkillContent(content string) error {
	if strings.TrimSpace(content) == "" || len(content) > codexSkillMaxBytes || !utf8.ValidString(content) {
		return errCodexSkillInvalid
	}
	if strings.ContainsRune(content, '\x00') {
		return errCodexSkillInvalid
	}
	return nil
}

func writeCodexSkillFile(directory, filename, content string) error {
	if err := validateCodexSkillContent(content); err != nil {
		return err
	}
	file, err := os.CreateTemp(directory, ".skill-*.tmp")
	if err != nil {
		return err
	}
	temporary := file.Name()
	removeTemporary := true
	defer func() {
		_ = file.Close()
		if removeTemporary {
			_ = os.Remove(temporary)
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if _, err := io.WriteString(file, content); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary, filepath.Join(directory, filename)); err != nil {
		return err
	}
	removeTemporary = false
	return nil
}

func decodeCodexSkillJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, codexSkillMaxBytes+16*1024))
	if err := decoder.Decode(destination); err != nil || ensureJSONEOF(decoder) != nil {
		http.Error(w, "invalid Codex skill request", http.StatusBadRequest)
		return false
	}
	return true
}

func codexSkillError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errCodexSkillNotFound):
		http.Error(w, "Codex skill not found", http.StatusNotFound)
	case errors.Is(err, errCodexSkillConflict):
		http.Error(w, "Codex skill changed; refresh before saving", http.StatusConflict)
	case errors.Is(err, errCodexSkillInvalid):
		http.Error(w, "invalid Codex skill", http.StatusBadRequest)
	default:
		http.Error(w, "Codex skill storage failed", http.StatusInternalServerError)
	}
}

func requireCodexSkillVersion(w http.ResponseWriter, r *http.Request, current string) bool {
	provided := strings.TrimSpace(r.Header.Get("If-Match"))
	provided = strings.Trim(provided, "\"")
	if provided == "" {
		http.Error(w, "If-Match is required for Codex skill changes", http.StatusPreconditionRequired)
		return false
	}
	if provided != current {
		codexSkillError(w, errCodexSkillConflict)
		return false
	}
	return true
}

func (s *Server) listCodexSkills(w http.ResponseWriter, r *http.Request) {
	if !authorizeCodexSkills(w, r) {
		return
	}
	root, err := s.codexSkillsRoot()
	if err != nil {
		codexSkillError(w, err)
		return
	}
	s.codexSkillsMu.Lock()
	defer s.codexSkillsMu.Unlock()
	items, err := listCodexSkills(root)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	writeJSON(w, map[string]any{"skills": items})
}

func (s *Server) getCodexSkill(w http.ResponseWriter, r *http.Request) {
	if !authorizeCodexSkills(w, r) {
		return
	}
	root, err := s.codexSkillsRoot()
	if err != nil {
		codexSkillError(w, err)
		return
	}
	id := chi.URLParam(r, "id")
	s.codexSkillsMu.Lock()
	defer s.codexSkillsMu.Unlock()
	item, err := readCodexSkill(root, id, true)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	writeJSON(w, item.response)
}

func (s *Server) createCodexSkill(w http.ResponseWriter, r *http.Request) {
	if !authorizeCodexSkills(w, r) {
		return
	}
	var input codexSkillWriteRequest
	if !decodeCodexSkillJSON(w, r, &input) || !validateCodexSkillID(input.ID) {
		http.Error(w, "invalid Codex skill id", http.StatusBadRequest)
		return
	}
	if err := validateCodexSkillContent(input.Content); err != nil {
		codexSkillError(w, err)
		return
	}
	root, err := s.codexSkillsRoot()
	if err != nil {
		codexSkillError(w, err)
		return
	}
	s.codexSkillsMu.Lock()
	defer s.codexSkillsMu.Unlock()
	if err := ensureCodexSkillsRoot(root); err != nil {
		codexSkillError(w, err)
		return
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	if len(entries) >= codexSkillMaxCount {
		codexSkillError(w, errCodexSkillInvalid)
		return
	}
	totalBytes, err := codexSkillsTotalBytes(root)
	if err != nil || totalBytes+len(input.Content) > codexSkillMaxTotalBytes {
		codexSkillError(w, errCodexSkillInvalid)
		return
	}
	directory, err := codexSkillDirectory(root, input.ID)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	if _, err := os.Lstat(directory); err == nil {
		http.Error(w, "Codex skill already exists", http.StatusConflict)
		return
	} else if !errors.Is(err, os.ErrNotExist) {
		codexSkillError(w, err)
		return
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			http.Error(w, "Codex skill already exists", http.StatusConflict)
			return
		}
		codexSkillError(w, err)
		return
	}
	if err := writeCodexSkillFile(directory, codexSkillFileName, input.Content); err != nil {
		_ = os.RemoveAll(directory)
		codexSkillError(w, err)
		return
	}
	item, err := readCodexSkill(root, input.ID, true)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, item.response)
}

func (s *Server) updateCodexSkill(w http.ResponseWriter, r *http.Request) {
	if !authorizeCodexSkills(w, r) {
		return
	}
	var input codexSkillWriteRequest
	if !decodeCodexSkillJSON(w, r, &input) {
		return
	}
	if err := validateCodexSkillContent(input.Content); err != nil {
		codexSkillError(w, err)
		return
	}
	root, err := s.codexSkillsRoot()
	if err != nil {
		codexSkillError(w, err)
		return
	}
	s.codexSkillsMu.Lock()
	defer s.codexSkillsMu.Unlock()
	current, err := readCodexSkill(root, chi.URLParam(r, "id"), true)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	if !requireCodexSkillVersion(w, r, current.response.Version) {
		return
	}
	if err := writeCodexSkillFile(filepath.Dir(current.path), filepath.Base(current.path), input.Content); err != nil {
		codexSkillError(w, err)
		return
	}
	updated, err := readCodexSkill(root, current.response.ID, true)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	writeJSON(w, updated.response)
}

func (s *Server) toggleCodexSkill(w http.ResponseWriter, r *http.Request) {
	if !authorizeCodexSkills(w, r) {
		return
	}
	var input codexSkillToggleRequest
	if !decodeCodexSkillJSON(w, r, &input) || input.Enabled == nil {
		http.Error(w, "enabled is required", http.StatusBadRequest)
		return
	}
	root, err := s.codexSkillsRoot()
	if err != nil {
		codexSkillError(w, err)
		return
	}
	s.codexSkillsMu.Lock()
	defer s.codexSkillsMu.Unlock()
	id := chi.URLParam(r, "id")
	current, err := readCodexSkill(root, id, true)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	if !requireCodexSkillVersion(w, r, current.response.Version) {
		return
	}
	if current.response.Enabled == *input.Enabled {
		writeJSON(w, current.response)
		return
	}
	from := current.path
	toName := codexSkillDisabledFileName
	if *input.Enabled {
		toName = codexSkillFileName
	}
	to := filepath.Join(filepath.Dir(from), toName)
	if _, err := os.Lstat(to); err == nil {
		codexSkillError(w, errCodexSkillConflict)
		return
	} else if !errors.Is(err, os.ErrNotExist) {
		codexSkillError(w, err)
		return
	}
	if err := os.Rename(from, to); err != nil {
		codexSkillError(w, err)
		return
	}
	updated, err := readCodexSkill(root, id, true)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	writeJSON(w, updated.response)
}

func (s *Server) invokeCodexSkill(w http.ResponseWriter, r *http.Request) {
	if !authorizeCodexSkills(w, r) {
		return
	}
	root, err := s.codexSkillsRoot()
	if err != nil {
		codexSkillError(w, err)
		return
	}
	s.codexSkillsMu.Lock()
	defer s.codexSkillsMu.Unlock()
	item, err := readCodexSkill(root, chi.URLParam(r, "id"), true)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	if !item.response.Enabled {
		codexSkillError(w, errCodexSkillConflict)
		return
	}
	writeJSON(w, map[string]any{
		"id": item.response.ID, "name": item.response.Name, "content": item.response.Content,
	})
}

func (s *Server) deleteCodexSkill(w http.ResponseWriter, r *http.Request) {
	if !authorizeCodexSkills(w, r) {
		return
	}
	root, err := s.codexSkillsRoot()
	if err != nil {
		codexSkillError(w, err)
		return
	}
	s.codexSkillsMu.Lock()
	defer s.codexSkillsMu.Unlock()
	directory, err := codexSkillDirectory(root, chi.URLParam(r, "id"))
	if err != nil {
		codexSkillError(w, err)
		return
	}
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		codexSkillError(w, errCodexSkillNotFound)
		return
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		codexSkillError(w, errCodexSkillNotFound)
		return
	}
	current, err := readCodexSkill(root, chi.URLParam(r, "id"), false)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	if !requireCodexSkillVersion(w, r, current.response.Version) {
		return
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		codexSkillError(w, err)
		return
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(current.path) {
		codexSkillError(w, errCodexSkillConflict)
		return
	}
	if err := os.Remove(current.path); err != nil {
		codexSkillError(w, err)
		return
	}
	if err := os.Remove(directory); err != nil {
		codexSkillError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
