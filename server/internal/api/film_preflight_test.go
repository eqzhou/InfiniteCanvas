package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func TestFilmSourcePreflightReportsStructureWithoutWritingFacts(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	before, err := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"format": "markdown",
		"text":   "  EPISODE 1\r\nINT. STATION - NIGHT\r\nLin waits.\r\n\r\nEPISODE 2\r\nNo scene heading here.  ",
	})
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/source/preflight", body)
	if response.Code != http.StatusOK {
		t.Fatalf("preflight: %d %s", response.Code, response.Body.String())
	}
	var payload struct {
		Data struct {
			Format       string   `json:"format"`
			Characters   int      `json:"characters"`
			EpisodeCount int      `json:"episodeCount"`
			SceneCount   int      `json:"sceneCount"`
			Summary      string   `json:"summary"`
			Warnings     []string `json:"warnings"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Data.Format != "markdown" || payload.Data.Characters == 0 || payload.Data.EpisodeCount != 2 ||
		payload.Data.SceneCount != 1 || payload.Data.Summary == "" || len(payload.Data.Warnings) == 0 {
		t.Fatalf("unexpected preflight result: %#v", payload.Data)
	}
	after, err := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	if err != nil || after.Revision != before.Revision || string(after.Document) != string(before.Document) {
		t.Fatalf("preflight mutated film facts: before=%#v after=%#v err=%v", before, after, err)
	}
}

func TestFilmSourcePreflightRejectsUnknownFieldsAndBlankText(t *testing.T) {
	_, handler := filmAPIHandler(t)
	for name, body := range map[string]string{
		"unknown": `{"text":"SCENE 1\nAction.","write":true}`,
		"blank":   `{"text":"  \n "}`,
	} {
		t.Run(name, func(t *testing.T) {
			response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/source/preflight", []byte(body))
			if response.Code != http.StatusBadRequest && response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("unsafe preflight accepted: %d %s", response.Code, response.Body.String())
			}
		})
	}
}
