package store

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

const (
	bcryptCost        = bcrypt.DefaultCost
	sessionTokenBytes = 32
)

func HashPassword(password string) (string, error) {
	if len(password) < 8 {
		return "", fmt.Errorf("password must be at least 8 characters")
	}
	if len(password) > 128 {
		return "", fmt.Errorf("password is too long")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func CheckPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func NewSessionToken() (token string, tokenHash string, err error) {
	raw := make([]byte, sessionTokenBytes)
	if _, err = rand.Read(raw); err != nil {
		return "", "", err
	}
	token = hex.EncodeToString(raw)
	tokenHash = HashSessionToken(token)
	return token, tokenHash, nil
}

func HashSessionToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
