package store

import (
	"encoding/json"
	"testing"
)

func TestWorkspaceSnapshotRoundTripPreservesGenerationJobOwnership(t *testing.T) {
	snapshot := WorkspaceSnapshot{
		Projects: []WorkspaceProject{},
		Films:    []WorkspaceFilm{},
		GenerationJobs: []WorkspaceGenerationJob{{
			UserID: "owner-a",
			Job: GenerationJob{
				ID: "job-a", Kind: "image", Status: "succeeded", Prompt: "prompt",
				Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`),
				CreatedAt: "2026-08-15T00:00:00Z", UpdatedAt: "2026-08-15T00:00:00Z",
			},
		}},
		States: []WorkspaceState{},
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	var restored WorkspaceSnapshot
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	if len(restored.GenerationJobs) != 1 || restored.GenerationJobs[0].UserID != "owner-a" {
		t.Fatalf("job ownership lost from rollback snapshot: %#v", restored.GenerationJobs)
	}
	ownedVersion, err := ComputeWorkspaceVersion(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.GenerationJobs[0].UserID = "owner-b"
	otherVersion, err := ComputeWorkspaceVersion(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if ownedVersion == otherVersion {
		t.Fatal("workspace version did not bind generation-job ownership")
	}
}
