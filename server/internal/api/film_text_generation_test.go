package api

import (
	"context"
	"encoding/json"
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
	executor := &recordingTextExecutor{result: `{"summary":"candidate"}`}
	server.textExecutor = executor
	server.executeClaimedTextJob(store.TenantGenerationJob{TenantID: store.DefaultTenantID, Job: job})

	stored, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, job.ID)
	if err != nil || stored.Status != "succeeded" || string(stored.Result) != `{"text":"{\"summary\":\"candidate\"}"}` {
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
