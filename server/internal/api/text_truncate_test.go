package api

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTruncateUTF8BytesCapsWithoutSplittingRunes(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		maxBytes int
		want     string
	}{
		{name: "empty", value: "", maxBytes: 0, want: ""},
		{name: "short value", value: "短文本", maxBytes: 100, want: "短文本"},
		{name: "ascii boundary", value: "abcdef", maxBytes: 3, want: "abc"},
		{name: "chinese mid-rune boundary", value: strings.Repeat("图", 100), maxBytes: 200, want: strings.Repeat("图", 66)},
		{name: "emoji mid-rune boundary", value: strings.Repeat("😀", 10), maxBytes: 10, want: strings.Repeat("😀", 2)},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got := truncateUTF8Bytes(testCase.value, testCase.maxBytes)
			if got != testCase.want {
				t.Fatalf("truncateUTF8Bytes(%q, %d) = %q, want %q", testCase.value, testCase.maxBytes, got, testCase.want)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("result is not valid UTF-8: %q", got)
			}
			if len(got) > testCase.maxBytes {
				t.Fatalf("result is %d bytes, want <= %d", len(got), testCase.maxBytes)
			}
		})
	}
}

func TestTruncateSuffixUTF8BytesKeepsTrailingRunes(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		maxBytes int
		want     string
	}{
		{name: "short value", value: "尾部", maxBytes: 100, want: "尾部"},
		{name: "zero capacity", value: "尾部", maxBytes: 0, want: ""},
		{name: "leading rune cut", value: "头" + strings.Repeat("尾", 100), maxBytes: 200, want: strings.Repeat("尾", 66)},
		{name: "ascii and emoji", value: "prefix😀suffix", maxBytes: 6, want: "suffix"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got := truncateSuffixUTF8Bytes(testCase.value, testCase.maxBytes)
			if got != testCase.want {
				t.Fatalf("truncateSuffixUTF8Bytes(%q, %d) = %q, want %q", testCase.value, testCase.maxBytes, got, testCase.want)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("result is not valid UTF-8: %q", got)
			}
			if len(got) > testCase.maxBytes {
				t.Fatalf("result is %d bytes, want <= %d", len(got), testCase.maxBytes)
			}
		})
	}
}
