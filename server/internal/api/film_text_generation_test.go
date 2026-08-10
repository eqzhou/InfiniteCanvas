package api

import (
	"encoding/json"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

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
