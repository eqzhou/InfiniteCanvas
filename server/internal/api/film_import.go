package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	defaultFilmImportBytes = int64(50 << 20)
	maxFilmImportBytes     = int64(100 << 20)
	maxFilmJSONImportBytes = int64(4 << 20)
	maxFilmDOCXEntries     = 2_048
	maxFilmDOCXExpanded    = int64(64 << 20)
)

var (
	errFilmPDFNeedsOCR = errors.New("PDF has no usable text layer; run OCR first and import the OCR result")
	errFilmImportBusy  = errors.New("film import concurrency or rate limit reached")
)

type filmImportJSONRequest struct {
	Revision      int    `json:"revision"`
	Text          string `json:"text,omitempty"`
	Format        string `json:"format,omitempty"`
	OriginalName  string `json:"originalName,omitempty"`
	MIMEType      string `json:"mimeType,omitempty"`
	ContentBase64 string `json:"contentBase64,omitempty"`
}

type filmImportPayload struct {
	revision int
	name     string
	mimeType string
	format   string
	data     []byte
}

func filmImportByteLimit() int64 {
	raw := strings.TrimSpace(os.Getenv("OPENBOARD_FILM_IMPORT_MAX_BYTES"))
	if raw == "" {
		return defaultFilmImportBytes
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1<<20 || value > maxFilmImportBytes {
		return defaultFilmImportBytes
	}
	return value
}

func cleanFilmImportName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 255 || strings.ContainsAny(value, "\x00\r\n/\\") || filepath.Base(value) != value {
		return "", errors.New("import filename is invalid")
	}
	return value, nil
}

func normalizedFilmImportMIME(value string) (string, error) {
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(value))
	if err != nil || mediaType == "" {
		return "", errors.New("import MIME type is invalid")
	}
	return strings.ToLower(mediaType), nil
}

func extractFilmImport(filename, mimeType string, data []byte, limit int64) (string, string, error) {
	name, mediaType, format, err := validateFilmImportMetadata(filename, mimeType, data, limit)
	if err != nil {
		return "", "", err
	}
	switch format {
	case "txt":
		text, err := extractFilmPlainText(data)
		return text, format, err
	case "markdown":
		text, err := extractFilmPlainText(data)
		return text, format, err
	case "docx":
		text, err := extractFilmDOCX(data, limit)
		return text, format, err
	case "pdf":
		return "", format, errors.New("PDF extraction requires the server sandbox")
	default:
		return "", "", fmt.Errorf("validated manuscript %q (%s) has unsupported format", name, mediaType)
	}
}

func validateFilmImportMetadata(filename, mimeType string, data []byte, limit int64) (string, string, string, error) {
	name, err := cleanFilmImportName(filename)
	if err != nil {
		return "", "", "", err
	}
	if limit < 1 || int64(len(data)) > limit {
		return "", "", "", errors.New("manuscript import exceeds its configured size limit")
	}
	mediaType, err := normalizedFilmImportMIME(mimeType)
	if err != nil {
		return "", "", "", err
	}
	extension := strings.ToLower(filepath.Ext(name))
	switch extension {
	case ".txt":
		if mediaType != "text/plain" && mediaType != "application/octet-stream" {
			return "", "", "", errors.New("TXT extension and MIME type do not match")
		}
		return name, mediaType, "txt", nil
	case ".md", ".markdown":
		if mediaType != "text/markdown" && mediaType != "text/x-markdown" && mediaType != "text/plain" && mediaType != "application/octet-stream" {
			return "", "", "", errors.New("Markdown extension and MIME type do not match")
		}
		return name, mediaType, "markdown", nil
	case ".docx":
		if mediaType != "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
			return "", "", "", errors.New("DOCX extension and MIME type do not match")
		}
		return name, mediaType, "docx", nil
	case ".pdf":
		if mediaType != "application/pdf" {
			return "", "", "", errors.New("PDF extension and MIME type do not match")
		}
		if err := validateFilmPDFEnvelope(data, limit); err != nil {
			return "", "", "", err
		}
		return name, mediaType, "pdf", nil
	default:
		return "", "", "", errors.New("manuscript extension must be .txt, .md, .markdown, .docx, or .pdf")
	}
}

func (s *Server) extractFilmImport(ctx context.Context, filename, mimeType string, data []byte, limit int64) (string, string, error) {
	_, _, format, err := validateFilmImportMetadata(filename, mimeType, data, limit)
	if err != nil {
		return "", "", err
	}
	if format != "pdf" {
		return extractFilmImport(filename, mimeType, data, limit)
	}
	config, err := s.filmPDFTextCapability()
	if err != nil {
		return "", "", err
	}
	text, err := extractFilmPDFWithRunner(ctx, data, limit, config, s.filmPDFTextRunner)
	return text, format, err
}

func extractFilmPlainText(data []byte) (string, error) {
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	if len(data) == 0 || len(data) > maxFilmSourceBytes || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return "", errors.New("manuscript text is empty, binary, invalid UTF-8, or exceeds the extracted-text limit")
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return "", errors.New("manuscript text is empty")
	}
	return text, nil
}

func safeFilmZipName(name string) bool {
	return name != "" && len(name) <= 512 && !strings.ContainsAny(name, "\x00\\") && !strings.HasPrefix(name, "/") && path.Clean(name) == name && name != "." && name != ".." && !strings.HasPrefix(name, "../")
}

func extractFilmDOCX(data []byte, limit int64) (string, error) {
	if len(data) < 4 || !(bytes.Equal(data[:4], []byte{'P', 'K', 3, 4}) || bytes.Equal(data[:4], []byte{'P', 'K', 5, 6}) || bytes.Equal(data[:4], []byte{'P', 'K', 7, 8})) {
		return "", errors.New("DOCX ZIP signature is invalid")
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || len(reader.File) == 0 || len(reader.File) > maxFilmDOCXEntries {
		return "", errors.New("DOCX archive is invalid or contains too many entries")
	}
	expandedLimit := maxFilmDOCXExpanded
	if limit < expandedLimit {
		expandedLimit = limit
	}
	var total uint64
	entries := make(map[string]struct{}, len(reader.File))
	var document, contentTypes *zip.File
	for _, entry := range reader.File {
		if !safeFilmZipName(entry.Name) || entry.FileInfo().IsDir() && !strings.HasSuffix(entry.Name, "/") {
			return "", errors.New("DOCX archive contains an unsafe entry path")
		}
		if _, duplicate := entries[entry.Name]; duplicate {
			return "", errors.New("DOCX archive contains duplicate entries")
		}
		entries[entry.Name] = struct{}{}
		total += entry.UncompressedSize64
		if entry.UncompressedSize64 > uint64(expandedLimit) || total > uint64(expandedLimit) {
			return "", errors.New("DOCX archive expands beyond its safety limit")
		}
		if entry.UncompressedSize64 > 1<<20 && entry.CompressedSize64 > 0 && entry.UncompressedSize64/entry.CompressedSize64 > 200 {
			return "", errors.New("DOCX archive compression ratio is unsafe")
		}
		if entry.Name == "word/document.xml" {
			document = entry
		} else if entry.Name == "[Content_Types].xml" {
			contentTypes = entry
		}
	}
	if document == nil || contentTypes == nil {
		return "", errors.New("DOCX is missing required OOXML parts")
	}
	if err := validateFilmDOCXContentTypes(contentTypes); err != nil {
		return "", err
	}
	stream, err := document.Open()
	if err != nil {
		return "", errors.New("DOCX document XML cannot be opened")
	}
	defer stream.Close()
	decoder := xml.NewDecoder(io.LimitReader(stream, expandedLimit+1))
	decoder.Strict = true
	var output strings.Builder
	inText := false
	for {
		token, tokenErr := decoder.Token()
		if errors.Is(tokenErr, io.EOF) {
			break
		}
		if tokenErr != nil {
			return "", errors.New("DOCX document XML is invalid")
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "t":
				inText = true
			case "tab":
				output.WriteByte('\t')
			case "br", "cr":
				output.WriteByte('\n')
			}
		case xml.EndElement:
			if value.Name.Local == "t" {
				inText = false
			}
			if value.Name.Local == "p" && output.Len() > 0 {
				output.WriteByte('\n')
			}
		case xml.CharData:
			if inText {
				output.Write(value)
			}
		}
		if output.Len() > maxFilmSourceBytes {
			return "", errors.New("DOCX extracted text exceeds its limit")
		}
	}
	return extractFilmPlainText([]byte(output.String()))
}

func validateFilmDOCXContentTypes(entry *zip.File) error {
	if entry.UncompressedSize64 > 1<<20 {
		return errors.New("DOCX content types metadata exceeds its limit")
	}
	stream, err := entry.Open()
	if err != nil {
		return errors.New("DOCX content types metadata cannot be opened")
	}
	defer stream.Close()
	decoder := xml.NewDecoder(io.LimitReader(stream, (1<<20)+1))
	decoder.Strict = true
	found := false
	for {
		token, tokenErr := decoder.Token()
		if errors.Is(tokenErr, io.EOF) {
			break
		}
		if tokenErr != nil {
			return errors.New("DOCX content types metadata is invalid")
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "Override" {
			continue
		}
		partName, contentType := "", ""
		for _, attribute := range start.Attr {
			switch attribute.Name.Local {
			case "PartName":
				partName = attribute.Value
			case "ContentType":
				contentType = attribute.Value
			}
		}
		if partName == "/word/document.xml" && contentType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" {
			found = true
		}
	}
	if !found {
		return errors.New("DOCX content types do not declare the main document")
	}
	return nil
}

func usableFilmPDFText(value string) bool {
	if len([]rune(strings.TrimSpace(value))) < 4 {
		return false
	}
	printable, total := 0, 0
	for _, character := range value {
		total++
		if unicode.IsPrint(character) || unicode.IsSpace(character) {
			printable++
		}
	}
	return total > 0 && printable*10 >= total*8
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func decodeFilmImportPayload(w http.ResponseWriter, r *http.Request, limit int64) (filmImportPayload, error) {
	contentType := strings.TrimSpace(r.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = "application/json"
	}
	mediaType, parameters, err := mime.ParseMediaType(contentType)
	if err != nil {
		return filmImportPayload{}, errors.New("import Content-Type is invalid")
	}
	if strings.HasPrefix(strings.ToLower(mediaType), "multipart/") {
		boundary := parameters["boundary"]
		if boundary == "" || len(boundary) > 200 {
			return filmImportPayload{}, errors.New("multipart boundary is invalid")
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit+(1<<20))
		reader := multipart.NewReader(r.Body, boundary)
		payload := filmImportPayload{revision: -1}
		reachedEOF := false
		for count := 0; count < 8; count++ {
			part, partErr := reader.NextPart()
			if errors.Is(partErr, io.EOF) {
				reachedEOF = true
				break
			}
			if partErr != nil {
				return filmImportPayload{}, errors.New("multipart import is invalid or exceeds its limit")
			}
			name := part.FormName()
			switch name {
			case "revision":
				value, readErr := io.ReadAll(io.LimitReader(part, 32))
				if readErr != nil || payload.revision >= 0 {
					return filmImportPayload{}, errors.New("multipart revision is invalid")
				}
				payload.revision, readErr = strconv.Atoi(strings.TrimSpace(string(value)))
				if readErr != nil {
					return filmImportPayload{}, errors.New("multipart revision is invalid")
				}
			case "file":
				if payload.data != nil {
					return filmImportPayload{}, errors.New("multipart import must contain one file")
				}
				payload.name = part.FileName()
				payload.mimeType = part.Header.Get("Content-Type")
				payload.data, partErr = io.ReadAll(io.LimitReader(part, limit+1))
				if partErr != nil || int64(len(payload.data)) > limit {
					return filmImportPayload{}, errors.New("multipart file exceeds its configured size limit")
				}
			case "format":
				value, readErr := io.ReadAll(io.LimitReader(part, 32))
				if readErr != nil || payload.format != "" {
					return filmImportPayload{}, errors.New("multipart format is invalid")
				}
				payload.format = strings.ToLower(strings.TrimSpace(string(value)))
				if payload.format == "md" {
					payload.format = "markdown"
				}
				if payload.format != "txt" && payload.format != "text" && payload.format != "markdown" && payload.format != "docx" && payload.format != "pdf" {
					return filmImportPayload{}, errors.New("multipart format is invalid")
				}
			default:
				return filmImportPayload{}, errors.New("multipart import contains an unknown field")
			}
			_ = part.Close()
		}
		if !reachedEOF {
			if err := requireMultipartEOF(reader); err != nil {
				return filmImportPayload{}, errors.New("multipart import contains too many parts")
			}
		}
		if payload.revision < 0 || payload.data == nil {
			return filmImportPayload{}, errors.New("multipart import requires revision and file")
		}
		return payload, nil
	}
	if strings.ToLower(mediaType) != "application/json" {
		return filmImportPayload{}, errors.New("import must use application/json or multipart/form-data")
	}
	jsonLimit := limit
	if jsonLimit > maxFilmJSONImportBytes {
		jsonLimit = maxFilmJSONImportBytes
	}
	bodyLimit := jsonLimit*4/3 + (256 << 10)
	r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input filmImportJSONRequest
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil || input.Revision < 0 || (input.Text == "") == (input.ContentBase64 == "") {
		return filmImportPayload{}, errors.New("JSON import is invalid or exceeds its limit")
	}
	payload := filmImportPayload{revision: input.Revision, name: input.OriginalName, mimeType: input.MIMEType, format: strings.ToLower(strings.TrimSpace(input.Format))}
	if input.ContentBase64 != "" {
		decodedLen := base64.StdEncoding.DecodedLen(len(input.ContentBase64))
		if int64(decodedLen) > jsonLimit {
			return filmImportPayload{}, errors.New("JSON import exceeds its configured size limit")
		}
		payload.data = make([]byte, decodedLen)
		count, decodeErr := base64.StdEncoding.Decode(payload.data, []byte(input.ContentBase64))
		if decodeErr != nil {
			return filmImportPayload{}, errors.New("contentBase64 is invalid")
		}
		payload.data = payload.data[:count]
	} else {
		if int64(len(input.Text)) > jsonLimit {
			return filmImportPayload{}, errors.New("JSON import exceeds its configured size limit")
		}
		payload.data = []byte(input.Text)
		format := strings.ToLower(strings.TrimSpace(input.Format))
		if format == "md" {
			format = "markdown"
		}
		if payload.name == "" {
			if format == "markdown" {
				payload.name = "manuscript.md"
			} else {
				payload.name = "manuscript.txt"
			}
		}
		if payload.mimeType == "" {
			if format == "markdown" {
				payload.mimeType = "text/markdown"
			} else {
				payload.mimeType = "text/plain"
			}
		}
	}
	return payload, nil
}

func requireMultipartEOF(reader *multipart.Reader) error {
	part, err := reader.NextPart()
	if errors.Is(err, io.EOF) {
		return nil
	}
	if part != nil {
		_ = part.Close()
	}
	if err != nil {
		return err
	}
	return errors.New("multipart data exceeds its part limit")
}

func (s *Server) importFilmSource(w http.ResponseWriter, r *http.Request) {
	release, gateErr := s.acquireFilmImport(r.Context(), tenantIDFrom(r))
	if gateErr != nil {
		writeFilmError(w, http.StatusTooManyRequests, "film_import_busy", "Film import concurrency or rate limit reached; retry later")
		return
	}
	defer release()
	limit := filmImportByteLimit()
	payload, err := decodeFilmImportPayload(w, r, limit)
	if err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_import", err.Error())
		return
	}
	name, _, format, err := validateFilmImportMetadata(payload.name, payload.mimeType, payload.data, limit)
	if err != nil {
		writeFilmError(w, http.StatusUnprocessableEntity, "import_rejected", err.Error())
		return
	}
	if payload.format != "" && payload.format != format && !(payload.format == "text" && format == "txt") {
		writeFilmError(w, http.StatusBadRequest, "invalid_import", "declared import format does not match the validated file")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	importStatus := filmSourceImportStatus{
		ID: "import-" + randomGenerationOwner(), Status: filmStatusRunning, Format: format, OriginalName: name,
		WorkerInstanceID: s.filmImportWorkerID, StartedAt: now, UpdatedAt: now,
	}
	_, startedDocument, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		if document.Source.Revision != payload.revision {
			return filmDocument{}, errors.New("source revision conflict")
		}
		if current := document.Source.ImportStatus; current != nil && current.Status == filmStatusRunning && current.WorkerInstanceID == s.filmImportWorkerID {
			return filmDocument{}, errors.New("source import is already running")
		}
		document.Source.ImportStatus = &importStatus
		return document, nil
	})
	if !ok {
		return
	}
	text, parsedFormat, err := s.extractFilmImport(r.Context(), name, payload.mimeType, payload.data, limit)
	if err != nil {
		s.persistFilmImportFailure(r.Context(), tenantIDFrom(r), chi.URLParam(r, "projectId"), importStatus, err.Error())
		code := "import_rejected"
		statusCode := http.StatusUnprocessableEntity
		if errors.Is(err, errFilmPDFNeedsOCR) {
			code = "pdf_ocr_required"
		}
		if errors.Is(err, errFilmPDFToolUnavailable) {
			code, statusCode = "pdf_tool_unavailable", http.StatusServiceUnavailable
		}
		writeFilmError(w, statusCode, code, err.Error())
		return
	}
	if parsedFormat != format {
		s.persistFilmImportFailure(r.Context(), tenantIDFrom(r), chi.URLParam(r, "projectId"), importStatus, "validated import format changed during parsing")
		writeFilmError(w, http.StatusInternalServerError, "import_state_invalid", "validated import format changed during parsing")
		return
	}
	preflight := cloneFilmDocument(startedDocument)
	preflight.Source.Format = parsedFormat
	preflight.Source.OriginalName = name
	if _, err := decomposeFilmSource(preflight, text); err != nil {
		s.persistFilmImportFailure(r.Context(), tenantIDFrom(r), chi.URLParam(r, "projectId"), importStatus, err.Error())
		writeFilmOperationError(w, err)
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		if document.Source.Revision != payload.revision {
			return filmDocument{}, errors.New("source revision conflict")
		}
		if document.Source.ImportStatus == nil || document.Source.ImportStatus.ID != importStatus.ID || document.Source.ImportStatus.Status != filmStatusRunning {
			return filmDocument{}, errors.New("source import status changed before parsing completed")
		}
		document.Source.Format = parsedFormat
		document.Source.OriginalName = name
		next, decomposeErr := decomposeFilmSource(document, text)
		if decomposeErr != nil {
			return filmDocument{}, decomposeErr
		}
		completedAt := time.Now().UTC().Format(time.RFC3339Nano)
		next.Source.ImportStatus = &filmSourceImportStatus{
			ID: importStatus.ID, Status: "succeeded", Format: parsedFormat, OriginalName: name,
			StartedAt: importStatus.StartedAt, UpdatedAt: completedAt, CompletedAt: completedAt,
		}
		return next, nil
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
		return
	}
	s.persistFilmImportFailure(r.Context(), tenantIDFrom(r), chi.URLParam(r, "projectId"), importStatus, "source import could not be committed; retry with the latest source revision")
}

func (s *Server) persistFilmImportFailure(ctx context.Context, tenantID, projectID string, importStatus filmSourceImportStatus, message string) {
	backend, ok := s.store.(store.FilmStore)
	if !ok {
		return
	}
	// Parsing commonly ends because the HTTP request was canceled or timed out.
	// Persist the terminal state with a short-lived detached context so a
	// database-backed store does not leave the import permanently "running".
	persistContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	completedAt := time.Now().UTC().Format(time.RFC3339Nano)
	for attempt := 0; attempt < 3; attempt++ {
		record, err := backend.GetFilmProject(persistContext, tenantID, projectID)
		if err != nil {
			return
		}
		document, err := decodeFilmDocument(record.Document)
		if err != nil || document.Source.ImportStatus == nil || document.Source.ImportStatus.ID != importStatus.ID || document.Source.ImportStatus.Status != filmStatusRunning {
			return
		}
		document.Source.ImportStatus = &filmSourceImportStatus{
			ID: importStatus.ID, Status: filmStatusFailed, Format: importStatus.Format, OriginalName: importStatus.OriginalName,
			StartedAt: importStatus.StartedAt, UpdatedAt: completedAt, CompletedAt: completedAt, Error: truncateRunes(message, 2_000),
		}
		document.Revision++
		document.UpdatedAt = completedAt
		if validateFilmAggregateLimits(document) != nil {
			return
		}
		raw, err := json.Marshal(document)
		if err != nil || len(raw) > maxProjectBytes {
			return
		}
		if _, err = backend.CompareAndSwapFilmProject(persistContext, tenantID, projectID, record.Revision, raw); err == nil {
			return
		} else if !errors.Is(err, store.ErrConflict) {
			return
		}
	}
}

func (s *Server) getFilmImportStatus(w http.ResponseWriter, r *http.Request) {
	_, _, document, ok := s.loadFilmProduction(w, r, false)
	if !ok {
		return
	}
	status := document.Source.ImportStatus
	if status != nil && status.Status == filmStatusRunning && status.WorkerInstanceID != s.filmImportWorkerID {
		completedAt := time.Now().UTC().Format(time.RFC3339Nano)
		_, updated, saved := s.mutateFilmProduction(w, r, func(current filmDocument) (filmDocument, error) {
			active := current.Source.ImportStatus
			if active == nil || active.ID != status.ID || active.Status != filmStatusRunning {
				return current, nil
			}
			current.Source.ImportStatus = &filmSourceImportStatus{
				ID: active.ID, Status: filmStatusFailed, Format: active.Format, OriginalName: active.OriginalName,
				StartedAt: active.StartedAt, UpdatedAt: completedAt, CompletedAt: completedAt,
				Error: "PDF or document parsing was interrupted by a server restart; retry the import",
			}
			return current, nil
		})
		if !saved {
			return
		}
		status = updated.Source.ImportStatus
	}
	if status == nil {
		writeJSON(w, map[string]any{"data": filmSourceImportStatus{Status: "idle"}})
		return
	}
	response := *status
	response.WorkerInstanceID = ""
	writeJSON(w, map[string]any{"data": response})
}
