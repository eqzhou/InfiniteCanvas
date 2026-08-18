package store

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

const (
	bcryptCost        = bcrypt.DefaultCost
	sessionTokenBytes = 32
)

func ValidateNewPassword(password string) error {
	if strings.TrimSpace(password) == "" || len(password) < 8 {
		return ErrPasswordTooShort
	}
	if len(password) > 72 {
		return ErrPasswordTooLong
	}
	return nil
}

func VerifyCurrentPassword(hash, current string) error {
	if hash == "" {
		if current != "" {
			return ErrInvalidCredentials
		}
		return nil
	}
	if !CheckPassword(hash, current) {
		return ErrInvalidCredentials
	}
	return nil
}

func HashPassword(password string) (string, error) {
	if err := ValidateNewPassword(password); err != nil {
		return "", err
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

func HashMediaReferenceToken(token string) string {
	return HashSessionToken(token)
}
