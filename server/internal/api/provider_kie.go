package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

const (
	kieDefaultUploadBaseURL      = "https://kieai.redpandaai.co"
	kieOfficialAPIHost           = "api.kie.ai"
	kieMaxConsecutivePollRetries = 3
	kieMaxRetryDelay             = 30 * time.Second
	kieMaxImageReferenceBytes    = 20 << 20
	kieMaxVideoReferenceBytes    = 64 << 20
	kieMaxAudioReferenceBytes    = 32 << 20
	kieMaxTaskResponseBytes      = 2 << 20
	kieMaxUploadResponseBytes    = 256 << 10
	kieMaxResultURLCount         = 8
)

type kieHTTPError struct {
	StatusCode int
	RetryAfter time.Duration
}

func (e *kieHTTPError) Error() string {
	return fmt.Sprintf("KIE provider returned HTTP %d", e.StatusCode)
}

type kieTaskStatus uint8

const (
	kieTaskPending kieTaskStatus = iota
	kieTaskSucceeded
	kieTaskFailed
)

type kieUploadedReferences struct {
	Images []string
	Videos []string
	Audios []string
}

func kieAPIEndpoint(baseURL, suffix string) (string, error) {
	parsed, err := validateGenerationURL(baseURL)
	if err != nil {
		return "", errors.New("invalid KIE provider URL")
	}
	basePath := strings.TrimRight(parsed.Path, "/")
	switch {
	case strings.HasSuffix(basePath, "/api/v1/jobs"):
		basePath = strings.TrimSuffix(basePath, "/jobs")
	case strings.HasSuffix(basePath, "/api/v1"):
	default:
		basePath += "/api/v1"
	}
	pathSuffix, rawQuery, _ := strings.Cut(suffix, "?")
	parsed.Path = path.Clean(basePath + "/" + strings.TrimLeft(pathSuffix, "/"))
	parsed.RawQuery = rawQuery
	return parsed.String(), nil
}

func kieUploadEndpoint(baseURL string) (string, error) {
	parsed, err := validateGenerationURL(baseURL)
	if err != nil {
		return "", errors.New("invalid KIE upload URL")
	}
	parsed.Path = path.Clean(strings.TrimRight(parsed.Path, "/") + "/api/file-stream-upload")
	return parsed.String(), nil
}

func kieReferenceUploadBaseURL(providerBaseURL, override string) (string, error) {
	if strings.TrimSpace(override) != "" {
		parsed, err := validateGenerationURL(override)
		if err != nil {
			return "", errors.New("invalid KIE upload URL")
		}
		return parsed.String(), nil
	}
	parsed, err := validateGenerationURL(providerBaseURL)
	if err != nil {
		return "", errors.New("invalid KIE provider URL")
	}
	if strings.EqualFold(parsed.Hostname(), kieOfficialAPIHost) {
		port := parsed.Port()
		if port != "" && port != "443" {
			return "", errors.New("invalid KIE provider port")
		}
		return kieDefaultUploadBaseURL, nil
	}
	return parsed.String(), nil
}

func kieClient(client *http.Client) *http.Client {
	clone := *client
	clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &clone
}

func kieJSONRequest(ctx context.Context, client *http.Client, baseURL, apiKey, method, suffix string, body any) (map[string]any, error) {
	endpoint, err := kieAPIEndpoint(baseURL, suffix)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		encoded, encodeErr := json.Marshal(body)
		if encodeErr != nil {
			return nil, errors.New("KIE request could not be encoded")
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, errors.New("KIE request could not be created")
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := kieClient(client).Do(request)
	if err != nil {
		return nil, fmt.Errorf("KIE provider request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2_048))
		return nil, &kieHTTPError{
			StatusCode: response.StatusCode,
			RetryAfter: kieRetryAfter(response.Header.Get("Retry-After"), time.Now()),
		}
	}
	limited := &io.LimitedReader{R: response.Body, N: kieMaxTaskResponseBytes + 1}
	decoder := json.NewDecoder(limited)
	decoder.UseNumber()
	var payload map[string]any
	if decoder.Decode(&payload) != nil || ensureJSONEOF(decoder) != nil || limited.N <= 0 || payload == nil {
		return nil, errors.New("KIE provider returned invalid JSON")
	}
	return payload, nil
}

func kieRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds < 1 {
			return 0
		}
		delay := time.Duration(seconds) * time.Second
		if delay > kieMaxRetryDelay {
			return kieMaxRetryDelay
		}
		return delay
	}
	date, err := http.ParseTime(value)
	if err != nil {
		return 0
	}
	delay := date.Sub(now)
	if delay <= 0 {
		return 0
	}
	if delay > kieMaxRetryDelay {
		return kieMaxRetryDelay
	}
	return delay
}

func retryKIEPoll(err error, fallback time.Duration) (time.Duration, bool) {
	if fallback > kieMaxRetryDelay {
		fallback = kieMaxRetryDelay
	}
	var responseError *kieHTTPError
	if errors.As(err, &responseError) {
		retryable := responseError.StatusCode == http.StatusRequestTimeout || responseError.StatusCode == http.StatusTooEarly ||
			responseError.StatusCode == http.StatusTooManyRequests || responseError.StatusCode >= 500
		if !retryable {
			return 0, false
		}
		if responseError.RetryAfter > fallback {
			return responseError.RetryAfter, true
		}
		return fallback, true
	}
	var transportError *url.Error
	if errors.As(err, &transportError) {
		return fallback, true
	}
	return 0, false
}

func uploadKIEReferences(ctx context.Context, client *http.Client, uploadBaseURL, apiKey string, references []generatedMedia) (kieUploadedReferences, error) {
	var result kieUploadedReferences
	for index, reference := range references {
		kind, mimeType, extension, limit, err := validateKIEReference(reference)
		if err != nil {
			return kieUploadedReferences{}, err
		}
		endpoint, err := kieUploadEndpoint(uploadBaseURL)
		if err != nil {
			return kieUploadedReferences{}, err
		}
		pipeReader, pipeWriter := io.Pipe()
		writer := multipart.NewWriter(pipeWriter)
		go func() {
			var writeErr error
			defer func() { _ = pipeWriter.CloseWithError(writeErr) }()
			if writeErr = writer.WriteField("uploadPath", kind+"s/user-uploads"); writeErr != nil {
				return
			}
			filename := "reference-" + strconv.Itoa(index+1) + extension
			if writeErr = writer.WriteField("fileName", filename); writeErr != nil {
				return
			}
			var part io.Writer
			part, writeErr = writer.CreateFormFile("file", filename)
			if writeErr != nil {
				return
			}
			_, writeErr = io.Copy(part, io.LimitReader(bytes.NewReader(reference.Data), int64(limit)+1))
			if writeErr == nil {
				writeErr = writer.Close()
			}
		}()
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, pipeReader)
		if err != nil {
			_ = pipeReader.CloseWithError(err)
			return kieUploadedReferences{}, errors.New("KIE upload request could not be created")
		}
		request.Header.Set("Authorization", "Bearer "+apiKey)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		response, err := kieClient(client).Do(request)
		if err != nil {
			_ = pipeReader.CloseWithError(err)
			return kieUploadedReferences{}, errors.New("KIE reference upload failed")
		}
		rawURL, readErr := readKIEUploadResponse(response, mimeType)
		response.Body.Close()
		if readErr != nil {
			return kieUploadedReferences{}, readErr
		}
		switch kind {
		case "image":
			result.Images = append(result.Images, rawURL)
		case "video":
			result.Videos = append(result.Videos, rawURL)
		case "audio":
			result.Audios = append(result.Audios, rawURL)
		}
	}
	return result, nil
}

func validateKIEReference(reference generatedMedia) (kind, mimeType, extension string, limit int, err error) {
	mimeType = normalizeMediaMIME(reference.MIMEType)
	if len(reference.Data) == 0 {
		return "", "", "", 0, errors.New("KIE reference is empty")
	}
	switch mimeType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		if len(reference.Data) > kieMaxImageReferenceBytes || sniffGeneratedImageMIME(reference.Data) != mimeType {
			return "", "", "", 0, errors.New("KIE image reference is invalid")
		}
		return "image", mimeType, imageExtension(mimeType), kieMaxImageReferenceBytes, nil
	case "video/mp4", "video/quicktime", "video/webm":
		detected := sniffGeneratedMediaMIME("video", reference.Data)
		if len(reference.Data) > kieMaxVideoReferenceBytes || (detected != mimeType && !(mimeType == "video/quicktime" && detected == "video/mp4")) {
			return "", "", "", 0, errors.New("KIE video reference is invalid")
		}
		extension = ".mp4"
		if mimeType == "video/quicktime" {
			extension = ".mov"
		}
		if mimeType == "video/webm" {
			extension = ".webm"
		}
		return "video", mimeType, extension, kieMaxVideoReferenceBytes, nil
	case "audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac":
		if len(reference.Data) > kieMaxAudioReferenceBytes || sniffGeneratedMediaMIME("audio", reference.Data) != mimeType {
			return "", "", "", 0, errors.New("KIE audio reference is invalid")
		}
		extension = map[string]string{"audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg", "audio/flac": ".flac", "audio/aac": ".aac"}[mimeType]
		return "audio", mimeType, extension, kieMaxAudioReferenceBytes, nil
	default:
		return "", "", "", 0, errors.New("KIE reference type is unsupported")
	}
}

func readKIEUploadResponse(response *http.Response, expectedMIME string) (string, error) {
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2_048))
		return "", fmt.Errorf("KIE upload returned HTTP %d", response.StatusCode)
	}
	limited := &io.LimitedReader{R: response.Body, N: kieMaxUploadResponseBytes + 1}
	var payload struct {
		Success bool `json:"success"`
		Code    any  `json:"code"`
		Data    struct {
			DownloadURL string `json:"downloadUrl"`
			FileURL     string `json:"fileUrl"`
			MIMEType    string `json:"mimeType"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(limited)
	if decoder.Decode(&payload) != nil || ensureJSONEOF(decoder) != nil || limited.N <= 0 || !payload.Success {
		return "", errors.New("KIE upload returned invalid JSON")
	}
	rawURL := strings.TrimSpace(payload.Data.DownloadURL)
	if rawURL == "" {
		rawURL = strings.TrimSpace(payload.Data.FileURL)
	}
	if _, err := validateGenerationDownloadURL(rawURL); err != nil {
		return "", errors.New("KIE upload returned an invalid URL")
	}
	if value := normalizeMediaMIME(payload.Data.MIMEType); value != "" && value != expectedMIME {
		return "", errors.New("KIE upload returned a mismatched media type")
	}
	return rawURL, nil
}

func kieImageInput(request imageGenerationRequest, references kieUploadedReferences) map[string]any {
	input := map[string]any{"prompt": request.Prompt, "aspect_ratio": kieAspectRatio(request.Size)}
	if request.Quality != "" {
		input["quality"] = request.Quality
	}
	if request.Count > 1 {
		input["num_images"] = request.Count
	}
	if len(references.Images) > 0 {
		input["image_urls"] = references.Images
	}
	return input
}

func kieVideoInput(request videoGenerationRequest, references kieUploadedReferences) map[string]any {
	input := map[string]any{"prompt": request.Prompt}
	if request.Ratio != "" {
		input["aspect_ratio"] = request.Ratio
	}
	if request.Resolution != "" {
		input["resolution"] = request.Resolution
	}
	if request.Seconds > 0 {
		input["duration"] = request.Seconds
	}
	if request.NegativePrompt != "" {
		input["negative_prompt"] = request.NegativePrompt
	}
	if request.GenerateAudio {
		input["generate_audio"] = true
	}
	if request.Watermark {
		input["watermark"] = true
	}
	if len(references.Images) > 0 {
		input["image_urls"] = references.Images
	}
	if len(references.Videos) > 0 {
		input["video_urls"] = references.Videos
	}
	if len(references.Audios) > 0 {
		input["audio_urls"] = references.Audios
	}
	return input
}

func kieAspectRatio(size string) string {
	if strings.Contains(size, ":") {
		return size
	}
	parts := strings.Split(size, "x")
	if len(parts) != 2 {
		return size
	}
	w, wErr := strconv.Atoi(parts[0])
	h, hErr := strconv.Atoi(parts[1])
	if wErr != nil || hErr != nil || w < 1 || h < 1 {
		return size
	}
	a, b := w, h
	for b != 0 {
		a, b = b, a%b
	}
	return strconv.Itoa(w/a) + ":" + strconv.Itoa(h/a)
}

func kieTaskID(payload map[string]any) string {
	data := mediaMap(payload["data"])
	return mediaString(data, "taskId", "task_id", "id")
}

func kieCreatedTaskID(payload map[string]any) string {
	code, ok := payload["code"]
	if !ok {
		return ""
	}
	switch value := code.(type) {
	case json.Number:
		if value.String() != "200" {
			return ""
		}
	case float64:
		if value != 200 {
			return ""
		}
	case string:
		if strings.TrimSpace(value) != "200" {
			return ""
		}
	default:
		return ""
	}
	taskID := kieTaskID(payload)
	if !validKIETaskID(taskID) {
		return ""
	}
	return taskID
}

func validKIETaskID(value string) bool {
	return len(value) > 0 && len(value) <= 1_000 && !strings.ContainsAny(value, "\r\n\x00")
}

func normalizeKIETask(payload map[string]any) (kieTaskStatus, []string, error) {
	data := mediaMap(payload["data"])
	if data == nil {
		return kieTaskFailed, nil, errors.New("KIE task response is missing data")
	}
	state := strings.ToLower(strings.TrimSpace(mediaString(data, "state", "status")))
	if state == "" && validKIETaskID(mediaString(data, "taskId", "task_id", "id")) {
		return kieTaskPending, nil, nil
	}
	switch state {
	case "waiting", "queuing", "generating", "pending", "running", "processing":
		return kieTaskPending, nil, nil
	case "fail", "failed", "error", "cancelled", "canceled":
		return kieTaskFailed, nil, errors.New("KIE task failed")
	case "success", "succeeded", "completed":
		urls, err := kieResultURLs(data["resultJson"])
		if err != nil {
			return kieTaskFailed, nil, err
		}
		return kieTaskSucceeded, urls, nil
	default:
		return kieTaskFailed, nil, errors.New("KIE task returned an unknown state")
	}
}

func kieResultURLs(value any) ([]string, error) {
	var result any
	switch typed := value.(type) {
	case string:
		if len(typed) == 0 || len(typed) > kieMaxTaskResponseBytes || json.Unmarshal([]byte(typed), &result) != nil {
			return nil, errors.New("KIE task returned invalid result JSON")
		}
	case map[string]any, []any:
		result = typed
	default:
		return nil, errors.New("KIE task returned invalid result JSON")
	}
	root, ok := result.(map[string]any)
	if !ok {
		return nil, errors.New("KIE task returned invalid result JSON")
	}
	var rawValues []any
	for _, key := range []string{"resultUrls", "result_urls", "urls"} {
		if values, exists := root[key].([]any); exists {
			rawValues = values
			break
		}
		if values, exists := root[key].([]string); exists {
			for _, item := range values {
				rawValues = append(rawValues, item)
			}
			break
		}
	}
	if len(rawValues) == 0 {
		for _, key := range []string{"resultUrl", "result_url", "videoUrl", "video_url", "imageUrl", "image_url", "url"} {
			if raw, ok := root[key].(string); ok {
				rawValues = []any{raw}
				break
			}
		}
	}
	if len(rawValues) == 0 || len(rawValues) > kieMaxResultURLCount {
		return nil, errors.New("KIE task returned an invalid result count")
	}
	urls := make([]string, 0, len(rawValues))
	for _, value := range rawValues {
		rawURL, ok := value.(string)
		if !ok {
			return nil, errors.New("KIE task returned an invalid result URL")
		}
		if _, err := validateGenerationDownloadURL(rawURL); err != nil {
			return nil, errors.New("KIE task returned an invalid result URL")
		}
		urls = append(urls, strings.TrimSpace(rawURL))
	}
	return urls, nil
}

func pollKIETask(ctx context.Context, client *http.Client, baseURL, apiKey, taskID string) (kieTaskStatus, []string, error) {
	if !validKIETaskID(taskID) {
		return kieTaskFailed, nil, errors.New("KIE task id is invalid")
	}
	payload, err := kieJSONRequest(ctx, client, baseURL, apiKey, http.MethodGet, "/jobs/recordInfo?taskId="+url.QueryEscape(taskID), nil)
	if err != nil {
		return kieTaskFailed, nil, err
	}
	return normalizeKIETask(payload)
}

func (e *openAIImageExecutor) generateKIEImageResumable(ctx context.Context, request imageGenerationRequest, existing *videoProviderCheckpoint, save func(videoProviderCheckpoint) error) ([]generatedImage, error) {
	if request.TransparentBackground {
		return nil, errors.New("KIE image provider does not support transparent background")
	}
	maxDuration := e.kieMaxDuration
	if maxDuration <= 0 {
		maxDuration = 15 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, maxDuration)
	defer cancel()
	taskID := ""
	if existing != nil {
		if existing.Protocol != "kie" || !validKIETaskID(existing.TaskID) {
			return nil, errors.New("KIE image checkpoint is invalid")
		}
		taskID = existing.TaskID
	} else {
		references := make([]generatedMedia, len(request.References))
		for index, reference := range request.References {
			references[index] = generatedMedia(reference)
		}
		uploadBase, err := kieReferenceUploadBaseURL(request.BaseURL, e.kieUploadBaseURL)
		if err != nil {
			return nil, err
		}
		uploaded, err := uploadKIEReferences(ctx, e.client, uploadBase, request.APIKey, references)
		if err != nil {
			return nil, err
		}
		payload, err := kieJSONRequest(ctx, e.client, request.BaseURL, request.APIKey, http.MethodPost, "/jobs/createTask", map[string]any{"model": request.Model, "input": kieImageInput(request, uploaded)})
		if err != nil {
			return nil, err
		}
		taskID = kieCreatedTaskID(payload)
		checkpoint := videoProviderCheckpoint{Protocol: "kie", TaskID: taskID}
		if !validVideoCheckpoint(checkpoint) || save == nil {
			return nil, errors.New("KIE image task id is missing")
		}
		if err := save(checkpoint); err != nil {
			return nil, err
		}
	}
	interval := e.kiePollInterval
	if interval < 0 {
		return nil, errors.New("invalid KIE poll interval")
	}
	consecutiveRetries := 0
	for {
		if err := waitContext(ctx, interval); err != nil {
			return nil, err
		}
		status, urls, err := pollKIETask(ctx, e.client, request.BaseURL, request.APIKey, taskID)
		if err != nil {
			if delay, retry := retryKIEPoll(err, interval); retry && consecutiveRetries < kieMaxConsecutivePollRetries {
				consecutiveRetries++
				if waitErr := waitContext(ctx, delay); waitErr != nil {
					return nil, waitErr
				}
				continue
			}
			return nil, err
		}
		consecutiveRetries = 0
		if status == kieTaskPending {
			continue
		}
		if status != kieTaskSucceeded || len(urls) < request.Count {
			return nil, errors.New("KIE image task returned insufficient results")
		}
		images := make([]generatedImage, 0, request.Count)
		for _, rawURL := range urls[:request.Count] {
			data, err := e.downloadImage(ctx, rawURL, request.BaseURL)
			if err != nil {
				return nil, errors.New("KIE image result download failed")
			}
			mimeType := sniffGeneratedImageMIME(data)
			if mimeType == "" {
				return nil, errors.New("KIE image result has an unsupported type")
			}
			images = append(images, generatedImage{Data: data, MIMEType: mimeType})
		}
		return images, nil
	}
}

func (e *httpVideoExecutor) createKIEVideo(ctx context.Context, request videoGenerationRequest) (map[string]any, error) {
	uploadBase, err := kieReferenceUploadBaseURL(request.BaseURL, e.kieUploadBaseURL)
	if err != nil {
		return nil, err
	}
	uploaded, err := uploadKIEReferences(ctx, e.client, uploadBase, request.APIKey, request.References)
	if err != nil {
		return nil, err
	}
	return kieJSONRequest(ctx, e.client, request.BaseURL, request.APIKey, http.MethodPost, "/jobs/createTask", map[string]any{"model": request.Model, "input": kieVideoInput(request, uploaded)})
}
