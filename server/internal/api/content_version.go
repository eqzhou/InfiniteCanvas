package api

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

func contentVersion(value []byte) string {
	sum := sha256.Sum256(value)
	return "m1-" + hex.EncodeToString(sum[:])
}

func blobContentVersion(contentType string, value []byte) string {
	return contentVersion(append(append([]byte(contentType), 0), value...))
}

func setContentETag(w http.ResponseWriter, version string) {
	w.Header().Set("ETag", `"`+version+`"`)
}

func parseExpectedVersion(w http.ResponseWriter, r *http.Request) (string, bool, bool) {
	if strings.TrimSpace(r.Header.Get("If-None-Match")) == "*" {
		return "", true, true
	}
	value := strings.TrimSpace(r.Header.Get("If-Match"))
	if value == "" {
		value = strings.TrimSpace(r.Header.Get("X-OpenBoard-Config-Version"))
	}
	if value == "" {
		// A few CDN/reverse-proxy combinations remove conditional and custom
		// request headers on PUT. The ETag is not secret, so accept the same
		// strictly validated token in the query as a final transport fallback.
		value = strings.TrimSpace(r.URL.Query().Get("configVersion"))
	}
	if len(value) >= 3 && value[0] == '"' && value[len(value)-1] == '"' {
		value = value[1 : len(value)-1]
		if strings.HasPrefix(value, "m1-") && len(value) == 67 {
			return value, false, true
		}
	}
	http.Error(w, "precondition required", http.StatusPreconditionRequired)
	return "", false, false
}
