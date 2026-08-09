package store

import "testing"

func TestGenerationQuotaHasNoUnlimitedZeroSentinel(t *testing.T) {
	tests := []struct {
		name      string
		used      int64
		requested int
		quota     int64
		exceeded  bool
	}{
		{name: "zero blocks first generation", used: 0, requested: 1, quota: 0, exceeded: true},
		{name: "remaining allowance permits request", used: 2, requested: 1, quota: 3, exceeded: false},
		{name: "request cannot cross allowance", used: 2, requested: 2, quota: 3, exceeded: true},
		{name: "fully used allowance blocks request", used: 3, requested: 1, quota: 3, exceeded: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := generationQuotaExceeded(test.used, test.requested, test.quota); got != test.exceeded {
				t.Fatalf("generationQuotaExceeded(%d, %d, %d) = %v", test.used, test.requested, test.quota, got)
			}
		})
	}
}

func TestOnlyProviderGenerationConsumesQuotaAndCredits(t *testing.T) {
	for _, kind := range []string{"image", "video", "audio"} {
		if !generationJobConsumesQuota(kind) {
			t.Fatalf("%s should consume generation quota", kind)
		}
	}
	for _, kind := range []string{"export", "workflow"} {
		if generationJobConsumesQuota(kind) {
			t.Fatalf("%s should not consume model generation quota", kind)
		}
	}
}
