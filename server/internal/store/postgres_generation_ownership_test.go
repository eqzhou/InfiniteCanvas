package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestGenerationOwnershipFallbackOnlyUsesActiveOwners(t *testing.T) {
	if !strings.Contains(generationJobOwnershipBackfillSQL, "WHERE status='active' AND role IN ('owner','admin')") {
		t.Fatal("generation ownership fallback may assign unclaimed jobs to an ordinary user")
	}
}

func TestGenerationOwnershipBackfillPreservesOriginalAccountEvidence(t *testing.T) {
	backend := openTombstoneTestStore(t)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	tenantID := "ownership-backfill-" + suffix
	ownerID := "ownership-owner-" + suffix
	memberID := "ownership-member-" + suffix
	bannedID := "ownership-banned-" + suffix
	memberOnlyTenantID := "ownership-member-only-" + suffix
	memberOnlyID := "ownership-member-only-user-" + suffix

	if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_tenants (id,name) VALUES ($1,$2)`, tenantID, tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_tenants (id,name) VALUES ($1,$2)`, memberOnlyTenantID, memberOnlyTenantID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = backend.pool.Exec(context.Background(), `DELETE FROM openboard_tenants WHERE id=$1`, tenantID)
		_, _ = backend.pool.Exec(context.Background(), `DELETE FROM openboard_tenants WHERE id=$1`, memberOnlyTenantID)
	})
	for _, account := range []struct {
		id, role, status string
	}{
		{ownerID, "owner", "active"},
		{memberID, "member", "active"},
		{bannedID, "member", "ban"},
	} {
		if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_users (id,tenant_id,email,password_hash,display_name,role,status)
VALUES ($1,$2,$3,'','test user',$4,$5)`, account.id, tenantID, account.id+"@example.invalid", account.role, account.status); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_users (id,tenant_id,email,password_hash,display_name,role,status)
VALUES ($1,$2,$3,'','test user','member','active')`, memberOnlyID, memberOnlyTenantID, memberOnlyID+"@example.invalid"); err != nil {
		t.Fatal(err)
	}

	type jobFixture struct {
		id         string
		kind       string
		parameters map[string]any
		userID     string
	}
	jobs := []jobFixture{
		{"credit-job", "image", map[string]any{"executor": "server"}, ""},
		{"usage-job", "image", map[string]any{"executor": "server"}, ""},
		{"ai-log-job", "text", map[string]any{"executor": "server"}, ""},
		{"workflow-job", "workflow", map[string]any{"executor": "workflow", "billingUserId": memberID}, ""},
		{"comfy-job", "image", map[string]any{"executor": "comfyui", "billingUserId": memberID}, ""},
		{"export-job", "export", map[string]any{"executor": "film-export", "userId": memberID}, ""},
		{"film-child", "image", map[string]any{"executor": "server"}, ""},
		{"film-parent", "film-stage", map[string]any{"executor": "film-stage", "childJobIds": []string{"film-child"}}, ""},
		{"owner-child", "image", map[string]any{"executor": "server"}, ""},
		{"mixed-parent", "film-stage", map[string]any{"executor": "film-stage", "childJobIds": []string{"film-child", "owner-child"}}, ""},
		{"fallback-job", "image", map[string]any{"executor": "server"}, ""},
		{"untrusted-parameters", "image", map[string]any{"executor": "workflow", "billingUserId": memberID}, ""},
		{"banned-parameters", "workflow", map[string]any{"executor": "workflow", "billingUserId": bannedID}, ""},
		{"already-owned", "image", map[string]any{"executor": "server"}, memberID},
	}
	now := time.Now().UTC()
	for index, fixture := range jobs {
		parameters, err := json.Marshal(fixture.parameters)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_generation_jobs
  (tenant_id,id,user_id,kind,status,prompt,parameters,result,created_at,updated_at)
VALUES ($1,$2,$3,$4,'succeeded','', $5, '{}'::jsonb, $6, $6)`,
			tenantID, fixture.id, fixture.userID, fixture.kind, parameters, now.Add(time.Duration(index)*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_generation_jobs
  (tenant_id,id,user_id,kind,status,prompt,parameters,result,created_at,updated_at)
VALUES ($1,'unclaimed-job','','image','succeeded','','{"executor":"server"}'::jsonb,'{}'::jsonb,$2,$2)`,
		memberOnlyTenantID, now); err != nil {
		t.Fatal(err)
	}

	if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_credit_logs (tenant_id,user_id,job_id,delta,balance_after,reason)
VALUES ($1,$2,'credit-job',-1,0,'reserve')`, tenantID, memberID); err != nil {
		t.Fatal(err)
	}
	for jobID, userID := range map[string]string{
		"usage-job":   memberID,
		"film-child":  memberID,
		"owner-child": ownerID,
	} {
		meta, _ := json.Marshal(map[string]string{"jobId": jobID})
		if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_usage_events (tenant_id,user_id,kind,units,meta)
VALUES ($1,$2,'generation',1,$3)`, tenantID, userID, meta); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := backend.pool.Exec(t.Context(), `
INSERT INTO openboard_ai_call_logs
  (tenant_id,id,job_id,user_id,kind,status,request,response,created_at)
VALUES ($1,$2,'ai-log-job',$3,'text','succeeded','{}'::jsonb,'{}'::jsonb,$4)`,
		tenantID, "ownership-ai-log-"+suffix, memberID, now); err != nil {
		t.Fatal(err)
	}

	if _, err := backend.pool.Exec(t.Context(), generationJobOwnershipBackfillSQL); err != nil {
		t.Fatalf("backfill generation ownership: %v", err)
	}
	expected := map[string]string{
		"credit-job":           memberID,
		"usage-job":            memberID,
		"ai-log-job":           memberID,
		"workflow-job":         memberID,
		"comfy-job":            memberID,
		"export-job":           memberID,
		"film-child":           memberID,
		"film-parent":          memberID,
		"owner-child":          ownerID,
		"mixed-parent":         ownerID,
		"fallback-job":         ownerID,
		"untrusted-parameters": ownerID,
		"banned-parameters":    ownerID,
		"already-owned":        memberID,
	}
	for jobID, wanted := range expected {
		var actual string
		if err := backend.pool.QueryRow(t.Context(), `
SELECT user_id FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`, tenantID, jobID).Scan(&actual); err != nil {
			t.Fatal(err)
		}
		if actual != wanted {
			t.Errorf("job %s owner = %q, want %q", jobID, actual, wanted)
		}
	}
	var unclaimedOwner string
	if err := backend.pool.QueryRow(t.Context(), `
SELECT user_id FROM openboard_generation_jobs WHERE tenant_id=$1 AND id='unclaimed-job'`, memberOnlyTenantID).Scan(&unclaimedOwner); err != nil {
		t.Fatal(err)
	}
	if unclaimedOwner != "" {
		t.Fatalf("ownerless tenant job assigned to ordinary user %q", unclaimedOwner)
	}
}
