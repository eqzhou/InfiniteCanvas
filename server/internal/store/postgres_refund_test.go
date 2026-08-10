package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

func openRefundTestStore(t *testing.T) *PostgresStore {
	t.Helper()
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for PostgreSQL transaction tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for PostgreSQL transaction tests")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	backend, err := Open(ctx, databaseURL, "")
	if err != nil {
		t.Fatalf("open PostgreSQL test store: %v", err)
	}
	t.Cleanup(backend.Close)
	return backend
}

type refundFixture struct {
	tenantID string
	userID   string
	jobID    string
	owner    string
}

func seedRefundFixture(t *testing.T, backend *PostgresStore, suffix string) refundFixture {
	t.Helper()
	fixture := refundFixture{
		tenantID: "refund-tenant-" + suffix,
		userID:   "refund-user-" + suffix,
		jobID:    "refund-job-" + suffix,
		owner:    "refund-worker-" + suffix,
	}
	ctx := t.Context()
	if _, err := backend.pool.Exec(ctx, `
INSERT INTO openboard_tenants (id,name) VALUES ($1,$2)
ON CONFLICT (id) DO NOTHING`, fixture.tenantID, fixture.tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.pool.Exec(ctx, `
INSERT INTO openboard_users (id,tenant_id,email,password_hash,display_name,role,credits,status)
VALUES ($1,$2,$3,'','refund user','owner',90,'active')`,
		fixture.userID, fixture.tenantID, fixture.userID+"@example.invalid"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := backend.pool.Exec(ctx, `
INSERT INTO openboard_generation_jobs
  (tenant_id,id,kind,status,prompt,provider_id,model,parameters,result,error,created_at,updated_at,lease_owner,lease_expires_at)
VALUES ($1,$2,'image','running','prompt','provider','model',
  '{"executor":"server","sharedChannel":{"providerId":"provider","secret":{"nonce":"nonce","ciphertext":"ciphertext"}}}'::jsonb,
  '{}'::jsonb,'',$3,$3,$4,$5)`,
		fixture.tenantID, fixture.jobID, now, fixture.owner, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.pool.Exec(ctx, `
INSERT INTO openboard_credit_logs
  (tenant_id,user_id,job_id,model,delta,balance_after,reason,meta)
VALUES ($1,$2,$3,'model',-10,90,'reserve','{}'::jsonb)`,
		fixture.tenantID, fixture.userID, fixture.jobID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = backend.pool.Exec(context.Background(), `DELETE FROM openboard_tenants WHERE id=$1`, fixture.tenantID)
	})
	return fixture
}

func generationSecretPresent(t *testing.T, backend *PostgresStore, fixture refundFixture) bool {
	t.Helper()
	var present bool
	if err := backend.pool.QueryRow(t.Context(), `SELECT parameters #> '{sharedChannel,secret}' IS NOT NULL
		FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`, fixture.tenantID, fixture.jobID).Scan(&present); err != nil {
		t.Fatal(err)
	}
	return present
}

func refundState(t *testing.T, backend *PostgresStore, fixture refundFixture) (string, int64, int) {
	t.Helper()
	var status string
	var credits int64
	var refunds int
	if err := backend.pool.QueryRow(t.Context(), `SELECT status FROM openboard_generation_jobs WHERE tenant_id=$1 AND id=$2`, fixture.tenantID, fixture.jobID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := backend.pool.QueryRow(t.Context(), `SELECT credits FROM openboard_users WHERE tenant_id=$1 AND id=$2`, fixture.tenantID, fixture.userID).Scan(&credits); err != nil {
		t.Fatal(err)
	}
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FROM openboard_credit_logs WHERE tenant_id=$1 AND job_id=$2 AND reason IN ('refund','failed','cancelled')`, fixture.tenantID, fixture.jobID).Scan(&refunds); err != nil {
		t.Fatal(err)
	}
	return status, credits, refunds
}

func TestCompleteServerGenerationJobRollsBackTerminalStateWhenRefundFails(t *testing.T) {
	backend := openRefundTestStore(t)
	fixture := seedRefundFixture(t, backend, fmt.Sprintf("rollback-%d", time.Now().UnixNano()))

	lockTx, err := backend.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer lockTx.Rollback(context.Background())
	var lockedCredits int64
	if err := lockTx.QueryRow(t.Context(), `SELECT credits FROM openboard_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, fixture.tenantID, fixture.userID).Scan(&lockedCredits); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(t.Context(), 150*time.Millisecond)
	_, err = backend.CompleteServerGenerationJob(ctx, fixture.tenantID, fixture.jobID, fixture.owner, "failed", []byte(`{}`), "failed", time.Now().UTC())
	cancel()
	if err == nil {
		t.Fatal("terminal transition succeeded even though its refund could not complete")
	}
	if err := lockTx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}

	status, credits, refunds := refundState(t, backend, fixture)
	if status != "running" || credits != 90 || refunds != 0 {
		t.Fatalf("non-atomic terminal transition: status=%s credits=%d refunds=%d", status, credits, refunds)
	}
	if !generationSecretPresent(t, backend, fixture) {
		t.Fatal("rolled-back terminal transition removed the active execution credential")
	}

	if _, err := backend.CompleteServerGenerationJob(t.Context(), fixture.tenantID, fixture.jobID, fixture.owner, "failed", []byte(`{}`), "failed", time.Now().UTC()); err != nil {
		t.Fatalf("retry terminal transition: %v", err)
	}
	status, credits, refunds = refundState(t, backend, fixture)
	if status != "failed" || credits != 100 || refunds != 1 {
		t.Fatalf("retry did not refund exactly once: status=%s credits=%d refunds=%d", status, credits, refunds)
	}
	if generationSecretPresent(t, backend, fixture) {
		t.Fatal("terminal job retained its shared-channel credential")
	}
}

func TestCancelServerGenerationJobRollsBackTerminalStateWhenRefundFails(t *testing.T) {
	backend := openRefundTestStore(t)
	fixture := seedRefundFixture(t, backend, fmt.Sprintf("cancel-rollback-%d", time.Now().UnixNano()))

	lockTx, err := backend.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer lockTx.Rollback(context.Background())
	var lockedCredits int64
	if err := lockTx.QueryRow(t.Context(), `SELECT credits FROM openboard_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, fixture.tenantID, fixture.userID).Scan(&lockedCredits); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(t.Context(), 150*time.Millisecond)
	_, err = backend.CancelServerGenerationJob(ctx, fixture.tenantID, fixture.jobID, time.Now().UTC())
	cancel()
	if err == nil {
		t.Fatal("cancellation succeeded even though its refund could not complete")
	}
	if err := lockTx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}

	status, credits, refunds := refundState(t, backend, fixture)
	if status != "running" || credits != 90 || refunds != 0 {
		t.Fatalf("non-atomic cancellation: status=%s credits=%d refunds=%d", status, credits, refunds)
	}
	if !generationSecretPresent(t, backend, fixture) {
		t.Fatal("rolled-back cancellation removed the active execution credential")
	}

	if _, err := backend.CancelServerGenerationJob(t.Context(), fixture.tenantID, fixture.jobID, time.Now().UTC()); err != nil {
		t.Fatalf("retry cancellation: %v", err)
	}
	status, credits, refunds = refundState(t, backend, fixture)
	if status != "cancelled" || credits != 100 || refunds != 1 {
		t.Fatalf("retry did not refund exactly once: status=%s credits=%d refunds=%d", status, credits, refunds)
	}
	if generationSecretPresent(t, backend, fixture) {
		t.Fatal("cancelled job retained its shared-channel credential")
	}
}

func TestCancelTextServerGenerationJobRefundsAndRemovesCredential(t *testing.T) {
	backend := openRefundTestStore(t)
	fixture := seedRefundFixture(t, backend, fmt.Sprintf("cancel-text-%d", time.Now().UnixNano()))
	if _, err := backend.pool.Exec(t.Context(), `UPDATE openboard_generation_jobs SET kind='text' WHERE tenant_id=$1 AND id=$2`, fixture.tenantID, fixture.jobID); err != nil {
		t.Fatal(err)
	}

	job, err := backend.CancelServerGenerationJob(t.Context(), fixture.tenantID, fixture.jobID, time.Now().UTC())
	if err != nil {
		t.Fatalf("cancel text server job: %v", err)
	}
	status, credits, refunds := refundState(t, backend, fixture)
	if job.Kind != "text" || status != "cancelled" || credits != 100 || refunds != 1 {
		t.Fatalf("text cancellation did not refund exactly once: job=%#v status=%s credits=%d refunds=%d", job, status, credits, refunds)
	}
	if generationSecretPresent(t, backend, fixture) {
		t.Fatal("cancelled text job retained its shared-channel credential")
	}
}

func TestWorkspaceGenerationReplacementRejectsActiveTextServerJob(t *testing.T) {
	backend := openRefundTestStore(t)
	fixture := seedRefundFixture(t, backend, fmt.Sprintf("protect-text-%d", time.Now().UnixNano()))
	if _, err := backend.pool.Exec(t.Context(), `UPDATE openboard_generation_jobs SET kind='text' WHERE tenant_id=$1 AND id=$2`, fixture.tenantID, fixture.jobID); err != nil {
		t.Fatal(err)
	}

	if err := backend.ReplaceGenerationJobs(t.Context(), fixture.tenantID, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("replacement did not protect an active text server job: %v", err)
	}
	job, err := backend.GetGenerationJob(t.Context(), fixture.tenantID, fixture.jobID)
	if err != nil {
		t.Fatalf("load protected text job: %v", err)
	}
	version := GenerationJobsVersion([]GenerationJob{job})
	if err := backend.CompareAndSwapGenerationJobs(t.Context(), fixture.tenantID, version, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("CAS replacement did not protect an active text server job: %v", err)
	}
}

func TestConcurrentCancelAndWorkerFailureRefundExactlyOnce(t *testing.T) {
	backend := openRefundTestStore(t)
	for iteration := range 12 {
		fixture := seedRefundFixture(t, backend, fmt.Sprintf("race-%d-%d", time.Now().UnixNano(), iteration))
		start := make(chan struct{})
		var wait sync.WaitGroup
		wait.Add(2)
		errorsSeen := make(chan error, 2)
		go func() {
			defer wait.Done()
			<-start
			_, err := backend.CompleteServerGenerationJob(t.Context(), fixture.tenantID, fixture.jobID, fixture.owner, "failed", []byte(`{}`), "failed", time.Now().UTC())
			if err != nil && !errors.Is(err, ErrConflict) {
				errorsSeen <- err
			}
		}()
		go func() {
			defer wait.Done()
			<-start
			_, err := backend.CancelServerGenerationJob(t.Context(), fixture.tenantID, fixture.jobID, time.Now().UTC())
			if err != nil {
				errorsSeen <- err
			}
		}()
		close(start)
		wait.Wait()
		close(errorsSeen)
		for err := range errorsSeen {
			t.Fatalf("concurrent terminal transition: %v", err)
		}
		status, credits, refunds := refundState(t, backend, fixture)
		if (status != "failed" && status != "cancelled") || credits != 100 || refunds != 1 {
			t.Fatalf("iteration %d: status=%s credits=%d refunds=%d", iteration, status, credits, refunds)
		}
	}
}

func TestConcurrentRefundCreditsIsExactlyOnceAndRejectsUnknownReasons(t *testing.T) {
	backend := openRefundTestStore(t)
	fixture := seedRefundFixture(t, backend, fmt.Sprintf("refund-race-%d", time.Now().UnixNano()))

	start := make(chan struct{})
	errorsSeen := make(chan error, 16)
	var wait sync.WaitGroup
	for range 16 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			if err := backend.RefundCredits(t.Context(), fixture.tenantID, "", fixture.jobID, "refund"); err != nil {
				errorsSeen <- err
			}
		}()
	}
	close(start)
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Fatalf("concurrent refund: %v", err)
	}
	status, credits, refunds := refundState(t, backend, fixture)
	if status != "running" || credits != 100 || refunds != 1 {
		t.Fatalf("concurrent refund was not exactly once: status=%s credits=%d refunds=%d", status, credits, refunds)
	}
	if err := backend.RefundCredits(t.Context(), fixture.tenantID, "", fixture.jobID, "manual"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown refund reason error = %v", err)
	}
	_, credits, refunds = refundState(t, backend, fixture)
	if credits != 100 || refunds != 1 {
		t.Fatalf("unknown reason changed credits: credits=%d refunds=%d", credits, refunds)
	}
}

func TestDeleteGenerationJobsForProjectRefundsActiveJobs(t *testing.T) {
	backend := openRefundTestStore(t)
	fixture := seedRefundFixture(t, backend, fmt.Sprintf("project-delete-%d", time.Now().UnixNano()))
	const projectID = "board-project-delete"
	if _, err := backend.pool.Exec(t.Context(), `UPDATE openboard_generation_jobs SET project_id=$3 WHERE tenant_id=$1 AND id=$2`,
		fixture.tenantID, fixture.jobID, projectID); err != nil {
		t.Fatal(err)
	}

	deleted, err := backend.DeleteGenerationJobsForProject(t.Context(), fixture.tenantID, projectID)
	if err != nil {
		t.Fatalf("delete project jobs: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted count = %d, want 1", deleted)
	}

	var credits int64
	var refunds int
	if err := backend.pool.QueryRow(t.Context(), `SELECT credits FROM openboard_users WHERE tenant_id=$1 AND id=$2`, fixture.tenantID, fixture.userID).Scan(&credits); err != nil {
		t.Fatal(err)
	}
	if err := backend.pool.QueryRow(t.Context(), `SELECT count(*) FROM openboard_credit_logs WHERE tenant_id=$1 AND job_id=$2 AND reason IN ('refund','failed','cancelled')`, fixture.tenantID, fixture.jobID).Scan(&refunds); err != nil {
		t.Fatal(err)
	}
	if credits != 100 || refunds != 1 {
		t.Fatalf("project deletion did not refund reserved credits: credits=%d refunds=%d", credits, refunds)
	}
	if _, err := backend.GetGenerationJob(t.Context(), fixture.tenantID, fixture.jobID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted job still readable: %v", err)
	}
}
