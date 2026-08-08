package store

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// Display names and asset titles are written to Postgres text columns, which
// reject invalid UTF-8. Slicing at a raw byte offset splits the trailing rune
// of Chinese text, so the INSERT fails and registration/login/asset creation
// breaks outright for those users.
func TestTruncateTextUTF8BytesNeverSplitsARune(t *testing.T) {
	cases := []struct {
		name     string
		value    string
		maxBytes int
	}{
		// "名" is 3 bytes; 200 is not a multiple of 3, so the cut lands mid-rune.
		{"chinese display name at 200", strings.Repeat("名", 100), 200},
		{"chinese asset title at 200", strings.Repeat("标", 100), 200},
		// 64 is likewise not a multiple of 3.
		{"chinese tag at 64", strings.Repeat("签", 40), 64},
		// 4-byte runes must survive too.
		{"emoji at 200", strings.Repeat("😀", 100), 200},
		{"mixed ascii and chinese", strings.Repeat("ab名", 100), 200},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := truncateTextUTF8Bytes(testCase.value, testCase.maxBytes)
			if !utf8.ValidString(got) {
				t.Errorf("result is not valid UTF-8: %q", got)
			}
			if len(got) > testCase.maxBytes {
				t.Errorf("result is %d bytes, want <= %d", len(got), testCase.maxBytes)
			}
		})
	}
}

func TestTruncateTextUTF8BytesLeavesShortValuesIntact(t *testing.T) {
	value := "标准名称"
	if got := truncateTextUTF8Bytes(value, 200); got != value {
		t.Errorf("truncateTextUTF8Bytes(%q, 200) = %q, want unchanged", value, got)
	}
}
