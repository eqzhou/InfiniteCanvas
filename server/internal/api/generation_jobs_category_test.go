package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestGenerationJobsCategoryFilterUsesParametersForCountAndItems(t *testing.T) {
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	t.Cleanup(server.Close)
	handler := serverRouter(server)

	for _, body := range []string{
		`{"id":"category-poster","kind":"image","status":"succeeded","prompt":"poster","parameters":{"category":"poster"},"result":{}}`,
		`{"id":"category-character","kind":"image","status":"succeeded","prompt":"character","parameters":{"category":"character"},"result":{}}`,
		`{"id":"category-literal-all","kind":"image","status":"succeeded","prompt":"literal all","parameters":{"category":"全部"},"result":{}}`,
		`{"id":"category-uncategorized","kind":"image","status":"succeeded","prompt":"none","parameters":{},"result":{}}`,
		`{"id":"category-overlong","kind":"image","status":"succeeded","prompt":"legacy","parameters":{"category":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"},"result":{}}`,
		`{"id":"category-control","kind":"image","status":"succeeded","prompt":"legacy control","parameters":{"category":"bad\ncategory"},"result":{}}`,
	} {
		response := request(t, handler, http.MethodPost, "/api/generation-jobs", []byte(body))
		if response.Code != http.StatusCreated {
			t.Fatalf("create category job: %d %s", response.Code, response.Body.String())
		}
	}
	memoryPage, err := backend.ListGenerationJobs(t.Context(), "local", store.GenerationJobQuery{Category: "poster", Page: 1, PageSize: 20})
	if err != nil || memoryPage.Total != 1 || !containsCategory(memoryPage.Categories, "character") || !containsCategory(memoryPage.Categories, "未分类") {
		t.Fatalf("memory category metadata = %#v, err=%v", memoryPage, err)
	}

	response := request(t, handler, http.MethodGet, "/api/generation-jobs?category=poster&page=1&pageSize=20", nil)
	if response.Code != http.StatusOK || !bytes.Contains(response.Body.Bytes(), []byte(`"total": 1`)) || !bytes.Contains(response.Body.Bytes(), []byte(`category-poster`)) || bytes.Contains(response.Body.Bytes(), []byte(`category-character`)) {
		t.Fatalf("category-filtered jobs: %d %s", response.Code, response.Body.String())
	}
	var page struct {
		Categories []string `json:"categories"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if !containsCategory(page.Categories, "poster") || !containsCategory(page.Categories, "character") || !containsCategory(page.Categories, "全部") || !containsCategory(page.Categories, "未分类") {
		t.Fatalf("category metadata = %#v, want all scoped categories including unclassified", page.Categories)
	}

	unclassified := request(t, handler, http.MethodGet, "/api/generation-jobs?category=%E6%9C%AA%E5%88%86%E7%B1%BB&page=1&pageSize=20", nil)
	if unclassified.Code != http.StatusOK || !bytes.Contains(unclassified.Body.Bytes(), []byte(`"total": 3`)) || bytes.Contains(unclassified.Body.Bytes(), []byte(`category-poster`)) {
		t.Fatalf("unclassified jobs: %d %s", unclassified.Code, unclassified.Body.String())
	}

	literalAll := request(t, handler, http.MethodGet, "/api/generation-jobs?category=%E5%85%A8%E9%83%A8&page=1&pageSize=20", nil)
	if literalAll.Code != http.StatusOK || !bytes.Contains(literalAll.Body.Bytes(), []byte(`"total": 1`)) || !bytes.Contains(literalAll.Body.Bytes(), []byte(`category-literal-all`)) {
		t.Fatalf("literal all jobs: %d %s", literalAll.Code, literalAll.Body.String())
	}
}

func TestGenerationJobsCategoryFilterRejectsInvalidValues(t *testing.T) {
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	server.SetProcessToken("test-token")
	t.Cleanup(server.Close)
	handler := serverRouter(server)
	for _, category := range []string{
		strings.Repeat("x", 101),
		" leading-space",
		"trailing-space ",
		"line\nfeed",
	} {
		response := request(t, handler, http.MethodGet, "/api/generation-jobs?category="+url.QueryEscape(category), nil)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("category %q status = %d, want 400: %s", category, response.Code, response.Body.String())
		}
	}
}

func serverRouter(server *Server) http.Handler {
	router := chi.NewRouter()
	MountServer(router, server)
	return router
}

func containsCategory(categories []string, want string) bool {
	for _, category := range categories {
		if category == want {
			return true
		}
	}
	return false
}
