package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

func sha256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func validSHA256Hex(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

func blobIdentityVersion(value blobObject) string {
	if value.Version != "" {
		return value.Version
	}
	return blobContentVersion(value.Metadata.ContentType, value.Data)
}

func protectedFilmBlobKey(key string) bool {
	return strings.HasPrefix(key, "film:media:") || strings.HasPrefix(key, "film:deliverable:")
}

func publicBlobAPIProtectedKey(key string) bool {
	if protectedFilmBlobKey(key) || strings.HasPrefix(key, "director-capture:") {
		return true
	}
	return strings.HasPrefix(key, "image:generated:") || strings.HasPrefix(key, "media:generated:")
}

func verifyFilmBlob(value blobObject, mimePrefix, expectedMIME, digest, objectVersion string, expectedBytes int64) error {
	if digest == "" || !validSHA256Hex(digest) || sha256Hex(value.Data) != digest {
		return errors.New("film media digest does not match the tenant object")
	}
	if expectedMIME != "" && value.Metadata.ContentType != expectedMIME {
		return errors.New("film media MIME does not match the tenant object")
	}
	if mimePrefix != "" && !strings.HasPrefix(value.Metadata.ContentType, mimePrefix) {
		return errors.New("film media MIME is invalid for its binding")
	}
	if expectedBytes > 0 && int64(len(value.Data)) != expectedBytes {
		return errors.New("film media size does not match the tenant object")
	}
	if objectVersion != "" && blobIdentityVersion(value) != objectVersion {
		return errors.New("film media object version does not match")
	}
	return nil
}
