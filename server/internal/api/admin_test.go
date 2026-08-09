package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

func TestTenantAdminAuthOffRequiresProcessToken(t *testing.T) {
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	router := chi.NewRouter()
	MountServer(router, server)
	body := []byte(`{"modelCosts":[],"defaultCredits":1}`)

	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	anonymous := requestWithHeaders(t, router, http.MethodPut, "/api/admin/models", body, nil)
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous admin write = %d %s", anonymous.Code, anonymous.Body.String())
	}
	authorized := requestWithHeaders(t, router, http.MethodPut, "/api/admin/models", body, map[string]string{
		"Authorization": "Bearer test-token",
	})
	if authorized.Code != http.StatusOK {
		t.Fatalf("token admin write = %d %s", authorized.Code, authorized.Body.String())
	}
}

func tenantAdminHandler(t *testing.T, backend *memoryStore, actor store.AuthUser) http.Handler {
	t.Helper()
	t.Setenv("OPENBOARD_AUTH_MODE", "required")
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r = r.WithContext(context.WithValue(r.Context(), authUserKey, actor))
			next.ServeHTTP(w, r)
		})
	})
	MountServer(router, NewServerWithStore(t.TempDir(), backend))
	return router
}

func seedAdminUser(backend *memoryStore, user store.AuthUser) {
	backend.authUsers[tenantKey(user.TenantID, user.ID)] = user
	backend.credits[tenantKey(user.TenantID, user.ID)] = user.Credits
}

func TestAdminModelsPutValidatesAndPersistsTenantCosts(t *testing.T) {
	backend := newMemoryStore()
	actor := store.AuthUser{ID: "owner-1", TenantID: "tenant-a", Role: "owner", Status: "active"}
	seedAdminUser(backend, actor)
	handler := tenantAdminHandler(t, backend, actor)

	body := []byte(`{"modelCosts":[{"model":" gpt-image-1 ","credits":7},{"model":"sora-2","credits":12}],"defaultCredits":3}`)
	got := request(t, handler, http.MethodPut, "/api/admin/models", body)
	if got.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body = %s", got.Code, got.Body.String())
	}
	var saved struct {
		ModelCosts     []store.ModelCreditCost `json:"modelCosts"`
		DefaultCredits int                     `json:"defaultCredits"`
	}
	if err := json.Unmarshal(got.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.DefaultCredits != 3 || len(saved.ModelCosts) != 2 || saved.ModelCosts[0].Model != "gpt-image-1" {
		t.Fatalf("saved = %#v", saved)
	}
	if cost, err := backend.GetModelCreditCost(t.Context(), actor.TenantID, "GPT-IMAGE-1"); err != nil || cost != 7 {
		t.Fatalf("cost = %d, %v", cost, err)
	}

	duplicate := request(t, handler, http.MethodPut, "/api/admin/models", []byte(`{"modelCosts":[{"model":"Model-X","credits":1},{"model":" model-x ","credits":2}],"defaultCredits":1}`))
	if duplicate.Code != http.StatusBadRequest || duplicate.Body.String() != "duplicate model\n" {
		t.Fatalf("duplicate = %d %q", duplicate.Code, duplicate.Body.String())
	}
	negative := request(t, handler, http.MethodPut, "/api/admin/models", []byte(`{"modelCosts":[],"defaultCredits":-1}`))
	if negative.Code != http.StatusBadRequest || negative.Body.String() != "invalid model cost\n" {
		t.Fatalf("negative = %d %q", negative.Code, negative.Body.String())
	}
	zero := request(t, handler, http.MethodPut, "/api/admin/models", []byte(`{"modelCosts":[],"defaultCredits":0}`))
	if zero.Code != http.StatusBadRequest || zero.Body.String() != "invalid model cost\n" {
		t.Fatalf("zero = %d %q", zero.Code, zero.Body.String())
	}
}

func TestAdminTenantGenerationQuotaCanBeReadAndSetToZero(t *testing.T) {
	backend := newMemoryStore()
	actor := store.AuthUser{ID: "owner-1", TenantID: "tenant-a", Role: "owner", Status: "active"}
	seedAdminUser(backend, actor)
	handler := tenantAdminHandler(t, backend, actor)

	updated := request(t, handler, http.MethodPut, "/api/admin/tenant-quota", []byte(`{"generationQuotaMonthly":0}`))
	if updated.Code != http.StatusOK {
		t.Fatalf("PUT = %d %s", updated.Code, updated.Body.String())
	}
	var quota struct {
		GenerationQuotaMonthly int64 `json:"generationQuotaMonthly"`
	}
	if err := json.Unmarshal(updated.Body.Bytes(), &quota); err != nil || quota.GenerationQuotaMonthly != 0 {
		t.Fatalf("updated quota = %#v, %v", quota, err)
	}

	listed := request(t, handler, http.MethodGet, "/api/admin/tenant-quota", nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("GET = %d %s", listed.Code, listed.Body.String())
	}
	if err := json.Unmarshal(listed.Body.Bytes(), &quota); err != nil || quota.GenerationQuotaMonthly != 0 {
		t.Fatalf("listed quota = %#v, %v", quota, err)
	}

	negative := request(t, handler, http.MethodPut, "/api/admin/tenant-quota", []byte(`{"generationQuotaMonthly":-1}`))
	if negative.Code != http.StatusBadRequest {
		t.Fatalf("negative = %d %s", negative.Code, negative.Body.String())
	}
}

func TestAdminCreditAdjustmentIsIdempotentAndQueryable(t *testing.T) {
	backend := newMemoryStore()
	actor := store.AuthUser{ID: "admin-1", TenantID: "tenant-a", Role: "admin", Status: "active"}
	target := store.AuthUser{ID: "member-1", TenantID: actor.TenantID, Role: "member", Status: "active", Credits: 10}
	seedAdminUser(backend, actor)
	seedAdminUser(backend, target)
	handler := tenantAdminHandler(t, backend, actor)
	body := []byte(`{"delta":5,"reason":"service recovery","idempotencyKey":"adjust-20260726-001"}`)

	first := request(t, handler, http.MethodPost, "/api/admin/users/member-1/credit-adjustments", body)
	if first.Code != http.StatusOK {
		t.Fatalf("first = %d %s", first.Code, first.Body.String())
	}
	second := request(t, handler, http.MethodPost, "/api/admin/users/member-1/credit-adjustments", body)
	if second.Code != http.StatusOK {
		t.Fatalf("second = %d %s", second.Code, second.Body.String())
	}
	if got := backend.credits[tenantKey(actor.TenantID, target.ID)]; got != 15 {
		t.Fatalf("credits = %d", got)
	}
	var replay struct {
		Replayed bool `json:"replayed"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &replay); err != nil || !replay.Replayed {
		t.Fatalf("replay = %#v, %v", replay, err)
	}

	conflict := request(t, handler, http.MethodPost, "/api/admin/users/member-1/credit-adjustments", []byte(`{"delta":6,"reason":"service recovery","idempotencyKey":"adjust-20260726-001"}`))
	if conflict.Code != http.StatusConflict || conflict.Body.String() != "idempotency key conflict\n" {
		t.Fatalf("conflict = %d %q", conflict.Code, conflict.Body.String())
	}

	logs := request(t, handler, http.MethodGet, "/api/admin/credit-logs?userId=member-1&reason=service%20recovery&page=1&pageSize=10", nil)
	if logs.Code != http.StatusOK {
		t.Fatalf("logs = %d %s", logs.Code, logs.Body.String())
	}
	var page struct {
		Items []struct {
			UserID  string `json:"userId"`
			ActorID string `json:"actorId"`
			Reason  string `json:"reason"`
			Delta   int64  `json:"delta"`
		} `json:"items"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(logs.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].UserID != target.ID || page.Items[0].ActorID != actor.ID || page.Items[0].Reason != "service recovery" || page.Items[0].Delta != 5 {
		t.Fatalf("page = %#v", page)
	}
}

func TestAdminUserProtectsOwnersAndMapsStoreErrors(t *testing.T) {
	backend := newMemoryStore()
	owner := store.AuthUser{ID: "owner-1", TenantID: "tenant-a", Role: "owner", Status: "active"}
	seedAdminUser(backend, owner)
	handler := tenantAdminHandler(t, backend, owner)

	ban := request(t, handler, http.MethodPatch, "/api/admin/users/owner-1", []byte(`{"status":"ban"}`))
	if ban.Code != http.StatusConflict || ban.Body.String() != "last active owner must be preserved\n" {
		t.Fatalf("ban = %d %q", ban.Code, ban.Body.String())
	}
	if backend.authUsers[tenantKey(owner.TenantID, owner.ID)].Status != "active" {
		t.Fatal("last owner was banned")
	}

	backend.updateUserErr = errors.New("pq: secret database detail")
	failed := request(t, handler, http.MethodPatch, "/api/admin/users/owner-1", []byte(`{"displayName":"Owner"}`))
	if failed.Code != http.StatusInternalServerError || failed.Body.String() != "failed to update user\n" {
		t.Fatalf("failed = %d %q", failed.Code, failed.Body.String())
	}
}

func TestTenantAdminCannotChangeOwnerRoleOrStatus(t *testing.T) {
	backend := newMemoryStore()
	actor := store.AuthUser{ID: "admin-1", TenantID: "tenant-a", Role: "admin", Status: "active"}
	owner := store.AuthUser{ID: "owner-1", TenantID: actor.TenantID, Role: "owner", Status: "active"}
	seedAdminUser(backend, actor)
	seedAdminUser(backend, owner)
	handler := tenantAdminHandler(t, backend, actor)

	for _, body := range []string{`{"role":"member"}`, `{"status":"ban"}`} {
		got := request(t, handler, http.MethodPatch, "/api/admin/users/owner-1", []byte(body))
		if got.Code != http.StatusForbidden || got.Body.String() != "only an owner can modify an owner\n" {
			t.Fatalf("body %s = %d %q", body, got.Code, got.Body.String())
		}
	}
}

func TestAdminMutationsRejectTenantMembers(t *testing.T) {
	backend := newMemoryStore()
	member := store.AuthUser{ID: "member-1", TenantID: "tenant-a", Role: "member", Status: "active"}
	seedAdminUser(backend, member)
	handler := tenantAdminHandler(t, backend, member)

	requests := []struct {
		method string
		path   string
		body   []byte
	}{
		{http.MethodPut, "/api/admin/models", []byte(`{"modelCosts":[],"defaultCredits":1}`)},
		{http.MethodGet, "/api/admin/tenant-quota", nil},
		{http.MethodPut, "/api/admin/tenant-quota", []byte(`{"generationQuotaMonthly":1}`)},
		{http.MethodGet, "/api/admin/credit-logs", nil},
		{http.MethodPost, "/api/admin/users/member-1/credit-adjustments", []byte(`{"delta":1,"reason":"test","idempotencyKey":"member-adjust-1"}`)},
	}
	for _, item := range requests {
		got := request(t, handler, item.method, item.path, item.body)
		if got.Code != http.StatusForbidden || got.Body.String() != "admin required\n" {
			t.Fatalf("%s %s = %d %q", item.method, item.path, got.Code, got.Body.String())
		}
	}
}

func TestAdminUserPatchRejectsNonIdempotentCreditDelta(t *testing.T) {
	backend := newMemoryStore()
	owner := store.AuthUser{ID: "owner-1", TenantID: "tenant-a", Role: "owner", Status: "active"}
	seedAdminUser(backend, owner)
	handler := tenantAdminHandler(t, backend, owner)

	got := request(t, handler, http.MethodPatch, "/api/admin/users/owner-1", []byte(`{"creditsDelta":1}`))
	if got.Code != http.StatusBadRequest || got.Body.String() != "use credit adjustments endpoint\n" {
		t.Fatalf("PATCH = %d %q", got.Code, got.Body.String())
	}
}

func TestStoreAuthorizationRechecksOwnerUnderUpdateLock(t *testing.T) {
	backend := newMemoryStore()
	owner := store.AuthUser{ID: "owner-1", TenantID: "tenant-a", Role: "owner", Status: "active"}
	secondOwner := store.AuthUser{ID: "owner-2", TenantID: owner.TenantID, Role: "owner", Status: "active"}
	seedAdminUser(backend, owner)
	seedAdminUser(backend, secondOwner)
	role := "member"
	_, err := backend.UpdateUser(t.Context(), owner.TenantID, owner.ID, store.UserPatch{Role: &role, ActorRole: "admin"})
	if !errors.Is(err, store.ErrUnauthorized) {
		t.Fatalf("err = %v", err)
	}
}

func TestCreditAdjustmentReplayIsTenantScoped(t *testing.T) {
	backend := newMemoryStore()
	for _, tenantID := range []string{"tenant-a", "tenant-b"} {
		seedAdminUser(backend, store.AuthUser{ID: "member-1", TenantID: tenantID, Role: "member", Status: "active"})
		user, logEntry, replayed, err := backend.AdjustCreditsIdempotent(t.Context(), tenantID, "member-1", "admin-1", "shared-adjustment-key", 2, "tenant scoped", json.RawMessage(`{}`))
		if err != nil || replayed || user.Credits != 2 || logEntry.TenantID != tenantID {
			t.Fatalf("tenant %s = %#v %#v %v %v", tenantID, user, logEntry, replayed, err)
		}
	}
}
