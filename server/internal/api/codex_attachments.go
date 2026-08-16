package api

import (
	"bytes"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
)

var codexImageExtensions = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

func (s *Server) uploadCodexAttachments(w http.ResponseWriter, r *http.Request) {
	if !authorizeAccountAgentExecution(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxCodexAttachmentBytes+(1<<20))
	if err := r.ParseMultipartForm(maxCodexAttachmentBytes + (1 << 20)); err != nil {
		http.Error(w, "invalid or oversized Codex attachments", http.StatusBadRequest)
		return
	}
	sessionID := strings.TrimSpace(r.FormValue("sessionId"))
	session, ok := s.findCodexForScope(requestAgentScope(r), sessionID)
	if !ok {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		files = r.MultipartForm.File["file"]
	}
	if len(files) == 0 || len(files) > 10 {
		http.Error(w, "between 1 and 10 image attachments are required", http.StatusBadRequest)
		return
	}
	directory := filepath.Join(s.dataDir, "codex-attachments", session.id)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		http.Error(w, "failed to prepare Codex attachment storage", http.StatusInternalServerError)
		return
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		http.Error(w, "failed to secure Codex attachment storage", http.StatusInternalServerError)
		return
	}
	created := make([]codexAttachment, 0, len(files))
	var total int64
	for _, header := range files {
		attachment, err := storeCodexAttachment(directory, header)
		if err != nil {
			removeCodexAttachments(created)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		total += attachment.Bytes
		if total > maxCodexAttachmentBytes {
			created = append(created, attachment)
			removeCodexAttachments(created)
			http.Error(w, "Codex attachments exceed the 30MB limit", http.StatusBadRequest)
			return
		}
		created = append(created, attachment)
	}
	session.mu.Lock()
	var pendingBytes int64
	for _, attachment := range session.pendingAttachments {
		pendingBytes += attachment.Bytes
	}
	if session.closed || pendingBytes+total > maxCodexAttachmentBytes {
		session.mu.Unlock()
		removeCodexAttachments(created)
		http.Error(w, "Codex pending attachment limit exceeded", http.StatusConflict)
		return
	}
	for _, attachment := range created {
		session.pendingAttachments[attachment.ID] = attachment
	}
	session.mu.Unlock()
	writeJSON(w, map[string]any{"attachments": created})
}

func storeCodexAttachment(directory string, header *multipart.FileHeader) (codexAttachment, error) {
	input, err := header.Open()
	if err != nil {
		return codexAttachment{}, errors.New("failed to read Codex attachment")
	}
	defer input.Close()
	buffer := make([]byte, 512)
	n, err := io.ReadFull(input, buffer)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return codexAttachment{}, errors.New("failed to inspect Codex attachment")
	}
	buffer = buffer[:n]
	mimeType := http.DetectContentType(buffer)
	extension, allowed := codexImageExtensions[mimeType]
	if !allowed {
		return codexAttachment{}, errors.New("Codex attachments must be PNG, JPEG, GIF, or WebP images")
	}
	id := randomID("image")
	path := filepath.Join(directory, id+extension)
	output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return codexAttachment{}, errors.New("failed to store Codex attachment")
	}
	written, copyErr := io.Copy(output, io.MultiReader(bytes.NewReader(buffer), io.LimitReader(input, maxCodexAttachmentBytes+1)))
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil || written <= 0 || written > maxCodexAttachmentBytes {
		_ = os.Remove(path)
		return codexAttachment{}, errors.New("Codex attachment is empty or too large")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = os.Remove(path)
		return codexAttachment{}, errors.New("failed to secure Codex attachment")
	}
	name := filepath.Base(header.Filename)
	if name == "." || name == "" {
		name = "image" + extension
	}
	return codexAttachment{ID: id, Name: name, MimeType: mimeType, Bytes: written, Path: path}, nil
}

func removeCodexAttachments(attachments []codexAttachment) {
	directories := make(map[string]struct{})
	for _, attachment := range attachments {
		if attachment.Path == "" {
			continue
		}
		_ = os.Remove(attachment.Path)
		directories[filepath.Dir(attachment.Path)] = struct{}{}
	}
	for directory := range directories {
		_ = os.Remove(directory)
		_ = os.Remove(filepath.Dir(directory))
	}
}

func (s *Server) deleteCodexAttachment(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSpace(r.URL.Query().Get("sessionId"))
	attachmentID := chi.URLParam(r, "id")
	if !projectIDPattern.MatchString(sessionID) || !projectIDPattern.MatchString(attachmentID) {
		http.Error(w, "valid sessionId and attachment ID are required", http.StatusBadRequest)
		return
	}
	session, ok := s.findCodexForScope(requestAgentScope(r), sessionID)
	if !ok {
		http.Error(w, "codex session not found", http.StatusNotFound)
		return
	}
	session.mu.Lock()
	attachment, ok := session.pendingAttachments[attachmentID]
	if ok {
		delete(session.pendingAttachments, attachmentID)
	}
	session.mu.Unlock()
	if !ok {
		http.Error(w, "pending Codex attachment not found", http.StatusNotFound)
		return
	}
	removeCodexAttachments([]codexAttachment{attachment})
	w.WriteHeader(http.StatusNoContent)
}

func purgeCodexAttachmentRoot(dataDir string) {
	_ = os.RemoveAll(filepath.Join(dataDir, "codex-attachments"))
}
