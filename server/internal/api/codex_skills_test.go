package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestCodexSkillsCRUDToggleAndInvoke(t *testing.T) {
	root := t.TempDir()
	t.Setenv("OPENBOARD_CODEX_SKILLS_ROOT", root)
	handler := testHandler(t)

	created := request(t, handler, http.MethodPost, "/api/codex/skills", []byte(`{"id":"review-code","content":"# Review\n\nCheck tests."}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var skill codexSkillResponse
	if err := json.Unmarshal(created.Body.Bytes(), &skill); err != nil || skill.ID != "review-code" || !skill.Enabled || skill.Content == "" {
		t.Fatalf("created skill=%s", created.Body.String())
	}
	missingVersion := request(t, handler, http.MethodPost, "/api/codex/skills/review-code/toggle", []byte(`{"enabled":false}`))
	if missingVersion.Code != http.StatusPreconditionRequired {
		t.Fatalf("missing version status=%d body=%s", missingVersion.Code, missingVersion.Body.String())
	}

	listed := request(t, handler, http.MethodGet, "/api/codex/skills", nil)
	if listed.Code != http.StatusOK || !json.Valid(listed.Body.Bytes()) {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body.String())
	}
	var list struct {
		Skills []codexSkillResponse `json:"skills"`
	}
	if err := json.Unmarshal(listed.Body.Bytes(), &list); err != nil || len(list.Skills) != 1 || list.Skills[0].Content != "" {
		t.Fatalf("listed skills=%s", listed.Body.String())
	}

	disabled := skillRequest(t, handler, http.MethodPost, "/api/codex/skills/review-code/toggle", []byte(`{"enabled":false}`), skill.Version)
	if disabled.Code != http.StatusOK {
		t.Fatalf("disable status=%d body=%s", disabled.Code, disabled.Body.String())
	}
	var disabledSkill codexSkillResponse
	if json.Unmarshal(disabled.Body.Bytes(), &disabledSkill) != nil || disabledSkill.Enabled {
		t.Fatalf("disabled skill=%s", disabled.Body.String())
	}

	inactiveInvoke := request(t, handler, http.MethodPost, "/api/codex/skills/review-code/invoke", nil)
	if inactiveInvoke.Code != http.StatusConflict {
		t.Fatalf("inactive invoke status=%d body=%s", inactiveInvoke.Code, inactiveInvoke.Body.String())
	}

	if err := json.Unmarshal(disabled.Body.Bytes(), &disabledSkill); err != nil {
		t.Fatalf("disabled skill=%s", disabled.Body.String())
	}
	enabled := skillRequest(t, handler, http.MethodPost, "/api/codex/skills/review-code/toggle", []byte(`{"enabled":true}`), disabledSkill.Version)
	if enabled.Code != http.StatusOK {
		t.Fatalf("enable status=%d body=%s", enabled.Code, enabled.Body.String())
	}

	invoked := request(t, handler, http.MethodPost, "/api/codex/skills/review-code/invoke", nil)
	if invoked.Code != http.StatusOK {
		t.Fatalf("invoke status=%d body=%s", invoked.Code, invoked.Body.String())
	}
	var invocation struct {
		ID      string `json:"id"`
		Content string `json:"content"`
	}
	if json.Unmarshal(invoked.Body.Bytes(), &invocation) != nil || invocation.ID != "review-code" || invocation.Content == "" {
		t.Fatalf("invocation=%s", invoked.Body.String())
	}

	var enabledSkill codexSkillResponse
	if json.Unmarshal(enabled.Body.Bytes(), &enabledSkill) != nil {
		t.Fatalf("enabled skill=%s", enabled.Body.String())
	}
	updated := skillRequest(t, handler, http.MethodPut, "/api/codex/skills/review-code", []byte(`{"content":"# Updated\n\nRun lint."}`), enabledSkill.Version)
	if updated.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", updated.Code, updated.Body.String())
	}
	var updatedSkill codexSkillResponse
	if json.Unmarshal(updated.Body.Bytes(), &updatedSkill) != nil || updatedSkill.Content != "# Updated\n\nRun lint." {
		t.Fatalf("updated skill=%s", updated.Body.String())
	}

	conflict := skillRequest(t, handler, http.MethodPut, "/api/codex/skills/review-code", []byte(`{"content":"stale"}`), "stale-version")
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflict status=%d body=%s", conflict.Code, conflict.Body.String())
	}

	deleted := skillRequest(t, handler, http.MethodDelete, "/api/codex/skills/review-code", nil, updatedSkill.Version)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "review-code")); !os.IsNotExist(err) {
		t.Fatalf("skill directory still exists: %v", err)
	}
}

func skillRequest(t *testing.T, handler http.Handler, method, path string, body []byte, version string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if version != "" {
		req.Header.Set("If-Match", version)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func TestCodexSkillsRejectUnsafeIDsAndSymlinkedSkillDirectories(t *testing.T) {
	root := t.TempDir()
	t.Setenv("OPENBOARD_CODEX_SKILLS_ROOT", root)
	handler := testHandler(t)

	for _, id := range []string{"../escape", "nested/name", ".", "", "bad value"} {
		response := request(t, handler, http.MethodPost, "/api/codex/skills", []byte(`{"id":"`+id+`","content":"x"}`))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("id=%q status=%d body=%s", id, response.Code, response.Body.String())
		}
	}

	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte("# outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	listed := request(t, handler, http.MethodGet, "/api/codex/skills", nil)
	if listed.Code != http.StatusOK || listed.Body.String() == "" {
		t.Fatalf("symlink list status=%d body=%s", listed.Code, listed.Body.String())
	}
	get := request(t, handler, http.MethodGet, "/api/codex/skills/linked", nil)
	if get.Code != http.StatusNotFound {
		t.Fatalf("symlink get status=%d body=%s", get.Code, get.Body.String())
	}

	if oversized := request(t, handler, http.MethodPost, "/api/codex/skills", []byte(`{"id":"oversized","content":"`+strings.Repeat("x", codexSkillMaxBytes+1)+`"}`)); oversized.Code != http.StatusBadRequest {
		t.Fatalf("oversized status=%d body=%s", oversized.Code, oversized.Body.String())
	}
	conflicting := filepath.Join(root, "conflicting")
	if err := os.Mkdir(conflicting, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(conflicting, codexSkillFileName), []byte("active"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(conflicting, codexSkillDisabledFileName), []byte("disabled"), 0o600); err != nil {
		t.Fatal(err)
	}
	if both := request(t, handler, http.MethodGet, "/api/codex/skills/conflicting", nil); both.Code != http.StatusNotFound {
		t.Fatalf("conflicting files status=%d body=%s", both.Code, both.Body.String())
	}
	longHeading := filepath.Join(root, "long-heading")
	if err := os.Mkdir(longHeading, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(longHeading, codexSkillFileName), []byte("# "+strings.Repeat("x", codexSkillMaxDescription+100)), 0o600); err != nil {
		t.Fatal(err)
	}
	longHeadingResponse := request(t, handler, http.MethodGet, "/api/codex/skills/long-heading", nil)
	if longHeadingResponse.Code != http.StatusOK {
		t.Fatalf("long heading status=%d body=%s", longHeadingResponse.Code, longHeadingResponse.Body.String())
	}
	var longHeadingSkill codexSkillResponse
	if err := json.Unmarshal(longHeadingResponse.Body.Bytes(), &longHeadingSkill); err != nil {
		t.Fatal(err)
	}
	if len(longHeadingSkill.Description) > codexSkillMaxDescription {
		t.Fatalf("description was not bounded: %d", len(longHeadingSkill.Description))
	}
}

func TestCodexSkillsRejectSymlinkedRoot(t *testing.T) {
	target := t.TempDir()
	rootParent := t.TempDir()
	root := filepath.Join(rootParent, "skills")
	if err := os.Symlink(target, root); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENBOARD_CODEX_SKILLS_ROOT", root)
	handler := testHandler(t)
	response := request(t, handler, http.MethodGet, "/api/codex/skills", nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("symlinked root status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestCodexSkillsRejectAccountSessions(t *testing.T) {
	t.Setenv("OPENBOARD_CODEX_SKILLS_ROOT", t.TempDir())
	server := NewServer(t.TempDir())
	defer server.Close()
	router := chi.NewRouter()
	MountServer(router, server)
	handler := withActor(router, store.AuthUser{ID: "member-1", TenantID: "tenant-a", Role: "member", Status: "active"})
	response := request(t, handler, http.MethodGet, "/api/codex/skills", nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("account skill status=%d body=%s", response.Code, response.Body.String())
	}
}
