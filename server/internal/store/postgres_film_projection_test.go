package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

const completeFilmProjectionDocument = `{
  "schemaVersion":3,"projectId":"film-projection","revision":1,"projectionRevision":4,
  "source":{"revision":1,"text":"source","format":"text","importedAt":"2026-08-09T00:00:00Z"},
  "episodes":[{"id":"episode-1","revision":1,"order":1,"title":"Episode","status":"approved"}],
  "scenes":[{"id":"scene-1","revision":2,"episodeId":"episode-1","order":1,"heading":"INT","status":"approved"}],
  "shots":[{"id":"shot-1","revision":3,"sceneId":"scene-1","order":1,"title":"Shot","status":"approved","identityVersionIds":["identity-1"],"styleAssetId":"style-1"}],
  "dialogues":[{"id":"dialogue-1","revision":1,"shotId":"shot-1","order":1,"kind":"dialogue","characterAssetId":"character-1","voiceAssetId":"voice-1","text":"Hello","status":"approved"}],
  "assets":[
    {"id":"character-1","revision":1,"kind":"character","title":"Character","status":"approved"},
    {"id":"identity-1","revision":1,"kind":"identity","title":"Identity","status":"approved","parentAssetId":"character-1","episodeIds":["episode-1"],"sceneIds":["scene-1"],"shotIds":["shot-1"]},
    {"id":"style-1","revision":1,"kind":"style","title":"Style","status":"approved"},
    {"id":"voice-1","revision":1,"kind":"voice","title":"Voice","status":"approved"}
  ],
  "stages":[{"id":"storyboard","revision":2,"status":"approved","updatedAt":"2026-08-09T00:00:00Z"}],
  "tasks":[],
  "qualityReports":[{"id":"quality-1","revision":1,"createdAt":"2026-08-09T00:00:00Z","issues":[],"repairs":[]}],
  "timeline":{"revision":3,"width":1920,"height":1080,"frameRate":24,"tracks":[]},
  "deliverables":[{"id":"deliverable-1","revision":1,"kind":"video","status":"succeeded","title":"Master","mimeType":"video/mp4","createdAt":"2026-08-09T00:00:00Z"}],
  "adoptions":[],
  "versions":[{"id":"version-1","entityType":"shot","entityId":"deleted-shot","revision":1,"snapshot":{"id":"deleted-shot","revision":1},"reason":"archive","createdAt":"2026-08-09T00:00:00Z"}]
}`

func TestBuildFilmRelationalProjectionCoversDomainAndRelations(t *testing.T) {
	entities, relations, err := buildFilmRelationalProjection([]byte(completeFilmProjectionDocument), 7)
	if err != nil {
		t.Fatal(err)
	}
	requiredTypes := []string{"episode", "scene", "shot", "asset", "dialogue", "stage_approval", "quality_report", "timeline", "deliverable", "entity_version", "projection"}
	seenTypes := map[string]bool{}
	for _, entity := range entities {
		seenTypes[entity.EntityType] = true
		if entity.AggregateRevision != 7 {
			t.Fatalf("entity %s aggregate revision=%d", entity.EntityID, entity.AggregateRevision)
		}
	}
	for _, entityType := range requiredTypes {
		if !seenTypes[entityType] {
			t.Errorf("missing entity type %q", entityType)
		}
	}
	wantRelations := []string{
		"scene_episode:scene:scene-1:episode:episode-1",
		"shot_scene:shot:shot-1:scene:scene-1",
		"dialogue_shot:dialogue:dialogue-1:shot:shot-1",
		"asset_parent:asset:identity-1:asset:character-1",
		"asset_episode:asset:identity-1:episode:episode-1",
		"asset_scene:asset:identity-1:scene:scene-1",
		"asset_shot:asset:identity-1:shot:shot-1",
		"shot_identity:shot:shot-1:asset:identity-1",
		"shot_style:shot:shot-1:asset:style-1",
		"dialogue_character:dialogue:dialogue-1:asset:character-1",
		"dialogue_voice:dialogue:dialogue-1:asset:voice-1",
	}
	gotRelations := make([]string, 0, len(relations))
	for _, relation := range relations {
		gotRelations = append(gotRelations, fmt.Sprintf("%s:%s:%s:%s:%s", relation.RelationType, relation.SourceType, relation.SourceID, relation.TargetType, relation.TargetID))
		if relation.AggregateRevision != 7 {
			t.Fatalf("relation %s aggregate revision=%d", relation.RelationType, relation.AggregateRevision)
		}
	}
	for _, relation := range wantRelations {
		if !slices.Contains(gotRelations, relation) {
			t.Errorf("missing relation %q in %v", relation, gotRelations)
		}
	}
}

func TestBuildFilmRelationalProjectionRejectsDanglingCurrentRelation(t *testing.T) {
	document := []byte(`{"episodes":[],"scenes":[{"id":"scene-1","revision":1,"episodeId":"missing","order":1}],"shots":[],"dialogues":[],"assets":[],"stages":[],"qualityReports":[],"deliverables":[],"versions":[],"timeline":{"revision":1}}`)
	if _, _, err := buildFilmRelationalProjection(document, 2); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected invalid input for dangling scene relation, got %v", err)
	}
}

func TestBuildFilmRelationalProjectionRejectsDuplicateRelations(t *testing.T) {
	document := []byte(`{"episodes":[{"id":"episode-1","revision":1}],"scenes":[{"id":"scene-1","revision":1,"episodeId":"episode-1"}],"shots":[{"id":"shot-1","revision":1,"sceneId":"scene-1","identityVersionIds":["asset-1","asset-1"]}],"dialogues":[],"assets":[{"id":"asset-1","revision":1}],"stages":[],"qualityReports":[],"deliverables":[],"versions":[],"timeline":{"revision":1}}`)
	if _, _, err := buildFilmRelationalProjection(document, 2); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected invalid input for duplicate relation, got %v", err)
	}
}

func TestBuildFilmRelationalProjectionRejectsUnboundedEntityFanout(t *testing.T) {
	episodes := make([]map[string]any, maxFilmProjectionRelationsPerEntity+1)
	episodeIDs := make([]string, len(episodes))
	for index := range episodes {
		episodeIDs[index] = fmt.Sprintf("episode-%d", index)
		episodes[index] = map[string]any{"id": episodeIDs[index], "revision": 1}
	}
	document, err := json.Marshal(map[string]any{
		"episodes": episodes, "scenes": []any{}, "shots": []any{}, "dialogues": []any{},
		"assets": []any{map[string]any{"id": "identity-1", "revision": 1, "episodeIds": episodeIDs}},
		"stages": []any{}, "tasks": []any{}, "qualityReports": []any{}, "deliverables": []any{},
		"adoptions": []any{}, "versions": []any{}, "timeline": map[string]any{"revision": 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := buildFilmRelationalProjection(document, 2); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected invalid input for unbounded relation fanout, got %v", err)
	}
}

func TestBuildFilmRelationalProjectionPreservesExplicitZeroOrder(t *testing.T) {
	document := []byte(`{"episodes":[{"id":"episode-five","revision":1,"order":5},{"id":"episode-zero","revision":1,"order":0}],"scenes":[],"shots":[],"dialogues":[],"assets":[],"stages":[],"tasks":[],"qualityReports":[],"deliverables":[],"adoptions":[],"versions":[],"timeline":{"revision":1}}`)
	entities, _, err := buildFilmRelationalProjection(document, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, entity := range entities {
		if entity.EntityID == "episode-zero" && entity.Position != 0 {
			t.Fatalf("explicit zero order projected as %d", entity.Position)
		}
	}
}

func TestPostgresFilmEntityProjectionTracksFilmCAS(t *testing.T) {
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for PostgreSQL Film projection tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for PostgreSQL Film projection tests")
	}
	backend, err := Open(context.Background(), databaseURL, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(backend.Close)
	tenantID := fmt.Sprintf("film-projection-%d", time.Now().UnixNano())
	projectID := "film-projection"
	project := []byte(`{"title":"Film Projection","updatedAt":"2026-08-09T00:00:00Z"}`)
	if err := backend.PutProject(t.Context(), tenantID, projectID, project); err != nil {
		t.Fatal(err)
	}
	first := []byte(`{"source":{"revision":1},"episodes":[{"id":"episode-1","revision":1}],"scenes":[{"id":"scene-1","revision":1,"episodeId":"episode-1"}],"shots":[{"id":"shot-1","revision":1,"sceneId":"scene-1"}],"dialogues":[],"assets":[],"stages":[],"tasks":[],"qualityReports":[],"deliverables":[],"adoptions":[],"versions":[],"timeline":{"revision":1}}`)
	record, err := backend.CreateFilmProject(t.Context(), tenantID, projectID, first)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FROM openboard_film_entities WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID).Scan(&count); err != nil || count != 6 {
		t.Fatalf("initial projection count=%d err=%v", count, err)
	}
	second := []byte(`{"source":{"revision":2},"episodes":[{"id":"episode-1","revision":2}],"scenes":[{"id":"scene-1","revision":2,"episodeId":"episode-1"}],"shots":[{"id":"shot-2","revision":1,"sceneId":"scene-1"}],"dialogues":[],"assets":[],"stages":[],"tasks":[],"qualityReports":[],"deliverables":[],"adoptions":[],"versions":[],"timeline":{"revision":2}}`)
	if _, err := backend.CompareAndSwapFilmProject(t.Context(), tenantID, projectID, record.Revision, second); err != nil {
		t.Fatal(err)
	}
	var oldCount, newCount int
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FILTER (WHERE entity_id='shot-1'), count(*) FILTER (WHERE entity_id='shot-2') FROM openboard_film_entities WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID).Scan(&oldCount, &newCount); err != nil || oldCount != 0 || newCount != 1 {
		t.Fatalf("CAS projection old=%d new=%d err=%v", oldCount, newCount, err)
	}
}

func TestPostgresFilmRelationalProjectionIsTenantScopedAtomicAndCascades(t *testing.T) {
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for PostgreSQL Film projection tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for PostgreSQL Film projection tests")
	}
	backend, err := Open(context.Background(), databaseURL, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(backend.Close)
	tenantID := fmt.Sprintf("film-relations-%d", time.Now().UnixNano())
	projectID := "film-projection"
	project := []byte(`{"title":"Film Projection","updatedAt":"2026-08-09T00:00:00Z"}`)
	if err := backend.PutProject(t.Context(), tenantID, projectID, project); err != nil {
		t.Fatal(err)
	}
	record, err := backend.CreateFilmProject(t.Context(), tenantID, projectID, []byte(completeFilmProjectionDocument))
	if err != nil {
		t.Fatal(err)
	}
	var entityCount, relationCount, wrongTenantCount int
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FROM openboard_film_entities WHERE tenant_id=$1 AND project_id=$2 AND aggregate_revision=$3`, tenantID, projectID, record.Revision).Scan(&entityCount); err != nil {
		t.Fatal(err)
	}
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FROM openboard_film_entity_relations WHERE tenant_id=$1 AND project_id=$2 AND aggregate_revision=$3`, tenantID, projectID, record.Revision).Scan(&relationCount); err != nil {
		t.Fatal(err)
	}
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FROM openboard_film_entities WHERE tenant_id=$1 AND project_id=$2`, tenantID+"-other", projectID).Scan(&wrongTenantCount); err != nil {
		t.Fatal(err)
	}
	if entityCount < 11 || relationCount < 11 || wrongTenantCount != 0 {
		t.Fatalf("entities=%d relations=%d wrongTenant=%d", entityCount, relationCount, wrongTenantCount)
	}

	invalid := []byte(`{"episodes":[],"scenes":[{"id":"scene-bad","revision":1,"episodeId":"missing","order":1}],"shots":[],"dialogues":[],"assets":[],"stages":[],"qualityReports":[],"deliverables":[],"versions":[],"timeline":{"revision":1}}`)
	if _, err := backend.CompareAndSwapFilmProject(t.Context(), tenantID, projectID, record.Revision, invalid); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected atomic CAS rejection, got %v", err)
	}
	current, err := backend.GetFilmProject(t.Context(), tenantID, projectID)
	if err != nil || current.Revision != record.Revision {
		t.Fatalf("CAS rollback revision=%d err=%v", current.Revision, err)
	}
	tokenDigest := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := backend.RestoreFilmProject(t.Context(), tenantID, projectID, record.Revision, invalid, tokenDigest, time.Now().Add(time.Hour), nil); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected atomic restore rejection, got %v", err)
	}
	var restoreTokenCount int
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FROM openboard_film_restore_tokens WHERE tenant_id=$1 AND project_id=$2 AND token_digest=$3`, tenantID, projectID, tokenDigest).Scan(&restoreTokenCount); err != nil || restoreTokenCount != 0 {
		t.Fatalf("restore tokens after rejected restore=%d err=%v", restoreTokenCount, err)
	}
	current, err = backend.GetFilmProject(t.Context(), tenantID, projectID)
	if err != nil || current.Revision != record.Revision {
		t.Fatalf("restore rollback revision=%d err=%v", current.Revision, err)
	}
	restoreDigest := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	restoredDocument := []byte(strings.ReplaceAll(completeFilmProjectionDocument, "shot-1", "shot-restored"))
	restored, err := backend.RestoreFilmProject(t.Context(), tenantID, projectID, record.Revision, restoredDocument, restoreDigest, time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatalf("restore valid Film aggregate: %v", err)
	}
	var restoredRelations int
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FROM openboard_film_entity_relations WHERE tenant_id=$1 AND project_id=$2 AND aggregate_revision=$3 AND (source_id='shot-restored' OR target_id='shot-restored')`, tenantID, projectID, restored.Revision).Scan(&restoredRelations); err != nil || restoredRelations == 0 {
		t.Fatalf("restored relations=%d err=%v", restoredRelations, err)
	}
	rolledBack, priorExisted, err := backend.RollbackFilmProject(t.Context(), tenantID, projectID, restored.Revision, restoreDigest, time.Now())
	if err != nil || !priorExisted {
		t.Fatalf("rollback valid Film restore prior=%v err=%v", priorExisted, err)
	}
	var priorRelations, staleRelations int
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FILTER (WHERE source_id='shot-1' OR target_id='shot-1'), count(*) FILTER (WHERE source_id='shot-restored' OR target_id='shot-restored') FROM openboard_film_entity_relations WHERE tenant_id=$1 AND project_id=$2 AND aggregate_revision=$3`, tenantID, projectID, rolledBack.Revision).Scan(&priorRelations, &staleRelations); err != nil || priorRelations == 0 || staleRelations != 0 {
		t.Fatalf("rollback relations prior=%d stale=%d err=%v", priorRelations, staleRelations, err)
	}

	if err := backend.DeleteProject(t.Context(), tenantID, projectID); err != nil {
		t.Fatal(err)
	}
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FROM openboard_film_entity_relations WHERE tenant_id=$1 AND project_id=$2`, tenantID, projectID).Scan(&relationCount); err != nil || relationCount != 0 {
		t.Fatalf("relations after delete=%d err=%v", relationCount, err)
	}
}
