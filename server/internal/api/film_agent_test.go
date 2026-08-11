package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

func filmAgentRunStageBody(t *testing.T, arguments map[string]any) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"tool":      "film.run_stage",
		"arguments": arguments,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func confirmFilmAgentArguments(t *testing.T, handler http.Handler, tool string, arguments map[string]any) map[string]any {
	t.Helper()
	confirmationBody, err := json.Marshal(map[string]any{"tool": tool, "arguments": arguments})
	if err != nil {
		t.Fatal(err)
	}
	response := requestWithHeaders(t, handler, http.MethodPost, "/api/agent/confirm", confirmationBody, map[string]string{
		"Origin": "http://localhost:5173", "Sec-Fetch-Site": "same-origin",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("issue Agent confirmation: %d %s", response.Code, response.Body.String())
	}
	var confirmation struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(response.Body.Bytes(), &confirmation) != nil || len(confirmation.Token) != 64 {
		t.Fatalf("invalid Agent confirmation: %s", response.Body.String())
	}
	next := make(map[string]any, len(arguments)+1)
	for key, value := range arguments {
		next[key] = value
	}
	next["confirmationToken"] = confirmation.Token
	return next
}

func importFilmAgentSource(t *testing.T, handler http.Handler) filmDocument {
	t.Helper()
	response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"EPISODE 1\nINT. STATION - NIGHT\nLin hears a signal."}`))
	if response.Code != http.StatusOK {
		t.Fatalf("source: %d %s", response.Code, response.Body.String())
	}
	return decodeFilmResponse(t, response)
}

func TestFilmAgentTextStagesQueueRealTextGenerationJobs(t *testing.T) {
	t.Run("decompose creates an idempotent job and candidate", func(t *testing.T) {
		backend, handler := filmAPIHandler(t)
		document := importFilmAgentSource(t, handler)
		arguments := map[string]any{
			"projectId": "film-api", "stage": "decompose", "revision": document.Stages[0].Revision,
			"providerId": "provider-text", "model": "gpt-text", "idempotencyKey": "agent-decompose-pass-1",
		}
		arguments = confirmFilmAgentArguments(t, handler, "film.run_stage", arguments)
		body := filmAgentRunStageBody(t, arguments)

		response := request(t, handler, http.MethodPost, "/api/agent/execute", body)
		if response.Code != http.StatusOK {
			t.Fatalf("agent decompose: %d %s", response.Code, response.Body.String())
		}
		current := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
		if len(current.Tasks) != 1 {
			t.Fatalf("agent decompose tasks = %#v", current.Tasks)
		}
		task := current.Tasks[0]
		job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
		if err != nil || job.Kind != "text" || job.Status != "queued" || task.TextSnapshot == nil {
			t.Fatalf("agent decompose did not queue text job: task=%#v job=%#v err=%v", task, job, err)
		}
		var parameters persistedTextJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Operation != "film_decompose" {
			t.Fatalf("agent decompose job contract = %s", job.Parameters)
		}

		replayArguments := confirmFilmAgentArguments(t, handler, "film.run_stage", arguments)
		replayed := request(t, handler, http.MethodPost, "/api/agent/execute", filmAgentRunStageBody(t, replayArguments))
		if replayed.Code != http.StatusOK {
			t.Fatalf("agent decompose replay: %d %s", replayed.Code, replayed.Body.String())
		}
		replayedDocument := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
		if len(replayedDocument.Tasks) != 1 || backend.atomicBatchCalls.Load() != 1 {
			t.Fatalf("agent decompose replay duplicated work: tasks=%d batches=%d", len(replayedDocument.Tasks), backend.atomicBatchCalls.Load())
		}

		job.Status = "succeeded"
		job.Result, _ = json.Marshal(providerTextResult{Text: validFilmAIDecompositionJSON})
		if err := backend.PutGenerationJob(t.Context(), store.DefaultTenantID, job); err != nil {
			t.Fatal(err)
		}
		syncBody, _ := json.Marshal(map[string]any{"revision": current.Revision})
		syncedResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+job.ID+"/sync", syncBody)
		if syncedResponse.Code != http.StatusOK {
			t.Fatalf("sync agent text job: %d %s", syncedResponse.Code, syncedResponse.Body.String())
		}
		synced := decodeFilmResponse(t, syncedResponse)
		if len(synced.AICandidates) != 1 || synced.AICandidates[0].GenerationJobID != job.ID {
			t.Fatalf("agent text job did not materialize candidate: %#v", synced.AICandidates)
		}
	})

	t.Run("script freezes the requested episode", func(t *testing.T) {
		backend, handler := filmAPIHandler(t)
		imported := importFilmAgentSource(t, handler)
		approveBody, _ := json.Marshal(map[string]any{"revision": imported.Stages[0].Revision})
		approvedResponse := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/decompose/approve", approveBody)
		if approvedResponse.Code != http.StatusOK {
			t.Fatalf("approve decompose: %d %s", approvedResponse.Code, approvedResponse.Body.String())
		}
		approved := decodeFilmResponse(t, approvedResponse)
		arguments := map[string]any{
			"projectId": "film-api", "stage": "script", "revision": approved.Stages[1].Revision,
			"episodeId": approved.Episodes[0].ID, "providerId": "provider-text", "model": "gpt-text",
			"idempotencyKey": "agent-script-pass-1",
		}
		arguments = confirmFilmAgentArguments(t, handler, "film.run_stage", arguments)

		response := request(t, handler, http.MethodPost, "/api/agent/execute", filmAgentRunStageBody(t, arguments))
		if response.Code != http.StatusOK {
			t.Fatalf("agent script: %d %s", response.Code, response.Body.String())
		}
		current := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
		if len(current.Tasks) != 1 {
			t.Fatalf("agent script tasks = %#v", current.Tasks)
		}
		task := current.Tasks[0]
		job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
		if err != nil || job.Kind != "text" || task.TextSnapshot == nil || task.TextSnapshot.TargetEntityID != approved.Episodes[0].ID {
			t.Fatalf("agent script did not freeze episode: task=%#v job=%#v err=%v", task, job, err)
		}
		var parameters persistedTextJobParameters
		if json.Unmarshal(job.Parameters, &parameters) != nil || parameters.Operation != "film_script" || parameters.TargetEntityID != approved.Episodes[0].ID {
			t.Fatalf("agent script job contract = %s", job.Parameters)
		}
	})
}

func TestFilmAgentTextStagesRequireStrictGenerationArguments(t *testing.T) {
	tests := []struct {
		name        string
		stage       string
		omit        string
		wantMessage string
	}{
		{name: "decompose provider", stage: "decompose", omit: "providerId", wantMessage: "provider"},
		{name: "decompose model", stage: "decompose", omit: "model", wantMessage: "model"},
		{name: "decompose idempotency", stage: "decompose", omit: "idempotencyKey", wantMessage: "idempotency"},
		{name: "script episode", stage: "script", omit: "episodeId", wantMessage: "episode"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, handler := filmAPIHandler(t)
			document := importFilmAgentSource(t, handler)
			if test.stage == "script" {
				approveBody, _ := json.Marshal(map[string]any{"revision": document.Stages[0].Revision})
				document = decodeFilmResponse(t, request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/decompose/approve", approveBody))
			}
			stageIndex := 0
			if test.stage == "script" {
				stageIndex = 1
			}
			arguments := map[string]any{
				"projectId": "film-api", "stage": test.stage, "revision": document.Stages[stageIndex].Revision,
				"episodeId": document.Episodes[0].ID, "providerId": "provider-text", "model": "gpt-text",
				"idempotencyKey": "agent-strict-pass-1",
			}
			delete(arguments, test.omit)
			arguments = confirmFilmAgentArguments(t, handler, "film.run_stage", arguments)

			response := request(t, handler, http.MethodPost, "/api/agent/execute", filmAgentRunStageBody(t, arguments))
			if response.Code != http.StatusBadRequest || !bytes.Contains(bytes.ToLower(response.Body.Bytes()), []byte(test.wantMessage)) {
				t.Fatalf("missing %s accepted: %d %s", test.omit, response.Code, response.Body.String())
			}
		})
	}
}

func TestFilmAgentHighImpactToolsRequireExplicitConfirmation(t *testing.T) {
	_, handler := filmAPIHandler(t)
	document := importFilmAgentSource(t, handler)
	body := filmAgentRunStageBody(t, map[string]any{
		"projectId": "film-api", "stage": "decompose", "revision": document.Stages[0].Revision,
		"providerId": "provider-text", "model": "gpt-text", "idempotencyKey": "agent-unconfirmed-pass-1",
	})

	response := request(t, handler, http.MethodPost, "/api/agent/execute", body)
	if response.Code != http.StatusBadRequest || !bytes.Contains(bytes.ToLower(response.Body.Bytes()), []byte("one-time confirmation")) {
		t.Fatalf("unconfirmed Agent mutation was accepted: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmAgentConfirmationIsBoundAndSingleUse(t *testing.T) {
	_, handler := filmAPIHandler(t)
	document := importFilmAgentSource(t, handler)
	arguments := map[string]any{
		"projectId": "film-api", "stage": "decompose", "revision": document.Stages[0].Revision,
		"providerId": "provider-text", "model": "gpt-text", "idempotencyKey": "agent-token-pass-1",
	}
	confirmed := confirmFilmAgentArguments(t, handler, "film.run_stage", arguments)
	first := request(t, handler, http.MethodPost, "/api/agent/execute", filmAgentRunStageBody(t, confirmed))
	if first.Code != http.StatusOK {
		t.Fatalf("confirmed Agent run failed: %d %s", first.Code, first.Body.String())
	}
	replay := request(t, handler, http.MethodPost, "/api/agent/execute", filmAgentRunStageBody(t, confirmed))
	if replay.Code != http.StatusBadRequest || !bytes.Contains(bytes.ToLower(replay.Body.Bytes()), []byte("one-time")) {
		t.Fatalf("confirmation token replay was accepted: %d %s", replay.Code, replay.Body.String())
	}
}

func TestFilmAgentConfirmationRequiresInteractiveBrowserSession(t *testing.T) {
	_, handler := filmAPIHandler(t)
	body := []byte(`{"tool":"film.validate","arguments":{"projectId":"film-api"}}`)
	missingBrowserProof := request(t, handler, http.MethodPost, "/api/agent/confirm", body)
	if missingBrowserProof.Code != http.StatusForbidden {
		t.Fatalf("non-interactive confirmation accepted: %d %s", missingBrowserProof.Code, missingBrowserProof.Body.String())
	}
}

func TestFilmAgentConfirmationPendingSetIsBoundedPerUser(t *testing.T) {
	server, _, handler := filmAPIServerHandler(t)
	scope := effectiveAgentScope(agentScope{tenantID: store.DefaultTenantID, userID: "film-test-user"})
	server.agentConfirmationMu.Lock()
	for index := 0; index < maxAgentConfirmationsPerScope; index++ {
		server.agentConfirmations[fmt.Sprintf("%064x", index+1)] = agentConfirmationRecord{
			Scope: scope, Digest: strings.Repeat("a", 64), ExpiresAt: time.Now().UTC().Add(time.Minute),
		}
	}
	server.agentConfirmationMu.Unlock()
	body := []byte(`{"tool":"film.validate","arguments":{"projectId":"film-api"}}`)
	response := requestWithHeaders(t, handler, http.MethodPost, "/api/agent/confirm", body, map[string]string{
		"Origin": "http://localhost:5173", "Sec-Fetch-Site": "same-origin",
	})
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("confirmation cap not enforced: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmAgentGenerativeRepairUsesConfirmedAtomicGeneration(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	prepareFilmGenerationStage(t, handler)
	validated := request(t, handler, http.MethodPost, "/api/film/projects/film-api/validate", []byte(`{}`))
	document := decodeFilmResponse(t, validated)
	var repair filmRepairProposal
	for _, candidate := range document.QualityReports[len(document.QualityReports)-1].Repairs {
		if candidate.EstimatedGenerations > 0 {
			repair = candidate
			break
		}
	}
	arguments := map[string]any{
		"projectId": "film-api", "repairId": repair.ID, "revision": repair.ExpectedRevision, "approved": true,
		"providerId": "provider-a", "model": "model-a", "config": map[string]any{"size": "1024x1024", "quality": "standard"},
		"idempotencyKey": "agent-repair-pass-1", "expectedCredits": 1,
	}
	arguments = confirmFilmAgentArguments(t, handler, "film.apply_repair", arguments)
	body, _ := json.Marshal(map[string]any{
		"tool":      "film.apply_repair",
		"arguments": arguments,
	})
	response := request(t, handler, http.MethodPost, "/api/agent/execute", body)
	if response.Code != http.StatusOK {
		t.Fatalf("confirmed Agent repair failed: %d %s", response.Code, response.Body.String())
	}
	current := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api", nil))
	selected, found := findFilmRepairProposal(current, repair.ID)
	if !found || !selected.Approved || selected.AppliedAt == "" || backend.atomicBatchCalls.Load() == 0 {
		t.Fatalf("Agent repair did not use the approved atomic path: repair=%#v batches=%d", selected, backend.atomicBatchCalls.Load())
	}
}
