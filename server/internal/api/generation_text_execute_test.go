package api

import (
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func TestServerTextLoopbackRequiresExplicitIsolatedE2EMode(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_E2E_TENANT_TOKEN", "0123456789abcdef0123456789abcdef")
	t.Setenv("OPENBOARD_DATABASE_URL", "postgres://localhost/openboard")
	const tenantID = "e2e-0123456789abcdef01234567"
	if allowServerTextProviderLoopback(tenantID) {
		t.Fatal("loopback was enabled for a non-isolated database")
	}

	t.Setenv("OPENBOARD_DATABASE_URL", "postgres://localhost/openboard_e2e_123_456")
	t.Setenv("OPENBOARD_AUTH_MODE", "account")
	if allowServerTextProviderLoopback(tenantID) {
		t.Fatal("loopback was enabled while account authentication was active")
	}

	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_E2E_TENANT_TOKEN", "")
	if allowServerTextProviderLoopback(tenantID) {
		t.Fatal("loopback was enabled without E2E tenant isolation")
	}

	t.Setenv("OPENBOARD_E2E_TENANT_TOKEN", "0123456789abcdef0123456789abcdef")
	if allowServerTextProviderLoopback(store.DefaultTenantID) {
		t.Fatal("default tenant inherited the E2E loopback exception")
	}
	if !allowServerTextProviderLoopback(tenantID) {
		t.Fatal("isolated formal E2E mode could not use its controlled loopback Provider")
	}
}
