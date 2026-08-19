package store

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestPostgresGenerationJobsCategoryFilterMatchesCountAndItems(t *testing.T) {
	backend := openTombstoneTestStore(t)
	tenantID := seedTombstoneTenant(t, backend)
	t.Cleanup(func() { _, _ = backend.pool.Exec(t.Context(), `DELETE FROM openboard_tenants WHERE id=$1`, tenantID) })

	now := time.Now().UTC()
	fixtures := []struct {
		id         string
		parameters map[string]any
	}{
		{id: "category-poster", parameters: map[string]any{"category": "poster"}},
		{id: "category-character", parameters: map[string]any{"category": "character"}},
		{id: "category-literal-all", parameters: map[string]any{"category": "全部"}},
		{id: "category-poster-nbsp", parameters: map[string]any{"category": "\u00a0poster\u00a0"}},
		{id: "category-character-ideographic", parameters: map[string]any{"category": "\u3000character\u3000"}},
		{id: "category-number", parameters: map[string]any{"category": 1}},
		{id: "category-missing", parameters: map[string]any{}},
		{id: "category-whitespace-only", parameters: map[string]any{"category": "\u00a0\u2003"}},
		{id: "category-surrogate-overlong", parameters: map[string]any{"category": strings.Repeat("😀", 51)}},
		{id: "category-control", parameters: map[string]any{"category": "bad\ncategory"}},
	}
	for index, fixture := range fixtures {
		parameters, err := json.Marshal(fixture.parameters)
		if err != nil {
			t.Fatal(err)
		}
		created := now.Add(time.Duration(index) * time.Millisecond)
		if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_generation_jobs
  (tenant_id,id,kind,status,prompt,parameters,result,created_at,updated_at)
VALUES ($1,$2,'image','succeeded',$3,$4,'{}'::jsonb,$5,$5)`, tenantID, fixture.id, fmt.Sprintf("prompt-%d", index), parameters, created); err != nil {
			t.Fatal(err)
		}
	}

	page, err := backend.ListGenerationJobs(t.Context(), tenantID, GenerationJobQuery{Category: "poster", Page: 1, PageSize: 20})
	if err != nil || page.Total != 2 || len(page.Items) != 2 {
		t.Fatalf("category-filtered page = %#v, err=%v", page, err)
	}
	for _, want := range []string{"category-poster", "category-poster-nbsp"} {
		found := false
		for _, item := range page.Items {
			if item.ID == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("category-filtered page = %#v, missing %q", page.Items, want)
		}
	}
	for _, want := range []string{"poster", "character", "全部", GenerationJobUncategorized} {
		if !containsStoreCategory(page.Categories, want) {
			t.Fatalf("category metadata = %#v, missing %q", page.Categories, want)
		}
	}
	unclassified, err := backend.ListGenerationJobs(t.Context(), tenantID, GenerationJobQuery{Category: GenerationJobUncategorized, Page: 1, PageSize: 20})
	if err != nil || unclassified.Total != 5 {
		t.Fatalf("unclassified page = %#v, err=%v", unclassified, err)
	}
	literalAll, err := backend.ListGenerationJobs(t.Context(), tenantID, GenerationJobQuery{Category: "全部", Page: 1, PageSize: 20})
	if err != nil || literalAll.Total != 1 || len(literalAll.Items) != 1 || literalAll.Items[0].ID != "category-literal-all" {
		t.Fatalf("literal all page = %#v, err=%v", literalAll, err)
	}
}

func containsStoreCategory(categories []string, want string) bool {
	for _, category := range categories {
		if category == want {
			return true
		}
	}
	return false
}
