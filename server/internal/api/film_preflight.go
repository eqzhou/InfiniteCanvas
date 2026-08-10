package api

import (
	"net/http"
	"strings"
	"unicode/utf8"
)

type filmSourcePreflightRequest struct {
	Text   string `json:"text"`
	Format string `json:"format,omitempty"`
}

type filmSourcePreflight struct {
	Format       string   `json:"format"`
	Bytes        int      `json:"bytes"`
	Characters   int      `json:"characters"`
	LineCount    int      `json:"lineCount"`
	EpisodeCount int      `json:"episodeCount"`
	SceneCount   int      `json:"sceneCount"`
	Summary      string   `json:"summary"`
	Warnings     []string `json:"warnings"`
}

func analyzeFilmSource(text, format string) (filmSourcePreflight, error) {
	normalized := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"))
	if normalized == "" || len(normalized) > maxFilmSourceBytes || !utf8.ValidString(normalized) {
		return filmSourcePreflight{}, errFilmSourceInvalid
	}
	format = strings.ToLower(strings.TrimSpace(format))
	if format == "" {
		format = "text"
	}
	if format == "md" {
		format = "markdown"
	}
	if format != "text" && format != "txt" && format != "markdown" {
		return filmSourcePreflight{}, errFilmSourceFormat
	}
	lines := strings.Split(normalized, "\n")
	episodes, scenes := 0, 0
	episodeHasScene := false
	episodesMissingScenes := 0
	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if filmEpisodeHeading.MatchString(line) {
			if episodes > 0 && !episodeHasScene {
				episodesMissingScenes++
			}
			episodes++
			episodeHasScene = false
			continue
		}
		if filmSceneHeading.MatchString(line) {
			scenes++
			episodeHasScene = true
		}
	}
	warnings := []string{}
	if episodes == 0 {
		episodes = 1
		warnings = append(warnings, "未识别到明确分集标题，将按单集处理")
	} else if !episodeHasScene {
		episodesMissingScenes++
	}
	if scenes == 0 {
		warnings = append(warnings, "未识别到标准场景标题，请检查 INT./EXT. 或场景标记")
	} else if episodesMissingScenes > 0 {
		warnings = append(warnings, "部分分集没有识别到标准场景标题")
	}
	return filmSourcePreflight{
		Format: format, Bytes: len(normalized), Characters: utf8.RuneCountInString(normalized),
		LineCount: len(lines), EpisodeCount: episodes, SceneCount: scenes,
		Summary: truncateRunes(strings.Join(strings.Fields(normalized), " "), 240), Warnings: warnings,
	}, nil
}

var (
	errFilmSourceInvalid = &filmInputError{"Manuscript text must contain valid UTF-8 text between 1 byte and 1 MiB"}
	errFilmSourceFormat  = &filmInputError{"Only TXT and Markdown manuscript preflight is supported"}
)

type filmInputError struct{ message string }

func (err *filmInputError) Error() string { return err.message }

func (s *Server) preflightFilmSource(w http.ResponseWriter, r *http.Request) {
	var input filmSourcePreflightRequest
	if err := decodeFilmRequest(w, r, maxFilmSourceBytes+4096, &input); err != nil {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if _, _, _, ok := s.loadFilmProduction(w, r, false); !ok {
		return
	}
	result, err := analyzeFilmSource(input.Text, input.Format)
	if err != nil {
		writeFilmError(w, http.StatusUnprocessableEntity, "source_preflight_invalid", err.Error())
		return
	}
	writeJSON(w, map[string]any{"data": result})
}
