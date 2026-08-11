package store

import (
	"encoding/json"
	"testing"
)

func TestComfyUIGenerationClaimsAreRestrictedToMediaJobs(t *testing.T) {
	for _, kind := range []string{"image", "video", "audio"} {
		claim := GenerationClaim{Kind: kind, Executor: "comfyui"}
		if !validServerGenerationClaim(claim) {
			t.Fatalf("valid ComfyUI claim was rejected: %#v", claim)
		}
		job := GenerationJob{Kind: kind, Parameters: json.RawMessage(`{"executor":"comfyui"}`)}
		if !serverOwnedGenerationJob(job) {
			t.Fatalf("ComfyUI %s job is not protected as server-owned", kind)
		}
	}
	for _, kind := range []string{"text", "workflow", "export", "film-stage", "unknown"} {
		if validServerGenerationClaim(GenerationClaim{Kind: kind, Executor: "comfyui"}) {
			t.Fatalf("non-media ComfyUI claim was accepted for %q", kind)
		}
	}
}
