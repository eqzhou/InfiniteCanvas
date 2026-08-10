package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

type recordingTextExecutor struct {
	connection providerModelConnection
	request    providerTextRequest
	result     string
	err        error
}

func (executor *recordingTextExecutor) Generate(
	_ context.Context,
	connection providerModelConnection,
	request providerTextRequest,
) (string, error) {
	executor.connection = connection
	executor.request = request
	return executor.result, executor.err
}

func TestSharedChannelSupportsTextGenerationJobs(t *testing.T) {
	channel := adminChannelPublic{
		ID:               "shared-text",
		Enabled:          true,
		AllowUserUse:     true,
		Protocol:         "openai",
		DefaultTextModel: "gpt-text",
		Models:           []string{"gpt-text"},
	}
	if !sharedChannelSupports(channel, "text", "") {
		t.Fatal("shared channel did not advertise its configured default text model")
	}
	if !sharedChannelSupports(channel, "text", "gpt-text") {
		t.Fatal("shared channel rejected an explicitly allowed text model")
	}
	channel.Protocol = "apimart"
	if sharedChannelSupports(channel, "text", "gpt-text") {
		t.Fatal("media-only protocol was accepted for text generation")
	}
}

func TestTextGenerationJobsAreServerManaged(t *testing.T) {
	parameters, err := json.Marshal(map[string]any{"executor": serverExecutorMarker})
	if err != nil {
		t.Fatal(err)
	}
	job := store.GenerationJob{Kind: "text", Parameters: parameters}
	if !isServerGenerationJob(job) {
		t.Fatal("durable text job was not recognized as a server generation job")
	}
}

func TestTextWorkerUsesFrozenChannelAndPersistsProviderResult(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	channel := adminChannelPublic{
		ID: "shared-text", BaseURL: "https://text.example/v1", Protocol: "openai",
		TimeoutSeconds: 45, DefaultTextModel: "gpt-text",
	}
	secret, err := server.sealGenerationChannelSecret(
		store.DefaultTenantID, "text-job", "text", channel, "sk-frozen",
	)
	if err != nil {
		t.Fatal(err)
	}
	parameters, err := json.Marshal(persistedTextJobParameters{
		Executor: serverExecutorMarker, RequestHash: "request-hash", Operation: "film_decompose",
		PromptVersion: "film-decompose-v1", OutputSchema: "film-decompose-v1",
		SharedChannel: &generationChannelSnapshot{
			ProviderID: channel.ID, BaseURL: channel.BaseURL, Protocol: channel.Protocol,
			Model: channel.DefaultTextModel, TimeoutSeconds: channel.TimeoutSeconds,
			SystemPrompt: "return strict json", Secret: secret,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	job := store.GenerationJob{
		ID: "text-job", ProjectID: "film-project", Kind: "text", Status: "running",
		Prompt: "untrusted manuscript", ProviderID: channel.ID, Model: channel.DefaultTextModel,
		Parameters: parameters, Result: json.RawMessage(`{}`), LeaseOwner: "worker-1",
		CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano),
	}
	if err := backend.CreateGenerationJob(t.Context(), store.DefaultTenantID, job); err != nil {
		t.Fatal(err)
	}
	executor := &recordingTextExecutor{result: validFilmAIDecompositionJSON}
	server.textExecutor = executor
	server.executeClaimedTextJob(store.TenantGenerationJob{TenantID: store.DefaultTenantID, Job: job})

	stored, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, job.ID)
	expectedResult, _ := json.Marshal(providerTextResult{Text: validFilmAIDecompositionJSON})
	if err != nil || stored.Status != "succeeded" || string(stored.Result) != string(expectedResult) {
		t.Fatalf("completed text job = %#v, err=%v", stored, err)
	}
	if executor.connection.APIKey != "sk-frozen" || executor.connection.BaseURL != channel.BaseURL ||
		executor.connection.Timeout != 45*time.Second || executor.request.SystemPrompt != "return strict json" ||
		executor.request.Prompt != job.Prompt || executor.request.Model != job.Model {
		t.Fatalf("frozen request was not honored: connection=%#v request=%#v", executor.connection, executor.request)
	}
	if string(stored.Parameters) == "" || containsJSONSecret(stored.Parameters) {
		t.Fatalf("completed job retained a public execution credential: %s", stored.Parameters)
	}
}

func containsJSONSecret(value json.RawMessage) bool {
	var root map[string]json.RawMessage
	if json.Unmarshal(value, &root) != nil {
		return true
	}
	var snapshot map[string]json.RawMessage
	return json.Unmarshal(root["sharedChannel"], &snapshot) == nil && snapshot["secret"] != nil
}

func TestFilmAIDecomposeRunCreatesOneIdempotentTextJob(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"INT. STATION - NIGHT\nLin hears a signal."}`))
	if response.Code != http.StatusOK {
		t.Fatalf("source: %d %s", response.Code, response.Body.String())
	}
	document := decodeFilmResponse(t, response)
	body, err := json.Marshal(map[string]any{
		"revision": document.Stages[0].Revision, "mode": "ai", "providerId": "provider-text",
		"model": "gpt-text", "idempotencyKey": "decompose-pass-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	first := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/decompose/run", body)
	if first.Code != http.StatusAccepted {
		t.Fatalf("AI decompose run: %d %s", first.Code, first.Body.String())
	}
	created := decodeFilmResponse(t, first)
	if created.Stages[0].Status != filmStatusRunning || len(created.Tasks) == 0 {
		t.Fatalf("stage/task state = %#v %#v", created.Stages[0], created.Tasks)
	}
	task := created.Tasks[len(created.Tasks)-1]
	if task.Stage != "decompose" || task.ShotID != "" || task.GenerationJobID == "" || task.TextSnapshot == nil ||
		task.TextSnapshot.SourceRevision != document.Source.Revision || task.TextSnapshot.SourceSHA256 == "" ||
		task.TextSnapshot.Model != "gpt-text" || task.TextSnapshot.PromptVersion != "film-decompose-v1" {
		t.Fatalf("text task did not freeze its inputs: %#v", task)
	}
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err != nil || job.Kind != "text" || job.Status != "queued" || job.ProjectID != "film-api" {
		t.Fatalf("text generation job = %#v err=%v", job, err)
	}
	if bytes.Contains(job.Parameters, []byte("INT. STATION")) {
		t.Fatalf("manuscript was duplicated into job parameters: %s", job.Parameters)
	}

	second := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/decompose/run", body)
	if second.Code != http.StatusOK {
		t.Fatalf("idempotent replay: %d %s", second.Code, second.Body.String())
	}
	replayed := decodeFilmResponse(t, second)
	if len(replayed.Tasks) != len(created.Tasks) {
		t.Fatalf("idempotent replay duplicated tasks: %d -> %d", len(created.Tasks), len(replayed.Tasks))
	}

	conflictBody := bytes.Replace(body, []byte(`"gpt-text"`), []byte(`"gpt-text-2"`), 1)
	conflict := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/decompose/run", conflictBody)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("idempotency mismatch accepted: %d %s", conflict.Code, conflict.Body.String())
	}

	listed := request(t, handler, http.MethodGet, "/api/generation-jobs?kind=text", nil)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte(task.GenerationJobID)) {
		t.Fatalf("text job was hidden from task history: %d %s", listed.Code, listed.Body.String())
	}
}

func TestFilmAICandidateMustBeAppliedBeforeStageApproval(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"INT. STATION - NIGHT\nLin hears a signal."}`))
	document := decodeFilmResponse(t, response)
	body, _ := json.Marshal(map[string]any{
		"revision": document.Stages[0].Revision, "mode": "ai", "providerId": "provider-text",
		"model": "gpt-text", "idempotencyKey": "apply-pass-1",
	})
	created := decodeFilmResponse(t, request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/decompose/run", body))
	task := created.Tasks[len(created.Tasks)-1]
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err != nil {
		t.Fatal(err)
	}
	job.Status = "succeeded"
	job.Result, _ = json.Marshal(providerTextResult{Text: validFilmAIDecompositionJSON})
	record, err := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	if err != nil {
		t.Fatal(err)
	}
	ready, err := integrateFilmTextJobResult(created, job, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(ready)
	if _, err := backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, "film-api", record.Revision, raw); err != nil {
		t.Fatal(err)
	}

	approve, _ := json.Marshal(map[string]any{"revision": ready.Stages[0].Revision})
	blocked := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/decompose/approve", approve)
	if blocked.Code != http.StatusUnprocessableEntity && blocked.Code != http.StatusConflict {
		t.Fatalf("ready candidate bypassed apply review: %d %s", blocked.Code, blocked.Body.String())
	}

	candidate := ready.AICandidates[0]
	applyBody, _ := json.Marshal(map[string]any{"revision": candidate.Revision})
	appliedResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/ai-candidates/"+candidate.ID+"/apply", applyBody)
	if appliedResponse.Code != http.StatusOK {
		t.Fatalf("apply candidate: %d %s", appliedResponse.Code, appliedResponse.Body.String())
	}
	applied := decodeFilmResponse(t, appliedResponse)
	if len(applied.StructureVersions) != 1 || applied.AICandidates[0].Status != filmAICandidateApplied || applied.Episodes[0].Title != "The signal" {
		t.Fatalf("candidate was not applied through API: %#v", applied)
	}
	approve, _ = json.Marshal(map[string]any{"revision": applied.Stages[0].Revision})
	approved := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/decompose/approve", approve)
	if approved.Code != http.StatusOK || decodeFilmResponse(t, approved).Stages[0].Status != filmStatusApproved {
		t.Fatalf("applied candidate could not be approved: %d %s", approved.Code, approved.Body.String())
	}
}
