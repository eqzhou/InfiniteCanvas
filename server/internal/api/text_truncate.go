package api

import "unicode/utf8"

// truncateUTF8Bytes caps a string to maxBytes without splitting the trailing
// rune. Slicing at a raw byte offset produces invalid UTF-8 whenever the cut
// lands mid-rune, and Postgres rejects invalid UTF-8 in a text column, so the
// whole INSERT fails. Every user-visible error string in this project is
// Chinese (3 bytes per rune), which makes a mid-rune cut the common case.
func truncateUTF8Bytes(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes
	for end > 0 {
		runeValue, size := utf8.DecodeLastRuneInString(value[:end])
		if runeValue != utf8.RuneError || size != 1 {
			break
		}
		end--
	}
	return value[:end]
}

// truncateSuffixUTF8Bytes keeps the trailing maxBytes of a string without
// splitting the leading rune of the retained slice.
func truncateSuffixUTF8Bytes(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	start := len(value) - maxBytes
	for start < len(value) {
		runeValue, size := utf8.DecodeRuneInString(value[start:])
		if runeValue != utf8.RuneError || size != 1 {
			break
		}
		start++
	}
	return value[start:]
}
