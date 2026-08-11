package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func makeMinimalFilmPDF(t *testing.T, dictionary string, stream []byte) []byte {
	t.Helper()
	objects := []string{
		`<< /Type /Catalog /Pages 2 0 R >>`,
		`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
		`<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>`,
		fmt.Sprintf("<< /Length %d %s >>\nstream\n%s\nendstream", len(stream), dictionary, stream),
	}
	var output bytes.Buffer
	output.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects)+1)
	for index, object := range objects {
		offsets[index+1] = output.Len()
		fmt.Fprintf(&output, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	xref := output.Len()
	fmt.Fprintf(&output, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for index := 1; index < len(offsets); index++ {
		fmt.Fprintf(&output, "%010d 00000 n \n", offsets[index])
	}
	fmt.Fprintf(&output, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	return output.Bytes()
}

func makeFilmDOCX(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for name, content := range entries {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestExtractFilmImportDOCXReadsOnlyDocumentXML(t *testing.T) {
	payload := makeFilmDOCX(t, map[string]string{
		"[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"word/document.xml":   `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>INT. SAFE ROOM - DAY</w:t></w:r></w:p><w:p><w:r><w:t>A lamp turns on.</w:t></w:r></w:p></w:body></w:document>`,
		"word/ignored.xml":    `<w:t>SECRET SHOULD NOT APPEAR</w:t>`,
	})

	text, format, err := extractFilmImport("script.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", payload, int64(len(payload)+1))
	if err != nil {
		t.Fatal(err)
	}
	if format != "docx" || !strings.Contains(text, "INT. SAFE ROOM - DAY") || strings.Contains(text, "SECRET") {
		t.Fatalf("unexpected DOCX extraction format=%q text=%q", format, text)
	}
}

func TestExtractFilmImportRejectsMaliciousDOCX(t *testing.T) {
	tests := []struct {
		name    string
		entries map[string]string
	}{
		{"path traversal", map[string]string{"../word/document.xml": `<w:t>escape</w:t>`, "word/document.xml": `<w:t>safe</w:t>`}},
		{"missing document", map[string]string{"word/other.xml": `<w:t>not the manuscript</w:t>`}},
		{"missing content types", map[string]string{"word/document.xml": `<w:t>not enough metadata</w:t>`}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := makeFilmDOCX(t, test.entries)
			if _, _, err := extractFilmImport("script.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", payload, 1<<20); err == nil {
				t.Fatal("malicious DOCX was accepted")
			}
		})
	}
}

func TestExtractFilmImportRejectsDuplicateDOCXEntries(t *testing.T) {
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, name := range []string{"[Content_Types].xml", "word/document.xml", "word/document.xml"} {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		content := `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>duplicate</w:t></w:r></w:p></w:body></w:document>`
		if name == "[Content_Types].xml" {
			content = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
		}
		_, _ = entry.Write([]byte(content))
	}
	_ = writer.Close()
	if _, _, err := extractFilmImport("duplicate.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", output.Bytes(), 1<<20); err == nil {
		t.Fatal("duplicate DOCX entry was accepted")
	}
}

func TestExtractFilmImportPDFRequiresUsableTextLayer(t *testing.T) {
	textPDF := makeMinimalFilmPDF(t, "", []byte("BT /F1 12 Tf 72 720 Td (INT. LAB - NIGHT) Tj 0 -20 Td (A monitor glows.) Tj ET"))
	runner := func(_ context.Context, executable string, arguments []string, stdout, _ io.Writer) error {
		if executable != "/opt/poppler/bin/pdftotext" {
			t.Fatalf("executable = %q", executable)
		}
		if len(arguments) != 6 || arguments[0] != "-layout" || arguments[1] != "-enc" || arguments[2] != "UTF-8" || arguments[3] != "-nopgbrk" || arguments[5] != "-" || !filepath.IsAbs(arguments[4]) {
			t.Fatalf("unsafe or unexpected pdftotext arguments: %#v", arguments)
		}
		if _, err := os.Stat(arguments[4]); err != nil {
			t.Fatalf("temporary PDF is unavailable to extractor: %v", err)
		}
		_, _ = io.WriteString(stdout, "EPISODE 1\nINT. LAB - NIGHT\nA monitor glows.\n")
		return nil
	}
	config := filmPDFTextConfig{Executable: "/opt/poppler/bin/pdftotext", TempRoot: t.TempDir(), Timeout: time.Second, OutputLimit: maxFilmSourceBytes}
	text, err := extractFilmPDFWithRunner(context.Background(), textPDF, 1<<20, config, runner)
	if err != nil || !strings.Contains(text, "A monitor glows.") {
		t.Fatalf("text PDF extraction text=%q err=%v", text, err)
	}
	if !strings.Contains(text, "EPISODE 1\nINT. LAB - NIGHT") {
		t.Fatalf("PDF extraction flattened structural newlines: %q", text)
	}

	imageOnly := makeMinimalFilmPDF(t, "", []byte("q 1 0 0 1 0 0 cm /Im1 Do Q"))
	emptyRunner := func(_ context.Context, _ string, _ []string, _, _ io.Writer) error { return nil }
	if _, err := extractFilmPDFWithRunner(context.Background(), imageOnly, 1<<20, config, emptyRunner); err == nil || !strings.Contains(strings.ToLower(err.Error()), "ocr") {
		t.Fatalf("image-only PDF error=%v, want OCR guidance", err)
	}
}

func TestExtractFilmPDFRunsThroughConfiguredSandboxWrapper(t *testing.T) {
	pdf := makeMinimalFilmPDF(t, "", []byte("BT (text) Tj ET"))
	config := filmPDFTextConfig{
		Executable: "/usr/bin/pdftotext", SandboxExecutable: "/usr/local/bin/openboard-pdf-sandbox",
		TempRoot: t.TempDir(), Timeout: time.Second, OutputLimit: maxFilmSourceBytes,
	}
	runner := func(_ context.Context, executable string, arguments []string, stdout, _ io.Writer) error {
		if executable != config.SandboxExecutable || len(arguments) != 7 || arguments[0] != config.Executable {
			t.Fatalf("sandbox invocation executable=%q arguments=%#v", executable, arguments)
		}
		_, _ = io.WriteString(stdout, "INT. SAFE ROOM - DAY\nThe parser is isolated.")
		return nil
	}
	if _, err := extractFilmPDFWithRunner(context.Background(), pdf, 1<<20, config, runner); err != nil {
		t.Fatal(err)
	}
}

func TestExtractFilmPDFEnforcesTimeoutAndOutputLimit(t *testing.T) {
	pdf := makeMinimalFilmPDF(t, "", []byte("BT (text) Tj ET"))
	config := filmPDFTextConfig{Executable: "/opt/poppler/bin/pdftotext", TempRoot: t.TempDir(), Timeout: 10 * time.Millisecond, OutputLimit: 32}
	timedOut := func(ctx context.Context, _ string, _ []string, _, _ io.Writer) error {
		<-ctx.Done()
		return ctx.Err()
	}
	if _, err := extractFilmPDFWithRunner(context.Background(), pdf, 1<<20, config, timedOut); err == nil || !strings.Contains(strings.ToLower(err.Error()), "timed out") {
		t.Fatalf("timeout error = %v", err)
	}
	overflow := func(_ context.Context, _ string, _ []string, stdout, _ io.Writer) error {
		_, err := stdout.Write(bytes.Repeat([]byte("x"), 64))
		return err
	}
	if _, err := extractFilmPDFWithRunner(context.Background(), pdf, 1<<20, config, overflow); err == nil || !strings.Contains(strings.ToLower(err.Error()), "limit") {
		t.Fatalf("output limit error = %v", err)
	}
}

func TestResolveFilmPDFTextConfigDiagnosesMissingOrRelativeTool(t *testing.T) {
	t.Setenv("OPENBOARD_PDFTOTEXT_PATH", "pdftotext")
	if _, err := resolveFilmPDFTextConfig(t.TempDir()); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("relative tool path error = %v", err)
	}
	t.Setenv("OPENBOARD_PDFTOTEXT_PATH", filepath.Join(t.TempDir(), "missing-pdftotext"))
	if _, err := resolveFilmPDFTextConfig(t.TempDir()); err == nil || !strings.Contains(strings.ToLower(err.Error()), "unavailable") {
		t.Fatalf("missing tool error = %v", err)
	}
}

func TestResolveFilmPDFTextConfigRequiresSandboxOutsideTestMode(t *testing.T) {
	toolPath := filepath.Join(t.TempDir(), "pdftotext")
	if err := os.WriteFile(toolPath, []byte("test executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	t.Setenv("OPENBOARD_PDFTOTEXT_PATH", toolPath)
	t.Setenv("OPENBOARD_PDF_SANDBOX_PATH", "")
	if _, err := resolveFilmPDFTextConfig(t.TempDir()); err == nil || !strings.Contains(strings.ToLower(err.Error()), "sandbox") {
		t.Fatalf("production PDF parser without sandbox error = %v", err)
	}
}

func TestExecFilmPDFTextRunnerDoesNotInheritServiceSecrets(t *testing.T) {
	scriptPath := filepath.Join(t.TempDir(), "show-environment")
	if err := os.WriteFile(scriptPath, []byte("#!/bin/sh\nenv\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_MASTER_KEY", "must-not-reach-parser")
	var output bytes.Buffer
	if err := (execFilmPDFTextRunner{}).Run(context.Background(), scriptPath, nil, &output, io.Discard); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "OPENBOARD_MASTER_KEY") || strings.Contains(output.String(), "must-not-reach-parser") {
		t.Fatalf("service secret leaked into parser environment: %q", output.String())
	}
}

func TestExtractFilmImportRejectsExtensionMIMEAndSignatureMismatch(t *testing.T) {
	tests := []struct {
		name, filename, mimeType string
		data                     []byte
	}{
		{"docx signature", "script.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", []byte("not-a-zip")},
		{"pdf signature", "script.pdf", "application/pdf", []byte("not-a-pdf")},
		{"mime mismatch", "script.pdf", "text/plain", []byte("%PDF-1.4\n%%EOF")},
		{"extension mismatch", "script.exe", "text/plain", []byte("safe text")},
		{"binary text", "script.txt", "text/plain", []byte{'a', 0, 'b'}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := extractFilmImport(test.filename, test.mimeType, test.data, 1<<20); err == nil {
				t.Fatal("mismatched import was accepted")
			}
		})
	}
}

func TestFilmImportSupportsBoundedJSONAndMultipart(t *testing.T) {
	server, _, handler := filmAPIServerHandler(t)
	toolPath := filepath.Join(t.TempDir(), "pdftotext")
	if err := os.WriteFile(toolPath, []byte("test executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_PDFTOTEXT_PATH", toolPath)
	server.filmPDFTextRunner = func(_ context.Context, _ string, _ []string, stdout, _ io.Writer) error {
		_, _ = io.WriteString(stdout, "INT. VAULT - DAY\nA door opens.\n")
		return nil
	}

	pdf := makeMinimalFilmPDF(t, "", []byte("BT (INT. VAULT - DAY) Tj (A door opens.) Tj ET"))
	jsonBody, _ := json.Marshal(map[string]any{
		"revision": 0, "originalName": "vault.pdf", "mimeType": "application/pdf",
		"contentBase64": base64.StdEncoding.EncodeToString(pdf),
	})
	jsonResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/source/import", jsonBody)
	if jsonResponse.Code != http.StatusOK || decodeFilmResponse(t, jsonResponse).Source.Format != "pdf" {
		t.Fatalf("JSON PDF import: %d %s", jsonResponse.Code, jsonResponse.Body.String())
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("revision", "1"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("format", "markdown"); err != nil {
		t.Fatal(err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="next.md"`)
	header.Set("Content-Type", "text/markdown")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("INT. EDIT BAY - NIGHT\nThe cut locks."))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/film/projects/film-api/source/import", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK || decodeFilmResponse(t, recorder).Source.Format != "markdown" {
		t.Fatalf("multipart Markdown import: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestFilmImportStatusIsPersistedAndQueryableWhileParsing(t *testing.T) {
	server, _, handler := filmAPIServerHandler(t)
	toolPath := filepath.Join(t.TempDir(), "pdftotext")
	if err := os.WriteFile(toolPath, []byte("test executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_PDFTOTEXT_PATH", toolPath)
	started := make(chan struct{})
	release := make(chan struct{})
	server.filmPDFTextRunner = func(ctx context.Context, _ string, _ []string, stdout, _ io.Writer) error {
		close(started)
		select {
		case <-release:
			_, _ = io.WriteString(stdout, "EPISODE 1\nINT. EDIT BAY - NIGHT\nThe cut locks.\n")
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	pdf := makeMinimalFilmPDF(t, "", []byte("BT (placeholder) Tj ET"))
	body, contentType := makeFilmImportMultipart(t, 0, "script.pdf", "application/pdf", pdf)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/api/film/projects/film-api/source/import", bytes.NewReader(body))
		req.Header.Set("Content-Type", contentType)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		done <- recorder
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("PDF parser did not start")
	}
	statusResponse := request(t, handler, http.MethodGet, "/api/film/projects/film-api/source/import/status", nil)
	if statusResponse.Code != http.StatusOK {
		t.Fatalf("status response: %d %s", statusResponse.Code, statusResponse.Body.String())
	}
	var statusPayload struct {
		Data filmSourceImportStatus `json:"data"`
	}
	if err := json.Unmarshal(statusResponse.Body.Bytes(), &statusPayload); err != nil || statusPayload.Data.Status != filmStatusRunning || statusPayload.Data.OriginalName != "script.pdf" {
		t.Fatalf("running import status = %#v, err=%v", statusPayload.Data, err)
	}
	close(release)
	result := <-done
	if result.Code != http.StatusOK {
		t.Fatalf("import response: %d %s", result.Code, result.Body.String())
	}
	completed := request(t, handler, http.MethodGet, "/api/film/projects/film-api/source/import/status", nil)
	if err := json.Unmarshal(completed.Body.Bytes(), &statusPayload); err != nil || statusPayload.Data.Status != "succeeded" || statusPayload.Data.CompletedAt == "" {
		t.Fatalf("completed import status = %#v, err=%v", statusPayload.Data, err)
	}
}

func TestFilmImportCancellationPersistsFailureWithDetachedContext(t *testing.T) {
	server, memoryBackend, handler := filmAPIServerHandler(t)
	memoryBackend.requireLiveContext = true
	toolPath := filepath.Join(t.TempDir(), "pdftotext")
	if err := os.WriteFile(toolPath, []byte("test executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_PDFTOTEXT_PATH", toolPath)
	started := make(chan struct{})
	server.filmPDFTextRunner = func(ctx context.Context, _ string, _ []string, _, _ io.Writer) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	pdf := makeMinimalFilmPDF(t, "", []byte("BT (placeholder) Tj ET"))
	body, contentType := makeFilmImportMultipart(t, 0, "canceled.pdf", "application/pdf", pdf)
	requestContext, cancel := context.WithCancel(context.Background())
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/api/film/projects/film-api/source/import", bytes.NewReader(body)).WithContext(requestContext)
		req.Header.Set("Content-Type", contentType)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		done <- recorder
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("PDF parser did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("canceled import handler did not return")
	}
	status := request(t, handler, http.MethodGet, "/api/film/projects/film-api/source/import/status", nil)
	var payload struct {
		Data filmSourceImportStatus `json:"data"`
	}
	if err := json.Unmarshal(status.Body.Bytes(), &payload); err != nil || payload.Data.Status != filmStatusFailed || payload.Data.CompletedAt == "" {
		t.Fatalf("canceled import status = %#v, err=%v", payload.Data, err)
	}
}

func TestFilmImportStatusMarksInterruptedWorkerFailedAfterRestart(t *testing.T) {
	first, memoryBackend, _ := filmAPIServerHandler(t)
	backend := first.store.(store.FilmStore)
	record, err := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	if err != nil {
		t.Fatal(err)
	}
	document, err := decodeFilmDocument(record.Document)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	document.Source.ImportStatus = &filmSourceImportStatus{ID: "import-restart", Status: filmStatusRunning, OriginalName: "restart.pdf", Format: "pdf", WorkerInstanceID: "previous-process", StartedAt: now, UpdatedAt: now}
	raw, _ := json.Marshal(document)
	if _, err := backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, "film-api", record.Revision, raw); err != nil {
		t.Fatal(err)
	}
	restarted := NewServerWithStore(t.TempDir(), memoryBackend)
	t.Cleanup(restarted.Close)
	router := chi.NewRouter()
	MountServer(router, restarted)
	response := request(t, router, http.MethodGet, "/api/film/projects/film-api/source/import/status", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("restart status: %d %s", response.Code, response.Body.String())
	}
	var payload struct {
		Data filmSourceImportStatus `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || payload.Data.Status != filmStatusFailed || !strings.Contains(strings.ToLower(payload.Data.Error), "interrupted") {
		t.Fatalf("reconciled import status = %#v, err=%v", payload.Data, err)
	}
}

func TestFilmImportPersistsMissingPDFToolFailureAndCapabilityDiagnostic(t *testing.T) {
	server, _, handler := filmAPIServerHandler(t)
	missing := filepath.Join(t.TempDir(), "missing-pdftotext")
	t.Setenv("OPENBOARD_PDFTOTEXT_PATH", missing)
	pdf := makeMinimalFilmPDF(t, "", []byte("BT (placeholder) Tj ET"))
	body, contentType := makeFilmImportMultipart(t, 0, "missing-tool.pdf", "application/pdf", pdf)
	req := httptest.NewRequest(http.MethodPost, "/api/film/projects/film-api/source/import", bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "pdf_tool_unavailable") {
		t.Fatalf("missing tool response: %d %s", response.Code, response.Body.String())
	}
	status := request(t, handler, http.MethodGet, "/api/film/projects/film-api/source/import/status", nil)
	var payload struct {
		Data filmSourceImportStatus `json:"data"`
	}
	if err := json.Unmarshal(status.Body.Bytes(), &payload); err != nil || payload.Data.Status != filmStatusFailed || !strings.Contains(payload.Data.Error, "unavailable") {
		t.Fatalf("persisted missing-tool status = %#v, err=%v", payload.Data, err)
	}
	capabilities := server.filmCapabilityData(httptest.NewRequest(http.MethodGet, "/api/film/capabilities", nil))
	if capabilities["pdfImport"] != false || !strings.Contains(strings.ToLower(fmt.Sprint(capabilities["pdfDiagnostic"])), "unavailable") {
		t.Fatalf("PDF capability = %#v", capabilities)
	}
}

func TestFilmPDFCapabilityCachesSandboxSelfTest(t *testing.T) {
	directory := t.TempDir()
	toolPath := filepath.Join(directory, "pdftotext")
	if err := os.WriteFile(toolPath, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	countPath := filepath.Join(directory, "sandbox-count")
	sandboxPath := filepath.Join(directory, "pdf-sandbox")
	script := fmt.Sprintf("#!/bin/sh\nprintf x >> %q\nexit 0\n", countPath)
	if err := os.WriteFile(sandboxPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_PDFTOTEXT_PATH", toolPath)
	t.Setenv("OPENBOARD_PDF_SANDBOX_PATH", sandboxPath)
	server := NewServer(directory)
	defer server.Close()
	if _, err := server.filmPDFTextCapability(); err != nil {
		t.Fatal(err)
	}
	if _, err := server.filmPDFTextCapability(); err != nil {
		t.Fatal(err)
	}
	count, err := os.ReadFile(countPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(count) != "x" {
		t.Fatalf("sandbox self-test count = %q, want one invocation", count)
	}
}

func TestFilmPDFCapabilityRetriesCachedFailureAfterTTL(t *testing.T) {
	directory := t.TempDir()
	toolPath := filepath.Join(directory, "pdftotext")
	if err := os.WriteFile(toolPath, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(directory, "sandbox-ready")
	countPath := filepath.Join(directory, "sandbox-count")
	sandboxPath := filepath.Join(directory, "pdf-sandbox")
	script := fmt.Sprintf("#!/bin/sh\nprintf x >> %q\nif [ ! -f %q ]; then touch %q; exit 1; fi\nexit 0\n", countPath, markerPath, markerPath)
	if err := os.WriteFile(sandboxPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_PDFTOTEXT_PATH", toolPath)
	t.Setenv("OPENBOARD_PDF_SANDBOX_PATH", sandboxPath)
	server := NewServer(directory)
	defer server.Close()
	if _, err := server.filmPDFTextCapability(); err == nil {
		t.Fatal("initial sandbox failure was not reported")
	}
	if _, err := server.filmPDFTextCapability(); err == nil {
		t.Fatal("failure cache was not honored before its retry deadline")
	}
	server.filmPDFCapabilityMu.Lock()
	server.filmPDFRetryAt = time.Now().Add(-time.Second)
	server.filmPDFCapabilityMu.Unlock()
	if _, err := server.filmPDFTextCapability(); err != nil {
		t.Fatalf("sandbox capability did not recover after retry deadline: %v", err)
	}
	count, err := os.ReadFile(countPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(count) != "xx" {
		t.Fatalf("sandbox self-test count = %q, want one failure and one retry", count)
	}
}

func makeFilmImportMultipart(t *testing.T, revision int, filename, mimeType string, data []byte) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("revision", strconv.Itoa(revision)); err != nil {
		t.Fatal(err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename))
	header.Set("Content-Type", mimeType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes(), writer.FormDataContentType()
}

func TestExtractFilmPDFDelegatesModernStructuresAndRejectsPolyglotEnvelope(t *testing.T) {
	modern := []byte("%PDF-1.7\n1 0 obj << /Type /XRef /Filter /FlateDecode >> stream\nobject-stream-placeholder\nendstream\nendobj\nstartxref\n9\n%%EOF\n")
	runner := func(_ context.Context, _ string, _ []string, stdout, _ io.Writer) error {
		_, _ = io.WriteString(stdout, "第一集\n内景 实验室 夜\n屏幕亮起。\n")
		return nil
	}
	config := filmPDFTextConfig{Executable: "/opt/poppler/bin/pdftotext", TempRoot: t.TempDir(), Timeout: time.Second, OutputLimit: maxFilmSourceBytes}
	text, err := extractFilmPDFWithRunner(context.Background(), modern, 1<<20, config, runner)
	if err != nil || !strings.Contains(text, "内景 实验室 夜") {
		t.Fatalf("modern PDF was not delegated to pdftotext: text=%q err=%v", text, err)
	}
	for _, invalid := range [][]byte{
		append([]byte("POLYGLOT"), modern...),
		[]byte("%PDF-1.7\nno trailer"),
	} {
		if _, err := extractFilmPDFWithRunner(context.Background(), invalid, 1<<20, config, runner); err == nil {
			t.Fatal("invalid PDF envelope was accepted")
		}
	}
}

func TestFilmImportRejectsConcurrentTenantRequestAndLargeJSON(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_FILM_MODE", "true")
	server := NewServerWithStore(t.TempDir(), newFilmMemoryStore())
	t.Cleanup(server.Close)
	handler := chi.NewRouter()
	MountServer(handler, server)
	project := []byte(`{"schemaVersion":3,"projectKind":"film","id":"film-api","title":"Film API","createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if response := request(t, handler, http.MethodPut, "/api/projects/film-api", project); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	if response := request(t, handler, http.MethodPost, "/api/film/projects/film-api", []byte(`{}`)); response.Code != http.StatusCreated {
		t.Fatal(response.Body.String())
	}
	release, err := server.acquireFilmImport(t.Context(), store.DefaultTenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.acquireFilmImport(t.Context(), store.DefaultTenantID); !errors.Is(err, errFilmImportBusy) {
		t.Fatalf("second tenant import = %v", err)
	}
	busyBody, _ := json.Marshal(map[string]any{"revision": 0, "text": "safe", "format": "txt"})
	if response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/source/import", busyBody); response.Code != http.StatusTooManyRequests {
		t.Fatalf("concurrent HTTP import accepted: %d %s", response.Code, response.Body.String())
	}
	release()

	large := bytes.Repeat([]byte("x"), int(maxFilmJSONImportBytes)+1)
	body, _ := json.Marshal(map[string]any{"revision": 0, "originalName": "large.pdf", "mimeType": "application/pdf", "contentBase64": base64.StdEncoding.EncodeToString(large)})
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/source/import", body)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("large JSON import accepted: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmImportConfiguredLimitCannotExceedHardCap(t *testing.T) {
	t.Setenv("OPENBOARD_FILM_IMPORT_MAX_BYTES", "209715200")
	if got := filmImportByteLimit(); got != defaultFilmImportBytes || got > maxFilmImportBytes {
		t.Fatalf("oversized configured import limit = %d", got)
	}
}

func TestFilmImportRejectsMultipartFormatMismatch(t *testing.T) {
	_, handler := filmAPIHandler(t)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("revision", "0")
	_ = writer.WriteField("format", "pdf")
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="script.docx"`)
	header.Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	part, _ := writer.CreatePart(header)
	_, _ = part.Write(makeFilmDOCX(t, map[string]string{
		"[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"word/document.xml":   `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Safe text</w:t></w:r></w:p></w:body></w:document>`,
	}))
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/film/projects/film-api/source/import", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("format mismatch accepted: %d %s", response.Code, response.Body.String())
	}
}

func TestMultipartPartLimitRequiresEOF(t *testing.T) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for index := 0; index < 3; index++ {
		part, err := writer.CreateFormField(fmt.Sprintf("field-%d", index))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write([]byte("value"))
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(bytes.NewReader(body.Bytes()), writer.Boundary())
	for index := 0; index < 2; index++ {
		part, err := reader.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		_ = part.Close()
	}
	if err := requireMultipartEOF(reader); err == nil {
		t.Fatal("multipart reader accepted data beyond the allowed part count")
	}
}
