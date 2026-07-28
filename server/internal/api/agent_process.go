package api

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type agentScope struct {
	tenantID string
	userID   string
}

func requestAgentScope(r *http.Request) agentScope {
	if user, ok := authUserFrom(r.Context()); ok {
		return agentScope{tenantID: user.TenantID, userID: user.ID}
	}
	return agentScope{}
}

func accountAgentExecutionAllowed(scope agentScope) bool {
	if scope == (agentScope{}) {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(os.Getenv("OPENBOARD_AGENT_ACCOUNT_EXECUTION")), "true")
}

func authorizeAccountAgentExecution(w http.ResponseWriter, r *http.Request) bool {
	if accountAgentExecutionAllowed(requestAgentScope(r)) {
		return true
	}
	http.Error(w, "local CLI execution is disabled for account sessions", http.StatusForbidden)
	return false
}

type agentProfileKey struct {
	scope   agentScope
	profile string
}

func normalizeAgentCWD(requested string, roots []string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return "", errors.New("agent working directory is required")
	}
	candidate, err := filepath.Abs(requested)
	if err != nil {
		return "", errors.New("agent working directory is invalid")
	}
	candidate, err = filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", errors.New("agent working directory does not exist")
	}
	info, err := os.Stat(candidate)
	if err != nil || !info.IsDir() {
		return "", errors.New("agent working directory must be a directory")
	}
	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		absoluteRoot, rootErr := filepath.Abs(root)
		if rootErr != nil {
			continue
		}
		canonicalRoot, rootErr := filepath.EvalSymlinks(absoluteRoot)
		if rootErr != nil {
			continue
		}
		relative, relErr := filepath.Rel(canonicalRoot, candidate)
		if relErr == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return candidate, nil
		}
	}
	return "", errors.New("agent working directory is outside the allowed roots")
}

func configuredAgentRoots() []string {
	if configured := strings.TrimSpace(os.Getenv("OPENBOARD_AGENT_WORKSPACE_ROOTS")); configured != "" {
		return filepath.SplitList(configured)
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		return nil
	}
	return []string{workingDirectory}
}

func resolveAgentCWD(requested string) (string, error) {
	if strings.TrimSpace(requested) == "" {
		workingDirectory, err := os.Getwd()
		if err != nil {
			return "", errors.New("agent working directory is unavailable")
		}
		requested = workingDirectory
	}
	return normalizeAgentCWD(requested, configuredAgentRoots())
}

var agentEnvironmentAllowlist = map[string]struct{}{
	"COLORTERM": {}, "HOME": {}, "LANG": {}, "LOGNAME": {}, "NO_COLOR": {},
	"PATH": {}, "SHELL": {}, "TERM": {}, "TMPDIR": {}, "USER": {},
}

var localAgentCredentialAllowlist = map[string]struct{}{
	"ANTHROPIC_API_KEY": {}, "OPENAI_API_KEY": {},
	"HTTP_PROXY": {}, "HTTPS_PROXY": {}, "NO_PROXY": {},
	"http_proxy": {}, "https_proxy": {}, "no_proxy": {},
	"NODE_EXTRA_CA_CERTS": {}, "SSL_CERT_DIR": {}, "SSL_CERT_FILE": {},
}

func sanitizedAgentEnvironment(input []string) []string {
	return filterAgentEnvironment(input, agentEnvironmentAllowlist)
}

func agentProcessEnvironment(scope agentScope, input []string) []string {
	allowed := agentEnvironmentAllowlist
	if scope == (agentScope{}) {
		allowed = make(map[string]struct{}, len(agentEnvironmentAllowlist)+len(localAgentCredentialAllowlist))
		for key := range agentEnvironmentAllowlist {
			allowed[key] = struct{}{}
		}
		for key := range localAgentCredentialAllowlist {
			allowed[key] = struct{}{}
		}
	}
	return filterAgentEnvironment(input, allowed)
}

func filterAgentEnvironment(input []string, allowedKeys map[string]struct{}) []string {
	values := make(map[string]string)
	for _, entry := range input {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		_, allowed := allowedKeys[key]
		if !allowed && !strings.HasPrefix(key, "LC_") {
			continue
		}
		values[key] = value
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}
