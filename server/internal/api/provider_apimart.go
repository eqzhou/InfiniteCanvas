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
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var apimartElementNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)

type apimartHTTPError struct {
	StatusCode int
	RetryAfter time.Duration
}

func isAPIMartSeedanceModel(model string) bool {
	capability, ok := resolveProviderModelCapability("apimart", "video", model)
	return ok && capability.Family == "seedance-2.0"
}

func (e *apimartHTTPError) Error() string {
	return fmt.Sprintf("APIMart provider returned HTTP %d", e.StatusCode)
}

func validateAPIMartVideoRequest(request videoGenerationRequest) error {
	capability, supported := resolveProviderModelCapability("apimart", "video", request.Model)
	if !supported {
		return errors.New("unsupported APIMart video model")
	}
	if capability.Family == "seedance-2.0" {
		return validateAPIMartSeedanceRequest(request, capability)
	}
	if len(request.Prompt) > 2_500 || request.Seconds < 1 || request.Seconds > 15 || len(request.NegativePrompt) > 2_500 ||
		len(request.References) > capability.MaxImageReferences {
		return errors.New("invalid APIMart video parameters")
	}
	if request.Ratio != "16:9" && request.Ratio != "9:16" && request.Ratio != "1:1" {
		return errors.New("invalid APIMart video aspect ratio")
	}
	for _, reference := range request.References {
		if reference.MIMEType != "image/png" && reference.MIMEType != "image/jpeg" &&
			reference.MIMEType != "image/webp" && reference.MIMEType != "image/gif" {
			return errors.New("APIMart video references must be images")
		}
	}
	mode := request.Mode
	if mode == "" {
		mode = "std"
	}
	switch capability.Family {
	case "kling-2.6":
		if (mode != "std" && mode != "pro") || (request.Seconds != 5 && request.Seconds != 10) {
			return errors.New("invalid Kling 2.6 mode or duration")
		}
		if mode == "std" && (request.GenerateAudio || len(request.References) > 1) {
			return errors.New("Kling 2.6 standard mode does not support audio or a last frame")
		}
		if request.GenerateAudio && len(request.References) > 1 {
			return errors.New("Kling 2.6 audio and last frame are mutually exclusive")
		}
		if request.MultiShot || len(request.Shots) > 0 || len(request.Elements) > 0 {
			return errors.New("Kling 2.6 does not support Kling 3 controls")
		}
	case "kling-3":
		if request.Seconds < 3 || request.Seconds > 15 {
			return errors.New("invalid Kling 3 duration")
		}
		if mode != "std" && mode != "pro" && mode != "4k" {
			return errors.New("invalid Kling 3 mode")
		}
		if request.MultiShot {
			if request.ShotType != "customize" && request.ShotType != "intelligence" {
				return errors.New("invalid Kling 3 shot type")
			}
			if request.ShotType == "customize" {
				if len(request.Shots) < 1 || len(request.Shots) > 6 {
					return errors.New("invalid Kling 3 shot count")
				}
				total := 0
				for index, shot := range request.Shots {
					if shot.Index != index+1 || len(strings.TrimSpace(shot.Prompt)) < 1 || len(shot.Prompt) > 512 ||
						shot.Duration < 1 || shot.Duration > request.Seconds {
						return errors.New("invalid Kling 3 shot")
					}
					total += shot.Duration
				}
				if total != request.Seconds {
					return errors.New("Kling 3 shot durations must equal total duration")
				}
			}
		} else if len(request.Shots) > 0 {
			return errors.New("Kling 3 shots require multi-shot mode")
		}
		if len(request.Elements) > 3 {
			return errors.New("invalid Kling 3 element count")
		}
		names := make(map[string]struct{}, len(request.Elements))
		for _, element := range request.Elements {
			if !apimartElementNamePattern.MatchString(element.Name) || len(element.Description) < 1 ||
				len(element.Description) > 1_000 || len(element.ImageURLs) < 2 || len(element.ImageURLs) > 4 {
				return errors.New("invalid Kling 3 element")
			}
			if _, duplicate := names[element.Name]; duplicate {
				return errors.New("duplicate Kling 3 element")
			}
			names[element.Name] = struct{}{}
			for _, rawURL := range element.ImageURLs {
				if err := validateAPIMartPublicURL(rawURL); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func validateAPIMartSeedanceRequest(request videoGenerationRequest, capability providerModelCapability) error {
	if request.Seconds < capability.MinDuration || request.Seconds > capability.MaxDuration ||
		!containsAPIMartString(capability.Ratios, request.Ratio) ||
		!containsAPIMartString(capability.Resolutions, strings.ToLower(strings.TrimSpace(request.Resolution))) ||
		len(request.References) > capability.MaxImageReferences {
		return errors.New("invalid APIMart Seedance parameters")
	}
	if !strings.EqualFold(strings.TrimSpace(request.Model), "doubao-seedance-2.0-mini") && len(request.Prompt) > 4_000 {
		return errors.New("APIMart Seedance prompt exceeds model limit")
	}
	if strings.TrimSpace(request.Prompt) == "" && len(request.References) == 0 {
		return errors.New("APIMart Seedance text generation requires a prompt")
	}
	if request.Ratio == "adaptive" && len(request.References) == 0 {
		return errors.New("APIMart Seedance adaptive ratio requires input media")
	}
	if (request.Mode != "" && request.Mode != "std") || request.NegativePrompt != "" || request.Watermark ||
		request.MultiShot || request.ShotType != "" || len(request.Shots) > 0 || len(request.Elements) > 0 {
		return errors.New("APIMart Seedance request contains unsupported controls")
	}
	for _, reference := range request.References {
		if reference.MIMEType != "image/png" && reference.MIMEType != "image/jpeg" &&
			reference.MIMEType != "image/webp" && reference.MIMEType != "image/gif" {
			return errors.New("APIMart Seedance local video/audio references lack a documented upload transport")
		}
	}
	if normalizeVideoFrameMode(request.FrameMode) == "first-last" && (len(request.References) < 1 || len(request.References) > 2) {
		return errors.New("APIMart Seedance first/last frame mode requires one or two images")
	}
	return nil
}

func validateAPIMartPublicURL(rawURL string) error {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("invalid APIMart public reference URL")
	}
	// These URLs are forwarded to APIMart, which fetches them server-side, so a
	// literal internal address would turn the provider into an SSRF proxy for
	// this deployment's network. Reject non-public literal IP hosts.
	if address, parseErr := netip.ParseAddr(parsed.Hostname()); parseErr == nil {
		if isUnsafeGenerationAddress(address.Unmap()) {
			return errors.New("APIMart public reference URL must not target an internal address")
		}
	}
	return nil
}

func apimartJSONRequest(ctx context.Context, client *http.Client, baseURL, apiKey, method, suffix string, body any) (map[string]any, error) {
	endpoint, err := generationProviderEndpoint(baseURL, suffix)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		encoded, encodeErr := json.Marshal(body)
		if encodeErr != nil {
			return nil, encodeErr
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2_048))
		return nil, &apimartHTTPError{StatusCode: response.StatusCode, RetryAfter: apimartRetryAfter(response.Header.Get("Retry-After"))}
	}
	limited := &io.LimitedReader{R: response.Body, N: maxMediaProviderJSONBytes + 1}
	decoder := json.NewDecoder(limited)
	decoder.UseNumber()
	var payload map[string]any
	if decoder.Decode(&payload) != nil || ensureJSONEOF(decoder) != nil || limited.N <= 0 || payload == nil {
		return nil, errors.New("APIMart provider returned invalid JSON")
	}
	if code, ok := payload["code"].(json.Number); ok && code.String() != "200" {
		return nil, errors.New("APIMart provider rejected the request")
	}
	return payload, nil
}

func apimartRetryAfter(value string) time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || seconds < 1 {
		return 0
	}
	if seconds > 30 {
		seconds = 30
	}
	return time.Duration(seconds) * time.Second
}

func retryAPIMartPoll(err error, fallback time.Duration) (time.Duration, bool) {
	var responseError *apimartHTTPError
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

func (e *httpVideoExecutor) createAPIMartVideo(ctx context.Context, request videoGenerationRequest) (map[string]any, error) {
	imageURLs, err := uploadAPIMartImages(ctx, e.client, request.BaseURL, request.APIKey, request.References)
	if err != nil {
		return nil, err
	}
	capability, supported := resolveProviderModelCapability("apimart", "video", request.Model)
	if supported {
		request.Model = capability.Model
	}
	if supported && capability.Family == "seedance-2.0" {
		return e.createAPIMartSeedanceVideo(ctx, request, imageURLs)
	}
	mode := request.Mode
	if mode == "" {
		mode = "std"
	}
	body := map[string]any{
		"model": request.Model, "prompt": request.Prompt, "mode": mode, "duration": request.Seconds,
		"aspect_ratio": request.Ratio, "audio": request.GenerateAudio, "watermark": request.Watermark,
	}
	if request.NegativePrompt != "" {
		body["negative_prompt"] = request.NegativePrompt
	}
	if len(imageURLs) > 0 {
		body["image_urls"] = imageURLs
	}
	if request.MultiShot {
		body["multi_shot"] = true
		body["shot_type"] = request.ShotType
		if request.ShotType == "customize" {
			body["multi_prompt"] = request.Shots
		}
	}
	if len(request.Elements) > 0 {
		elements := make([]map[string]any, len(request.Elements))
		for index, element := range request.Elements {
			elements[index] = map[string]any{
				"name": element.Name, "description": element.Description, "element_input_urls": element.ImageURLs,
			}
		}
		body["element_list"] = elements
	}
	return apimartJSONRequest(ctx, e.client, request.BaseURL, request.APIKey, http.MethodPost, "/videos/generations", body)
}

func (e *httpVideoExecutor) createAPIMartSeedanceVideo(ctx context.Context, request videoGenerationRequest, imageURLs []string) (map[string]any, error) {
	body := map[string]any{
		"model": request.Model, "duration": request.Seconds, "size": request.Ratio,
		"resolution": strings.ToLower(strings.TrimSpace(request.Resolution)), "generate_audio": request.GenerateAudio,
	}
	if request.Prompt != "" {
		body["prompt"] = request.Prompt
	}
	if len(imageURLs) > 0 {
		if normalizeVideoFrameMode(request.FrameMode) == "first-last" {
			roles := make([]map[string]string, len(imageURLs))
			for index, imageURL := range imageURLs {
				role := "first_frame"
				if index == 1 {
					role = "last_frame"
				}
				roles[index] = map[string]string{"url": imageURL, "role": role}
			}
			body["image_with_roles"] = roles
		} else {
			body["image_urls"] = imageURLs
		}
	}
	return apimartJSONRequest(ctx, e.client, request.BaseURL, request.APIKey, http.MethodPost, "/videos/generations", body)
}

func uploadAPIMartImages(ctx context.Context, client *http.Client, baseURL, apiKey string, references []generatedMedia) ([]string, error) {
	result := make([]string, 0, len(references))
	for _, reference := range references {
		if reference.MIMEType != "image/png" && reference.MIMEType != "image/jpeg" && reference.MIMEType != "image/webp" && reference.MIMEType != "image/gif" {
			return nil, errors.New("APIMart reference type is unsupported")
		}
		if len(reference.Data) < 1 || len(reference.Data) > 20<<20 {
			return nil, errors.New("APIMart reference exceeds size limit")
		}
		endpoint, err := generationProviderEndpoint(baseURL, "/uploads/images")
		if err != nil {
			return nil, err
		}
		buffer := new(bytes.Buffer)
		writer := multipart.NewWriter(buffer)
		extension := imageExtension(reference.MIMEType)
		part, err := writer.CreateFormFile("file", "reference"+extension)
		if err != nil {
			return nil, err
		}
		if _, err = part.Write(reference.Data); err != nil {
			return nil, err
		}
		if err = writer.Close(); err != nil {
			return nil, err
		}
		httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, buffer)
		if err != nil {
			return nil, err
		}
		httpRequest.Header.Set("Authorization", "Bearer "+apiKey)
		httpRequest.Header.Set("Content-Type", writer.FormDataContentType())
		response, err := client.Do(httpRequest)
		if err != nil {
			return nil, err
		}
		payload, readErr := readAPIMartUploadResponse(response)
		response.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		result = append(result, payload)
	}
	return result, nil
}

func readAPIMartUploadResponse(response *http.Response) (string, error) {
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2_048))
		return "", fmt.Errorf("APIMart upload returned HTTP %d", response.StatusCode)
	}
	limited := &io.LimitedReader{R: response.Body, N: maxMediaProviderJSONBytes + 1}
	var payload struct {
		URL string `json:"url"`
	}
	decoder := json.NewDecoder(limited)
	if decoder.Decode(&payload) != nil || ensureJSONEOF(decoder) != nil || limited.N <= 0 {
		return "", errors.New("APIMart upload returned invalid JSON")
	}
	if err := validateAPIMartPublicURL(payload.URL); err != nil {
		return "", err
	}
	return payload.URL, nil
}

func apimartTaskID(payload map[string]any) string {
	if direct := mediaString(payload, "id", "task_id", "taskId"); direct != "" {
		return direct
	}
	if data := mediaMap(payload["data"]); data != nil {
		return mediaString(data, "id", "task_id", "taskId")
	}
	if data, ok := payload["data"].([]any); ok && len(data) > 0 {
		return mediaString(mediaMap(data[0]), "id", "task_id", "taskId")
	}
	return ""
}

func apimartVideoResultURL(payload map[string]any) string {
	data := mediaMap(payload["data"])
	result := mediaMap(data["result"])
	videos, _ := result["videos"].([]any)
	if len(videos) == 0 {
		return ""
	}
	video := mediaMap(videos[0])
	if raw := mediaString(video, "url", "video_url", "videoUrl"); raw != "" {
		return raw
	}
	if values, ok := video["url"].([]any); ok && len(values) > 0 {
		value, _ := values[0].(string)
		return strings.TrimSpace(value)
	}
	return ""
}

func (e *openAIImageExecutor) generateAPIMart(ctx context.Context, request imageGenerationRequest) ([]generatedImage, error) {
	return e.GenerateResumable(ctx, request, nil, func(videoProviderCheckpoint) error { return nil })
}

func (e *openAIImageExecutor) GenerateResumable(ctx context.Context, request imageGenerationRequest, existing *videoProviderCheckpoint, save func(videoProviderCheckpoint) error) ([]generatedImage, error) {
	if request.Protocol == "kie" {
		return e.generateKIEImageResumable(ctx, request, existing, save)
	}
	capability, supported := resolveProviderModelCapability("apimart", "image", request.Model)
	if !supported {
		return nil, errors.New("unsupported APIMart image model")
	}
	request.Model = capability.Model
	size := apimartImageSize(request.Size)
	quality := request.Quality
	if quality == "" {
		quality = "auto"
	}
	if request.Count < 1 || request.Count > capability.MaxOutputs || len(request.References) > capability.MaxImageReferences ||
		!containsAPIMartString(capability.Sizes, size) || !containsAPIMartString(capability.Qualities, quality) {
		return nil, errors.New("invalid APIMart image parameters")
	}
	maxDuration := e.apimartMaxDuration
	if maxDuration <= 0 {
		maxDuration = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, maxDuration)
	defer cancel()
	taskID := ""
	if existing != nil {
		if existing.Protocol != "apimart" || !validAPIMartTaskID(existing.TaskID) {
			return nil, errors.New("APIMart image checkpoint is invalid")
		}
		taskID = existing.TaskID
	} else {
		references := make([]generatedMedia, len(request.References))
		for index, reference := range request.References {
			references[index] = generatedMedia(reference)
		}
		imageURLs, err := uploadAPIMartImages(ctx, e.client, request.BaseURL, request.APIKey, references)
		if err != nil {
			return nil, err
		}
		body := map[string]any{
			"model": request.Model, "prompt": request.Prompt, "size": size,
			"quality": quality, "n": request.Count,
		}
		if request.TransparentBackground {
			body["background"] = "transparent"
		}
		if len(imageURLs) > 0 {
			body["image_urls"] = imageURLs
		}
		created, err := apimartJSONRequest(ctx, e.client, request.BaseURL, request.APIKey, http.MethodPost, "/images/generations", body)
		if err != nil {
			return nil, err
		}
		taskID = apimartTaskID(created)
		checkpoint := videoProviderCheckpoint{Protocol: "apimart", TaskID: taskID}
		if !validAPIMartTaskID(taskID) || save == nil {
			return nil, errors.New("APIMart image task id is missing")
		}
		if err := save(checkpoint); err != nil {
			return nil, err
		}
	}
	interval := e.apimartPollInterval
	if interval < 0 {
		return nil, errors.New("invalid APIMart poll interval")
	}
	for {
		if err := waitContext(ctx, interval); err != nil {
			return nil, err
		}
		payload, err := apimartJSONRequest(ctx, e.client, request.BaseURL, request.APIKey, http.MethodGet,
			"/tasks/"+url.PathEscape(taskID), nil)
		if err != nil {
			if delay, retry := retryAPIMartPoll(err, interval); retry {
				if waitErr := waitContext(ctx, delay); waitErr != nil {
					return nil, waitErr
				}
				continue
			}
			return nil, err
		}
		status := strings.ToLower(mediaNestedString(payload, []string{"status"}, []string{"data", "status"}))
		if mediaFailedStatus(status) {
			return nil, errors.New("APIMart image provider reported terminal failure")
		}
		if !mediaSuccessfulStatus(status) {
			continue
		}
		urls := apimartImageResultURLs(payload)
		if len(urls) < request.Count || len(urls) > 8 {
			return nil, errors.New("APIMart image provider returned an invalid result count")
		}
		images := make([]generatedImage, 0, request.Count)
		for _, rawURL := range urls[:request.Count] {
			data, err := e.downloadImage(ctx, rawURL, request.BaseURL)
			if err != nil {
				return nil, err
			}
			images = append(images, generatedImage{Data: data, MIMEType: sniffGeneratedImageMIME(data)})
		}
		return images, nil
	}
}

func containsAPIMartString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func apimartImageSize(value string) string {
	if ratio, ok := map[string]string{
		"1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3",
		"1792x1024": "7:4", "1024x1792": "4:7",
	}[value]; ok {
		return ratio
	}
	parts := strings.Split(value, "x")
	if len(parts) == 2 {
		width, widthErr := strconv.Atoi(parts[0])
		height, heightErr := strconv.Atoi(parts[1])
		if widthErr == nil && heightErr == nil && width == height && width > 0 {
			return "1:1"
		}
	}
	return value
}

func validAPIMartTaskID(value string) bool {
	return len(value) > 0 && len(value) <= 1_000 && !strings.ContainsAny(value, "\r\n\x00")
}

func apimartImageResultURLs(payload map[string]any) []string {
	data := mediaMap(payload["data"])
	result := mediaMap(data["result"])
	items, _ := result["images"].([]any)
	urls := make([]string, 0)
	for _, item := range items {
		value := mediaMap(item)
		if raw := mediaString(value, "url"); raw != "" {
			urls = append(urls, raw)
			continue
		}
		values, _ := value["url"].([]any)
		for _, candidate := range values {
			if raw, ok := candidate.(string); ok && strings.TrimSpace(raw) != "" {
				urls = append(urls, strings.TrimSpace(raw))
			}
		}
	}
	return urls
}
