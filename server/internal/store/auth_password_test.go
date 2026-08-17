package store

import (
	"errors"
	"strings"
	"testing"
)

func TestVerifyCurrentPassword(t *testing.T) {
	hash, err := HashPassword("correct-horse")
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyCurrentPassword(hash, "correct-horse"); err != nil {
		t.Fatalf("matching current password: %v", err)
	}
	if err := VerifyCurrentPassword(hash, "wrong-horse"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong current password = %v", err)
	}
	if err := VerifyCurrentPassword(hash, ""); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("empty current against existing hash = %v", err)
	}
	if err := VerifyCurrentPassword("", ""); err != nil {
		t.Fatalf("oauth account with empty current: %v", err)
	}
	if err := VerifyCurrentPassword("", "anything1"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("oauth account with unexpected current = %v", err)
	}
}

func TestValidateNewPassword(t *testing.T) {
	if err := ValidateNewPassword("short"); !errors.Is(err, ErrPasswordTooShort) {
		t.Fatalf("short password = %v", err)
	}
	if err := ValidateNewPassword(strings.Repeat(" ", 8)); !errors.Is(err, ErrPasswordTooShort) {
		t.Fatalf("whitespace password = %v", err)
	}
	if err := ValidateNewPassword("long-enough"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateNewPassword(strings.Repeat("a", 72)); err != nil {
		t.Fatal(err)
	}
	if err := ValidateNewPassword(strings.Repeat("a", 73)); !errors.Is(err, ErrPasswordTooLong) {
		t.Fatalf("73-byte password = %v", err)
	}
}
