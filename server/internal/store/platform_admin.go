package store

import (
	"os"
	"strings"
)

// IsConfiguredPlatformAdmin is deliberately an exact, deployment-controlled
// allowlist. It is evaluated when an authenticated user is loaded, so an
// operator can grant or revoke platform access by changing the process
// configuration without exposing a self-service elevation endpoint.
func IsConfiguredPlatformAdmin(email string) bool {
	target := strings.ToLower(strings.TrimSpace(email))
	if target == "" {
		return false
	}
	for _, raw := range strings.Split(os.Getenv("OPENBOARD_PLATFORM_ADMIN_EMAILS"), ",") {
		if strings.EqualFold(target, strings.TrimSpace(raw)) {
			return true
		}
	}
	return false
}
