package store

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeGenerationJobCategoryMatchesWorkbenchRules(t *testing.T) {
	for _, test := range []struct {
		name  string
		value string
		want  string
	}{
		{name: "trim", value: "  poster  ", want: "poster"},
		{name: "non-breaking-space trim", value: "\u00a0poster\u00a0", want: "poster"},
		{name: "ideographic-space trim", value: "\u3000poster\u3000", want: "poster"},
		{name: "byte-order-mark trim", value: "\ufeffposter\ufeff", want: "poster"},
		{name: "empty", value: "", want: GenerationJobUncategorized},
		{name: "overlong", value: strings.Repeat("x", 101), want: GenerationJobUncategorized},
		{name: "control character", value: "poster\ncopy", want: GenerationJobUncategorized},
		{name: "format character", value: "poster\u200bcopy", want: GenerationJobUncategorized},
		{name: "surrogate boundary accepted", value: strings.Repeat("😀", 50), want: strings.Repeat("😀", 50)},
		{name: "surrogate boundary rejected", value: strings.Repeat("😀", 51), want: GenerationJobUncategorized},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := NormalizeGenerationJobCategory(test.value); got != test.want {
				t.Fatalf("normalized category = %q, want %q", got, test.want)
			}
		})
	}
}

func TestGenerationJobCategoriesKeepLiteralAllDistinctFromUncategorized(t *testing.T) {
	jobs := []GenerationJob{
		{Parameters: json.RawMessage(`{"category":"全部"}`)},
		{Parameters: json.RawMessage(`{"category":"bad\ncategory"}`)},
	}
	got := GenerationJobCategories(jobs)
	want := []string{"全部", GenerationJobUncategorized}
	if len(got) != len(want) {
		t.Fatalf("categories = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("categories = %#v, want %#v", got, want)
		}
	}
}

func TestGenerationJobCategoryTreatsMissingAndNonStringAsUncategorized(t *testing.T) {
	for _, parameters := range []json.RawMessage{
		json.RawMessage(`{}`),
		json.RawMessage(`{"category":"   "}`),
		json.RawMessage(`{"category":"\u00a0\u2003"}`),
		json.RawMessage(`{"category":42}`),
	} {
		if got := GenerationJobCategory(parameters); got != GenerationJobUncategorized {
			t.Fatalf("category for %s = %q, want %q", parameters, got, GenerationJobUncategorized)
		}
	}
}
