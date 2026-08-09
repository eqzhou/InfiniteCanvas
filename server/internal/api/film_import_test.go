package api

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"

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
	text, format, err := extractFilmImport("script.pdf", "application/pdf", textPDF, 1<<20)
	if err != nil || format != "pdf" || !strings.Contains(text, "A monitor glows.") {
		t.Fatalf("text PDF extraction format=%q text=%q err=%v", format, text, err)
	}

	imageOnly := makeMinimalFilmPDF(t, "", []byte("q 1 0 0 1 0 0 cm /Im1 Do Q"))
	if _, _, err := extractFilmImport("scan.pdf", "application/pdf", imageOnly, 1<<20); err == nil || !strings.Contains(strings.ToLower(err.Error()), "ocr") {
		t.Fatalf("image-only PDF error=%v, want OCR guidance", err)
	}
}

func TestExtractFilmImportPDFEnforcesGlobalExpansionAndOperatorLimits(t *testing.T) {
	var compressed bytes.Buffer
	zw := zlib.NewWriter(&compressed)
	_, _ = zw.Write(bytes.Repeat([]byte("BT (word) Tj ET\n"), (maxFilmPDFOperators/2)+1))
	_ = zw.Close()
	pdf := makeMinimalFilmPDF(t, "/Filter /FlateDecode", compressed.Bytes())
	if _, _, err := extractFilmImport("operators.pdf", "application/pdf", pdf, maxFilmPDFExpandedBytes+1); err == nil {
		t.Fatal("PDF operator/ratio bomb was accepted")
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
	_, handler := filmAPIHandler(t)

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

func TestExtractFilmImportRejectsPDFPseudoStructureAndPolyglot(t *testing.T) {
	stream := []byte("BT (Valid text layer) Tj ET")
	valid := makeMinimalFilmPDF(t, "", stream)
	length := []byte(fmt.Sprintf("/Length %d", len(stream)))
	tests := [][]byte{
		append([]byte("POLYGLOT"), valid...),
		bytes.Replace(valid, []byte("/Type /Catalog"), []byte("/Type /NotCatalog"), 1),
		bytes.Replace(valid, []byte("/Type /Page /Parent"), []byte("/Type /Fake /Parent"), 1),
		bytes.Replace(valid, []byte("startxref\n"), []byte("startxref\n999999"), 1),
		bytes.Replace(valid, length, []byte("/Length 2"), 1),
		bytes.Replace(valid, length, append(append([]byte(nil), length...), append([]byte(" "), length...)...), 1),
	}
	for _, value := range tests {
		if _, _, err := extractFilmImport("bad.pdf", "application/pdf", value, 1<<20); err == nil {
			t.Fatal("pseudo-structured PDF was accepted")
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
