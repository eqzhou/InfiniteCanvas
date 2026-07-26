package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

var blockedPromptSourcePrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001:db8::/32"),
}

func isBlockedPromptSourceAddress(address netip.Addr) bool {
	address = address.Unmap()
	if isUnsafeGenerationAddress(address) || !address.IsGlobalUnicast() {
		return true
	}
	for _, prefix := range blockedPromptSourcePrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func validateAdminPromptSourceURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("invalid prompt source URL")
	}
	if address, parseErr := netip.ParseAddr(parsed.Hostname()); parseErr == nil && isBlockedPromptSourceAddress(address) {
		return nil, errors.New("blocked prompt source URL")
	}
	return parsed, nil
}

func safePromptCatalogDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("prompt source host could not be resolved")
	}
	for _, candidate := range addresses {
		candidate = candidate.Unmap()
		if isBlockedPromptSourceAddress(candidate) {
			continue
		}
		dialer := net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
		return dialer.DialContext(ctx, network, net.JoinHostPort(candidate.String(), port))
	}
	return nil, errors.New("prompt source resolved to a blocked address")
}

func fetchAdminPromptCatalog(ctx context.Context, source adminPromptSource) ([]adminPromptEntry, error) {
	parsed, err := validateAdminPromptSourceURL(source.URL)
	if err != nil {
		return nil, err
	}
	if source.Format != "json" {
		return nil, errors.New("unsupported prompt source format")
	}
	transport := &http.Transport{Proxy: nil, DialContext: safePromptCatalogDialContext, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 10 * time.Second}
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("prompt source request failed")
	}
	defer response.Body.Close()
	return readAdminPromptCatalogResponse(response)
}

func readAdminPromptCatalogResponse(response *http.Response) ([]adminPromptEntry, error) {
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("prompt source returned HTTP %d", response.StatusCode)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || (mediaType != "application/json" && !strings.HasSuffix(mediaType, "+json")) {
		return nil, errors.New("prompt source content type is not JSON")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxAdminPromptBodyBytes+1))
	if err != nil || len(raw) > maxAdminPromptBodyBytes {
		return nil, errors.New("prompt source response exceeds size limit")
	}
	return parseAdminPromptSourceJSON(raw)
}

func parseAdminPromptSourceJSON(raw []byte) ([]adminPromptEntry, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var items []adminPromptEntry
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		if decoder.Decode(&items) != nil || ensureJSONEOF(decoder) != nil {
			return nil, errors.New("invalid prompt source JSON")
		}
	} else {
		var document struct {
			Items []adminPromptEntry `json:"items"`
		}
		if decoder.Decode(&document) != nil || ensureJSONEOF(decoder) != nil {
			return nil, errors.New("invalid prompt source JSON")
		}
		items = document.Items
	}
	if len(items) > maxAdminPromptEntries {
		return nil, errors.New("prompt source has too many items")
	}
	out := make([]adminPromptEntry, 0, len(items))
	for _, item := range items {
		normalized, err := normalizePromptEntry(item)
		if err != nil {
			return nil, err
		}
		out = append(out, normalized)
	}
	return out, nil
}
