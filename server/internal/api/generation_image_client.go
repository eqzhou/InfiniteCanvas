package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

const maxImageProviderResponseBytes = 40 << 20

type openAIImageExecutor struct {
	client *http.Client
}

func newOpenAIImageExecutor() *openAIImageExecutor {
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           safeGenerationDialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return &openAIImageExecutor{client: &http.Client{
		Transport: transport,
		Timeout:   3 * time.Minute,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}}
}

func (e *openAIImageExecutor) Generate(ctx context.Context, request imageGenerationRequest) ([]generatedImage, error) {
	if request.Count < 1 || request.Count > 8 {
		return nil, errors.New("image result count is out of range")
	}
	switch request.Protocol {
	case "", "openai":
		return e.generateOpenAI(ctx, request)
	case "gemini":
		return e.generateGemini(ctx, request)
	case "template":
		return e.generateTemplate(ctx, request)
	default:
		return nil, errors.New("unsupported image provider protocol")
	}
}

func (e *openAIImageExecutor) generateTemplate(ctx context.Context, request imageGenerationRequest) ([]generatedImage, error) {
	if request.TransparentBackground && (request.Template == nil || !request.Template.SupportsTransparentBackground) {
		return nil, errors.New("image provider template does not support transparent background")
	}
	endpoint, err := imageTemplateEndpoint(request.BaseURL, request.Template)
	if err != nil {
		return nil, err
	}
	body, err := compileImageProviderTemplate(request.Template, request)
	if err != nil {
		return nil, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, request.Template.Method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	if request.APIKey != "" {
		if request.Template.Auth == "x-api-key" {
			httpRequest.Header.Set("x-api-key", request.APIKey)
		} else {
			httpRequest.Header.Set("Authorization", "Bearer "+request.APIKey)
		}
	}
	response, err := e.client.Do(httpRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
		return nil, fmt.Errorf("image template provider returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxImageProviderResponseBytes {
		return nil, errors.New("image template provider response exceeds size limit")
	}
	limited := &io.LimitedReader{R: response.Body, N: maxImageProviderResponseBytes + 1}
	decoder := json.NewDecoder(limited)
	var payload any
	if decoder.Decode(&payload) != nil || limited.N <= 0 || ensureJSONEOF(decoder) != nil {
		return nil, errors.New("image template provider returned invalid JSON")
	}
	value, err := readImageTemplatePath(payload, request.Template.ResponsePath)
	if err != nil {
		return nil, err
	}
	outputs, ok := value.([]any)
	if !ok || len(outputs) < request.Count || len(outputs) > 8 {
		return nil, errors.New("image template provider returned an invalid result count")
	}
	images := make([]generatedImage, 0, request.Count)
	totalBytes := 0
	for _, output := range outputs[:request.Count] {
		rawURL, ok := output.(string)
		if !ok || len(rawURL) < 1 {
			return nil, errors.New("image template provider returned an invalid image URL")
		}
		var data []byte
		var mimeType string
		if strings.HasPrefix(rawURL, "data:") {
			data, mimeType, err = decodeTemplateDataImage(rawURL)
		} else {
			data, err = e.downloadImage(ctx, rawURL)
			if err == nil {
				mimeType = sniffGeneratedImageMIME(data)
			}
		}
		if err != nil {
			return nil, err
		}
		totalBytes += len(data)
		if totalBytes > maxGeneratedTotalBytes {
			return nil, errors.New("image template provider results exceed total size limit")
		}
		images = append(images, generatedImage{Data: data, MIMEType: mimeType})
	}
	return images, nil
}

func (e *openAIImageExecutor) generateOpenAI(ctx context.Context, request imageGenerationRequest) ([]generatedImage, error) {
	endpoint, err := imageProviderEndpoint(request.BaseURL, len(request.References) > 0)
	if err != nil {
		return nil, err
	}
	var body io.Reader
	contentType := "application/json"
	if len(request.References) > 0 {
		buffer := new(bytes.Buffer)
		writer := multipart.NewWriter(buffer)
		for key, value := range map[string]string{
			"model": request.Model, "prompt": request.Prompt, "n": strconv.Itoa(request.Count),
			"size": request.Size, "quality": request.Quality,
		} {
			if value != "" {
				if err := writer.WriteField(key, value); err != nil {
					return nil, err
				}
			}
		}
		for index, reference := range request.References {
			extension := imageExtension(reference.MIMEType)
			part, err := writer.CreateFormFile("image", fmt.Sprintf("ref-%d%s", index, extension))
			if err != nil {
				return nil, err
			}
			if _, err := part.Write(reference.Data); err != nil {
				return nil, err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		body = buffer
		contentType = writer.FormDataContentType()
	} else {
		value, err := json.Marshal(map[string]any{
			"model": request.Model, "prompt": request.Prompt, "n": request.Count,
			"size": request.Size, "quality": request.Quality,
			"background": func() string {
				if request.TransparentBackground {
					return "transparent"
				}
				return ""
			}(),
		})
		if err != nil {
			return nil, err
		}
		if !request.TransparentBackground {
			var payload map[string]any
			_ = json.Unmarshal(value, &payload)
			delete(payload, "background")
			value, _ = json.Marshal(payload)
		}
		body = bytes.NewReader(value)
	}

	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, body)
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Content-Type", contentType)
	if request.APIKey != "" {
		httpRequest.Header.Set("Authorization", "Bearer "+request.APIKey)
	}
	response, err := e.client.Do(httpRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
		return nil, fmt.Errorf("image provider returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxImageProviderResponseBytes {
		return nil, errors.New("image provider response exceeds size limit")
	}
	var payload struct {
		Data []struct {
			Base64 string `json:"b64_json"`
			URL    string `json:"url"`
		} `json:"data"`
	}
	limited := &io.LimitedReader{R: response.Body, N: maxImageProviderResponseBytes + 1}
	decoder := json.NewDecoder(limited)
	if err := decoder.Decode(&payload); err != nil || limited.N <= 0 || ensureJSONEOF(decoder) != nil || len(payload.Data) < 1 || len(payload.Data) > 8 {
		return nil, errors.New("image provider returned an invalid result")
	}
	images := make([]generatedImage, 0, len(payload.Data))
	totalBytes := 0
	for _, item := range payload.Data {
		var imageData []byte
		if item.Base64 != "" {
			if len(item.Base64) > base64.StdEncoding.EncodedLen(maxGeneratedImageBytes)+4 {
				return nil, errors.New("image provider result exceeds size limit")
			}
			decoded, err := base64.StdEncoding.DecodeString(item.Base64)
			if err != nil {
				return nil, errors.New("image provider returned invalid base64")
			}
			imageData = decoded
		} else if item.URL != "" {
			downloaded, err := e.downloadImage(ctx, item.URL)
			if err != nil {
				return nil, err
			}
			imageData = downloaded
		} else {
			return nil, errors.New("image provider returned an empty result")
		}
		if len(imageData) == 0 || len(imageData) > maxGeneratedImageBytes {
			return nil, errors.New("image provider result exceeds size limit")
		}
		totalBytes += len(imageData)
		if totalBytes > maxGeneratedTotalBytes {
			return nil, errors.New("image provider results exceed total size limit")
		}
		images = append(images, generatedImage{Data: imageData, MIMEType: sniffGeneratedImageMIME(imageData)})
	}
	return images, nil
}

func (e *openAIImageExecutor) generateGemini(ctx context.Context, request imageGenerationRequest) ([]generatedImage, error) {
	if request.TransparentBackground {
		return nil, errors.New("Gemini image generation does not support transparent background")
	}
	endpoint, err := geminiImageProviderEndpoint(request.BaseURL, request.Model)
	if err != nil {
		return nil, err
	}
	parts := make([]map[string]any, 0, len(request.References)+1)
	parts = append(parts, map[string]any{"text": request.Prompt})
	for _, reference := range request.References {
		if reference.MIMEType != "image/png" && reference.MIMEType != "image/jpeg" {
			return nil, errors.New("Gemini reference image type is unsupported")
		}
		parts = append(parts, map[string]any{"inlineData": map[string]any{
			"mimeType": reference.MIMEType,
			"data":     base64.StdEncoding.EncodeToString(reference.Data),
		}})
	}
	body, err := json.Marshal(map[string]any{
		"contents":         []any{map[string]any{"role": "user", "parts": parts}},
		"generationConfig": map[string]any{"responseModalities": []string{"TEXT", "IMAGE"}},
	})
	if err != nil {
		return nil, err
	}
	images := make([]generatedImage, 0, request.Count)
	totalBytes := 0
	for len(images) < request.Count {
		batch, err := e.generateGeminiBatch(ctx, endpoint, request.APIKey, body)
		if err != nil {
			return nil, err
		}
		for _, image := range batch {
			totalBytes += len(image.Data)
			if totalBytes > maxGeneratedTotalBytes {
				return nil, errors.New("Gemini image results exceed total size limit")
			}
			images = append(images, image)
			if len(images) == request.Count {
				break
			}
		}
	}
	return images, nil
}

func (e *openAIImageExecutor) generateGeminiBatch(ctx context.Context, endpoint, apiKey string, body []byte) ([]generatedImage, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		request.Header.Set("x-goog-api-key", apiKey)
	}
	response, err := e.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
		return nil, fmt.Errorf("Gemini image provider returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxImageProviderResponseBytes {
		return nil, errors.New("Gemini image response exceeds size limit")
	}
	var payload struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					InlineData *struct {
						MIMEType string `json:"mimeType"`
						Data     string `json:"data"`
					} `json:"inlineData"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	limited := &io.LimitedReader{R: response.Body, N: maxImageProviderResponseBytes + 1}
	decoder := json.NewDecoder(limited)
	if decoder.Decode(&payload) != nil || limited.N <= 0 || ensureJSONEOF(decoder) != nil || len(payload.Candidates) > 8 {
		return nil, errors.New("Gemini image provider returned an invalid result")
	}
	images := make([]generatedImage, 0)
	for _, candidate := range payload.Candidates {
		if len(candidate.Content.Parts) > 32 {
			return nil, errors.New("Gemini image provider returned too many parts")
		}
		for _, part := range candidate.Content.Parts {
			if part.InlineData == nil || part.InlineData.Data == "" {
				continue
			}
			if part.InlineData.MIMEType != "image/png" && part.InlineData.MIMEType != "image/jpeg" {
				return nil, errors.New("Gemini image provider returned an unsupported image")
			}
			if len(part.InlineData.Data) > base64.StdEncoding.EncodedLen(maxGeneratedImageBytes)+4 {
				return nil, errors.New("Gemini image result exceeds size limit")
			}
			data, err := base64.StdEncoding.DecodeString(part.InlineData.Data)
			if err != nil || len(data) < 1 || len(data) > maxGeneratedImageBytes {
				return nil, errors.New("Gemini image provider returned invalid base64")
			}
			images = append(images, generatedImage{Data: data, MIMEType: part.InlineData.MIMEType})
		}
	}
	if len(images) == 0 {
		return nil, errors.New("Gemini image provider returned no image")
	}
	return images, nil
}

func geminiImageProviderEndpoint(baseURL, model string) (string, error) {
	parsed, err := validateGenerationURL(baseURL)
	model = strings.TrimSpace(model)
	if err != nil || !geminiImageModelPattern.MatchString(model) {
		return "", errors.New("invalid Gemini image provider configuration")
	}
	basePath := strings.TrimRight(parsed.Path, "/")
	parsed.Path = basePath + "/models/" + model + ":generateContent"
	parsed.RawPath = basePath + "/models/" + url.PathEscape(model) + ":generateContent"
	return parsed.String(), nil
}

func (e *openAIImageExecutor) downloadImage(ctx context.Context, rawURL string) ([]byte, error) {
	if _, err := validateGenerationDownloadURL(rawURL); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "image/png,image/jpeg,image/gif,image/webp,image/avif")
	response, err := e.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("image download returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxGeneratedImageBytes {
		return nil, errors.New("image provider result exceeds size limit")
	}
	return readBounded(response.Body, maxGeneratedImageBytes)
}

func imageProviderEndpoint(baseURL string, edit bool) (string, error) {
	parsed, err := validateGenerationURL(baseURL)
	if err != nil {
		return "", err
	}
	basePath := strings.TrimRight(parsed.Path, "/")
	if !strings.HasSuffix(basePath, "/v1") && !strings.HasSuffix(basePath, "/api/v3") &&
		!strings.HasSuffix(basePath, "/api/plan/v3") {
		basePath += "/v1"
	}
	if edit {
		parsed.Path = path.Clean(basePath + "/images/edits")
	} else {
		parsed.Path = path.Clean(basePath + "/images/generations")
	}
	return parsed.String(), nil
}

func validateGenerationURL(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" {
		return nil, errors.New("invalid image provider URL")
	}
	if parsed.Scheme != "https" {
		if parsed.Scheme != "http" || !isExplicitLoopbackHost(parsed.Hostname()) {
			return nil, errors.New("image provider URL must use HTTPS")
		}
	}
	return parsed, nil
}

func safeGenerationDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("image provider host could not be resolved")
	}
	allowLoopback := isExplicitLoopbackHost(host)
	var selected netip.Addr
	for _, address := range addresses {
		address = address.Unmap()
		if isUnsafeGenerationAddress(address) && !(allowLoopback && address.IsLoopback()) {
			continue
		}
		selected = address
		break
	}
	if !selected.IsValid() {
		return nil, errors.New("image provider resolved to a blocked network address")
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	return dialer.DialContext(ctx, network, net.JoinHostPort(selected.String(), port))
}

func isUnsafeGenerationAddress(address netip.Addr) bool {
	cgnat := netip.MustParsePrefix("100.64.0.0/10")
	return address.IsLoopback() || address.IsPrivate() || address.IsLinkLocalUnicast() ||
		address.IsLinkLocalMulticast() || address.IsMulticast() || address.IsUnspecified() || cgnat.Contains(address)
}

func isExplicitLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address, err := netip.ParseAddr(host)
	return err == nil && address.Unmap().IsLoopback()
}

func readBounded(reader io.Reader, maximum int64) ([]byte, error) {
	value, err := io.ReadAll(io.LimitReader(reader, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(value)) > maximum {
		return nil, errors.New("image provider response exceeds size limit")
	}
	return value, nil
}

func imageExtension(mimeType string) string {
	switch mimeType {
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/avif":
		return ".avif"
	default:
		return ".png"
	}
}
