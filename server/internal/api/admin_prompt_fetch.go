package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
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
	if source.Format != "json" && source.Format != "markdown" {
		return nil, errors.New("unsupported prompt source format")
	}
	transport := &http.Transport{Proxy: nil, DialContext: safePromptCatalogDialContext, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 10 * time.Second}
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	if source.Format == "markdown" {
		request.Header.Set("Accept", "text/markdown, text/plain;q=0.9")
	} else {
		request.Header.Set("Accept", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("prompt source request failed")
	}
	defer response.Body.Close()
	return readAdminPromptCatalogResponse(response, source.Format)
}

func readAdminPromptCatalogResponse(response *http.Response, requestedFormat ...string) ([]adminPromptEntry, error) {
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("prompt source returned HTTP %d", response.StatusCode)
	}
	format := "json"
	if len(requestedFormat) > 0 && requestedFormat[0] == "markdown" {
		format = "markdown"
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if format == "json" {
		// GitHub Raw serves repository JSON files as text/plain. The source
		// format is explicit and the body is still decoded with strict JSON,
		// so accepting that MIME type does not turn arbitrary text into rows.
		if err != nil || (mediaType != "application/json" && mediaType != "text/plain" && !strings.HasSuffix(mediaType, "+json")) {
			return nil, errors.New("prompt source content type is not JSON")
		}
	} else if err != nil || (mediaType != "text/markdown" && mediaType != "text/plain" && mediaType != "text/x-markdown") {
		return nil, errors.New("prompt source content type is not Markdown")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxAdminPromptBodyBytes+1))
	if err != nil || len(raw) > maxAdminPromptBodyBytes {
		return nil, errors.New("prompt source response exceeds size limit")
	}
	if format == "markdown" {
		return parseAdminPromptSourceMarkdown(raw)
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

var adminPromptEnumerationPattern = regexp.MustCompile(`^(?:[一二三四五六七八九十百千万]+|[0-9]+)(?:\s*[、.)：:]\s*|\s+)`)
var adminMarkdownFencePattern = regexp.MustCompile("^\\s*(`{3,}|~{3,})(.*)$")
var adminMarkdownHeadingPattern = regexp.MustCompile(`^(#{2,5})\s+(.+?)\s*$`)
var adminMarkdownNumberedPattern = regexp.MustCompile(`^\s*(\d+)[.)、]\s+(.+?)\s*$`)

var adminMarkdownPromptPattern = regexp.MustCompile("(?is)(?:提示词(?:文本)?|prompt)\\s*[:：]?\\s*(?:```|~~~)([^\\n]*)\\r?\\n(.*?)\\r?\\n(?:```|~~~)")
var adminMarkdownBodyPattern = regexp.MustCompile("(?s)(?:```|~~~)([^\\n]*)\\r?\\n(.*?)\\r?\\n(?:```|~~~)")

type adminMarkdownHeading struct {
	level int
	title string
	index int
}

func adminMarkdownHeadings(text string) []adminMarkdownHeading {
	var headings []adminMarkdownHeading
	fenceCharacter := byte(0)
	fenceLength := 0
	for offset := 0; offset < len(text); {
		end := strings.IndexByte(text[offset:], '\n')
		lineEnd := len(text)
		if end >= 0 {
			lineEnd = offset + end
		}
		line := strings.TrimSuffix(text[offset:lineEnd], "\r")
		if fence := adminMarkdownFencePattern.FindStringSubmatch(line); fence != nil {
			marker := fence[1][0]
			if fenceCharacter == 0 {
				fenceCharacter, fenceLength = marker, len(fence[1])
			} else if marker == fenceCharacter && len(fence[1]) >= fenceLength {
				fenceCharacter, fenceLength = 0, 0
			}
		} else if fenceCharacter == 0 {
			if match := adminMarkdownHeadingPattern.FindStringSubmatch(line); match != nil {
				headings = append(headings, adminMarkdownHeading{level: len(match[1]), title: strings.TrimSpace(match[2]), index: offset})
			}
		}
		if end < 0 {
			break
		}
		offset = lineEnd + 1
	}
	return headings
}

func adminMarkdownFenceBodies(block string, textOnly bool) []string {
	var bodies []string
	for _, match := range adminMarkdownBodyPattern.FindAllStringSubmatch(block, -1) {
		language := strings.ToLower(strings.TrimSpace(match[1]))
		if textOnly && language != "" && language != "text" && language != "prompt" && language != "plain" && language != "markdown" && language != "md" {
			continue
		}
		body := strings.TrimSpace(match[2])
		if body != "" {
			bodies = append(bodies, body)
		}
	}
	return bodies
}

func adminMarkdownTags(title string) []string {
	cleaned := adminPromptEnumerationPattern.ReplaceAllString(strings.TrimSpace(title), "")
	cleaned = strings.TrimSpace(strings.NewReplacer("/", "、", "&", "、", "与", "、", ",", "、", "，", "、").Replace(cleaned))
	parts := strings.Split(cleaned, "、")
	tags := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" && len(part) <= 100 {
			tags = append(tags, part)
		}
		if len(tags) >= 64 {
			break
		}
	}
	return tags
}

type adminMarkdownNumberedPrompt struct {
	ordinal   string
	firstLine string
	body      string
}

func adminMarkdownNumberedPrompts(block string) []adminMarkdownNumberedPrompt {
	type pending struct {
		ordinal string
		lines   []string
	}
	var entries []pending
	var current *pending
	flush := func() {
		if current == nil {
			return
		}
		entries = append(entries, *current)
		current = nil
	}
	for _, line := range strings.Split(block, "\n") {
		if match := adminMarkdownNumberedPattern.FindStringSubmatch(line); match != nil {
			flush()
			current = &pending{ordinal: match[1], lines: []string{match[2]}}
			continue
		}
		if current != nil && strings.TrimSpace(line) != "" {
			current.lines = append(current.lines, strings.TrimSpace(line))
		}
	}
	flush()
	out := make([]adminMarkdownNumberedPrompt, 0, len(entries))
	promptPrefix := regexp.MustCompile(`(?i)^(?:提示词(?:文本)?|prompt)\s*[:：]\s*`)
	for _, entry := range entries {
		body := strings.TrimSpace(strings.Join(entry.lines, "\n"))
		body = promptPrefix.ReplaceAllString(body, "")
		if body == "" {
			continue
		}
		firstLine := promptPrefix.ReplaceAllString(strings.TrimSpace(entry.lines[0]), "")
		cleanFirstLine := strings.TrimSpace(firstLine)
		if cleanFirstLine == "说明" || cleanFirstLine == "说明：" ||
			cleanFirstLine == "备注" || cleanFirstLine == "备注：" ||
			cleanFirstLine == "对应案例图" || cleanFirstLine == "图片链接" ||
			strings.HasPrefix(body, "http://") || strings.HasPrefix(body, "https://") {
			continue
		}
		out = append(out, adminMarkdownNumberedPrompt{
			ordinal:   entry.ordinal,
			firstLine: strings.TrimSpace(firstLine),
			body:      body,
		})
	}
	return out
}

func expandAdminMarkdownNumberedPrompt(entry adminMarkdownNumberedPrompt) []adminMarkdownNumberedPrompt {
	lines := strings.Split(entry.body, "\n")
	bullets := make([]string, 0)
	bulletPattern := regexp.MustCompile("^\\s*[-*]\\s+(.+?)\\s*$")
	for _, line := range lines[1:] {
		if match := bulletPattern.FindStringSubmatch(line); match != nil {
			bullets = append(bullets, strings.TrimSpace(match[1]))
		}
	}
	if strings.Contains(entry.firstLine, "#") && len(bullets) > 0 {
		out := make([]adminMarkdownNumberedPrompt, 0, len(bullets))
		for index, body := range bullets {
			out = append(out, adminMarkdownNumberedPrompt{
				ordinal:   entry.ordinal + "." + fmt.Sprint(index+1),
				firstLine: body,
				body:      body,
			})
		}
		return out
	}
	return []adminMarkdownNumberedPrompt{entry}
}

func parseAdminPromptSourceMarkdown(raw []byte) ([]adminPromptEntry, error) {
	text := string(raw)
	headings := adminMarkdownHeadings(text)
	if len(headings) < 2 {
		return nil, errors.New("prompt source Markdown has no structured headings")
	}
	parentTags := []string{}
	sectionTags := []string{}
	items := make([]adminPromptEntry, 0)
	identityCounts := map[string]int{}
	for index := 0; index < len(headings); index++ {
		current := headings[index]
		if current.level <= 2 {
			parentTags = adminMarkdownTags(current.title)
			sectionTags = append([]string(nil), parentTags...)
			continue
		}
		nextIndex := index + 1
		nextLevel := 0
		end := len(text)
		if nextIndex < len(headings) {
			nextLevel = headings[nextIndex].level
			end = headings[nextIndex].index
		}
		block := text[current.index:end]
		title := strings.TrimSpace(current.title)
		if current.level >= 5 && (strings.Contains(strings.ToLower(title), "prompt") ||
			strings.Contains(title, "提示词") || strings.Contains(title, "指令") ||
			strings.Contains(title, "关键词") || strings.Contains(title, "可直接复用") ||
			strings.Contains(title, "摘录")) {
			numbered := adminMarkdownNumberedPrompts(block)
			for _, numberedEntry := range numbered {
				for _, prompt := range expandAdminMarkdownNumberedPrompt(numberedEntry) {
					itemTitle := prompt.firstLine
					if itemTitle == "" {
						itemTitle = title + " · " + prompt.ordinal
					}
					identity := title + "\x00" + prompt.ordinal + "\x00" + prompt.body
					identityCounts[identity]++
					hash := sha256.Sum256([]byte(identity + fmt.Sprintf("\x00%d", identityCounts[identity])))
					normalized, err := normalizePromptEntry(adminPromptEntry{
						ID:    fmt.Sprintf("md_%x", hash[:16]),
						Title: itemTitle,
						Body:  prompt.body,
						Tags:  append([]string(nil), sectionTags...),
					})
					if err != nil {
						return nil, err
					}
					items = append(items, normalized)
					if len(items) > maxAdminPromptEntries {
						return nil, errors.New("prompt source has too many items")
					}
				}
			}
			continue
		}
		labeled := adminMarkdownPromptPattern.FindStringSubmatch(block)
		bodies := []string{}
		if len(labeled) > 2 {
			bodies = append(bodies, strings.TrimSpace(labeled[2]))
		}
		if len(bodies) == 0 && current.level >= 3 &&
			(strings.Contains(strings.ToLower(title), "prompt") || strings.Contains(title, "提示词")) {
			bodies = adminMarkdownFenceBodies(block, false)
		}
		if current.level == 3 {
			// Every H3 starts a new entry/category scope. Never inherit a
			// preceding sibling category's tags.
			sectionTags = append([]string(nil), parentTags...)
		}
		if current.level == 3 && len(bodies) == 0 {
			nextHeading := ""
			if nextIndex < len(headings) {
				nextHeading = strings.ToLower(headings[nextIndex].title)
			}
			if nextLevel == 4 && (strings.Contains(nextHeading, "prompt") || strings.Contains(headings[nextIndex].title, "提示词")) {
				if nextIndex+1 < len(headings) {
					end = headings[nextIndex+1].index
				} else {
					end = len(text)
				}
				block = text[current.index:end]
				bodies = adminMarkdownFenceBodies(block, false)
				index = nextIndex
			} else if nextLevel >= 4 {
				sectionTags = append(append([]string(nil), parentTags...), adminMarkdownTags(title)...)
				if len(sectionTags) > 64 {
					sectionTags = sectionTags[:64]
				}
				continue
			} else {
				continue
			}
		}
		if current.level >= 4 && len(bodies) == 0 {
			bodies = adminMarkdownFenceBodies(block, true)
		}
		if len(bodies) == 0 {
			continue
		}
		body := bodies[0]
		identity := title + "\x00" + body
		identityCounts[identity]++
		hash := sha256.Sum256([]byte(identity + fmt.Sprintf("\x00%d", identityCounts[identity])))
		item := adminPromptEntry{
			ID:    fmt.Sprintf("md_%x", hash[:16]),
			Title: title,
			Body:  body,
			Tags:  append([]string(nil), sectionTags...),
		}
		normalized, err := normalizePromptEntry(item)
		if err != nil {
			return nil, err
		}
		items = append(items, normalized)
		if len(items) > maxAdminPromptEntries {
			return nil, errors.New("prompt source has too many items")
		}
	}
	if len(items) == 0 {
		return nil, errors.New("prompt source Markdown has no prompt entries")
	}
	return items, nil
}
