package store

import "testing"

func TestNormalizeEmail(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
		valid bool
	}{
		{name: "canonicalizes", input: "  Person@Example.COM ", want: "person@example.com", valid: true},
		{name: "rejects whitespace", input: "person @example.com", valid: false},
		{name: "rejects repeated separators", input: "person..name@example.com", valid: false},
		{name: "rejects missing local part", input: "@example.com", valid: false},
		{name: "rejects missing domain", input: "person@", valid: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, valid := NormalizeEmail(test.input)
			if valid != test.valid || got != test.want {
				t.Fatalf("NormalizeEmail(%q) = (%q, %v), want (%q, %v)", test.input, got, valid, test.want, test.valid)
			}
		})
	}
}
