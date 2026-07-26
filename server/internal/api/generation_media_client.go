package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

const maxMediaProviderJSONBytes = 2 << 20

type httpVideoExecutor struct {
	client           *http.Client
	pollInterval     time.Duration
	maxDuration      time.Duration
	kieUploadBaseURL string
}

type httpAudioExecutor struct {
	client *http.Client
}

func newHTTPVideoExecutor() *httpVideoExecutor {
	return &httpVideoExecutor{client: newOpenAIImageExecutor().client, pollInterval: 2 * time.Second, maxDuration: 30 * time.Minute}
}

func newHTTPAudioExecutor() *httpAudioExecutor {
	return &httpAudioExecutor{client: newOpenAIImageExecutor().client}
}

func (e *httpVideoExecutor) Generate(ctx context.Context, request videoGenerationRequest, existing *videoProviderCheckpoint, save func(videoProviderCheckpoint) error) (generatedMedia, error) {
	if e.maxDuration <= 0 {
		e.maxDuration = 30 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, e.maxDuration)
	defer cancel()
	if request.Protocol == "template" {
		if existing != nil {
			return generatedMedia{}, errors.New("synchronous video template cannot resume a provider checkpoint")
		}
		return e.generateTemplate(ctx, request)
	}
	if request.Protocol == "apimart" {
		if err := validateAPIMartVideoRequest(request); err != nil {
			return generatedMedia{}, err
		}
	}
	checkpoint := existing
	var immediate map[string]any
	if checkpoint == nil {
		created, err := e.create(ctx, request)
		if err != nil {
			return generatedMedia{}, err
		}
		taskID := mediaString(created, "id", "task_id", "taskId")
		if request.Protocol == "apimart" {
			taskID = apimartTaskID(created)
		} else if request.Protocol == "kie" {
			taskID = kieCreatedTaskID(created)
		}
		if taskID == "" {
			if data := mediaMap(created["data"]); data != nil {
				taskID = mediaString(data, "id", "task_id", "taskId")
			}
		}
		candidate := videoProviderCheckpoint{Protocol: request.Protocol, TaskID: taskID}
		if !validVideoCheckpoint(candidate) {
			return generatedMedia{}, errors.New("video provider task id is missing")
		}
		if err := save(candidate); err != nil {
			return generatedMedia{}, err
		}
		checkpoint = &candidate
		immediate = created
	} else if checkpoint.Protocol != request.Protocol {
		return generatedMedia{}, errors.New("video provider checkpoint protocol mismatch")
	}

	if immediate != nil {
		if media, done, err := e.completed(ctx, request, *checkpoint, immediate); done || err != nil {
			return media, err
		}
	}
	interval := e.pollInterval
	if interval < 0 {
		return generatedMedia{}, errors.New("invalid video poll interval")
	}
	kieConsecutiveRetries := 0
	for {
		if err := waitContext(ctx, interval); err != nil {
			return generatedMedia{}, err
		}
		payload, err := e.poll(ctx, request, *checkpoint)
		if err != nil {
			if request.Protocol == "apimart" {
				if delay, retry := retryAPIMartPoll(err, interval); retry {
					if waitErr := waitContext(ctx, delay); waitErr != nil {
						return generatedMedia{}, waitErr
					}
					continue
				}
			}
			if request.Protocol == "kie" {
				if delay, retry := retryKIEPoll(err, interval); retry && kieConsecutiveRetries < kieMaxConsecutivePollRetries {
					kieConsecutiveRetries++
					if waitErr := waitContext(ctx, delay); waitErr != nil {
						return generatedMedia{}, waitErr
					}
					continue
				}
			}
			return generatedMedia{}, err
		}
		kieConsecutiveRetries = 0
		if media, done, err := e.completed(ctx, request, *checkpoint, payload); done || err != nil {
			return media, err
		}
	}
}

func (e *httpVideoExecutor) generateTemplate(ctx context.Context, request videoGenerationRequest) (generatedMedia, error) {
	endpoint, err := imageTemplateEndpoint(request.BaseURL, request.Template)
	if err != nil {
		return generatedMedia{}, err
	}
	referenceImages := make([]string, 0)
	referenceVideos := make([]string, 0)
	referenceAudios := make([]string, 0)
	for _, reference := range request.References {
		kind := mediaMIMEKind(reference.MIMEType)
		if kind == "" {
			return generatedMedia{}, errors.New("video template reference type is unsupported")
		}
		dataURL := "data:" + reference.MIMEType + ";base64," + base64.StdEncoding.EncodeToString(reference.Data)
		switch kind {
		case "image":
			referenceImages = append(referenceImages, dataURL)
		case "video":
			referenceVideos = append(referenceVideos, dataURL)
		case "audio":
			referenceAudios = append(referenceAudios, dataURL)
		}
	}
	body, err := compileGenerationProviderTemplate(request.Template, map[string]any{
		"prompt": request.Prompt, "model": request.Model, "size": request.Size,
		"duration": request.Seconds, "ratio": request.Ratio, "resolution": request.Resolution,
		"referenceImages": referenceImages, "referenceVideos": referenceVideos, "referenceAudios": referenceAudios,
	}, (maxMediaReferenceBytes*4/3)+(4<<20))
	if err != nil {
		return generatedMedia{}, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, request.Template.Method, endpoint, bytes.NewReader(body))
	if err != nil {
		return generatedMedia{}, err
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
		return generatedMedia{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
		return generatedMedia{}, fmt.Errorf("video template provider returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxMediaProviderJSONBytes {
		return generatedMedia{}, errors.New("video template provider response exceeds size limit")
	}
	limited := &io.LimitedReader{R: response.Body, N: maxMediaProviderJSONBytes + 1}
	decoder := json.NewDecoder(limited)
	decoder.UseNumber()
	var payload any
	if decoder.Decode(&payload) != nil || ensureJSONEOF(decoder) != nil || limited.N <= 0 {
		return generatedMedia{}, errors.New("video template provider returned invalid JSON")
	}
	value, err := readImageTemplatePath(payload, request.Template.ResponsePath)
	if err != nil {
		return generatedMedia{}, err
	}
	rawURL, ok := value.(string)
	if !ok || strings.TrimSpace(rawURL) == "" {
		return generatedMedia{}, errors.New("video template response must resolve to a URL")
	}
	return e.download(ctx, rawURL, request.BaseURL, maxGeneratedVideoBytes)
}

func (e *httpVideoExecutor) create(ctx context.Context, request videoGenerationRequest) (map[string]any, error) {
	if request.Protocol == "apimart" {
		return e.createAPIMartVideo(ctx, request)
	}
	if request.Protocol == "kie" {
		return e.createKIEVideo(ctx, request)
	}
	body := map[string]any{"model": request.Model}
	endpoint := "/videos"
	if request.Protocol == "ark" {
		endpoint = "/contents/generations/tasks"
		content := []map[string]any{{"type": "text", "text": request.Prompt}}
		counts := map[string]int{}
		frameMode := normalizeVideoFrameMode(request.FrameMode)
		for _, reference := range request.References {
			kind := mediaMIMEKind(reference.MIMEType)
			counts[kind]++
			limit := 3
			if kind == "image" {
				limit = 9
			}
			if kind == "" || counts[kind] > limit {
				continue
			}
			// Ark fetches reference media from its own network. Images are small
			// enough to inline as data URLs, but video and audio must be public
			// URLs; inlining them would silently build an oversized request that
			// the provider cannot use.
			var mediaURL string
			if reference.PublicURL != "" {
				mediaURL = reference.PublicURL
			} else if kind == "image" {
				mediaURL = "data:" + reference.MIMEType + ";base64," + base64.StdEncoding.EncodeToString(reference.Data)
			} else {
				return nil, fmt.Errorf(
					"Ark %s references require a publicly reachable URL; configure OPENBOARD_PUBLIC_BASE_URL so the provider can fetch them",
					kind)
			}
			role := "reference_" + kind
			if kind == "image" && frameMode == "first-last" {
				switch counts[kind] {
				case 1:
					role = "first_frame"
				case 2:
					role = "last_frame"
				}
			}
			item := map[string]any{"type": kind + "_url", kind + "_url": map[string]any{"url": mediaURL}, "role": role}
			content = append(content, item)
		}
		body = map[string]any{
			"model": request.Model, "content": content, "ratio": request.Ratio,
			"resolution": request.Resolution, "generate_audio": request.GenerateAudio, "watermark": request.Watermark,
		}
		if request.Seconds > 0 {
			body["duration"] = request.Seconds
		}
	} else {
		body["prompt"] = request.Prompt
		if request.Seconds > 0 {
			body["seconds"] = request.Seconds
		}
		for _, reference := range request.References {
			if mediaMIMEKind(reference.MIMEType) == "image" {
				body["input_reference"] = "data:" + reference.MIMEType + ";base64," + base64.StdEncoding.EncodeToString(reference.Data)
				break
			}
		}
	}
	return e.jsonRequest(ctx, request, http.MethodPost, endpoint, body)
}

func (e *httpVideoExecutor) poll(ctx context.Context, request videoGenerationRequest, checkpoint videoProviderCheckpoint) (map[string]any, error) {
	if checkpoint.Protocol == "apimart" {
		return apimartJSONRequest(ctx, e.client, request.BaseURL, request.APIKey, http.MethodGet,
			"/tasks/"+url.PathEscape(checkpoint.TaskID), nil)
	}
	if checkpoint.Protocol == "kie" {
		return kieJSONRequest(ctx, e.client, request.BaseURL, request.APIKey, http.MethodGet,
			"/jobs/recordInfo?taskId="+url.QueryEscape(checkpoint.TaskID), nil)
	}
	endpoint := "/videos/" + url.PathEscape(checkpoint.TaskID)
	if checkpoint.Protocol == "ark" {
		endpoint = "/contents/generations/tasks/" + url.PathEscape(checkpoint.TaskID)
	}
	return e.jsonRequest(ctx, request, http.MethodGet, endpoint, nil)
}

func (e *httpVideoExecutor) completed(ctx context.Context, request videoGenerationRequest, checkpoint videoProviderCheckpoint, payload map[string]any) (generatedMedia, bool, error) {
	if checkpoint.Protocol == "kie" {
		status, urls, err := normalizeKIETask(payload)
		if err != nil {
			return generatedMedia{}, true, err
		}
		if status == kieTaskPending {
			return generatedMedia{}, false, nil
		}
		if status != kieTaskSucceeded || len(urls) == 0 {
			return generatedMedia{}, true, errors.New("KIE video task completed without a result")
		}
		media, err := e.download(ctx, urls[0], request.BaseURL, maxGeneratedVideoBytes)
		if err != nil {
			return generatedMedia{}, true, errors.New("KIE video result download failed")
		}
		return media, true, nil
	}
	status := strings.ToLower(mediaNestedString(payload,
		[]string{"status"}, []string{"task_status"}, []string{"taskStatus"}, []string{"state"},
		[]string{"data", "status"}, []string{"data", "task_status"}, []string{"data", "state"},
		[]string{"task", "status"}, []string{"task", "state"}))
	if mediaFailedStatus(status) {
		return generatedMedia{}, true, errors.New("video provider reported terminal failure")
	}
	outputURL := mediaVideoURL(payload)
	if checkpoint.Protocol == "apimart" {
		outputURL = apimartVideoResultURL(payload)
	}
	if outputURL != "" {
		media, err := e.download(ctx, outputURL, request.BaseURL, maxGeneratedVideoBytes)
		return media, true, err
	}
	if mediaSuccessfulStatus(status) {
		if checkpoint.Protocol == "ark" {
			return generatedMedia{}, true, errors.New("video provider completed without an output URL")
		}
		if checkpoint.Protocol == "apimart" {
			return generatedMedia{}, true, errors.New("APIMart video provider completed without an output URL")
		}
		endpoint, err := generationProviderEndpoint(request.BaseURL, "/videos/"+url.PathEscape(checkpoint.TaskID)+"/content")
		if err != nil {
			return generatedMedia{}, true, err
		}
		httpRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return generatedMedia{}, true, err
		}
		httpRequest.Header.Set("Authorization", "Bearer "+request.APIKey)
		response, err := e.client.Do(httpRequest)
		if err != nil {
			return generatedMedia{}, true, err
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return generatedMedia{}, true, fmt.Errorf("video content returned HTTP %d", response.StatusCode)
		}
		data, err := readBounded(response.Body, maxGeneratedVideoBytes)
		return generatedMedia{Data: data, MIMEType: normalizeMediaMIME(response.Header.Get("Content-Type"))}, true, err
	}
	return generatedMedia{}, false, nil
}

func (e *httpVideoExecutor) jsonRequest(ctx context.Context, request videoGenerationRequest, method, suffix string, body any) (map[string]any, error) {
	endpoint, err := generationProviderEndpoint(request.BaseURL, suffix)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		value, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(value)
	}
	httpRequest, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		httpRequest.Header.Set("Content-Type", "application/json")
	}
	httpRequest.Header.Set("Authorization", "Bearer "+request.APIKey)
	response, err := e.client.Do(httpRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
		return nil, fmt.Errorf("video provider returned HTTP %d", response.StatusCode)
	}
	limited := &io.LimitedReader{R: response.Body, N: maxMediaProviderJSONBytes + 1}
	decoder := json.NewDecoder(limited)
	decoder.UseNumber()
	var payload map[string]any
	if decoder.Decode(&payload) != nil || ensureJSONEOF(decoder) != nil || limited.N <= 0 || payload == nil {
		return nil, errors.New("video provider returned invalid JSON")
	}
	return payload, nil
}

func (e *httpVideoExecutor) download(ctx context.Context, rawURL, providerBaseURL string, limit int) (generatedMedia, error) {
	if _, err := validateGenerationResultURL(rawURL, providerBaseURL); err != nil {
		return generatedMedia{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return generatedMedia{}, err
	}
	request.Header.Set("Accept", "video/mp4,video/webm,application/octet-stream")
	response, err := e.client.Do(request)
	if err != nil {
		return generatedMedia{}, errGenerationDownloadFailed
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return generatedMedia{}, fmt.Errorf("video download returned HTTP %d", response.StatusCode)
	}
	data, err := readBounded(response.Body, int64(limit))
	return generatedMedia{Data: data, MIMEType: normalizeMediaMIME(response.Header.Get("Content-Type"))}, err
}

func (e *httpAudioExecutor) Generate(ctx context.Context, request audioGenerationRequest) (generatedMedia, error) {
	endpoint, err := generationProviderEndpoint(request.BaseURL, "/audio/speech")
	if err != nil {
		return generatedMedia{}, err
	}
	if request.Speed != 0 && (math.IsNaN(request.Speed) || request.Speed < 0.25 || request.Speed > 4) {
		return generatedMedia{}, errors.New("audio speed must be between 0.25 and 4.0")
	}
	payload := map[string]any{
		"model": request.Model, "input": request.Prompt, "voice": request.Voice, "response_format": request.Format,
	}
	// Omit unset optional fields so the provider default applies.
	if request.Speed != 0 {
		payload["speed"] = request.Speed
	}
	if instructions := strings.TrimSpace(request.Instructions); instructions != "" {
		payload["instructions"] = instructions
	}
	body, _ := json.Marshal(payload)
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return generatedMedia{}, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Authorization", "Bearer "+request.APIKey)
	response, err := e.client.Do(httpRequest)
	if err != nil {
		return generatedMedia{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
		return generatedMedia{}, fmt.Errorf("audio provider returned HTTP %d", response.StatusCode)
	}
	data, err := readBounded(response.Body, maxGeneratedAudioBytes)
	mimeType := normalizeMediaMIME(response.Header.Get("Content-Type"))
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = audioFormatMIME(request.Format)
	}
	return generatedMedia{Data: data, MIMEType: mimeType}, err
}

func generationProviderEndpoint(baseURL, suffix string) (string, error) {
	parsed, err := validateGenerationURL(baseURL)
	if err != nil {
		return "", err
	}
	basePath := strings.TrimRight(parsed.Path, "/")
	if !strings.HasSuffix(basePath, "/v1") && !strings.HasSuffix(basePath, "/api/v3") && !strings.HasSuffix(basePath, "/api/plan/v3") {
		basePath += "/v1"
	}
	parsed.Path = path.Clean(basePath + "/" + strings.TrimLeft(suffix, "/"))
	return parsed.String(), nil
}

func validateGenerationDownloadURL(rawURL string) (*url.URL, error) {
	if len(rawURL) > 32*1024 {
		return nil, errors.New("generation result URL exceeds size limit")
	}
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" || len(parsed.RawQuery) > 16*1024 {
		return nil, errors.New("invalid generation result URL")
	}
	if parsed.Scheme != "https" && (parsed.Scheme != "http" || !isExplicitLoopbackHost(parsed.Hostname())) {
		return nil, errors.New("generation result URL must use HTTPS")
	}
	return parsed, nil
}

// errGenerationDownloadFailed replaces raw transport errors on result
// downloads. Go's *url.Error embeds the full request URL, and provider result
// URLs are frequently presigned, so propagating the original error would write
// signature/credential query parameters into logs and job error details.
var errGenerationDownloadFailed = errors.New("generation result download failed")

// validateGenerationResultURL validates a provider-returned result URL.
// Result URLs are attacker-controlled, so loopback is only tolerated when the
// operator explicitly configured a loopback provider endpoint (local
// development and tests). Otherwise a malicious or compromised provider could
// make the server fetch its own internal services.
func validateGenerationResultURL(rawURL, providerBaseURL string) (*url.URL, error) {
	parsed, err := validateGenerationDownloadURL(rawURL)
	if err != nil {
		return nil, err
	}
	if isExplicitLoopbackHost(parsed.Hostname()) && !isLoopbackProviderEndpoint(providerBaseURL) {
		return nil, errors.New("generation result URL must not target a loopback address")
	}
	return parsed, nil
}

func isLoopbackProviderEndpoint(rawURL string) bool {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return false
	}
	return isExplicitLoopbackHost(parsed.Hostname())
}

func waitContext(ctx context.Context, duration time.Duration) error {
	if duration == 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func mediaMap(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func mediaString(value map[string]any, keys ...string) string {
	for _, key := range keys {
		if item, ok := value[key].(string); ok && strings.TrimSpace(item) != "" {
			return strings.TrimSpace(item)
		}
	}
	return ""
}

func mediaNestedString(value map[string]any, paths ...[]string) string {
	for _, parts := range paths {
		current := value
		for index, part := range parts {
			if index == len(parts)-1 {
				if text, ok := current[part].(string); ok && text != "" {
					return text
				}
				break
			}
			current = mediaMap(current[part])
			if current == nil {
				break
			}
		}
	}
	return ""
}

func mediaVideoURL(value map[string]any) string {
	paths := [][]string{
		{"url"}, {"video_url"}, {"videoUrl"}, {"output_url"}, {"download_url"},
		{"output", "url"}, {"output", "video_url"}, {"content", "video_url"},
		{"result", "url"}, {"result", "video_url"}, {"data", "url"},
		{"data", "output", "url"}, {"data", "result", "url"}, {"task", "output", "url"},
	}
	return mediaNestedString(value, paths...)
}

func mediaSuccessfulStatus(value string) bool {
	switch value {
	case "completed", "succeeded", "success", "done", "finished":
		return true
	default:
		return false
	}
}

func mediaFailedStatus(value string) bool {
	switch value {
	case "failed", "error", "cancelled", "canceled", "expired":
		return true
	default:
		return false
	}
}

func audioFormatMIME(format string) string {
	switch format {
	case "mp3":
		return "audio/mpeg"
	case "wav":
		return "audio/wav"
	case "pcm":
		return "audio/pcm"
	case "opus":
		return "audio/ogg"
	case "aac":
		return "audio/aac"
	case "flac":
		return "audio/flac"
	default:
		return "application/octet-stream"
	}
}
