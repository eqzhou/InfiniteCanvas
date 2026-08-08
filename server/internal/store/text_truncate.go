package store

import "unicode/utf8"

// truncateTextUTF8Bytes caps a string to maxBytes without splitting the
// trailing rune. Postgres rejects invalid UTF-8 in a text column, so slicing at
// a raw byte offset fails the whole statement whenever the cut lands mid-rune.
// Chinese text is 3 bytes per rune, which makes that the common case for the
// display names, titles, and tags users actually supply.
func truncateTextUTF8Bytes(value string, maxBytes int) string {
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
