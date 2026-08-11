package store

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
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

func TestCancelComfyUIGenerationJobIsAtomicAndRefundsOnce(t *testing.T) {
	backend := openRefundTestStore(t)
	for _, status := range []string{"queued", "running"} {
		t.Run(status, func(t *testing.T) {
			fixture := seedRefundFixture(t, backend, fmt.Sprintf("comfyui-%s-%d", status, time.Now().UnixNano()))
			if _, err := backend.pool.Exec(t.Context(), `UPDATE openboard_generation_jobs SET
				status=$3, parameters='{"executor":"comfyui"}'::jsonb,
				lease_owner=CASE WHEN $3='running' THEN lease_owner ELSE '' END,
				lease_expires_at=CASE WHEN $3='running' THEN lease_expires_at ELSE NULL END
				WHERE tenant_id=$1 AND id=$2`, fixture.tenantID, fixture.jobID, status); err != nil {
				t.Fatal(err)
			}
			job, err := backend.CancelServerGenerationJob(t.Context(), fixture.tenantID, fixture.jobID, time.Now().UTC())
			if err != nil {
				t.Fatalf("cancel ComfyUI %s job: %v", status, err)
			}
			storedStatus, credits, refunds := refundState(t, backend, fixture)
			if job.Status != "cancelled" || storedStatus != "cancelled" || credits != 100 || refunds != 1 {
				t.Fatalf("status=%s stored=%s credits=%d refunds=%d", job.Status, storedStatus, credits, refunds)
			}
			if _, err := backend.CancelServerGenerationJob(t.Context(), fixture.tenantID, fixture.jobID, time.Now().UTC()); err != nil {
				t.Fatalf("idempotent cancel: %v", err)
			}
			_, credits, refunds = refundState(t, backend, fixture)
			if credits != 100 || refunds != 1 {
				t.Fatalf("duplicate refund credits=%d refunds=%d", credits, refunds)
			}
		})
	}
}
