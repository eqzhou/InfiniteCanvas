package store

import (
	"errors"
	"testing"
)

func TestValidateBootstrapClaimIsSingleUse(t *testing.T) {
	tests := []struct {
		name       string
		userCount  int
		authorized bool
		wantErr    bool
	}{
		{name: "empty install requires token", userCount: 0, wantErr: true},
		{name: "empty install accepts token", userCount: 0, authorized: true},
		{name: "normal registration after bootstrap", userCount: 1},
		{name: "bootstrap token cannot create a second owner", userCount: 1, authorized: true, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateBootstrapClaim(test.userCount, test.authorized)
			if errors.Is(err, ErrBootstrapRequired) != test.wantErr {
				t.Fatalf("validateBootstrapClaim(%d, %v) = %v", test.userCount, test.authorized, err)
			}
		})
	}
}

func TestCanonicalTenantRolePreservesLegacyAdministratorAuthority(t *testing.T) {
	for _, fixture := range []struct {
		input string
		want  string
	}{
		{input: "owner", want: "owner"},
		{input: "admin", want: "owner"},
		{input: "member", want: "member"},
		{input: "user", want: "member"},
		{input: "unknown", want: ""},
	} {
		if got := CanonicalTenantRole(fixture.input); got != fixture.want {
			t.Fatalf("CanonicalTenantRole(%q) = %q, want %q", fixture.input, got, fixture.want)
		}
	}
}
