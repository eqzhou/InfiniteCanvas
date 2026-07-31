package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func promptCatalogHandler(t *testing.T, backend *memoryStore, actor store.AuthUser, fetcher promptCatalogFetchFunc) http.Handler {
	_, handler := promptCatalogServerHandler(t, backend, actor, fetcher)
	return handler
}

func promptCatalogServerHandler(t *testing.T, backend *memoryStore, actor store.AuthUser, fetcher promptCatalogFetchFunc) (*Server, http.Handler) {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	server := NewServerWithStore(t.TempDir(), backend)
	server.promptCatalogFetcher = fetcher
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r = r.WithContext(context.WithValue(r.Context(), authUserKey, actor))
			next.ServeHTTP(w, r)
		})
	})
	MountServer(router, server)
	return server, router
}

func TestAdminPromptCatalogCRUDAndBulkDelete(t *testing.T) {
	backend := newMemoryStore()
	owner := store.AuthUser{ID: "owner-1", TenantID: "tenant-a", Role: "owner", Status: "active"}
	seedAdminUser(backend, owner)
	handler := promptCatalogHandler(t, backend, owner, nil)

	category := request(t, handler, http.MethodPost, "/api/admin/prompt-categories", []byte(`{"id":"product","name":"产品摄影","order":1}`))
	if category.Code != http.StatusCreated {
		t.Fatalf("category = %d %s", category.Code, category.Body.String())
	}
	prompt := request(t, handler, http.MethodPost, "/api/admin/prompts", []byte(`{"id":"prompt-1","categoryId":"product","title":"棚拍","body":"Studio light","tags":["product"],"sourceId":"spoofed","updatedAt":"2000-01-01T00:00:00Z"}`))
	if prompt.Code != http.StatusCreated {
		t.Fatalf("prompt = %d %s", prompt.Code, prompt.Body.String())
	}

	listed := request(t, handler, http.MethodGet, "/api/prompt-catalog", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("list = %d %s", listed.Code, listed.Body.String())
	}
	var catalog adminPromptCatalog
	if err := json.Unmarshal(listed.Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	if catalog.Revision != 2 || len(catalog.Categories) != 1 || len(catalog.Prompts) != 1 {
		t.Fatalf("catalog = %#v", catalog)
	}
	if catalog.Prompts[0].SourceID != "" || catalog.Prompts[0].UpdatedAt == "2000-01-01T00:00:00Z" {
		t.Fatalf("server-owned fields accepted: %#v", catalog.Prompts[0])
	}
	revalidated := httptest.NewRecorder()
	revalidateRequest := httptest.NewRequest(http.MethodGet, "/api/prompt-catalog", nil)
	revalidateRequest.Header.Set("If-None-Match", listed.Header().Get("ETag"))
	handler.ServeHTTP(revalidated, revalidateRequest)
	if revalidated.Code != http.StatusNotModified {
		t.Fatalf("revalidate = %d %s", revalidated.Code, revalidated.Body.String())
	}

	deleted := request(t, handler, http.MethodPost, "/api/admin/prompts/bulk-delete", []byte(`{"ids":["prompt-1","prompt-1"]}`))
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", deleted.Code, deleted.Body.String())
	}
	if err := json.Unmarshal(deleted.Body.Bytes(), &catalog); err != nil || len(catalog.Prompts) != 0 {
		t.Fatalf("catalog = %#v, %v", catalog, err)
	}

	removeCategory := request(t, handler, http.MethodDelete, "/api/admin/prompt-categories/product", nil)
	if removeCategory.Code != http.StatusNoContent {
		t.Fatalf("category delete = %d %s", removeCategory.Code, removeCategory.Body.String())
	}
}

func TestDuePromptSourceRunnerIsDeterministicAndPersistsNextRun(t *testing.T) {
	backend := newMemoryStore()
	owner := store.AuthUser{ID: "owner-1", TenantID: "tenant-a", Role: "owner", Status: "active"}
	seedAdminUser(backend, owner)
	fetches := 0
	server, handler := promptCatalogServerHandler(t, backend, owner, func(_ context.Context, _ adminPromptSource) ([]adminPromptEntry, error) {
		fetches++
		return []adminPromptEntry{{ID: "scheduled", Title: "Scheduled", Body: "body", Tags: []string{}}}, nil
	})
	created := request(t, handler, http.MethodPost, "/api/admin/prompt-sources", []byte(`{"id":"scheduled-source","name":"Scheduled","url":"https://catalog.example/prompts.json","format":"json","enabled":true,"scheduleEnabled":true,"intervalMinutes":30}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	dueAt := time.Date(2026, 7, 26, 8, 0, 0, 0, time.UTC)
	_, err := server.updateAdminPromptCatalog(t.Context(), owner.TenantID, func(c *adminPromptCatalog) error {
		c.Sources[0].NextRunAt = dueAt.Add(-time.Minute).Format(time.RFC3339Nano)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	runs, err := server.runDuePromptSources(t.Context(), owner.TenantID, dueAt)
	if err != nil || len(runs) != 1 || fetches != 1 {
		t.Fatalf("runs=%#v fetches=%d err=%v", runs, fetches, err)
	}
	runs, err = server.runDuePromptSources(t.Context(), owner.TenantID, dueAt)
	if err != nil || len(runs) != 0 || fetches != 1 {
		t.Fatalf("second runs=%#v fetches=%d err=%v", runs, fetches, err)
	}
	catalog, _, err := server.loadAdminPromptCatalog(t.Context(), owner.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	if catalog.Sources[0].NextRunAt != dueAt.Add(30*time.Minute).Format(time.RFC3339Nano) || catalog.Sources[0].ScheduleStatus != "succeeded" {
		t.Fatalf("source schedule = %#v", catalog.Sources[0])
	}
}

func TestDuePromptSourceLeasePinsRevisionAndBlocksMutation(t *testing.T) {
	backend := newMemoryStore()
	owner := store.AuthUser{ID: "owner-1", TenantID: "tenant-a", Role: "owner", Status: "active"}
	seedAdminUser(backend, owner)
	fetchStarted := make(chan adminPromptSource, 1)
	releaseFetch := make(chan struct{})
	server, handler := promptCatalogServerHandler(t, backend, owner, func(_ context.Context, source adminPromptSource) ([]adminPromptEntry, error) {
		fetchStarted <- source
		<-releaseFetch
		return []adminPromptEntry{{ID: "scheduled", Title: "Scheduled", Body: "body", Tags: []string{}}}, nil
	})
	created := request(t, handler, http.MethodPost, "/api/admin/prompt-sources", []byte(`{"id":"scheduled-source","name":"Scheduled","url":"https://catalog.example/original.json","format":"json","enabled":true,"scheduleEnabled":true,"intervalMinutes":30}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	dueAt := time.Date(2026, 7, 26, 8, 0, 0, 0, time.UTC)
	if _, err := server.updateAdminPromptCatalog(t.Context(), owner.TenantID, func(c *adminPromptCatalog) error {
		c.Sources[0].NextRunAt = dueAt.Add(-time.Minute).Format(time.RFC3339Nano)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	runDone := make(chan error, 1)
	go func() {
		_, err := server.runDuePromptSources(t.Context(), owner.TenantID, dueAt)
		runDone <- err
	}()
	claimed := <-fetchStarted
	if claimed.URL != "https://catalog.example/original.json" || claimed.Revision != 1 {
		t.Fatalf("claimed source = %#v", claimed)
	}

	updated := request(t, handler, http.MethodPut, "/api/admin/prompt-sources/scheduled-source", []byte(`{"name":"Scheduled","url":"https://catalog.example/replaced.json","format":"json","enabled":false,"scheduleEnabled":false}`))
	if updated.Code != http.StatusConflict {
		t.Fatalf("update during lease = %d %s", updated.Code, updated.Body.String())
	}
	deleted := request(t, handler, http.MethodDelete, "/api/admin/prompt-sources/scheduled-source", nil)
	if deleted.Code != http.StatusConflict {
		t.Fatalf("delete during lease = %d %s", deleted.Code, deleted.Body.String())
	}

	close(releaseFetch)
	if err := <-runDone; err != nil {
		t.Fatal(err)
	}
}

func TestPromptCatalogSchedulerRecoversDueSourcesAndClaimsAcrossInstances(t *testing.T) {
	backend := newMemoryStore()
	tenantID := "tenant-recovered"
	seed := NewServerWithStore(t.TempDir(), backend)
	_, err := seed.updateAdminPromptCatalog(t.Context(), tenantID, func(c *adminPromptCatalog) error {
		c.Sources = append(c.Sources, adminPromptSource{
			ID: "scheduled-source", Name: "Scheduled", URL: "https://catalog.example/prompts.json", Format: "json",
			Enabled: true, ScheduleEnabled: true, IntervalMinutes: 5, NextRunAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), Revision: 1,
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	fetches := 0
	fetched := make(chan struct{}, 2)
	fetcher := func(_ context.Context, _ adminPromptSource) ([]adminPromptEntry, error) {
		mu.Lock()
		fetches++
		mu.Unlock()
		fetched <- struct{}{}
		return []adminPromptEntry{{ID: "scheduled", Title: "Scheduled", Body: "body", Tags: []string{}}}, nil
	}
	first := NewServerWithStore(t.TempDir(), backend)
	second := NewServerWithStore(t.TempDir(), backend)
	first.promptCatalogFetcher, second.promptCatalogFetcher = fetcher, fetcher
	first.promptSchedulerInterval, second.promptSchedulerInterval = 10*time.Millisecond, 10*time.Millisecond
	first.startPromptCatalogScheduler()
	second.startPromptCatalogScheduler()
	t.Cleanup(first.Close)
	t.Cleanup(second.Close)

	select {
	case <-fetched:
	case <-time.After(time.Second):
		t.Fatal("scheduler did not recover the persisted due source")
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	gotFetches := fetches
	mu.Unlock()
	if gotFetches != 1 {
		t.Fatalf("fetches = %d, want one claimed run", gotFetches)
	}
	catalog, _, err := first.loadAdminPromptCatalog(t.Context(), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if catalog.Sources[0].ScheduleLeaseID != "" || catalog.Sources[0].ScheduleLeaseUntil != "" || catalog.Sources[0].ScheduleStatus != "succeeded" {
		t.Fatalf("lease was not released: %#v", catalog.Sources[0])
	}
}

func TestPromptCatalogSchedulerCloseCancelsAndWaitsForFetch(t *testing.T) {
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	started := make(chan struct{})
	finished := make(chan struct{})
	server.promptCatalogFetcher = func(ctx context.Context, _ adminPromptSource) ([]adminPromptEntry, error) {
		close(started)
		<-ctx.Done()
		close(finished)
		return nil, ctx.Err()
	}
	_, err := server.updateAdminPromptCatalog(t.Context(), store.DefaultTenantID, func(c *adminPromptCatalog) error {
		c.Sources = append(c.Sources, adminPromptSource{
			ID: "scheduled-source", Name: "Scheduled", URL: "https://catalog.example/prompts.json", Format: "json",
			Enabled: true, ScheduleEnabled: true, IntervalMinutes: 5, NextRunAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), Revision: 1,
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	server.promptSchedulerInterval = time.Hour
	server.startPromptCatalogScheduler()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("scheduled fetch did not start")
	}
	server.Close()
	select {
	case <-finished:
	default:
		t.Fatal("Close returned before the scheduled fetch stopped")
	}
}

func TestPromptSourceSyncPublishesAtomicallyAndFailureKeepsLastCatalog(t *testing.T) {
	backend := newMemoryStore()
	owner := store.AuthUser{ID: "owner-1", TenantID: "tenant-a", Role: "owner", Status: "active"}
	seedAdminUser(backend, owner)
	fail := false
	fetcher := func(_ context.Context, source adminPromptSource) ([]adminPromptEntry, error) {
		if fail {
			return nil, errors.New("upstream unavailable")
		}
		return []adminPromptEntry{{ID: "remote-1", Title: "Remote", Body: "remote body", Tags: []string{"synced"}}}, nil
	}
	handler := promptCatalogHandler(t, backend, owner, fetcher)
	source := request(t, handler, http.MethodPost, "/api/admin/prompt-sources", []byte(`{"id":"source-1","name":"Catalog","url":"https://catalog.example/prompts.json","format":"json","enabled":true}`))
	if source.Code != http.StatusCreated {
		t.Fatalf("source = %d %s", source.Code, source.Body.String())
	}

	synced := request(t, handler, http.MethodPost, "/api/admin/prompt-sources/source-1/sync", nil)
	if synced.Code != http.StatusOK {
		t.Fatalf("sync = %d %s", synced.Code, synced.Body.String())
	}
	var run adminPromptSyncRun
	if err := json.Unmarshal(synced.Body.Bytes(), &run); err != nil || run.Status != "succeeded" || run.ItemCount != 1 {
		t.Fatalf("run = %#v, %v", run, err)
	}

	fail = true
	failed := request(t, handler, http.MethodPost, "/api/admin/prompt-sources/source-1/sync", nil)
	if failed.Code != http.StatusBadGateway {
		t.Fatalf("failed = %d %s", failed.Code, failed.Body.String())
	}
	listed := request(t, handler, http.MethodGet, "/api/admin/prompt-catalog", nil)
	var catalog adminPromptCatalog
	if err := json.Unmarshal(listed.Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Prompts) != 1 || catalog.Prompts[0].Body != "remote body" {
		t.Fatalf("prompts changed after failure: %#v", catalog.Prompts)
	}
	if len(catalog.SyncRuns) != 2 || catalog.SyncRuns[1].Status != "failed" {
		t.Fatalf("runs = %#v", catalog.SyncRuns)
	}
}

func TestPromptCatalogRBACAndUnsafeSourceURL(t *testing.T) {
	backend := newMemoryStore()
	member := store.AuthUser{ID: "member-1", TenantID: "tenant-a", Role: "member", Status: "active"}
	seedAdminUser(backend, member)
	handler := promptCatalogHandler(t, backend, member, nil)

	if got := request(t, handler, http.MethodGet, "/api/prompt-catalog", nil); got.Code != http.StatusOK {
		t.Fatalf("public read = %d", got.Code)
	}
	if got := request(t, handler, http.MethodPost, "/api/admin/prompt-categories", []byte(`{"id":"x","name":"X"}`)); got.Code != http.StatusForbidden {
		t.Fatalf("member mutation = %d", got.Code)
	}

	for _, rawURL := range []string{"http://example.com/prompts.json", "https://127.0.0.1/prompts.json", "https://169.254.169.254/latest", "https://198.18.0.1/benchmark", "https://192.0.2.1/docs", "https://user:pass@example.com/prompts.json"} {
		if _, err := validateAdminPromptSourceURL(rawURL); err == nil {
			t.Fatalf("unsafe URL accepted: %s", rawURL)
		}
	}
}

func TestDecodeAdminPromptCatalogDefaultsLegacyJSONSourceFormat(t *testing.T) {
	catalog, err := decodeAdminPromptCatalog([]byte(`{"version":1,"revision":2,"categories":[],"prompts":[],"sources":[{"id":"legacy","name":"Legacy","url":"https://catalog.example/prompts.json","enabled":true}],"syncRuns":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Sources) != 1 || catalog.Sources[0].Format != "json" {
		t.Fatalf("legacy source format = %#v", catalog.Sources)
	}
}

func TestPromptSourceResponseEnforcesRedirectMIMEAndSizeBounds(t *testing.T) {
	response := func(status int, contentType, body string) *http.Response {
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{contentType}}, Body: io.NopCloser(strings.NewReader(body))}
	}
	valid, err := readAdminPromptCatalogResponse(response(http.StatusOK, "application/json", `[{"id":"one","title":"One","body":"Body","tags":[]}]`))
	if err != nil || len(valid) != 1 {
		t.Fatalf("valid = %#v, %v", valid, err)
	}
	githubRaw, err := readAdminPromptCatalogResponse(response(http.StatusOK, "text/plain; charset=utf-8", `[{"id":"raw","title":"Raw","body":"Body","tags":[]}]`))
	if err != nil || len(githubRaw) != 1 || githubRaw[0].ID != "raw" {
		t.Fatalf("GitHub Raw JSON = %#v, %v", githubRaw, err)
	}
	for name, candidate := range map[string]*http.Response{
		"redirect":  response(http.StatusTemporaryRedirect, "application/json", `{}`),
		"mime":      response(http.StatusOK, "text/html", `{}`),
		"oversized": response(http.StatusOK, "application/json", strings.Repeat(" ", maxAdminPromptBodyBytes+1)),
	} {
		if _, err := readAdminPromptCatalogResponse(candidate); err == nil {
			t.Fatalf("%s response accepted", name)
		}
	}
}

func TestPromptSourceMarkdownResponseParsesNestedPromptCatalog(t *testing.T) {
	markdown := "# Catalog\n\n## Prompt collection\n\n### 一、电商与产品\n\n#### 1.1 商品主图\n\n```text\nproduct hero image\n```\n\n### 二、角色与一致性\n\n#### 2.1 角色三视图\n\n```text\ncharacter turnaround sheet\n```\n\n### Legacy labeled entry\n\n提示词：\n```text\nlegacy labeled prompt\n```\n\n### Empty trailing documentation heading\n"
	response := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/markdown; charset=utf-8"}},
		Body:       io.NopCloser(strings.NewReader(markdown)),
	}
	items, err := readAdminPromptCatalogResponse(response, "markdown")
	if err != nil {
		t.Fatalf("markdown parse failed: %v", err)
	}
	if len(items) != 3 || items[0].Title != "1.1 商品主图" || items[1].Title != "2.1 角色三视图" || items[2].Body != "legacy labeled prompt" {
		t.Fatalf("items = %#v", items)
	}
	if strings.Join(items[0].Tags, ",") != "Prompt collection,电商,产品" ||
		strings.Join(items[1].Tags, ",") != "Prompt collection,角色,一致性" ||
		strings.Join(items[2].Tags, ",") != "Prompt collection" {
		t.Fatalf("tags = %#v", items)
	}
}

func TestPromptSourceMarkdownResponseParsesSupplementalNumberedPromptsAndTildeFences(t *testing.T) {
	markdown := "# Catalog\n\n## 补充案例\n\n#### 来源文章\n\n##### 原文提示词摘录\n\n- 说明：只保留明确给出的提示词\n1. 提示词：一张中文信息图，结构清晰\n2. 围绕上面的形象，设计一个 IP\n\n##### 可直接复用的指令/关键词摘录\n\n1. 生成一张胶片旅行抓拍\n2. 关键词：photorealistic\n\n### 真实提示词\n\n~~~text\nactual prompt\n~~~\n"
	response := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/markdown"}},
		Body:       io.NopCloser(strings.NewReader(markdown)),
	}
	items, err := readAdminPromptCatalogResponse(response, "markdown")
	if err != nil {
		t.Fatalf("markdown parse failed: %v", err)
	}
	if len(items) != 5 {
		t.Fatalf("items = %#v", items)
	}
	if items[0].Body != "一张中文信息图，结构清晰" ||
		items[1].Body != "围绕上面的形象，设计一个 IP" ||
		items[2].Body != "生成一张胶片旅行抓拍" ||
		items[3].Body != "关键词：photorealistic" ||
		items[4].Body != "actual prompt" {
		t.Fatalf("items = %#v", items)
	}
}
