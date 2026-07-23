package store

import (
	"strings"
	"testing"
)

func TestHashPasswordAndCheck(t *testing.T) {
	hash, err := HashPassword("correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	if hash == "" || hash == "correct-horse-battery" {
		t.Fatal("expected bcrypt hash")
	}
	if !CheckPassword(hash, "correct-horse-battery") {
		t.Fatal("password should match")
	}
	if CheckPassword(hash, "wrong-password") {
		t.Fatal("wrong password should not match")
	}
}

func TestHashPasswordRejectsShort(t *testing.T) {
	if _, err := HashPassword("short"); err == nil {
		t.Fatal("expected short password error")
	}
}

func TestSessionTokenHashing(t *testing.T) {
	token, hash, err := NewSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(token) != 64 {
		t.Fatalf("token length = %d, want 64 hex chars", len(token))
	}
	if HashSessionToken(token) != hash {
		t.Fatal("hash mismatch")
	}
	if HashSessionToken(token+"x") == hash {
		t.Fatal("different token should not hash equal")
	}
	// tokens should be unique across calls
	token2, hash2, err := NewSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if token == token2 || hash == hash2 {
		t.Fatal("session tokens must not collide")
	}
	if strings.Contains(hash, token) {
		t.Fatal("hash must not contain raw token")
	}
}
