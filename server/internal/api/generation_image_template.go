package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	maxImageTemplateBytes   = 128 << 10
	maxImageTemplateDepth   = 20
	maxImageTemplateEntries = 10_000
)

var imageTemplateFieldPath = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,15}$`)
var imageTemplatePlaceholder = regexp.MustCompile(`^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$`)

var allowedImageTemplatePlaceholders = map[string]struct{}{
	"prompt": {}, "model": {}, "size": {}, "quality": {}, "count": {},
	"duration": {}, "ratio": {}, "resolution": {}, "transparentBackground": {},
	"referenceImages": {}, "referenceVideos": {}, "referenceAudios": {},
}

type imageProviderTemplate struct {
	Method                        string          `json:"method"`
	Path                          string          `json:"path"`
	Auth                          string          `json:"auth"`
	Request                       json.RawMessage `json:"request"`
	ResponsePath                  string          `json:"responsePath"`
	TaskIDPath                    string          `json:"taskIdPath,omitempty"`
	StatusPath                    string          `json:"statusPath,omitempty"`
	ResultPath                    string          `json:"resultPath,omitempty"`
	SupportsTransparentBackground bool            `json:"supportsTransparentBackground,omitempty"`
}

func validateImageProviderTemplate(template *imageProviderTemplate) error {
	if template == nil || len(template.Path) > 8*1024 ||
		(template.Method != http.MethodPost && template.Method != http.MethodPut) ||
		(template.Auth != "bearer" && template.Auth != "x-api-key") || !validImageTemplatePath(template.Path) ||
		!imageTemplateFieldPath.MatchString(template.ResponsePath) {
		return errors.New("invalid image provider template")
	}
	for _, value := range []string{template.TaskIDPath, template.StatusPath, template.ResultPath} {
		if value != "" && !imageTemplateFieldPath.MatchString(value) {
			return errors.New("invalid image provider template field path")
		}
	}
	if len(template.Request) < 2 || len(template.Request) > maxImageTemplateBytes {
		return errors.New("image provider template request exceeds limits")
	}
	root, err := decodeImageTemplateRequest(template.Request)
	if err != nil {
		return err
	}
	entries := 0
	return validateImageTemplateValue(root, 0, &entries)
}

func validImageTemplatePath(value string) bool {
	if !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") ||
		strings.ContainsAny(value, "?#\\") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == ".." {
			return false
		}
	}
	return true
}

func decodeImageTemplateRequest(raw json.RawMessage) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil || ensureJSONEOF(decoder) != nil {
		return nil, errors.New("invalid image provider template request")
	}
	root, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("image provider template request must be an object")
	}
	return root, nil
}

func validateImageTemplateValue(value any, depth int, entries *int) error {
	if depth > maxImageTemplateDepth {
		return errors.New("image provider template exceeds depth limit")
	}
	switch typed := value.(type) {
	case nil, bool:
		return nil
	case json.Number:
		value, err := typed.Float64()
		if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
			return errors.New("image provider template contains invalid number")
		}
		return nil
	case string:
		if match := imageTemplatePlaceholder.FindStringSubmatch(typed); match != nil {
			if _, ok := allowedImageTemplatePlaceholders[match[1]]; !ok {
				return errors.New("unsupported image provider template placeholder")
			}
			return nil
		}
		if strings.Contains(typed, "{{") || strings.Contains(typed, "}}") {
			return errors.New("invalid image provider template placeholder")
		}
		return nil
	case []any:
		*entries += len(typed)
		if *entries > maxImageTemplateEntries {
			return errors.New("image provider template exceeds entry limit")
		}
		for _, item := range typed {
			if err := validateImageTemplateValue(item, depth+1, entries); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		*entries += len(typed)
		if *entries > maxImageTemplateEntries {
			return errors.New("image provider template exceeds entry limit")
		}
		for key, item := range typed {
			if key == "__proto__" || key == "prototype" || key == "constructor" {
				return errors.New("image provider template contains unsafe key")
			}
			if err := validateImageTemplateValue(item, depth+1, entries); err != nil {
				return err
			}
		}
		return nil
	default:
		return errors.New("image provider template contains unsupported value")
	}
}

func compileImageProviderTemplate(template *imageProviderTemplate, request imageGenerationRequest) ([]byte, error) {
	if err := validateImageProviderTemplate(template); err != nil {
		return nil, err
	}
	references := make([]string, 0, len(request.References))
	for _, reference := range request.References {
		if reference.MIMEType != "image/png" && reference.MIMEType != "image/jpeg" {
			return nil, errors.New("image template reference type is unsupported")
		}
		references = append(references, "data:"+reference.MIMEType+";base64,"+base64.StdEncoding.EncodeToString(reference.Data))
	}
	values := map[string]any{
		"prompt": request.Prompt, "model": request.Model, "size": request.Size, "resolution": request.Resolution,
		"quality": request.Quality, "count": request.Count,
		"transparentBackground": request.TransparentBackground, "referenceImages": references,
	}
	return compileGenerationProviderTemplate(template, values, maxImageProviderResponseBytes)
}

func compileGenerationProviderTemplate(template *imageProviderTemplate, values map[string]any, maxBytes int) ([]byte, error) {
	if maxBytes < 1 {
		return nil, errors.New("invalid compiled provider template size limit")
	}
	if err := validateImageProviderTemplate(template); err != nil {
		return nil, err
	}
	root, err := decodeImageTemplateRequest(template.Request)
	if err != nil {
		return nil, err
	}
	compiled, err := replaceImageTemplateValues(root, values)
	if err != nil {
		return nil, err
	}
	if _, err := generationTemplateJSONSize(compiled, maxBytes); err != nil {
		return nil, err
	}
	body, err := json.Marshal(compiled)
	if err != nil || len(body) > maxBytes {
		return nil, errors.New("compiled image provider template exceeds size limit")
	}
	return body, nil
}

func generationTemplateJSONSize(value any, maximum int) (int, error) {
	add := func(total, amount int) (int, error) {
		if amount < 0 || total > maximum-amount {
			return 0, errors.New("compiled image provider template exceeds size limit")
		}
		return total + amount, nil
	}
	var visit func(any, int) (int, error)
	visit = func(current any, total int) (int, error) {
		switch typed := current.(type) {
		case nil:
			return add(total, 4)
		case bool:
			if typed {
				return add(total, 4)
			}
			return add(total, 5)
		case int:
			return add(total, len(fmt.Sprintf("%d", typed)))
		case json.Number:
			return add(total, len(typed.String()))
		case string:
			return add(total, generationTemplateJSONStringSize(typed))
		case []string:
			var err error
			if total, err = add(total, 2); err != nil {
				return 0, err
			}
			for index, item := range typed {
				if index > 0 {
					if total, err = add(total, 1); err != nil {
						return 0, err
					}
				}
				if total, err = visit(item, total); err != nil {
					return 0, err
				}
			}
			return total, nil
		case []any:
			var err error
			if total, err = add(total, 2); err != nil {
				return 0, err
			}
			for index, item := range typed {
				if index > 0 {
					if total, err = add(total, 1); err != nil {
						return 0, err
					}
				}
				if total, err = visit(item, total); err != nil {
					return 0, err
				}
			}
			return total, nil
		case map[string]any:
			var err error
			if total, err = add(total, 2); err != nil {
				return 0, err
			}
			index := 0
			for key, item := range typed {
				if index > 0 {
					if total, err = add(total, 1); err != nil {
						return 0, err
					}
				}
				if total, err = add(total, generationTemplateJSONStringSize(key)+1); err != nil {
					return 0, err
				}
				if total, err = visit(item, total); err != nil {
					return 0, err
				}
				index++
			}
			return total, nil
		default:
			return 0, errors.New("compiled image provider template contains unsupported value")
		}
	}
	return visit(value, 0)
}

func generationTemplateJSONStringSize(value string) int {
	size := 2
	for len(value) > 0 {
		r, width := utf8.DecodeRuneInString(value)
		value = value[width:]
		switch r {
		case '"', '\\', '\b', '\f', '\n', '\r', '\t':
			size += 2
		case '<', '>', '&', '\u2028', '\u2029':
			size += 6
		default:
			if r < 0x20 {
				size += 6
			} else {
				size += width
			}
		}
	}
	return size
}

func replaceImageTemplateValues(value any, values map[string]any) (any, error) {
	switch typed := value.(type) {
	case string:
		if match := imageTemplatePlaceholder.FindStringSubmatch(typed); match != nil {
			value, ok := values[match[1]]
			if !ok {
				return nil, nil
			}
			return value, nil
		}
		return typed, nil
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			replaced, err := replaceImageTemplateValues(item, values)
			if err != nil {
				return nil, err
			}
			result[index] = replaced
		}
		return result, nil
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			replaced, err := replaceImageTemplateValues(item, values)
			if err != nil {
				return nil, err
			}
			result[key] = replaced
		}
		return result, nil
	default:
		return typed, nil
	}
}

func imageTemplateEndpoint(baseURL string, template *imageProviderTemplate) (string, error) {
	if err := validateImageProviderTemplate(template); err != nil {
		return "", err
	}
	parsed, err := validateGenerationURL(baseURL)
	if err != nil {
		return "", err
	}
	base := strings.TrimRight(parsed.String(), "/")
	endpoint, err := url.Parse(base + template.Path)
	if err != nil {
		return "", errors.New("invalid image provider template endpoint")
	}
	return endpoint.String(), nil
}

func readImageTemplatePath(value any, fieldPath string) (any, error) {
	if !imageTemplateFieldPath.MatchString(fieldPath) {
		return nil, errors.New("invalid image provider template response path")
	}
	current := value
	for _, segment := range strings.Split(fieldPath, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("image provider template response field is missing: %s", fieldPath)
		}
		current, ok = object[segment]
		if !ok {
			return nil, fmt.Errorf("image provider template response field is missing: %s", fieldPath)
		}
	}
	return current, nil
}

func decodeTemplateDataImage(value string) ([]byte, string, error) {
	var prefix, mimeType string
	switch {
	case strings.HasPrefix(value, "data:image/png;base64,"):
		prefix, mimeType = "data:image/png;base64,", "image/png"
	case strings.HasPrefix(value, "data:image/jpeg;base64,"):
		prefix, mimeType = "data:image/jpeg;base64,", "image/jpeg"
	default:
		return nil, "", errors.New("image provider template returned an unsupported data URL")
	}
	encoded := strings.TrimPrefix(value, prefix)
	if len(encoded) > base64.StdEncoding.EncodedLen(maxGeneratedImageBytes)+4 {
		return nil, "", errors.New("image provider template result exceeds size limit")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) < 1 || len(data) > maxGeneratedImageBytes {
		return nil, "", errors.New("image provider template returned invalid base64")
	}
	return data, mimeType, nil
}
