package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type fileManagerLaunch func(name string, args ...string) error

func fileManagerCommand(path string) (string, []string, error) {
	path = filepath.Clean(path)
	if path == "." || path == string(filepath.Separator) || strings.ContainsRune(path, '\x00') {
		return "", nil, errors.New("file path is invalid")
	}
	info, err := os.Stat(path)
	if err != nil && !os.IsNotExist(err) {
		return "", nil, err
	}
	target := path
	if err != nil && os.IsNotExist(err) {
		target = filepath.Dir(path)
	} else if !info.IsDir() {
		target = path
	}
	switch runtime.GOOS {
	case "darwin":
		return "open", []string{"-R", target}, nil
	case "windows":
		return "explorer", []string{"/select," + target}, nil
	case "linux", "freebsd", "openbsd", "netbsd":
		return "xdg-open", []string{target}, nil
	default:
		return "", nil, errors.New("native file manager is unsupported on this platform")
	}
}

func revealFileInManager(path string, launch fileManagerLaunch) error {
	name, args, err := fileManagerCommand(path)
	if err != nil {
		return err
	}
	if launch != nil {
		return launch(name, args...)
	}
	command := exec.Command(name, args...)
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}

func resolveCodexFilePath(session *codexSession, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsRune(raw, '\x00') || session.cwd == "" {
		return "", errors.New("file path is invalid")
	}
	root, err := filepath.Abs(session.cwd)
	if err != nil {
		return "", errors.New("session working directory is invalid")
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", errors.New("session working directory is unavailable")
	}
	candidate := raw
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(root, candidate)
	}
	candidate, err = filepath.Abs(candidate)
	if err != nil {
		return "", errors.New("file path is invalid")
	}
	canonical := candidate
	if resolved, resolveErr := filepath.EvalSymlinks(candidate); resolveErr == nil {
		canonical = resolved
	} else if !os.IsNotExist(resolveErr) {
		return "", errors.New("file path is unavailable")
	} else {
		parent, parentErr := filepath.EvalSymlinks(filepath.Dir(candidate))
		if parentErr != nil {
			return "", errors.New("file parent directory is unavailable")
		}
		canonical = filepath.Join(parent, filepath.Base(candidate))
	}
	relative, err := filepath.Rel(root, canonical)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("file path is outside the session workspace")
	}
	return canonical, nil
}

func (s *Server) revealCodexFile(w http.ResponseWriter, r *http.Request) {
	if !authorizeAccountAgentExecution(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	var request struct {
		SessionID string `json:"sessionId"`
		Path      string `json:"path"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || ensureJSONEOF(decoder) != nil || request.SessionID == "" || request.Path == "" {
		http.Error(w, "sessionId and path are required", http.StatusBadRequest)
		return
	}
	session, ok := s.findCodexForScope(requestAgentScope(r), request.SessionID)
	if !ok {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	path, err := resolveCodexFilePath(session, request.Path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := revealFileInManager(path, s.fileManagerLauncher); err != nil {
		http.Error(w, "failed to open native file manager", http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]string{"path": path})
}
