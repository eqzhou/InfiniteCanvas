package api

import (
	"net/http"
	"strings"

	"github.com/openboard/openboard/server/internal/store"
)

type accessCapability string

const (
	capabilityPlatformManage accessCapability = "platform.manage"
	capabilityTenantManage   accessCapability = "tenant.manage"
)

// Tenant roles are intentionally orthogonal to PlatformAdmin. A platform
// administrator may be a normal tenant user in the tenant they belong to.
type tenantRole string

const (
	tenantRoleOwner tenantRole = "owner"
	tenantRoleUser  tenantRole = "user"
)

func tenantRoleOf(user store.AuthUser) tenantRole {
	switch store.CanonicalTenantRole(user.Role) {
	case string(tenantRoleOwner):
		return tenantRoleOwner
	case "member":
		return tenantRoleUser
	}
	return tenantRole("")
}

func isTenantOwner(user store.AuthUser) bool {
	return tenantRoleOf(user) == tenantRoleOwner
}

func isTenantUser(user store.AuthUser) bool {
	return tenantRoleOf(user) == tenantRoleUser
}

// generationJobScopeUserID returns an empty filter only for tenant Owners and
// auth-off local operation. Platform administration is deliberately irrelevant:
// it does not grant access to a tenant's prompts, results, or paid tasks.
func generationJobScopeUserID(r *http.Request) (string, bool) {
	if authMode() == "off" {
		return "", true
	}
	if requestHasBootstrapProcessAccess(r) {
		return "", true
	}
	user, ok := authUserFrom(r.Context())
	if !ok || strings.TrimSpace(user.ID) == "" || strings.EqualFold(strings.TrimSpace(user.Status), "ban") {
		return "", false
	}
	if isTenantOwner(user) {
		return "", true
	}
	return strings.TrimSpace(user.ID), true
}

func requestCanAccessGenerationJob(r *http.Request, job store.GenerationJob) bool {
	if authMode() == "off" || requestHasBootstrapProcessAccess(r) {
		return true
	}
	user, ok := authUserFrom(r.Context())
	if !ok || strings.TrimSpace(user.ID) == "" || strings.EqualFold(strings.TrimSpace(user.Status), "ban") {
		return false
	}
	return isTenantOwner(user) || strings.TrimSpace(job.UserID) != "" && job.UserID == user.ID
}

// requestOwnsGenerationJob is stricter than inspection access. Owners may
// inspect tenant history, but an idempotent create must never return or reuse a
// different account's task merely because the caller is an Owner.
func requestOwnsGenerationJob(r *http.Request, job store.GenerationJob) bool {
	if authMode() == "off" || requestHasBootstrapProcessAccess(r) {
		return true
	}
	user, ok := authUserFrom(r.Context())
	return ok && strings.TrimSpace(user.ID) != "" && !strings.EqualFold(strings.TrimSpace(user.Status), "ban") &&
		strings.TrimSpace(job.UserID) != "" && job.UserID == user.ID
}

func userHasCapability(user store.AuthUser, capability accessCapability) bool {
	switch capability {
	case capabilityPlatformManage:
		return user.PlatformAdmin || store.IsConfiguredPlatformAdminUserID(user.ID)
	case capabilityTenantManage:
		return isTenantOwner(user)
	default:
		return false
	}
}

func capabilityDeniedMessage(capability accessCapability) string {
	if capability == capabilityPlatformManage {
		return "platform administrator required"
	}
	return "tenant owner required"
}

// requireCapability is the single authorization boundary for control-plane
// operations. Platform administration and tenant ownership are deliberately
// independent: possessing one capability never grants the other.
func (s *Server) requireCapability(
	w http.ResponseWriter,
	r *http.Request,
	capability accessCapability,
	unavailable string,
) bool {
	if s.store == nil {
		http.Error(w, unavailable, http.StatusServiceUnavailable)
		return false
	}
	if authMode() == "off" {
		if !s.authorizeProcessToken(r) {
			http.Error(w, "invalid access token", http.StatusUnauthorized)
			return false
		}
		return true
	}
	if user, ok := authUserFrom(r.Context()); ok {
		if strings.EqualFold(strings.TrimSpace(user.Status), "ban") {
			http.Error(w, "account disabled", http.StatusForbidden)
			return false
		}
		if !userHasCapability(user, capability) {
			http.Error(w, capabilityDeniedMessage(capability), http.StatusForbidden)
			return false
		}
		return true
	}
	if authMode() == "required" {
		http.Error(w, "login required", http.StatusUnauthorized)
		return false
	}

	// Empty optional-mode installations may be bootstrapped only by the local
	// process credential. Once any account exists, that credential cannot invent
	// a user/tenant identity or bypass either role boundary.
	count, err := s.store.CountUsers(r.Context())
	if err != nil {
		http.Error(w, "failed to verify administrative access", http.StatusServiceUnavailable)
		return false
	}
	if count == 0 && s.authorizeProcessToken(r) {
		return true
	}
	http.Error(w, "login required", http.StatusUnauthorized)
	return false
}

func (s *Server) requireTenantOwner(w http.ResponseWriter, r *http.Request, unavailable string) bool {
	return s.requireCapability(w, r, capabilityTenantManage, unavailable)
}

func (s *Server) requirePlatformAdmin(w http.ResponseWriter, r *http.Request) bool {
	return s.requireCapability(w, r, capabilityPlatformManage, "platform administration unavailable")
}
