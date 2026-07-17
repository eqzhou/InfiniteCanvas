package mcpserver

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const maxRemoteResponseBytes = 32 << 20

type connectionConfig struct {
	BaseURL string `json:"baseUrl"`
	Token   string `json:"token"`
}

type remoteExecutor struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewRemote(connectionFile string) (*Server, error) {
	info, err := os.Stat(connectionFile)
	if err != nil {
		return nil, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("OpenBoard connection file permissions must be 0600")
	}
	data, err := os.ReadFile(connectionFile)
	if err != nil {
		return nil, err
	}
	var config connectionConfig
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || ensureDecoderEOF(decoder) != nil {
		return nil, errors.New("OpenBoard connection file is invalid")
	}
	baseURL, err := validateConnectionURL(config.BaseURL)
	if err != nil {
		return nil, err
	}
	if len(config.Token) > 64*1024 {
		return nil, errors.New("OpenBoard connection token is too large")
	}
	return newWithExecutor(&remoteExecutor{
		baseURL: baseURL,
		token:   config.Token,
		client:  &http.Client{Timeout: 35 * time.Second},
	}), nil
}

func validateConnectionURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return "", errors.New("OpenBoard connection URL is invalid")
	}
	host, _, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		return "", errors.New("OpenBoard connection URL requires an explicit port")
	}
	ip := net.ParseIP(host)
	loopback := strings.EqualFold(host, "localhost") || ip != nil && ip.IsLoopback()
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback) {
		return "", errors.New("OpenBoard connection URL must use HTTPS or loopback HTTP")
	}
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

func (r *remoteExecutor) ExecuteTool(tool string, arguments json.RawMessage) (any, error) {
	body, err := json.Marshal(map[string]any{"tool": tool, "arguments": arguments})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodPost, r.baseURL+"/api/agent/execute", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if r.token != "" {
		request.Header.Set("Authorization", "Bearer "+r.token)
	}
	response, err := r.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call OpenBoard local server: %w", err)
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, maxRemoteResponseBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(data) > maxRemoteResponseBytes {
		return nil, errors.New("OpenBoard local server response is too large")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("OpenBoard local server returned HTTP %d", response.StatusCode)
	}
	var envelope struct {
		OK   bool `json:"ok"`
		Data any  `json:"data"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&envelope) != nil || ensureDecoderEOF(decoder) != nil || !envelope.OK {
		return nil, errors.New("OpenBoard local server response is invalid")
	}
	return envelope.Data, nil
}

func ensureDecoderEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("multiple JSON values")
	}
	return nil
}
