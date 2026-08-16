package store

import (
	"os"
	"strings"
)

// IsConfiguredPlatformAdminUserID is an exact, deployment-controlled grant
// keyed by the immutable server-generated user ID. Email addresses are not an
// authorization primitive because password registration does not prove email
// ownership.
func IsConfiguredPlatformAdminUserID(userID string) bool {
	target := strings.TrimSpace(userID)
	if target == "" {
		return false
	}
	for _, raw := range strings.Split(os.Getenv("OPENBOARD_PLATFORM_ADMIN_USER_IDS"), ",") {
		if target == strings.TrimSpace(raw) {
			return true
		}
	}
	return false
}
