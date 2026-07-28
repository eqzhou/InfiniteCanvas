package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

// Fixture only; must stay local to tests and never ship as a real secret.
const linuxDoFixturePassphrase = "test-passphrase-not-a-secret"

func openLinuxDoTestStore(t *testing.T) *PostgresStore {
	t.Helper()
	databaseURL := os.Getenv("OPENBOARD_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("OPENBOARD_TEST_DATABASE_URL is required in CI for PostgreSQL Linux.do auth tests")
		}
		t.Skip("OPENBOARD_TEST_DATABASE_URL is required for PostgreSQL Linux.do auth tests")
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

// A password account must never become loggable through Linux.do merely because
// the OAuth profile reports the same email. Auto-linking would let any Linux.do
// identity that claims that address take over the workspace.
func TestUpsertLinuxDoUserRejectsUnlinkedEmailCollision(t *testing.T) {
	backend := openLinuxDoTestStore(t)
	ctx := t.Context()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	email := fmt.Sprintf("owner-%s@example.com", suffix)

	passwordUser, _, err := backend.RegisterUser(ctx, RegisterInput{
		Email:       email,
		Password:    linuxDoFixturePassphrase,
		DisplayName: "Password Owner",
	})
	if err != nil {
		t.Fatalf("register password user: %v", err)
	}

	_, token, err := backend.UpsertLinuxDoUser(ctx, LinuxDoUserInput{
		LinuxDoID:   "linuxdo-" + suffix,
		Email:       email,
		DisplayName: "Linux Do Impersonator",
		Username:    "impersonator",
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("email collision should return ErrConflict, got user token=%q err=%v", token, err)
	}

	var linked string
	if err := backend.pool.QueryRow(ctx, `
SELECT COALESCE(linux_do_id,'') FROM openboard_users WHERE tenant_id=$1 AND id=$2`,
		passwordUser.TenantID, passwordUser.ID).Scan(&linked); err != nil {
		t.Fatalf("reload password user: %v", err)
	}
	if linked != "" {
		t.Fatalf("password account was linked to linux.do id %q", linked)
	}
}

func TestUpsertLinuxDoUserCreatesIndependentAccountWhenEmailIsFree(t *testing.T) {
	backend := openLinuxDoTestStore(t)
	ctx := t.Context()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	// Ensure the installation already has at least one user so the new Linux.do
	// account is forced into its own tenant instead of claiming local.
	if _, _, err := backend.RegisterUser(ctx, RegisterInput{
		Email:       fmt.Sprintf("seed-%s@example.com", suffix),
		Password:    linuxDoFixturePassphrase,
		DisplayName: "Seed",
	}); err != nil {
		t.Fatalf("seed first user: %v", err)
	}

	user, token, err := backend.UpsertLinuxDoUser(ctx, LinuxDoUserInput{
		LinuxDoID:   "linuxdo-new-" + suffix,
		Email:       fmt.Sprintf("linuxdo-%s@example.com", suffix),
		DisplayName: "Linux Do User",
		Username:    "linuxdo-user",
	})
	if err != nil {
		t.Fatalf("create linux.do user: %v", err)
	}
	if token == "" || user.ID == "" || user.TenantID == "" || user.TenantID == DefaultTenantID {
		t.Fatalf("unexpected linux.do user: %#v token empty=%v", user, token == "")
	}
	if user.LinuxDoID != "linuxdo-new-"+suffix {
		t.Fatalf("linux.do id = %q", user.LinuxDoID)
	}

	again, againToken, err := backend.UpsertLinuxDoUser(ctx, LinuxDoUserInput{
		LinuxDoID:   "linuxdo-new-" + suffix,
		Email:       fmt.Sprintf("linuxdo-%s@example.com", suffix),
		DisplayName: "Linux Do User",
		Username:    "linuxdo-user",
	})
	if err != nil {
		t.Fatalf("relogin linux.do user: %v", err)
	}
	if again.ID != user.ID || again.TenantID != user.TenantID || againToken == "" {
		t.Fatalf("relogin changed identity: first=%#v again=%#v", user, again)
	}
}
