package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func onePixelPNG(t *testing.T) []byte {
	t.Helper()
	value, err := base64.StdEncoding.DecodeString(onePixelPNGBase64())
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestFilmStageWaiverAPIHonorsFeatureGateAndPersistsAudit(t *testing.T) {
	t.Setenv(filmStageWaiverFeatureEnv, "true")
	_, handler := filmAPIHandler(t)
	created := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/script/waivers", []byte(`{"revision":1,"stageRevision":1,"reason":"External approved screenplay supplied.","riskAccepted":true}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("create waiver: %d %s", created.Code, created.Body.String())
	}
	document := decodeFilmResponse(t, created)
	if len(document.StageWaivers) != 1 {
		t.Fatalf("persisted waivers = %d", len(document.StageWaivers))
	}
	revokeBody, _ := json.Marshal(filmStageWaiverRevokeRequest{Revision: document.Revision, WaiverRevision: 1})
	revoked := request(t, handler, http.MethodDelete, "/api/film/projects/film-api/stage-waivers/"+document.StageWaivers[0].ID, revokeBody)
	if revoked.Code != http.StatusOK || decodeFilmResponse(t, revoked).StageWaivers[0].RevokedAt == "" {
		t.Fatalf("revoke waiver: %d %s", revoked.Code, revoked.Body.String())
	}
}

func TestFilmStageWaiverAPIFailsClosedWhenDisabled(t *testing.T) {
	t.Setenv(filmStageWaiverFeatureEnv, "false")
	_, handler := filmAPIHandler(t)
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/script/waivers", []byte(`{"revision":1,"stageRevision":1,"reason":"External approved screenplay supplied.","riskAccepted":true}`))
	if response.Code != http.StatusNotFound {
		t.Fatalf("disabled waiver status = %d body=%s", response.Code, response.Body.String())
	}
}

func TestFilmStageWaiverIsAuditedAndUnblocksOnlyMatchingRevision(t *testing.T) {
	document := newFilmDocument("film-waiver")
	actor := store.AuthUser{ID: "owner-1", Role: "owner", Status: "active"}

	next, err := createFilmStageWaiver(document, "script", filmStageWaiverRequest{
		Revision: document.Revision, StageRevision: document.Stages[1].Revision,
		Reason: "The approved external screenplay is attached.", RiskAccepted: true,
	}, actor, "2026-08-11T00:00:00Z")
	if err != nil {
		t.Fatalf("create waiver: %v", err)
	}
	if len(next.StageWaivers) != 1 {
		t.Fatalf("waivers = %d, want 1", len(next.StageWaivers))
	}
	waiver := next.StageWaivers[0]
	if waiver.StageID != "script" || waiver.ActorID != actor.ID || waiver.ProjectRevision != document.Revision || !waiver.RiskAccepted {
		t.Fatalf("unexpected waiver audit: %#v", waiver)
	}
	if waiver.StageRevision != next.Stages[1].Revision || len(waiver.AffectedDownstream) == 0 {
		t.Fatalf("waiver does not freeze stage/downstream facts: %#v", waiver)
	}
	if err := validateFilmStageDependencies(next, "storyboard"); err != nil {
		t.Fatalf("matching waiver should unblock storyboard: %v", err)
	}

	stale := cloneFilmDocument(next)
	stale.Stages[1].Revision++
	if err := validateFilmStageDependencies(stale, "storyboard"); err == nil || !strings.Contains(err.Error(), "approved or actively waived") {
		t.Fatalf("stale waiver should not unblock dependency: %v", err)
	}
}

func TestFilmStageWaiverRejectsUnsafeOrUnauthorizedRequests(t *testing.T) {
	document := newFilmDocument("film-waiver")
	owner := store.AuthUser{ID: "owner-1", Role: "owner", Status: "active"}
	member := store.AuthUser{ID: "member-1", Role: "member", Status: "active"}
	valid := filmStageWaiverRequest{Revision: document.Revision, StageRevision: 1, Reason: "External approved artifact supplied.", RiskAccepted: true}

	if _, err := createFilmStageWaiver(document, "script", valid, member, "2026-08-11T00:00:00Z"); err == nil || !strings.Contains(err.Error(), "owner or admin") {
		t.Fatalf("member waiver error = %v", err)
	}
	for _, stage := range []string{"decompose", "compose", "delivery"} {
		if _, err := createFilmStageWaiver(document, stage, valid, owner, "2026-08-11T00:00:00Z"); err == nil || !strings.Contains(err.Error(), "cannot be waived") {
			t.Fatalf("%s waiver error = %v", stage, err)
		}
	}
	stale := valid
	stale.Revision++
	if _, err := createFilmStageWaiver(document, "script", stale, owner, "2026-08-11T00:00:00Z"); err == nil || !strings.Contains(err.Error(), "project revision conflict") {
		t.Fatalf("stale project error = %v", err)
	}
	stale = valid
	stale.StageRevision++
	if _, err := createFilmStageWaiver(document, "script", stale, owner, "2026-08-11T00:00:00Z"); err == nil || !strings.Contains(err.Error(), "stage revision conflict") {
		t.Fatalf("stale stage error = %v", err)
	}
}

func TestFilmStageWaiverCanBeRevokedAndIsDisclosed(t *testing.T) {
	document := newFilmDocument("film-waiver")
	actor := store.AuthUser{ID: "admin-1", Role: "admin", Status: "active"}
	next, err := createFilmStageWaiver(document, "script", filmStageWaiverRequest{
		Revision: 1, StageRevision: 1, Reason: "External approved artifact supplied.", RiskAccepted: true,
	}, actor, "2026-08-11T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	report, err := validateFilmDocument(next)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, issue := range report.Issues {
		found = found || issue.Code == "stage_waived" && issue.TargetID == "script"
	}
	if !found {
		t.Fatalf("active waiver missing from quality report: %#v", report.Issues)
	}
	manifest, err := filmManifest(next)
	if err != nil || !strings.Contains(string(manifest), `"stageWaivers"`) || !strings.Contains(string(manifest), `"script"`) {
		t.Fatalf("manifest does not disclose waiver: %v %s", err, manifest)
	}

	revoked, err := revokeFilmStageWaiver(next, next.StageWaivers[0].ID, filmStageWaiverRevokeRequest{
		Revision: next.Revision, WaiverRevision: next.StageWaivers[0].Revision,
	}, actor, "2026-08-11T01:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if revoked.StageWaivers[0].RevokedAt == "" || revoked.StageWaivers[0].RevokedBy != actor.ID {
		t.Fatalf("revocation was not audited: %#v", revoked.StageWaivers[0])
	}
	if err := validateFilmStageDependencies(revoked, "storyboard"); err == nil {
		t.Fatal("revoked waiver still unblocked storyboard")
	}
}

func TestFilmStageWaiverJSONDoesNotLeakUnstructuredActorData(t *testing.T) {
	document := newFilmDocument("film-waiver")
	next, err := createFilmStageWaiver(document, "script", filmStageWaiverRequest{
		Revision: 1, StageRevision: 1, Reason: "External approved artifact supplied.", RiskAccepted: true,
	}, store.AuthUser{ID: "owner-1", Role: "owner", Status: "active"}, "2026-08-11T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(next.StageWaivers[0])
	if err != nil || strings.Contains(string(raw), "Password") {
		t.Fatalf("unsafe waiver serialization: %v %s", err, raw)
	}
}

func TestFilmSplitCandidateAdoptionFreezesVerifiedGridLineage(t *testing.T) {
	_, handler := filmAPIHandler(t)
	document := decodeFilmResponse(t, request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"INT. SET - DAY\nAction."}`)))
	source := onePixelPNG(t)
	child := onePixelPNG(t)
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:grid-source", source, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:grid-child", child, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatal(response.Body.String())
	}
	body, _ := json.Marshal(map[string]any{
		"targetType": "shot", "targetId": document.Shots[0].ID, "targetField": "image", "expectedRevision": document.Shots[0].Revision,
		"sourceNodeId": "node-grid-child", "storageKey": "image:grid-child", "candidateSha256": sha256Hex(child),
		"splitSourceStorageKey": "image:grid-source", "splitCrop": map[string]any{"x": 0, "y": 0, "width": 1, "height": 1},
	})
	adoptedResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/projection/adopt", body)
	if adoptedResponse.Code != http.StatusOK {
		t.Fatalf("adopt split: %d %s", adoptedResponse.Code, adoptedResponse.Body.String())
	}
	adopted := decodeFilmResponse(t, adoptedResponse)
	lineage := adopted.Adoptions[len(adopted.Adoptions)-1]
	if lineage.SplitSourceStorageKey != "image:grid-source" || lineage.SplitSourceSHA256 != sha256Hex(source) || lineage.CandidateSHA256 != sha256Hex(child) || lineage.SplitCrop.Width != 1 {
		t.Fatalf("split lineage = %#v", lineage)
	}

	badBody := strings.Replace(string(body), sha256Hex(child), strings.Repeat("0", 64), 1)
	bad := request(t, handler, http.MethodPost, "/api/film/projects/film-api/projection/adopt", []byte(badBody))
	if bad.Code != http.StatusUnprocessableEntity {
		t.Fatalf("forged candidate hash status = %d body=%s", bad.Code, bad.Body.String())
	}
}
