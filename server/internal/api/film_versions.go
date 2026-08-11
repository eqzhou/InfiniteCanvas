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
		if len(document.Versions) >= 1_000 {
			return filmDocument{}, errors.New("film entity version limit reached")
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		switch version.EntityType {
		case "scene":
			return restoreFilmSceneVersion(document, *version, input.Revision, now)
		case "dialogue":
			return restoreFilmDialogueVersion(document, *version, input.Revision, now)
		case "asset":
			return restoreFilmAssetVersion(document, *version, input.Revision, now)
		case "timeline":
			return restoreFilmTimelineVersion(document, *version, input.Revision, now)
		case "shot":
			return restoreFilmShotVersion(document, *version, input.Revision, now)
		default:
			return filmDocument{}, errors.New("entity version type is unsupported")
		}
	})
	if ok {
		s.writeFilmDocument(w, r, http.StatusOK, record, document)
	}
}

func finalizeFilmVersionRestore(document filmDocument, invalidationStage, now string) (filmDocument, error) {
	next := invalidateFilmStages(document, invalidationStage, now)
	if err := validateFilmAggregate(next, next.ProjectID); err != nil {
		return filmDocument{}, errors.New("entity version cannot be restored against the current production: " + err.Error())
	}
	return next, nil
}

func restoreFilmShotVersion(document filmDocument, version filmEntityVersion, expectedRevision int, now string) (filmDocument, error) {
	var prior filmShot
	if json.Unmarshal(version.Snapshot, &prior) != nil || prior.ID != version.EntityID || prior.Revision != version.Revision {
		return filmDocument{}, errors.New("entity version snapshot is invalid")
	}
	for index, current := range document.Shots {
		if current.ID != prior.ID {
			continue
		}
		if current.Revision != expectedRevision {
			return filmDocument{}, errors.New("entity version revision conflict")
		}
		currentBytes, err := json.Marshal(current)
		if err != nil {
			return filmDocument{}, err
		}
		document.Versions = append(document.Versions, filmEntityVersion{ID: stableFilmID("version", "shot", current.ID, current.Revision, "restore", version.ID), EntityType: "shot", EntityID: current.ID, Revision: current.Revision, Snapshot: currentBytes, Reason: "restore-before:" + version.ID, CreatedAt: now})
		prior.Revision = current.Revision + 1
		prior.Status = filmStatusDraft
		document.Shots[index] = prior
		return finalizeFilmVersionRestore(document, "script", now)
	}
	return filmDocument{}, errors.New("entity version target not found")
}

func restoreFilmAssetVersion(document filmDocument, version filmEntityVersion, expectedRevision int, now string) (filmDocument, error) {
	var prior filmAsset
	if json.Unmarshal(version.Snapshot, &prior) != nil || prior.ID != version.EntityID || prior.Revision != version.Revision {
		return filmDocument{}, errors.New("entity version snapshot is invalid")
	}
	for index, current := range document.Assets {
		if current.ID != prior.ID {
			continue
		}
		if current.Revision != expectedRevision {
			return filmDocument{}, errors.New("entity version revision conflict")
		}
		currentBytes, err := json.Marshal(current)
		if err != nil {
			return filmDocument{}, err
		}
		document.Versions = append(document.Versions, filmEntityVersion{ID: stableFilmID("version", "asset", current.ID, current.Revision, "restore", version.ID), EntityType: "asset", EntityID: current.ID, Revision: current.Revision, Snapshot: currentBytes, Reason: "restore-before:" + version.ID, CreatedAt: now})
		prior.Revision = current.Revision + 1
		prior.Status = filmStatusDraft
		document.Assets[index] = prior
		return finalizeFilmVersionRestore(document, filmAssetInvalidationStage(prior.Kind), now)
	}
	return filmDocument{}, errors.New("entity version target not found")
}

func restoreFilmTimelineVersion(document filmDocument, version filmEntityVersion, expectedRevision int, now string) (filmDocument, error) {
	var prior filmTimeline
	if version.EntityID != "timeline" || json.Unmarshal(version.Snapshot, &prior) != nil || prior.Revision != version.Revision || validateFilmTimeline(prior) != nil {
		return filmDocument{}, errors.New("entity version snapshot is invalid")
	}
	if document.Timeline.Revision != expectedRevision {
		return filmDocument{}, errors.New("entity version revision conflict")
	}
	currentBytes, err := json.Marshal(document.Timeline)
	if err != nil {
		return filmDocument{}, err
	}
	document.Versions = append(document.Versions, filmEntityVersion{ID: stableFilmID("version", "timeline", document.Timeline.Revision, "restore", version.ID), EntityType: "timeline", EntityID: "timeline", Revision: document.Timeline.Revision, Snapshot: currentBytes, Reason: "restore-before:" + version.ID, CreatedAt: now})
	prior.Revision = document.Timeline.Revision + 1
	document.Timeline = prior
	return finalizeFilmVersionRestore(document, "compose", now)
}

func filmAssetInvalidationStage(kind string) string {
	if kind == "voice" {
		return "audio"
	}
	return "storyboard"
}

func restoreFilmDialogueVersion(document filmDocument, version filmEntityVersion, expectedRevision int, now string) (filmDocument, error) {
	var prior filmDialogue
	if json.Unmarshal(version.Snapshot, &prior) != nil || prior.ID != version.EntityID || prior.Revision != version.Revision {
		return filmDocument{}, errors.New("entity version snapshot is invalid")
	}
	for index, current := range document.Dialogues {
		if current.ID != prior.ID {
			continue
		}
		if current.Revision != expectedRevision {
			return filmDocument{}, errors.New("entity version revision conflict")
		}
		currentBytes, err := json.Marshal(current)
		if err != nil {
			return filmDocument{}, err
		}
		document.Versions = append(document.Versions, filmEntityVersion{ID: stableFilmID("version", "dialogue", current.ID, current.Revision, "restore", version.ID), EntityType: "dialogue", EntityID: current.ID, Revision: current.Revision, Snapshot: currentBytes, Reason: "restore-before:" + version.ID, CreatedAt: now})
		prior.Revision = current.Revision + 1
		prior.Status = filmStatusDraft
		document.Dialogues[index] = prior
		return finalizeFilmVersionRestore(document, "audio", now)
	}
	return filmDocument{}, errors.New("entity version target not found")
}

func restoreFilmSceneVersion(document filmDocument, version filmEntityVersion, expectedRevision int, now string) (filmDocument, error) {
	var prior filmScene
	if json.Unmarshal(version.Snapshot, &prior) != nil || prior.ID != version.EntityID || prior.Revision != version.Revision {
		return filmDocument{}, errors.New("entity version snapshot is invalid")
	}
	for index, current := range document.Scenes {
		if current.ID != prior.ID {
			continue
		}
		if current.Revision != expectedRevision {
			return filmDocument{}, errors.New("entity version revision conflict")
		}
		currentBytes, err := json.Marshal(current)
		if err != nil {
			return filmDocument{}, err
		}
		document.Versions = append(document.Versions, filmEntityVersion{ID: stableFilmID("version", "scene", current.ID, current.Revision, "restore", version.ID), EntityType: "scene", EntityID: current.ID, Revision: current.Revision, Snapshot: currentBytes, Reason: "restore-before:" + version.ID, CreatedAt: now})
		prior.Revision = current.Revision + 1
		prior.Status = filmStatusDraft
		document.Scenes[index] = prior
		return finalizeFilmVersionRestore(document, "storyboard", now)
	}
	return filmDocument{}, errors.New("entity version target not found")
}
