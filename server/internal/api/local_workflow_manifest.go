package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
)

const maxLocalWorkflowManifestBytes = 256 << 10

var localWorkflowField = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)

type localWorkflowNode struct {
	ID     string            `json:"id"`
	Type   string            `json:"type"`
	Inputs map[string]string `json:"inputs"`
}

type localWorkflowLimits struct {
	MaxSeconds int `json:"maxSeconds"`
	MaxWidth   int `json:"maxWidth"`
	MaxHeight  int `json:"maxHeight"`
}

type localWorkflowManifest struct {
	Version      int                 `json:"version"`
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Endpoint     string              `json:"endpoint"`
	AllowPrivate bool                `json:"allowPrivate,omitempty"`
	BusinessMode string              `json:"businessMode"`
	Nodes        []localWorkflowNode `json:"nodes"`
	Outputs      []string            `json:"outputs"`
	Limits       localWorkflowLimits `json:"limits"`
	ContractHash string              `json:"-"`
}

var allowedLocalWorkflowNodes = map[string]struct{}{
	"LoadImage": {}, "LoadAudio": {}, "CLIPTextEncode": {}, "KSampler": {}, "VAEDecode": {},
	"ImageScale": {}, "VideoCombine": {}, "SaveImage": {}, "SaveVideo": {}, "SaveAudio": {},
}

var allowedLocalWorkflowModes = map[string]struct{}{
	"text_to_image": {}, "image_to_image": {}, "text_to_audio": {},
	"text_to_video": {}, "first_frame_to_video": {}, "first_last_frame_to_video": {}, "reference_to_video": {},
}

var allowedLocalWorkflowPlaceholders = map[string]struct{}{
	"${prompt}": {}, "${negativePrompt}": {}, "${references}": {}, "${firstFrame}": {}, "${lastFrame}": {},
	"${seed}": {}, "${width}": {}, "${height}": {}, "${duration}": {},
}

func validateLocalWorkflowEndpoint(raw string, allowPrivate bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return errors.New("local workflow endpoint is invalid")
	}
	host := strings.TrimSpace(parsed.Hostname())
	if host == "" {
		return errors.New("local workflow endpoint host is required")
	}
	if strings.EqualFold(host, "localhost") {
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return errors.New("local workflow endpoint scheme is invalid")
		}
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return errors.New("local workflow endpoint must use a literal loopback or private address")
	}
	if ip.IsLoopback() {
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return errors.New("local workflow endpoint scheme is invalid")
		}
		return nil
	}
	if !allowPrivate || !ip.IsPrivate() || parsed.Scheme != "https" {
		return errors.New("local workflow private endpoint requires explicit permission and HTTPS")
	}
	return nil
}

func validateLocalWorkflowManifest(manifest localWorkflowManifest) error {
	if manifest.Version != 1 || !validProjectID(manifest.ID) || !validFilmText(manifest.Name, 200, true) {
		return errors.New("local workflow identity is invalid")
	}
	if _, ok := allowedLocalWorkflowModes[manifest.BusinessMode]; !ok {
		return errors.New("local workflow business mode is unsupported")
	}
	if err := validateLocalWorkflowEndpoint(manifest.Endpoint, manifest.AllowPrivate); err != nil {
		return err
	}
	if len(manifest.Nodes) == 0 || len(manifest.Nodes) > 128 || len(manifest.Outputs) == 0 || len(manifest.Outputs) > 8 {
		return errors.New("local workflow graph exceeds its limits")
	}
	if manifest.Limits.MaxSeconds < 1 || manifest.Limits.MaxSeconds > 900 || manifest.Limits.MaxWidth < 64 || manifest.Limits.MaxWidth > 4096 || manifest.Limits.MaxHeight < 64 || manifest.Limits.MaxHeight > 4096 || int64(manifest.Limits.MaxWidth)*int64(manifest.Limits.MaxHeight) > 16_777_216 {
		return errors.New("local workflow resource limits are invalid")
	}
	nodes := make(map[string]struct{}, len(manifest.Nodes))
	for _, node := range manifest.Nodes {
		if !validProjectID(node.ID) || len(node.Inputs) > 64 {
			return errors.New("local workflow node is invalid")
		}
		if _, duplicate := nodes[node.ID]; duplicate {
			return errors.New("local workflow node ids must be unique")
		}
		nodes[node.ID] = struct{}{}
		if _, allowed := allowedLocalWorkflowNodes[node.Type]; !allowed {
			return errors.New("local workflow node type is not allowed")
		}
		for key, value := range node.Inputs {
			if !localWorkflowField.MatchString(key) || len(value) > 2_000 {
				return errors.New("local workflow node input is invalid")
			}
			if strings.Contains(value, "${") {
				if _, allowed := allowedLocalWorkflowPlaceholders[value]; !allowed {
					return errors.New("local workflow placeholder is not allowed")
				}
			}
		}
	}
	seenOutputs := map[string]struct{}{}
	expectedOutputKind, err := localWorkflowBusinessKind(manifest.BusinessMode)
	if err != nil {
		return err
	}
	for _, output := range manifest.Outputs {
		if _, exists := nodes[output]; !exists {
			return errors.New("local workflow output node is missing")
		}
		if _, duplicate := seenOutputs[output]; duplicate {
			return errors.New("local workflow outputs must be unique")
		}
		seenOutputs[output] = struct{}{}
		for _, node := range manifest.Nodes {
			if node.ID == output && localWorkflowSaveNodeKind(node.Type) != expectedOutputKind {
				return errors.New("local workflow output type does not match business mode")
			}
		}
	}
	return nil
}

func localWorkflowBusinessKind(mode string) (string, error) {
	switch mode {
	case "text_to_image", "image_to_image":
		return "image", nil
	case "text_to_audio":
		return "audio", nil
	case "text_to_video", "first_frame_to_video", "first_last_frame_to_video", "reference_to_video":
		return "video", nil
	default:
		return "", errors.New("local workflow business mode is unsupported")
	}
}

func localWorkflowSaveNodeKind(nodeType string) string {
	switch nodeType {
	case "SaveImage":
		return "image"
	case "SaveVideo":
		return "video"
	case "SaveAudio":
		return "audio"
	default:
		return ""
	}
}

func localWorkflowOutputKind(manifest localWorkflowManifest) (string, error) {
	if err := validateLocalWorkflowManifest(manifest); err != nil {
		return "", err
	}
	return localWorkflowBusinessKind(manifest.BusinessMode)
}

func decodeLocalWorkflowManifest(raw []byte) (localWorkflowManifest, error) {
	if len(raw) == 0 || len(raw) > maxLocalWorkflowManifestBytes {
		return localWorkflowManifest{}, errors.New("local workflow manifest exceeds its limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var manifest localWorkflowManifest
	if decoder.Decode(&manifest) != nil || ensureJSONEOF(decoder) != nil {
		return localWorkflowManifest{}, errors.New("local workflow manifest JSON is invalid")
	}
	if err := validateLocalWorkflowManifest(manifest); err != nil {
		return localWorkflowManifest{}, err
	}
	canonical, err := json.Marshal(manifest)
	if err != nil {
		return localWorkflowManifest{}, err
	}
	digest := sha256.Sum256(canonical)
	manifest.ContractHash = hex.EncodeToString(digest[:])
	return manifest, nil
}
