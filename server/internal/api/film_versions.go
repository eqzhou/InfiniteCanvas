package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

func (s *Server) restoreFilmEntityVersion(w http.ResponseWriter, r *http.Request) {
	var input filmRevisionRequest
	if err := decodeFilmRequest(w, r, 4096, &input); err != nil || input.Revision < 1 {
		writeFilmError(w, http.StatusBadRequest, "invalid_request", "current entity revision is required")
		return
	}
	record, document, ok := s.mutateFilmProduction(w, r, func(document filmDocument) (filmDocument, error) {
		var version *filmEntityVersion
		for index := range document.Versions {
			if document.Versions[index].ID == chi.URLParam(r, "versionId") {
				version = &document.Versions[index]
				break
			}
		}
		if version == nil {
			return filmDocument{}, errors.New("entity version not found")
		}
		if version.EntityType != "shot" {
			return filmDocument{}, errors.New("entity version type is unsupported")
		}
		var prior filmShot
		if json.Unmarshal(version.Snapshot, &prior) != nil || prior.ID != version.EntityID || prior.Revision != version.Revision {
			return filmDocument{}, errors.New("entity version snapshot is invalid")
		}
		for index, current := range document.Shots {
			if current.ID != prior.ID {
				continue
			}
			if current.Revision != input.Revision {
				return filmDocument{}, errors.New("entity version revision conflict")
			}
			now := time.Now().UTC().Format(time.RFC3339Nano)
			currentBytes, _ := json.Marshal(current)
			document.Versions = append(document.Versions, filmEntityVersion{ID: stableFilmID("version", "shot", current.ID, current.Revision, "restore", version.ID), EntityType: "shot", EntityID: current.ID, Revision: current.Revision, Snapshot: currentBytes, Reason: "restore-before:" + version.ID, CreatedAt: now})
			prior.Revision = current.Revision + 1
			prior.Status = filmStatusDraft
			document.Shots[index] = prior
			return invalidateFilmStages(document, "script", now), nil
		}
		return filmDocument{}, errors.New("entity version target not found")
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}
