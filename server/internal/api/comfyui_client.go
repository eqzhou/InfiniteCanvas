package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

const (
	maxComfyUIJSONBytes   = 2 << 20
	maxComfyUIPromptBytes = 100_000
)

type comfyUIExternalCheckpoint struct {
	PromptID string `json:"promptId"`
}

type comfyUIWorkflowValues struct {
	Prompt         string   `json:"prompt,omitempty"`
	NegativePrompt string   `json:"negativePrompt,omitempty"`
	References     []string `json:"references,omitempty"`
	FirstFrame     string   `json:"firstFrame,omitempty"`
	LastFrame      string   `json:"lastFrame,omitempty"`
	Seed           int64    `json:"seed,omitempty"`
	Width          int      `json:"width,omitempty"`
	Height         int      `json:"height,omitempty"`
	Duration       int      `json:"duration,omitempty"`
	ReferenceNames []string `json:"-"`
	FirstFrameName string   `json:"-"`
	LastFrameName  string   `json:"-"`
}

type comfyUIExecutionRequest struct {
	Manifest localWorkflowManifest
	Values   comfyUIWorkflowValues
}

type comfyUIExecutionItem struct {
	Kind     string
	Data     []byte
	MIMEType string
}

type comfyUIExecutionOutput struct {
	Kind     string
	Data     []byte
	MIMEType string
	Items    []comfyUIExecutionItem
}

type comfyUIExecutor struct {
	endpoint     *url.URL
	client       *http.Client
	pollInterval time.Duration
}

type comfyUIOutputReference struct {
	Filename  string `json:"filename"`
	Subfolder string `json:"subfolder"`
	Type      string `json:"type"`
}

func newComfyUIExecutor(endpoint string, allowPrivate bool) (*comfyUIExecutor, error) {
	if err := validateLocalWorkflowEndpoint(endpoint, allowPrivate); err != nil {
		return nil, err
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, errors.New("invalid ComfyUI endpoint")
	}
	destinationHost := parsed.Hostname()
	if strings.EqualFold(destinationHost, "localhost") {
		destinationHost = "127.0.0.1"
	}
	destinationPort := parsed.Port()
	if destinationPort == "" {
		if parsed.Scheme == "https" {
			destinationPort = "443"
		} else {
			destinationPort = "80"
		}
	}
	destination := net.JoinHostPort(destinationHost, destinationPort)
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if !sameComfyUIAddress(address, parsed) {
				return nil, errors.New("ComfyUI destination changed")
			}
			return dialer.DialContext(ctx, network, destination)
		},
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          4,
		MaxIdleConnsPerHost:   2,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	return &comfyUIExecutor{
		endpoint: parsed,
		client: &http.Client{
			Transport:     transport,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		pollInterval: 500 * time.Millisecond,
	}, nil
}

func sameComfyUIAddress(address string, endpoint *url.URL) bool {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	expectedPort := endpoint.Port()
	if expectedPort == "" {
		if endpoint.Scheme == "https" {
			expectedPort = "443"
		} else {
			expectedPort = "80"
		}
	}
	return strings.EqualFold(host, endpoint.Hostname()) && port == expectedPort
}

func compileComfyUIPrompt(manifest localWorkflowManifest, values comfyUIWorkflowValues) (map[string]any, error) {
	if err := validateLocalWorkflowManifest(manifest); err != nil {
		return nil, err
	}
	if len(values.Prompt) > maxComfyUIPromptBytes || len(values.NegativePrompt) > maxComfyUIPromptBytes ||
		values.Width < 0 || values.Height < 0 || values.Duration < 0 ||
		(values.Width > 0 && values.Width > manifest.Limits.MaxWidth) ||
		(values.Height > 0 && values.Height > manifest.Limits.MaxHeight) ||
		(values.Duration > 0 && values.Duration > manifest.Limits.MaxSeconds) {
		return nil, errors.New("ComfyUI workflow values exceed limits")
	}
	nodeIDs := make(map[string]struct{}, len(manifest.Nodes))
	for _, node := range manifest.Nodes {
		nodeIDs[node.ID] = struct{}{}
	}
	prompt := make(map[string]any, len(manifest.Nodes))
	for _, node := range manifest.Nodes {
		inputs := make(map[string]any, len(node.Inputs))
		for key, raw := range node.Inputs {
			value, err := comfyUIInputValue(raw, values, nodeIDs)
			if err != nil {
				return nil, err
			}
			inputs[key] = value
		}
		prompt[node.ID] = map[string]any{"class_type": node.Type, "inputs": inputs}
	}
	encoded, err := json.Marshal(prompt)
	if err != nil || len(encoded) > maxLocalWorkflowManifestBytes {
		return nil, errors.New("compiled ComfyUI prompt exceeds limit")
	}
	return prompt, nil
}

func comfyUIInputValue(raw string, values comfyUIWorkflowValues, nodeIDs map[string]struct{}) (any, error) {
	switch raw {
	case "${prompt}":
		return values.Prompt, nil
	case "${negativePrompt}":
		return values.NegativePrompt, nil
	case "${references}":
		if len(values.ReferenceNames) > 0 {
			return strings.Join(values.ReferenceNames, ","), nil
		}
		return strings.Join(values.References, ","), nil
	case "${firstFrame}":
		if values.FirstFrameName != "" {
			return values.FirstFrameName, nil
		}
		return values.FirstFrame, nil
	case "${lastFrame}":
		if values.LastFrameName != "" {
			return values.LastFrameName, nil
		}
		return values.LastFrame, nil
	case "${seed}":
		return values.Seed, nil
	case "${width}":
		return values.Width, nil
	case "${height}":
		return values.Height, nil
	case "${duration}":
		return values.Duration, nil
	}
	if strings.Contains(raw, "${") {
		return nil, errors.New("unsupported ComfyUI placeholder")
	}
	if _, linked := nodeIDs[raw]; linked {
		return []any{raw, 0}, nil
	}
	var literal any
	if json.Unmarshal([]byte(raw), &literal) == nil {
		switch literal.(type) {
		case bool, float64, nil:
			return literal, nil
		}
	}
	return raw, nil
}

func (e *comfyUIExecutor) Run(ctx context.Context, request comfyUIExecutionRequest, checkpoint *comfyUIExternalCheckpoint, save func(comfyUIExternalCheckpoint) error) (comfyUIExecutionOutput, error) {
	if e == nil || e.client == nil || e.endpoint == nil || e.pollInterval < 0 {
		return comfyUIExecutionOutput{}, errors.New("ComfyUI executor is invalid")
	}
	if request.Manifest.Endpoint != e.endpoint.String() {
		return comfyUIExecutionOutput{}, errors.New("ComfyUI manifest endpoint changed")
	}
	duration := time.Duration(request.Manifest.Limits.MaxSeconds) * time.Second
	if duration <= 0 {
		return comfyUIExecutionOutput{}, errors.New("ComfyUI timeout is invalid")
	}
	runCtx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	current := checkpoint
	if current == nil {
		prompt, err := compileComfyUIPrompt(request.Manifest, request.Values)
		if err != nil {
			return comfyUIExecutionOutput{}, err
		}
		promptID, err := e.submit(runCtx, prompt)
		if err != nil {
			return comfyUIExecutionOutput{}, err
		}
		candidate := comfyUIExternalCheckpoint{PromptID: promptID}
		if save == nil {
			return comfyUIExecutionOutput{}, errors.New("ComfyUI checkpoint callback is required")
		}
		if err := save(candidate); err != nil {
			return comfyUIExecutionOutput{}, fmt.Errorf("persist ComfyUI checkpoint: %w", err)
		}
		current = &candidate
	}
	if !validComfyUIPromptID(current.PromptID) {
		return comfyUIExecutionOutput{}, errors.New("invalid ComfyUI prompt id")
	}
	for {
		references, done, err := e.history(runCtx, current.PromptID, request.Manifest)
		if err != nil {
			return comfyUIExecutionOutput{}, err
		}
		if done {
			items := make([]comfyUIExecutionItem, 0, len(references))
			for _, reference := range references {
				item, err := e.download(runCtx, reference)
				if err != nil {
					return comfyUIExecutionOutput{}, err
				}
				items = append(items, item)
			}
			if len(items) == 0 {
				return comfyUIExecutionOutput{}, errors.New("ComfyUI completed without output")
			}
			return comfyUIExecutionOutput{Kind: items[0].Kind, Data: items[0].Data, MIMEType: items[0].MIMEType, Items: items}, nil
		}
		if err := waitContext(runCtx, e.pollInterval); err != nil {
			return comfyUIExecutionOutput{}, err
		}
	}
}

func (e *comfyUIExecutor) submit(ctx context.Context, prompt map[string]any) (string, error) {
	body, err := json.Marshal(map[string]any{"prompt": prompt})
	if err != nil || len(body) > maxLocalWorkflowManifestBytes {
		return "", errors.New("ComfyUI prompt exceeds request limit")
	}
	var response struct {
		PromptID string `json:"prompt_id"`
	}
	if err := e.doJSON(ctx, http.MethodPost, "/prompt", body, &response); err != nil {
		return "", err
	}
	if !validComfyUIPromptID(response.PromptID) {
		return "", errors.New("ComfyUI response has invalid prompt id")
	}
	return response.PromptID, nil
}

func validComfyUIPromptID(value string) bool {
	return len(value) >= 1 && len(value) <= 128 && workflowIDPattern.MatchString(value)
}

func (e *comfyUIExecutor) history(ctx context.Context, promptID string, manifest localWorkflowManifest) ([]comfyUIOutputReference, bool, error) {
	var payload map[string]json.RawMessage
	if err := e.doJSON(ctx, http.MethodGet, "/history/"+url.PathEscape(promptID), nil, &payload); err != nil {
		return nil, false, err
	}
	raw, exists := payload[promptID]
	if !exists {
		return nil, false, nil
	}
	var entry struct {
		Status struct {
			Status    string `json:"status_str"`
			Completed bool   `json:"completed"`
		} `json:"status"`
		Outputs map[string]map[string]json.RawMessage `json:"outputs"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if decoder.Decode(&entry) != nil || ensureJSONEOF(decoder) != nil {
		return nil, false, errors.New("ComfyUI history is invalid")
	}
	status := strings.ToLower(strings.TrimSpace(entry.Status.Status))
	if status == "error" || status == "failed" {
		return nil, true, errors.New("ComfyUI reported execution failure")
	}
	if !entry.Status.Completed && status != "success" {
		return nil, false, nil
	}
	kind, err := localWorkflowOutputKind(manifest)
	if err != nil {
		return nil, true, err
	}
	field := map[string]string{"image": "images", "video": "videos", "audio": "audio"}[kind]
	result := make([]comfyUIOutputReference, 0, len(manifest.Outputs))
	for _, outputID := range manifest.Outputs {
		fields, ok := entry.Outputs[outputID]
		if !ok {
			continue
		}
		rawReferences := fields[field]
		if len(rawReferences) == 0 && kind == "video" {
			rawReferences = fields["gifs"]
		}
		var references []comfyUIOutputReference
		if len(rawReferences) > 0 && json.Unmarshal(rawReferences, &references) != nil {
			return nil, true, errors.New("ComfyUI output list is invalid")
		}
		for _, reference := range references {
			if !validComfyUIOutputReference(reference) {
				return nil, true, errors.New("ComfyUI output path is invalid")
			}
			result = append(result, reference)
			if len(result) > 8 {
				return nil, true, errors.New("ComfyUI output count exceeds limit")
			}
		}
	}
	if len(result) == 0 {
		return nil, true, errors.New("ComfyUI completed without declared output")
	}
	return result, true, nil
}

func validComfyUIOutputReference(value comfyUIOutputReference) bool {
	if value.Type != "output" || len(value.Filename) < 1 || len(value.Filename) > 255 || len(value.Subfolder) > 512 ||
		strings.ContainsAny(value.Filename, "/\\\r\n\x00") || value.Filename == "." || value.Filename == ".." {
		return false
	}
	if value.Subfolder == "" {
		return true
	}
	clean := path.Clean(value.Subfolder)
	return clean == value.Subfolder && clean != "." && clean != ".." && !strings.HasPrefix(clean, "../") && !strings.HasPrefix(clean, "/") && !strings.ContainsAny(clean, "\\\r\n\x00")
}

func (e *comfyUIExecutor) download(ctx context.Context, reference comfyUIOutputReference) (comfyUIExecutionItem, error) {
	kind := comfyUIKindFromFilename(reference.Filename)
	if kind == "" {
		return comfyUIExecutionItem{}, errors.New("ComfyUI output extension is unsupported")
	}
	query := url.Values{"filename": {reference.Filename}, "subfolder": {reference.Subfolder}, "type": {reference.Type}}
	request, err := e.request(ctx, http.MethodGet, "/view?"+query.Encode(), nil)
	if err != nil {
		return comfyUIExecutionItem{}, err
	}
	response, err := e.client.Do(request)
	if err != nil {
		return comfyUIExecutionItem{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return comfyUIExecutionItem{}, fmt.Errorf("ComfyUI output returned HTTP %d", response.StatusCode)
	}
	limit := int64(maxGeneratedImageBytes)
	if kind == "video" {
		limit = maxGeneratedVideoBytes
	} else if kind == "audio" {
		limit = maxGeneratedAudioBytes
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return comfyUIExecutionItem{}, errors.New("ComfyUI output exceeds limit")
	}
	mimeType := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	return comfyUIExecutionItem{Kind: kind, Data: data, MIMEType: mimeType}, nil
}

func comfyUIKindFromFilename(filename string) string {
	extension := strings.ToLower(path.Ext(filename))
	switch extension {
	case ".png", ".jpg", ".jpeg":
		return "image"
	case ".mp4", ".webm":
		return "video"
	case ".mp3", ".wav", ".ogg", ".flac", ".aac":
		return "audio"
	default:
		return ""
	}
}

func (e *comfyUIExecutor) UploadImage(ctx context.Context, filename, mimeType string, data []byte) (string, error) {
	if !validComfyUIUploadName(filename) || sniffGeneratedImageMIME(data) == "" || normalizeMediaMIME(mimeType) != sniffGeneratedImageMIME(data) {
		return "", errors.New("invalid ComfyUI input image")
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("image", filename)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	_ = writer.WriteField("type", "input")
	_ = writer.WriteField("overwrite", "true")
	if err := writer.Close(); err != nil {
		return "", err
	}
	request, err := e.request(ctx, http.MethodPost, "/upload/image", bytes.NewReader(body.Bytes()))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := e.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("ComfyUI upload returned HTTP %d", response.StatusCode)
	}
	var uploaded struct {
		Name      string `json:"name"`
		Subfolder string `json:"subfolder"`
		Type      string `json:"type"`
	}
	if err := decodeBoundedJSON(response.Body, maxComfyUIJSONBytes, &uploaded); err != nil || uploaded.Type != "input" || !validComfyUIUploadName(uploaded.Name) || uploaded.Subfolder != "" {
		return "", errors.New("ComfyUI upload response is invalid")
	}
	return uploaded.Name, nil
}

func validComfyUIUploadName(value string) bool {
	return len(value) >= 1 && len(value) <= 255 && !strings.ContainsAny(value, "/\\\r\n\x00") && value != "." && value != ".."
}

func (e *comfyUIExecutor) Cancel(ctx context.Context, checkpoint comfyUIExternalCheckpoint) error {
	if !validComfyUIPromptID(checkpoint.PromptID) {
		return errors.New("invalid ComfyUI prompt id")
	}
	queueBody, _ := json.Marshal(map[string]any{"delete": []string{checkpoint.PromptID}})
	if err := e.doJSON(ctx, http.MethodPost, "/queue", queueBody, nil); err != nil {
		return err
	}
	return e.doJSON(ctx, http.MethodPost, "/interrupt", []byte(`{}`), nil)
}

func (e *comfyUIExecutor) doJSON(ctx context.Context, method, requestPath string, body []byte, output any) error {
	request, err := e.request(ctx, method, requestPath, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := e.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("ComfyUI returned HTTP %d", response.StatusCode)
	}
	if output == nil {
		_, err = io.Copy(io.Discard, io.LimitReader(response.Body, maxComfyUIJSONBytes+1))
		return err
	}
	return decodeBoundedJSON(response.Body, maxComfyUIJSONBytes, output)
}

func (e *comfyUIExecutor) request(ctx context.Context, method, requestPath string, body io.Reader) (*http.Request, error) {
	if e == nil || e.endpoint == nil || !strings.HasPrefix(requestPath, "/") || strings.HasPrefix(requestPath, "//") {
		return nil, errors.New("invalid ComfyUI request path")
	}
	target := *e.endpoint
	queryIndex := strings.IndexByte(requestPath, '?')
	if queryIndex >= 0 {
		target.Path, target.RawQuery = requestPath[:queryIndex], requestPath[queryIndex+1:]
	} else {
		target.Path, target.RawQuery = requestPath, ""
	}
	return http.NewRequestWithContext(ctx, method, target.String(), body)
}

func decodeBoundedJSON(reader io.Reader, limit int64, output any) error {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil || int64(len(data)) > limit {
		return errors.New("JSON response exceeds limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(output); err != nil || ensureJSONEOF(decoder) != nil {
		return errors.New("invalid JSON response")
	}
	return nil
}

func comfyUIUploadFilename(index int, mimeType, digest string) string {
	extension := ".png"
	if normalizeMediaMIME(mimeType) == "image/jpeg" {
		extension = ".jpg"
	}
	return "openboard-" + strconv.Itoa(index) + "-" + digest + extension
}
