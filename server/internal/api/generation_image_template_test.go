package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func validImageTemplateForTest() *imageProviderTemplate {
	return &imageProviderTemplate{
		Method: http.MethodPost, Path: "/render", Auth: "bearer",
		Request:      json.RawMessage(`{"prompt":"{{prompt}}","options":{"size":"{{size}}","refs":"{{referenceImages}}"},"flags":[true,null,7,"literal"]}`),
		ResponsePath: "output.images", TaskIDPath: "task.id", StatusPath: "task.status", ResultPath: "task.result",
	}
}

func TestImageProviderTemplateCompilerMatchesBrowserContract(t *testing.T) {
	template := validImageTemplateForTest()
	original := append([]byte(nil), template.Request...)
	pngBytes, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	body, err := compileImageProviderTemplate(template, imageGenerationRequest{
		Prompt: "draw", Model: "relay", Size: "1024x1024", Quality: "high", Count: 2,
		References: []generatedImage{{Data: pngBytes, MIMEType: "image/png"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var value struct {
		Prompt  string `json:"prompt"`
		Options struct {
			Size string   `json:"size"`
			Refs []string `json:"refs"`
		} `json:"options"`
		Flags []any `json:"flags"`
	}
	if json.Unmarshal(body, &value) != nil || value.Prompt != "draw" || value.Options.Size != "1024x1024" ||
		len(value.Options.Refs) != 1 || !strings.HasPrefix(value.Options.Refs[0], "data:image/png;base64,") ||
		len(value.Flags) != 4 || !bytes.Equal(template.Request, original) {
		t.Fatalf("compiled=%s template=%s", body, template.Request)
	}
}

func TestImageProviderTemplateValidationRejectsEveryExecutableEscape(t *testing.T) {
	tooMany := `{"items":[` + strings.Repeat("0,", maxImageTemplateEntries) + `0]}`
	tooDeep := `{"value":` + strings.Repeat(`{"value":`, maxImageTemplateDepth+1) + `null` + strings.Repeat(`}`, maxImageTemplateDepth+1) + `}`
	tests := []*imageProviderTemplate{
		nil,
		{Method: http.MethodPost, Path: "/render", Auth: "basic", Request: json.RawMessage(`{}`), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render?key=x", Auth: "bearer", Request: json.RawMessage(`{}`), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(`[]`), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(`{"x":`), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(`{"x":"prefix {{prompt}}"}`), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(`{"x":"{{script}}"}`), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(tooMany), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(tooDeep), ResponsePath: "images"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(`{}`), ResponsePath: "items.0.url"},
		{Method: http.MethodPost, Path: "/render", Auth: "bearer", Request: json.RawMessage(`{}`), ResponsePath: "images", TaskIDPath: "task[0]"},
		{Method: http.MethodPost, Path: "/" + strings.Repeat("x", 8*1024), Auth: "bearer", Request: json.RawMessage(`{}`), ResponsePath: "images"},
	}
	for index, template := range tests {
		if err := validateImageProviderTemplate(template); err == nil {
			t.Fatalf("case %d unexpectedly passed: %+v", index, template)
		}
	}
}

func TestImageProviderTemplateHelpersRejectMalformedResults(t *testing.T) {
	value := map[string]any{"output": map[string]any{"images": []any{"ok"}}}
	if result, err := readImageTemplatePath(value, "output.images"); err != nil || len(result.([]any)) != 1 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	for _, fieldPath := range []string{"output.missing", "output.images.url", "items[0]"} {
		if _, err := readImageTemplatePath(value, fieldPath); err == nil {
			t.Fatalf("expected %q to fail", fieldPath)
		}
	}
	if _, err := imageTemplateEndpoint("http://public.example", validImageTemplateForTest()); err == nil {
		t.Fatal("expected public HTTP endpoint to fail")
	}
	if _, _, err := decodeTemplateDataImage("data:image/gif;base64,AQ=="); err == nil {
		t.Fatal("expected GIF data URL to fail")
	}
	if _, _, err := decodeTemplateDataImage("data:image/png;base64,!"); err == nil {
		t.Fatal("expected malformed base64 to fail")
	}
	data, mimeType, err := decodeTemplateDataImage("data:image/jpeg;base64,AQ==")
	if err != nil || mimeType != "image/jpeg" || !bytes.Equal(data, []byte{1}) {
		t.Fatalf("data=%v mime=%q err=%v", data, mimeType, err)
	}
}

func TestImageProviderTemplateCompilerRejectsUnsupportedReference(t *testing.T) {
	if _, err := compileImageProviderTemplate(validImageTemplateForTest(), imageGenerationRequest{
		Count: 1, References: []generatedImage{{Data: []byte("gif"), MIMEType: "image/gif"}},
	}); err == nil {
		t.Fatal("expected unsupported reference type to fail")
	}
}

func TestGenerationProviderTemplateSizeGuardMatchesJSONEncoding(t *testing.T) {
	value := map[string]any{
		"text":  "quote \" slash \\ control\n html <>& \u2028",
		"flags": []any{true, false, nil, json.Number("12.5")},
		"refs":  []string{"data:image/png;base64,AQ==", "plain"},
		"count": 2,
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	size, err := generationTemplateJSONSize(value, len(encoded))
	if err != nil || size != len(encoded) {
		t.Fatalf("size=%d encoded=%d err=%v", size, len(encoded), err)
	}
	if _, err := generationTemplateJSONSize(value, len(encoded)-1); err == nil {
		t.Fatal("expected bounded size calculation to reject overflow")
	}
	template := &imageProviderTemplate{
		Method: http.MethodPost, Path: "/render", Auth: "bearer",
		Request: json.RawMessage(`{"first":"{{prompt}}","second":"{{prompt}}"}`), ResponsePath: "url",
	}
	if _, err := compileGenerationProviderTemplate(template, map[string]any{"prompt": strings.Repeat("x", 64)}, 100); err == nil {
		t.Fatal("expected repeated expansion to be rejected before marshaling")
	}
}

func TestGenerationProviderTemplateUsesNullForAllowedMissingValues(t *testing.T) {
	template := &imageProviderTemplate{
		Method: http.MethodPost, Path: "/render", Auth: "bearer",
		Request: json.RawMessage(`{"prompt":"{{prompt}}","duration":"{{duration}}"}`), ResponsePath: "url",
	}
	body, err := compileGenerationProviderTemplate(template, map[string]any{"prompt": "draw"}, 1024)
	if err != nil || string(body) != `{"duration":null,"prompt":"draw"}` {
		t.Fatalf("body=%s err=%v", body, err)
	}
}
