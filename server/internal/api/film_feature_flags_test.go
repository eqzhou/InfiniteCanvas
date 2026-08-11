package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestIncrementFeatureFlagsAreDefaultClosedAndStrict(t *testing.T) {
	for _, name := range []string{
		"OPENBOARD_WEBDAV_MEDIA",
		"OPENBOARD_ADVANCED_VOICE",
		"OPENBOARD_LOCAL_WORKFLOWS",
		"OPENBOARD_STYLE_EXTRACTION",
		"OPENBOARD_FILM_STAGE_WAIVER",
	} {
		t.Run(name+" defaults closed", func(t *testing.T) {
			t.Setenv(name, "")
			if incrementFeatureEnabled(name) {
				t.Fatalf("%s must default to disabled", name)
			}
		})
		t.Run(name+" rejects ambiguous values", func(t *testing.T) {
			t.Setenv(name, "1")
			if incrementFeatureEnabled(name) {
				t.Fatalf("%s must accept only an explicit true value", name)
			}
		})
		t.Run(name+" accepts true case-insensitively", func(t *testing.T) {
			t.Setenv(name, " TRUE ")
			if !incrementFeatureEnabled(name) {
				t.Fatalf("%s should be enabled by true", name)
			}
		})
	}
}

func TestFilmCapabilitiesExposeIncrementFeatureFlags(t *testing.T) {
	t.Setenv("OPENBOARD_WEBDAV_MEDIA", "true")
	t.Setenv("OPENBOARD_ADVANCED_VOICE", "false")
	t.Setenv("OPENBOARD_LOCAL_WORKFLOWS", "true")
	t.Setenv("OPENBOARD_STYLE_EXTRACTION", "true")
	t.Setenv("OPENBOARD_FILM_STAGE_WAIVER", "invalid")
	_, handler := filmAPIHandler(t)

	response := request(t, handler, http.MethodGet, "/api/film/capabilities", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("capabilities: %d %s", response.Code, response.Body.String())
	}
	var payload struct {
		Data struct {
			Features map[string]bool `json:"features"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"webdavMedia":     true,
		"advancedVoice":   false,
		"localWorkflows":  true,
		"styleExtraction": true,
		"stageWaiver":     false,
	}
	for name, expected := range want {
		actual, present := payload.Data.Features[name]
		if !present || actual != expected {
			t.Fatalf("feature %s = %v present=%v, want %v", name, actual, present, expected)
		}
	}
}
