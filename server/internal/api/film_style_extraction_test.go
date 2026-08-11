package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func seedFilmStyleReference(t *testing.T, server *Server, backend *filmMemoryStore, handler http.Handler) (filmDocument, filmAsset, []byte) {
	t.Helper()
	image := apimartPNG(t)
	key := "upload:style-reference"
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/"+key, image, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatalf("upload style reference: %d %s", response.Code, response.Body.String())
	}
	value, err := server.readTenantBlob(t.Context(), store.DefaultTenantID, key, maxProviderTextImageBytes)
	if err != nil {
		t.Fatal(err)
	}
	record, err := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	if err != nil {
		t.Fatal(err)
	}
	document, err := decodeFilmDocument(record.Document)
	if err != nil {
		t.Fatal(err)
	}
	asset := filmAsset{
		ID: "asset-style-reference", Revision: 3, Kind: "prop", Title: "Reference frame", Status: filmStatusApproved,
		Description: "Frozen visual reference", MediaStorageKey: key, MediaMIMEType: "image/png",
		MediaSHA256: sha256Hex(image), MediaObjectVersion: blobIdentityVersion(value), MediaProvenance: "upload",
	}
	document.Assets = append(document.Assets, asset)
	document.Revision++
	raw, _ := json.Marshal(document)
	updated, err := backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, document.ProjectID, record.Revision, raw)
	if err != nil {
		t.Fatal(err)
	}
	document, err = decodeFilmDocument(updated.Document)
	if err != nil {
		t.Fatal(err)
	}
	return document, asset, image
}

func styleExtractionBody(t *testing.T, revision int, assetID, idempotencyKey, focus string) []byte {
	t.Helper()
	value, err := json.Marshal(map[string]any{
		"revision": revision, "sourceAssetId": assetID, "providerId": "provider-text", "model": "gpt-text",
		"idempotencyKey": idempotencyKey,
		"parameters":     map[string]any{"detailLevel": "high", "includeNegativePrompt": true, "focus": focus},
	})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestFilmStyleExtractionFeatureGate(t *testing.T) {
	t.Setenv(styleExtractionFeatureEnv, "false")
	_, handler := filmAPIHandler(t)
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/style-extractions", []byte(`{}`))
	if response.Code != http.StatusNotFound {
		t.Fatalf("disabled style extraction = %d %s", response.Code, response.Body.String())
	}
}

func TestFilmStyleExtractionQueuesFrozenIdempotentJobAndAdoptsCandidate(t *testing.T) {
	t.Setenv(styleExtractionFeatureEnv, "true")
	server, backend, handler := filmAPIServerHandler(t)
	if err := backend.PutModelCreditConfig(t.Context(), store.DefaultTenantID, store.ModelCreditConfig{DefaultCredits: 1, ModelCosts: []store.ModelCreditCost{{Model: "gpt-text", Credits: 5}}}); err != nil {
		t.Fatal(err)
	}
	document, source, _ := seedFilmStyleReference(t, server, backend, handler)
	body := styleExtractionBody(t, document.Revision, source.ID, "style-pass-1", "lighting and palette")
	createdResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/style-extractions", body)
	if createdResponse.Code != http.StatusAccepted {
		t.Fatalf("create style extraction: %d %s", createdResponse.Code, createdResponse.Body.String())
	}
	created := decodeFilmResponse(t, createdResponse)
	if len(created.Tasks) != 1 || created.Tasks[0].Stage != "style_extraction" || created.Tasks[0].StyleSnapshot == nil {
		t.Fatalf("style task did not freeze its input: %#v", created.Tasks)
	}
	snapshot := created.Tasks[0].StyleSnapshot
	if snapshot.SourceAsset.ID != source.ID || snapshot.SourceAsset.Revision != 3 || snapshot.SourceAsset.MediaSHA256 != source.MediaSHA256 ||
		snapshot.Model != "gpt-text" || snapshot.Parameters.Focus != "lighting and palette" || snapshot.EstimatedCredits != 5 {
		t.Fatalf("style snapshot = %#v", snapshot)
	}
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, created.Tasks[0].GenerationJobID)
	if err != nil || job.Kind != "text" || job.Status != "queued" {
		t.Fatalf("style job = %#v err=%v", job, err)
	}
	var parameters persistedTextJobParameters
	if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Operation != "film_style_extraction" || parameters.Style == nil || parameters.Style.SourceAsset.MediaObjectVersion == "" {
		t.Fatalf("style job parameters = %s", job.Parameters)
	}

	replay := request(t, handler, http.MethodPost, "/api/film/projects/film-api/style-extractions", body)
	if replay.Code != http.StatusOK || len(decodeFilmResponse(t, replay).Tasks) != 1 || backend.atomicBatchCalls.Load() != 1 {
		t.Fatalf("idempotent replay = %d %s batches=%d", replay.Code, replay.Body.String(), backend.atomicBatchCalls.Load())
	}
	conflict := request(t, handler, http.MethodPost, "/api/film/projects/film-api/style-extractions", styleExtractionBody(t, created.Revision, source.ID, "style-pass-1", "camera movement"))
	if conflict.Code != http.StatusConflict {
		t.Fatalf("idempotency conflict accepted: %d %s", conflict.Code, conflict.Body.String())
	}

	job.Status = "succeeded"
	job.Result, _ = json.Marshal(providerTextResult{Text: `{"summary":"Noir rain at night","stylePrompt":"cinematic noir, cyan rain, hard rim light","negativePrompt":"flat daylight","palette":["#07111f","#19d3ff"],"lighting":"hard cyan rim light","composition":"deep perspective","camera":"anamorphic 40mm","texture":"wet grain","tags":["noir","rain"]}`})
	if err := backend.PutGenerationJob(t.Context(), store.DefaultTenantID, job); err != nil {
		t.Fatal(err)
	}
	syncBody, _ := json.Marshal(map[string]any{"revision": created.Revision})
	syncedResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+job.ID+"/sync", syncBody)
	if syncedResponse.Code != http.StatusOK {
		t.Fatalf("sync style extraction: %d %s", syncedResponse.Code, syncedResponse.Body.String())
	}
	synced := decodeFilmResponse(t, syncedResponse)
	if len(synced.StyleCandidates) != 1 || synced.StyleCandidates[0].Status != filmStatusNeedsReview || synced.Tasks[0].Status != filmStatusNeedsReview {
		t.Fatalf("style candidate not reviewable: %#v %#v", synced.StyleCandidates, synced.Tasks)
	}
	candidate := synced.StyleCandidates[0]
	adoptBody, _ := json.Marshal(map[string]any{"revision": synced.Revision, "candidateRevision": candidate.Revision, "title": "Night noir v1"})
	adoptedResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/style-extractions/"+candidate.ID+"/adopt", adoptBody)
	if adoptedResponse.Code != http.StatusOK {
		t.Fatalf("adopt style candidate: %d %s", adoptedResponse.Code, adoptedResponse.Body.String())
	}
	adopted := decodeFilmResponse(t, adoptedResponse)
	if adopted.StyleCandidates[0].Status != filmAICandidateApplied || adopted.StyleCandidates[0].AdoptedAssetID == "" {
		t.Fatalf("candidate was not adopted: %#v", adopted.StyleCandidates[0])
	}
	style := adopted.Assets[len(adopted.Assets)-1]
	if style.Kind != "style" || style.Status != filmStatusApproved || style.Title != "Night noir v1" || style.StyleBible == nil ||
		style.StylePrompt != candidate.Bible.StylePrompt || style.ParentAssetID != source.ID {
		t.Fatalf("adopted immutable style asset = %#v", style)
	}
}

func TestFilmStyleExtractionLoadsFrozenImageAndSupportsRetry(t *testing.T) {
	t.Setenv(styleExtractionFeatureEnv, "true")
	server, backend, handler := filmAPIServerHandler(t)
	document, source, image := seedFilmStyleReference(t, server, backend, handler)
	created := decodeFilmResponse(t, request(t, handler, http.MethodPost, "/api/film/projects/film-api/style-extractions", styleExtractionBody(t, document.Revision, source.ID, "style-retry-1", "texture")))
	task := created.Tasks[0]
	job, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	channel := adminChannelPublic{ID: job.ProviderID, BaseURL: "https://text.example/v1", Protocol: "openai", TimeoutSeconds: 45, DefaultTextModel: job.Model}
	secret, err := server.sealGenerationChannelSecret(store.DefaultTenantID, job.ID, job.Kind, channel, "sk-frozen")
	if err != nil {
		t.Fatal(err)
	}
	var persisted persistedTextJobParameters
	if json.Unmarshal(job.Parameters, &persisted) != nil {
		t.Fatal("decode style job parameters")
	}
	persisted.SharedChannel = &generationChannelSnapshot{ProviderID: channel.ID, BaseURL: channel.BaseURL, Protocol: channel.Protocol, Model: channel.DefaultTextModel, TimeoutSeconds: channel.TimeoutSeconds, Secret: secret}
	job.Parameters, _ = json.Marshal(persisted)
	if err := backend.PutGenerationJob(t.Context(), store.DefaultTenantID, job); err != nil {
		t.Fatal(err)
	}
	_, providerRequest, err := server.resolveTextGenerationRequest(t.Context(), store.DefaultTenantID, job)
	if err != nil || len(providerRequest.Images) != 1 || !strings.HasPrefix(providerRequest.Images[0], "data:image/png;base64,") {
		t.Fatalf("frozen image request = %#v err=%v", providerRequest, err)
	}
	if !bytes.Contains([]byte(providerRequest.Images[0]), []byte(base64.StdEncoding.EncodeToString(image))) {
		t.Fatal("provider request does not contain the frozen source image")
	}
	job.Status, job.Error = "failed", "provider failed"
	if err := backend.PutGenerationJob(t.Context(), store.DefaultTenantID, job); err != nil {
		t.Fatal(err)
	}
	syncBody, _ := json.Marshal(map[string]any{"revision": created.Revision})
	failed := decodeFilmResponse(t, request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+job.ID+"/sync", syncBody))
	retriedResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+job.ID+"/retry", nil)
	if retriedResponse.Code != http.StatusAccepted {
		t.Fatalf("retry style extraction: %d %s", retriedResponse.Code, retriedResponse.Body.String())
	}
	if len(failed.Tasks) != 1 {
		t.Fatalf("failed task state = %#v", failed.Tasks)
	}
	current := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil))
	if len(current.Tasks) != 2 || current.Tasks[1].StyleSnapshot == nil || current.Tasks[1].StyleSnapshot.SourceAsset.MediaSHA256 != source.MediaSHA256 {
		t.Fatalf("retry did not preserve style snapshot: %#v", current.Tasks)
	}

	if overwrite := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/"+source.MediaStorageKey, []byte("changed"), map[string]string{"Content-Type": "image/png"}); overwrite.Code != http.StatusNoContent {
		t.Fatalf("overwrite source: %d %s", overwrite.Code, overwrite.Body.String())
	}
	retryJob, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, current.Tasks[1].GenerationJobID)
	if _, _, err := server.resolveTextGenerationRequest(t.Context(), store.DefaultTenantID, retryJob); err == nil {
		t.Fatal("mutated source blob was accepted as the frozen style input")
	}
}
