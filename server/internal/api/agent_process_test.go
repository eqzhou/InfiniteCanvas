package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeAgentCWDAllowsOnlyCanonicalDirectoriesWithinRoots(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "project", "nested")
	if err := os.MkdirAll(child, 0o700); err != nil {
		t.Fatal(err)
	}
	rootCanonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	childCanonical, err := filepath.EvalSymlinks(child)
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name      string
		requested string
		want      string
	}{
		{name: "allowlist root", requested: root, want: rootCanonical},
		{name: "nested directory", requested: filepath.Join(root, "project", ".", "nested"), want: childCanonical},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeAgentCWD(test.requested, []string{root})
			if err != nil {
				t.Fatalf("normalizeAgentCWD(%q): %v", test.requested, err)
			}
			if got != test.want {
				t.Fatalf("normalizeAgentCWD(%q) = %q, want %q", test.requested, got, test.want)
			}
			if !filepath.IsAbs(got) {
				t.Fatalf("normalized cwd is not absolute: %q", got)
			}
		})
	}

	t.Run("canonicalizes a symlinked allowlist root", func(t *testing.T) {
		rootAlias := filepath.Join(t.TempDir(), "allowed-link")
		if err := os.Symlink(root, rootAlias); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		got, err := normalizeAgentCWD(child, []string{rootAlias})
		if err != nil {
			t.Fatal(err)
		}
		if got != childCanonical {
			t.Fatalf("normalized cwd = %q, want %q", got, childCanonical)
		}
	})
}

func TestNormalizeAgentCWDRejectsEscapesAndNonDirectories(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "allowed")
	outside := filepath.Join(parent, "outside")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "not-a-directory.txt")
	if err := os.WriteFile(file, []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(root, "outside-link")
	symlinkErr := os.Symlink(outside, symlink)

	tests := []struct {
		name      string
		requested string
	}{
		{name: "parent traversal", requested: filepath.Join(root, "..", "outside")},
		{name: "missing path", requested: filepath.Join(root, "missing")},
		{name: "regular file", requested: file},
	}
	if symlinkErr == nil {
		tests = append(tests, struct {
			name      string
			requested string
		}{name: "symlink escape", requested: symlink})
	} else {
		t.Logf("symlink escape case unavailable: %v", symlinkErr)
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got, err := normalizeAgentCWD(test.requested, []string{root}); err == nil {
				t.Fatalf("normalizeAgentCWD(%q) = %q, want rejection", test.requested, got)
			}
		})
	}
}

func TestNormalizeAgentCWDRejectsSiblingWithAllowedPrefix(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "allowed")
	sibling := filepath.Join(parent, "allowed-evil")
	for _, directory := range []string{root, sibling} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := normalizeAgentCWD(sibling, []string{root}); err == nil {
		t.Fatalf("prefix sibling was accepted as cwd: %q", got)
	}
}

func TestSanitizedAgentEnvironmentFiltersServiceSecrets(t *testing.T) {
	input := []string{
		"PATH=/usr/local/bin:/usr/bin",
		"HOME=/home/agent",
		"TMPDIR=/tmp/agent",
		"LANG=en_US.UTF-8",
		"OPENBOARD_TOKEN=openboard-process-token",
		"OPENBOARD_SECRET_KEY=openboard-secret-key",
		"OPENBOARD_MASTER_KEY=openboard-master-key",
		"OPENBOARD_DATABASE_URL=postgres://user:password@database/openboard",
		"OPENBOARD_REDIS_URL=redis://:password@redis/0",
		"OPENBOARD_S3_ACCESS_KEY_ID=openboard-s3-access-key",
		"OPENBOARD_S3_SECRET_ACCESS_KEY=openboard-s3-secret",
		"OPENBOARD_S3_SESSION_TOKEN=openboard-s3-session",
		"OPENBOARD_LINUXDO_CLIENT_SECRET=linuxdo-secret",
		"DATABASE_URL=postgres://user:password@database/app",
		"REDIS_URL=redis://:password@redis/0",
		"ANTHROPIC_API_KEY=anthropic-secret",
		"OPENAI_API_KEY=openai-secret",
		"AWS_ACCESS_KEY_ID=access-key",
		"AWS_SECRET_ACCESS_KEY=aws-secret",
		"AWS_SESSION_TOKEN=aws-session",
		"OPENBOARD_FUTURE_SECRET=future-secret",
		"UNRELATED_SERVICE_PASSWORD=service-password",
	}

	got := sanitizedAgentEnvironment(input)
	values := environmentMap(t, got)
	for key, want := range map[string]string{
		"PATH":   "/usr/local/bin:/usr/bin",
		"HOME":   "/home/agent",
		"TMPDIR": "/tmp/agent",
		"LANG":   "en_US.UTF-8",
	} {
		if values[key] != want {
			t.Fatalf("safe environment %s = %q, want %q", key, values[key], want)
		}
	}
	for _, key := range []string{
		"OPENBOARD_TOKEN",
		"OPENBOARD_SECRET_KEY",
		"OPENBOARD_MASTER_KEY",
		"OPENBOARD_DATABASE_URL",
		"OPENBOARD_REDIS_URL",
		"OPENBOARD_S3_ACCESS_KEY_ID",
		"OPENBOARD_S3_SECRET_ACCESS_KEY",
		"OPENBOARD_S3_SESSION_TOKEN",
		"OPENBOARD_LINUXDO_CLIENT_SECRET",
		"DATABASE_URL",
		"REDIS_URL",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"OPENBOARD_FUTURE_SECRET",
		"UNRELATED_SERVICE_PASSWORD",
	} {
		if value, exists := values[key]; exists {
			t.Fatalf("service secret %s leaked to agent environment as %q", key, value)
		}
	}
}

func TestAccountAgentExecutionRequiresExplicitOptIn(t *testing.T) {
	authenticated := agentScope{tenantID: "tenant-a", userID: "user-a"}
	t.Setenv("OPENBOARD_AGENT_ACCOUNT_EXECUTION", "")
	if accountAgentExecutionAllowed(authenticated) {
		t.Fatal("account-owned host agent execution was enabled by default")
	}
	if !accountAgentExecutionAllowed(agentScope{}) {
		t.Fatal("auth-off local agent execution was disabled")
	}
	t.Setenv("OPENBOARD_AGENT_ACCOUNT_EXECUTION", "true")
	if !accountAgentExecutionAllowed(authenticated) {
		t.Fatal("explicit account execution opt-in was ignored")
	}
}

func TestAgentProcessEnvironmentKeepsLocalCLIAuthOutOfAccountSessions(t *testing.T) {
	input := []string{
		"PATH=/usr/bin",
		"OPENAI_API_KEY=local-openai",
		"ANTHROPIC_API_KEY=local-anthropic",
		"HTTPS_PROXY=https://proxy.example",
		"OPENBOARD_MASTER_KEY=must-never-pass",
	}
	local := environmentMap(t, agentProcessEnvironment(agentScope{}, input))
	for _, key := range []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HTTPS_PROXY"} {
		if local[key] == "" {
			t.Fatalf("auth-off local process lost %s", key)
		}
	}
	if _, exists := local["OPENBOARD_MASTER_KEY"]; exists {
		t.Fatal("server master key leaked to auth-off agent")
	}
	account := environmentMap(t, agentProcessEnvironment(agentScope{tenantID: "tenant-a", userID: "user-a"}, input))
	for _, key := range []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HTTPS_PROXY", "OPENBOARD_MASTER_KEY"} {
		if _, exists := account[key]; exists {
			t.Fatalf("account process received %s", key)
		}
	}
}

func environmentMap(t *testing.T, values []string) map[string]string {
	t.Helper()
	result := make(map[string]string, len(values))
	for _, entry := range values {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			t.Fatalf("invalid environment entry %q", entry)
		}
		if _, exists := result[key]; exists {
			t.Fatalf("duplicate environment entry %q", key)
		}
		result[key] = value
	}
	return result
}
