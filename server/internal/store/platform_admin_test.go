package store

import "testing"

func TestPlatformAdminGrantUsesStableUserIDOnly(t *testing.T) {
	t.Setenv("OPENBOARD_PLATFORM_ADMIN_EMAILS", "admin@example.com")
	t.Setenv("OPENBOARD_PLATFORM_ADMIN_USER_IDS", "")
	if IsConfiguredPlatformAdminUserID("admin@example.com") {
		t.Fatal("an email value must not be treated as an immutable user-id grant")
	}

	t.Setenv("OPENBOARD_PLATFORM_ADMIN_USER_IDS", " user-a,USER-B ")
	if !IsConfiguredPlatformAdminUserID("user-a") || !IsConfiguredPlatformAdminUserID("USER-B") {
		t.Fatal("configured user IDs were not granted platform capability")
	}
	if IsConfiguredPlatformAdminUserID("user-c") {
		t.Fatal("unlisted user received platform capability")
	}
}
