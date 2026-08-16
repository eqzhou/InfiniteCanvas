package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

// capabilityMemoryStore keeps these endpoint tests independent from postgres
// while retaining the full Store behavior supplied by memoryStore.
type capabilityMemoryStore struct {
	*memoryStore
	platformTenants store.TenantPage
	platformUsers   store.UserPage
	invitations     []store.TenantInvitation
	createdInvite   store.CreatedTenantInvitation
	createdInput    store.TenantInvitationInput
	revokedTenant   string
	revokedID       string
}

func (m *capabilityMemoryStore) ListTenants(_ context.Context, _ store.TenantQuery) (store.TenantPage, error) {
	return m.platformTenants, nil
}

func (m *capabilityMemoryStore) ListPlatformUsers(_ context.Context, _ store.PlatformUserQuery) (store.UserPage, error) {
	return m.platformUsers, nil
}

func (m *capabilityMemoryStore) GetUserAnyTenant(_ context.Context, userID string) (store.AuthUser, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for key, user := range m.authUsers {
		if strings.HasSuffix(key, "\x00"+userID) {
			user.Credits = m.credits[key]
			return user, nil
		}
	}
	return store.AuthUser{}, store.ErrNotFound
}

func (m *capabilityMemoryStore) CreateTenantInvitation(_ context.Context, input store.TenantInvitationInput) (store.CreatedTenantInvitation, error) {
	m.createdInput = input
	return m.createdInvite, nil
}

func (m *capabilityMemoryStore) ListTenantInvitations(_ context.Context, tenantID string) ([]store.TenantInvitation, error) {
	items := make([]store.TenantInvitation, 0, len(m.invitations))
	for _, item := range m.invitations {
		if item.TenantID == tenantID {
			items = append(items, item)
		}
	}
	return items, nil
}

func (m *capabilityMemoryStore) RevokeTenantInvitation(_ context.Context, tenantID, invitationID string) error {
	m.revokedTenant = tenantID
	m.revokedID = invitationID
	return nil
}

func capabilityHandler(t *testing.T, backend *capabilityMemoryStore, actor store.AuthUser) http.Handler {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	router := chi.NewRouter()
	MountServer(router, NewServerWithStore(t.TempDir(), backend))
	return withActor(router, actor)
}

func TestPlatformAdminEndpointsRejectOrdinaryUsers(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	actor := store.AuthUser{ID: "member-a", TenantID: "tenant-a", Role: "admin", Status: "active"}
	handler := capabilityHandler(t, backend, actor)

	got := request(t, handler, http.MethodGet, "/api/platform/tenants", nil)
	if got.Code != http.StatusForbidden {
		t.Fatalf("ordinary tenant admin platform list = %d %s", got.Code, got.Body.String())
	}
}

func TestPlatformAdminCanListAndUpdateAnotherTenant(t *testing.T) {
	backend := &capabilityMemoryStore{
		memoryStore: newMemoryStore(),
		platformTenants: store.TenantPage{
			Items: []store.Tenant{
				{ID: "tenant-a", Name: "Alpha", Plan: "free", GenerationQuotaMonthly: 10},
				{ID: "tenant-b", Name: "Beta", Plan: "pro", GenerationQuotaMonthly: 100},
			},
			Page: 1, PageSize: 20, Total: 2,
		},
	}
	backend.tenants["tenant-b"] = store.Tenant{ID: "tenant-b", Name: "Beta", Plan: "pro", GenerationQuotaMonthly: 100}
	actor := store.AuthUser{ID: "platform-1", TenantID: "tenant-a", Role: "member", Status: "active", PlatformAdmin: true}
	handler := capabilityHandler(t, backend, actor)

	listed := request(t, handler, http.MethodGet, "/api/platform/tenants", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("platform tenant list = %d %s", listed.Code, listed.Body.String())
	}
	var page store.TenantPage
	if err := json.Unmarshal(listed.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode platform tenant page: %v", err)
	}
	if page.Total != 2 || len(page.Items) != 2 || page.Items[1].ID != "tenant-b" {
		t.Fatalf("platform tenant page = %#v", page)
	}

	updated := request(t, handler, http.MethodPut, "/api/platform/tenants/tenant-b/quota", []byte(`{"generationQuotaMonthly":250}`))
	if updated.Code != http.StatusOK {
		t.Fatalf("platform quota update = %d %s", updated.Code, updated.Body.String())
	}
	var tenant store.Tenant
	if err := json.Unmarshal(updated.Body.Bytes(), &tenant); err != nil {
		t.Fatalf("decode updated tenant: %v", err)
	}
	if tenant.ID != "tenant-b" || tenant.GenerationQuotaMonthly != 250 {
		t.Fatalf("updated tenant = %#v", tenant)
	}
	if backend.tenants["tenant-b"].GenerationQuotaMonthly != 250 {
		t.Fatalf("backend tenant quota = %d", backend.tenants["tenant-b"].GenerationQuotaMonthly)
	}
}

func TestPlatformAdminCannotDisableConfiguredPlatformAdmin(t *testing.T) {
	backend := &capabilityMemoryStore{memoryStore: newMemoryStore()}
	actor := store.AuthUser{ID: "platform-1", TenantID: "tenant-a", Email: "platform@example.com", Role: "member", Status: "active", PlatformAdmin: true}
	backend.authUsers[tenantKey(actor.TenantID, actor.ID)] = actor
	backend.credits[tenantKey(actor.TenantID, actor.ID)] = actor.Credits
	handler := capabilityHandler(t, backend, actor)

	got := request(t, handler, http.MethodPatch, "/api/platform/users/platform-1", []byte(`{"status":"ban"}`))
	if got.Code != http.StatusConflict {
		t.Fatalf("platform admin self-ban = %d %s", got.Code, got.Body.String())
	}
}

func TestTenantInvitationEndpointsEnforceRolesAndDoNotLeakToken(t *testing.T) {
	createdAt := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	fixtureToken := strings.Repeat("t", 32)
	backend := &capabilityMemoryStore{
		memoryStore: newMemoryStore(),
		createdInvite: store.CreatedTenantInvitation{
			TenantInvitation: store.TenantInvitation{
				ID: "invite-1", TenantID: "tenant-a", Email: "new@example.com", Role: "member",
				ExpiresAt: createdAt.Add(24 * time.Hour), CreatedBy: "owner-a", CreatedAt: createdAt,
			},
			Token: fixtureToken,
		},
		invitations: []store.TenantInvitation{{
			ID: "invite-1", TenantID: "tenant-a", Email: "new@example.com", Role: "member",
			ExpiresAt: createdAt.Add(24 * time.Hour), CreatedBy: "owner-a", CreatedAt: createdAt,
		}},
	}
	member := store.AuthUser{ID: "member-a", TenantID: "tenant-a", Role: "member", Status: "active"}
	if got := request(t, capabilityHandler(t, backend, member), http.MethodPost, "/api/tenant/invitations", []byte(`{"email":"new@example.com","role":"member"}`)); got.Code != http.StatusForbidden {
		t.Fatalf("member invitation create = %d %s", got.Code, got.Body.String())
	}

	admin := store.AuthUser{ID: "admin-a", TenantID: "tenant-a", Role: "admin", Status: "active"}
	if got := request(t, capabilityHandler(t, backend, admin), http.MethodPost, "/api/tenant/invitations", []byte(`{"email":"new@example.com","role":"admin"}`)); got.Code != http.StatusBadRequest {
		t.Fatalf("legacy admin creating a new privileged invitation = %d %s", got.Code, got.Body.String())
	}

	owner := store.AuthUser{ID: "owner-a", TenantID: "tenant-a", Role: "owner", Status: "active"}
	created := request(t, capabilityHandler(t, backend, owner), http.MethodPost, "/api/tenant/invitations", []byte(`{"email":"new@example.com","role":"user"}`))
	if created.Code != http.StatusCreated || !strings.Contains(created.Body.String(), fixtureToken) {
		t.Fatalf("owner invitation create = %d %s", created.Code, created.Body.String())
	}
	if created.Header().Get("Cache-Control") != "no-store" || created.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("invitation response cache headers = %q/%q", created.Header().Get("Cache-Control"), created.Header().Get("Pragma"))
	}
	if backend.createdInput.TenantID != "tenant-a" || backend.createdInput.CreatedBy != "owner-a" || backend.createdInput.Role != "member" {
		t.Fatalf("created invitation input = %#v", backend.createdInput)
	}

	listed := request(t, capabilityHandler(t, backend, owner), http.MethodGet, "/api/tenant/invitations", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("owner invitation list = %d %s", listed.Code, listed.Body.String())
	}
	if strings.Contains(listed.Body.String(), fixtureToken) {
		t.Fatalf("invitation list leaked one-time token: %s", listed.Body.String())
	}

	revoked := request(t, capabilityHandler(t, backend, owner), http.MethodPost, "/api/tenant/invitations/invite-1/revoke", nil)
	if revoked.Code != http.StatusNoContent || backend.revokedTenant != "tenant-a" || backend.revokedID != "invite-1" {
		t.Fatalf("invitation revoke = %d tenant=%q id=%q body=%s", revoked.Code, backend.revokedTenant, backend.revokedID, revoked.Body.String())
	}
}
