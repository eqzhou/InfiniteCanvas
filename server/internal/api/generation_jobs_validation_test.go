package api

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func filmStageValidationJob(t *testing.T, parameters filmStageGenerationParameters) store.GenerationJob {
	t.Helper()
	raw, err := json.Marshal(parameters)
	if err != nil {
		t.Fatal(err)
	}
	return store.GenerationJob{
		ID: "film-parent", ProjectID: "film-project", Kind: "film-stage", Status: "succeeded",
		Parameters: raw, Result: json.RawMessage(`{}`),
	}
}

func TestPersistedFilmStageJobValidatesChildCredits(t *testing.T) {
	base := filmStageGenerationParameters{
		Executor: "film-stage", ProjectID: "film-project", Stage: "video",
		RequestHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ChildJobIDs: []string{"child-one", "child-two"}, ChildCredits: []int{3, 5}, EstimatedCredits: 8,
	}
	if !validGenerationJobFields(filmStageValidationJob(t, base)) {
		t.Fatal("expected bounded matching child credits to be accepted")
	}

	invalid := []filmStageGenerationParameters{
		{Executor: base.Executor, ProjectID: "other-project", Stage: base.Stage, RequestHash: base.RequestHash, ChildJobIDs: base.ChildJobIDs, ChildCredits: base.ChildCredits, EstimatedCredits: base.EstimatedCredits},
		{Executor: base.Executor, ProjectID: base.ProjectID, Stage: "unknown", RequestHash: base.RequestHash, ChildJobIDs: base.ChildJobIDs, ChildCredits: base.ChildCredits, EstimatedCredits: base.EstimatedCredits},
		{Executor: base.Executor, ProjectID: base.ProjectID, Stage: "compose", RequestHash: base.RequestHash, ChildJobIDs: base.ChildJobIDs, ChildCredits: base.ChildCredits, EstimatedCredits: base.EstimatedCredits},
		{Executor: base.Executor, ProjectID: base.ProjectID, Stage: base.Stage, RequestHash: base.RequestHash, ChildJobIDs: base.ChildJobIDs, ChildCredits: []int{3}, EstimatedCredits: 3},
		{Executor: base.Executor, ProjectID: base.ProjectID, Stage: base.Stage, RequestHash: base.RequestHash, ChildJobIDs: base.ChildJobIDs, ChildCredits: []int{-1, 5}, EstimatedCredits: 4},
		{Executor: base.Executor, ProjectID: base.ProjectID, Stage: base.Stage, RequestHash: base.RequestHash, ChildJobIDs: base.ChildJobIDs, ChildCredits: []int{1_000_000_000, 1}, EstimatedCredits: 1_000_000_001},
		{Executor: base.Executor, ProjectID: base.ProjectID, Stage: base.Stage, RequestHash: base.RequestHash, ChildJobIDs: []string{"child-one", "child-one"}, ChildCredits: []int{3, 5}, EstimatedCredits: 8},
	}
	for index, parameters := range invalid {
		if validGenerationJobFields(filmStageValidationJob(t, parameters)) {
			t.Fatalf("invalid film stage parameters %d were accepted", index)
		}
	}
}

func TestRestoredFilmStageJobsRequireExactChildBindings(t *testing.T) {
	requestHash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	parent := filmStageValidationJob(t, filmStageGenerationParameters{Executor: "film-stage", ProjectID: "film-project", Stage: "video", RequestHash: requestHash, ChildJobIDs: []string{"child-one"}, ChildCredits: []int{3}, EstimatedCredits: 3})
	binding := &filmGenerationBinding{ProjectID: "film-project", Stage: "video", ShotID: "shot-one", TaskID: "task-one", ParentGenerationJobID: parent.ID, RequestHash: requestHash}
	parameters, _ := json.Marshal(persistedMediaJobParameters{Executor: serverExecutorMarker, RequestHash: requestHash, Film: binding, EstimatedCredits: 3})
	child := store.GenerationJob{ID: "child-one", ProjectID: "film-project", Kind: "video", Status: "succeeded", Parameters: parameters, Result: json.RawMessage(`{}`)}
	if err := validateRestoredGenerationJobRelations([]store.GenerationJob{parent, child}); err != nil {
		t.Fatalf("valid Film parent-child binding rejected: %v", err)
	}
	child.ProjectID = "other-project"
	if err := validateRestoredGenerationJobRelations([]store.GenerationJob{parent, child}); err == nil {
		t.Fatal("cross-project Film child binding was accepted")
	}
	child.ProjectID = "film-project"
	child.Kind = "image"
	if err := validateRestoredGenerationJobRelations([]store.GenerationJob{parent, child}); err == nil {
		t.Fatal("wrong Film child kind was accepted")
	}
	child.Kind = "video"
	parameters, _ = json.Marshal(persistedMediaJobParameters{Executor: serverExecutorMarker, RequestHash: requestHash, Film: binding, EstimatedCredits: 4})
	child.Parameters = parameters
	if err := validateRestoredGenerationJobRelations([]store.GenerationJob{parent, child}); err == nil {
		t.Fatal("Film child quote mismatch was accepted")
	}
	if err := validateRestoredGenerationJobRelations([]store.GenerationJob{parent}); err == nil {
		t.Fatal("new Film parent without its frozen-credit child was accepted")
	}
	legacyParent := filmStageValidationJob(t, filmStageGenerationParameters{Executor: "film-stage", ProjectID: "film-project", Stage: "video", RequestHash: requestHash, ChildJobIDs: []string{"missing-legacy-child"}})
	if err := validateRestoredGenerationJobRelations([]store.GenerationJob{legacyParent}); err != nil {
		t.Fatalf("legacy orphaned Film parent should remain restorable: %v", err)
	}
}

func TestFilmStageChildDeletionRequiresDeletingItsParent(t *testing.T) {
	backend := newMemoryStore()
	parent := filmStageValidationJob(t, filmStageGenerationParameters{Executor: "film-stage", ProjectID: "film-project", Stage: "video", RequestHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ChildJobIDs: []string{"child-one"}})
	backend.jobs[tenantKey(store.DefaultTenantID, parent.ID)] = parent
	if err := validateFilmStageDeletion(context.Background(), backend, store.DefaultTenantID, map[string]struct{}{"child-one": {}}); err == nil {
		t.Fatal("deleting a Film child without its parent was accepted")
	}
	if err := validateFilmStageDeletion(context.Background(), backend, store.DefaultTenantID, map[string]struct{}{"child-one": {}, parent.ID: {}}); err != nil {
		t.Fatalf("deleting a Film parent and child together was rejected: %v", err)
	}
}

func TestGenerationStoreAtomicallyProtectsFilmStageChildren(t *testing.T) {
	backend := newMemoryStore()
	parent := filmStageValidationJob(t, filmStageGenerationParameters{Executor: "film-stage", ProjectID: "film-project", Stage: "video", RequestHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ChildJobIDs: []string{"child-one"}})
	child := store.GenerationJob{ID: "child-one", ProjectID: "film-project", Kind: "video", Status: "succeeded", Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`)}
	backend.jobs[tenantKey(store.DefaultTenantID, parent.ID)] = parent
	backend.jobs[tenantKey(store.DefaultTenantID, child.ID)] = child

	if err := backend.DeleteGenerationJob(t.Context(), store.DefaultTenantID, child.ID); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("atomic single delete error = %v, want conflict", err)
	}
	if _, err := backend.DeleteGenerationJobs(t.Context(), store.DefaultTenantID, []string{child.ID}); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("atomic bulk child-only delete error = %v, want conflict", err)
	}
	if deleted, err := backend.DeleteGenerationJobs(t.Context(), store.DefaultTenantID, []string{child.ID, parent.ID}); err != nil || deleted != 2 {
		t.Fatalf("atomic parent+child delete = %d, %v", deleted, err)
	}
}
