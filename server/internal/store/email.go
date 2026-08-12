package store

import "strings"

// NormalizeEmail provides one canonical representation for account and
// invitation email addresses while rejecting whitespace and malformed
// local/domain boundaries.
func NormalizeEmail(raw string) (string, bool) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if len(email) < 3 || len(email) > 320 || strings.ContainsAny(email, "\r\n\t ") {
		return "", false
	}
	at := strings.LastIndexByte(email, '@')
	if at <= 0 || at == len(email)-1 || strings.Contains(email[:at], "@") {
		return "", false
	}
	local, domain := email[:at], email[at+1:]
	for _, char := range local + domain {
		if char < 0x21 || char > 0x7e {
			return "", false
		}
	}
	if strings.HasPrefix(local, ".") || strings.HasSuffix(local, ".") || strings.Contains(local, "..") ||
		strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") || strings.Contains(domain, "..") {
		return "", false
	}
	return email, true
}
