package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/openboard/openboard/server/internal/store"
)

func prepareFilmGenerationStage(t *testing.T, handler http.Handler) filmDocument {
	t.Helper()
	response := request(t, handler, http.MethodPut, "/api/film/projects/film-api/source/text", []byte(`{"revision":0,"text":"INT. SET - DAY\nA performer crosses the set."}`))
	if response.Code != http.StatusOK {
		t.Fatalf("source: %d %s", response.Code, response.Body.String())
	}
	document := decodeFilmResponse(t, response)
	approve, _ := json.Marshal(map[string]any{"revision": document.Stages[0].Revision})
	response = request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/decompose/approve", approve)
	if response.Code != http.StatusOK {
		t.Fatalf("approve decompose: %d %s", response.Code, response.Body.String())
	}
	document = decodeFilmResponse(t, response)
	run, _ := json.Marshal(map[string]any{"revision": document.Stages[1].Revision})
	response = request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/script/run", run)
	if response.Code != http.StatusAccepted {
		t.Fatalf("run script: %d %s", response.Code, response.Body.String())
	}
	document = decodeFilmResponse(t, response)
	approve, _ = json.Marshal(map[string]any{"revision": document.Stages[1].Revision})
	response = request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/script/approve", approve)
	if response.Code != http.StatusOK {
		t.Fatalf("approve script: %d %s", response.Code, response.Body.String())
	}
	return decodeFilmResponse(t, response)
}

func filmGenerationRunBody(t *testing.T, revision int, shotID, key string) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"revision": revision, "shotIds": []string{shotID}, "providerId": "provider-a",
		"model": "model-a", "idempotencyKey": key,
		"config": map[string]any{"size": "1024x1024", "quality": "standard"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestFilmGenerationStagesRejectModelsOutsideTenantAllowList(t *testing.T) {
	server, _, handler := filmAPIServerHandler(t)
	if err := server.saveSitePolicy(t.Context(), store.DefaultTenantID, SitePolicy{
		AllowRegister: true, AllowCustomChannel: true, AllowCloudChannel: true,
		AvailableModels: []string{"allowed-model"},
	}); err != nil {
		t.Fatal(err)
	}
	document := prepareFilmGenerationStage(t, handler)
	for _, stage := range []string{"storyboard", "first_frame", "video", "audio"} {
		t.Run(stage, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{
				"revision": document.Stages[2].Revision, "shotIds": []string{document.Shots[0].ID},
				"providerId": "provider-a", "model": "blocked-model", "idempotencyKey": "blocked-" + stage,
				"config": map[string]any{"size": "1024x1024", "quality": "standard"},
			})
			if err != nil {
				t.Fatal(err)
			}
			response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/"+stage+"/run", body)
			if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), modelNotAllowedMessage) {
				t.Fatalf("blocked Film %s model = %d %s", stage, response.Code, response.Body.String())
			}
		})
	}
}

func TestFilmGenerationRejectsSharedChannelFinalModelOutsideTenantAllowList(t *testing.T) {
	server, _, handler := filmAPIServerHandler(t)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	if err := server.saveSitePolicy(t.Context(), store.DefaultTenantID, SitePolicy{
		AllowRegister: true, AllowCustomChannel: true, AllowCloudChannel: true,
		AvailableModels: []string{"allowed-model"},
	}); err != nil {
		t.Fatal(err)
	}
	channels, _ := json.Marshal([]adminChannelPublic{{
		ID: "shared-film", Name: "Shared Film", BaseURL: "https://shared.example/v1", Protocol: "openai",
		Enabled: true, AllowUserUse: true, Weight: 1, TimeoutSeconds: 30,
		DefaultImageModel: "blocked-final-model", Models: []string{"blocked-final-model"},
	}})
	if got := putAdminConfigForTest(t, handler, "/api/admin/channels", channels); got.Code != http.StatusOK {
		t.Fatalf("put channels: %d %s", got.Code, got.Body.String())
	}
	if got := putSharedChannelSecret(t, handler, "shared-film", "sk-private"); got.Code != http.StatusNoContent {
		t.Fatalf("put secret: %d %s", got.Code, got.Body.String())
	}
	document := prepareFilmGenerationStage(t, handler)
	body, _ := json.Marshal(map[string]any{
		"revision": document.Stages[2].Revision, "shotIds": []string{document.Shots[0].ID},
		"providerId": "shared-film", "model": "", "idempotencyKey": "blocked-final-shared",
		"config": map[string]any{"size": "1024x1024", "quality": "standard"},
	})
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", body)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), modelNotAllowedMessage) {
		t.Fatalf("blocked routed Film model = %d %s", response.Code, response.Body.String())
	}
}

func TestSelectFilmGenerationShotsSupportsEpisodeRangeAndOrderZero(t *testing.T) {
	document := newFilmDocument("film-range")
	document.Episodes = []filmEpisode{{ID: "ep-0", Revision: 1, Order: 0, Title: "Zero", Status: filmStatusDraft}, {ID: "ep-1", Revision: 1, Order: 1, Title: "One", Status: filmStatusDraft}}
	document.Scenes = []filmScene{{ID: "scene-0", Revision: 1, EpisodeID: "ep-0", Order: 0, Heading: "A", Status: filmStatusDraft}, {ID: "scene-1", Revision: 1, EpisodeID: "ep-1", Order: 1, Heading: "B", Status: filmStatusDraft}}
	document.Shots = []filmShot{{ID: "shot-0", Revision: 1, SceneID: "scene-0", Order: 0, Title: "Zero", Description: "Zero", Status: filmStatusDraft, DurationSeconds: 1, AspectRatio: "16:9"}, {ID: "shot-1", Revision: 1, SceneID: "scene-1", Order: 1, Title: "One", Description: "One", Status: filmStatusDraft, DurationSeconds: 1, AspectRatio: "16:9"}}
	selected, err := selectFilmGenerationShots(document, filmGenerationRunRequest{EpisodeRange: &filmEpisodeRange{From: 0, To: 0}, ShotRange: &filmShotRange{Start: 0, End: 0}})
	if err != nil || len(selected) != 1 || selected[0].ID != "shot-0" {
		t.Fatalf("range selection = %#v err=%v", selected, err)
	}
	if _, err := selectFilmGenerationShots(document, filmGenerationRunRequest{ShotRange: &filmShotRange{Start: 9, End: 9}}); err == nil {
		t.Fatal("empty explicit range selected every shot")
	}
}

func TestFilmAudioGenerationCreatesOneFrozenTargetPerDialogue(t *testing.T) {
	document := newFilmDocument("film-dialogue-audio")
	shot := filmShot{ID: "shot-1", Revision: 2, SceneID: "scene-1", Order: 1, Title: "Exchange", Description: "Two people speak", Status: filmStatusDraft, DurationSeconds: 4, AspectRatio: "16:9"}
	document.Shots = []filmShot{shot}
	document.Assets = []filmAsset{
		{ID: "voice-a", Revision: 1, Kind: "voice", Title: "A", Status: filmStatusApproved, Voice: "voice-alpha"},
		{ID: "voice-b", Revision: 1, Kind: "voice", Title: "B", Status: filmStatusApproved, Voice: "voice-beta"},
	}
	document.Dialogues = []filmDialogue{
		{ID: "dialogue-b", Revision: 3, ShotID: shot.ID, Order: 2, Kind: "dialogue", VoiceAssetID: "voice-b", Emotion: "angry", Text: "Second line", Status: filmStatusDraft},
		{ID: "dialogue-a", Revision: 2, ShotID: shot.ID, Order: 1, Kind: "dialogue", VoiceAssetID: "voice-a", Emotion: "calm", Text: "First line", Status: filmStatusDraft},
	}
	targets := filmGenerationTargets(document, "audio", document.Shots)
	if len(targets) != 2 || targets[0].Dialogue == nil || targets[0].Dialogue.ID != "dialogue-a" || targets[1].Dialogue == nil || targets[1].Dialogue.ID != "dialogue-b" {
		t.Fatalf("dialogue targets are not independently ordered: %#v", targets)
	}
	for _, target := range targets {
		jobShot, config := filmDialogueAudioInputs(document, target, filmGenerationConfig{Format: "mp3"})
		job, err := buildFilmGenerationTargetJob("audio", jobShot, target.Dialogue, document.ProjectID, "audio-provider", "tts", "task-1", "parent-1", "job-1", strings.Repeat("a", 64), config, nil, document.UpdatedAt)
		if err != nil {
			t.Fatal(err)
		}
		binding, _ := filmJobBinding(job)
		if binding == nil || binding.DialogueID != target.Dialogue.ID || job.Prompt != target.Dialogue.Text || config.Voice == "" || !strings.Contains(config.Instructions, target.Dialogue.Emotion) {
			t.Fatalf("dialogue job did not freeze voice/emotion/text independently: target=%#v job=%#v binding=%#v config=%#v", target, job, binding, config)
		}
	}
	hashA, _ := filmGenerationTargetRequestHash(document.ProjectID, "audio", targets, filmGenerationRunRequest{Model: "tts", IdempotencyKey: "audio-pass"})
	changed := targets
	changed[0].Dialogue.Text = "Changed line"
	hashB, _ := filmGenerationTargetRequestHash(document.ProjectID, "audio", changed, filmGenerationRunRequest{Model: "tts", IdempotencyKey: "audio-pass"})
	if hashA == hashB {
		t.Fatal("dialogue edits did not invalidate the idempotent audio request")
	}
}

func TestFilmVideoReferencesKeepFirstAndLastFramesInSemanticOrder(t *testing.T) {
	shot := filmShot{FirstFrameStorageKey: "film/first.png", LastFrameStorageKey: "film/last.png"}
	got := orderedFilmVideoReferences(shot, []string{"film/style.png", "film/last.png"})
	want := []string{"film/first.png", "film/last.png", "film/style.png"}
	if !slices.Equal(got, want) {
		t.Fatalf("video references = %#v, want %#v", got, want)
	}
}

func TestFilmDialogueRepairGenerationUsesDialogueAsTaskAndJobTarget(t *testing.T) {
	document, err := decomposeFilmSource(newFilmDocument("dialogue-repair"), "INT. ROOM - DAY\nAction.")
	if err != nil {
		t.Fatal(err)
	}
	dialogue := filmDialogue{ID: "dialogue-repair-target", Revision: 2, ShotID: document.Shots[0].ID, Order: 0, Text: "Try again", Status: filmStatusDraft}
	document.Dialogues = []filmDialogue{dialogue}
	repair := filmRepairProposal{TargetType: "dialogue", TargetID: dialogue.ID, RegenerationStage: "audio"}
	target, err := filmRepairGenerationTarget(document, repair)
	if err != nil || target.Dialogue == nil || target.Dialogue.ID != dialogue.ID || filmGenerationTargetID(target) != dialogue.ID {
		t.Fatalf("dialogue repair target = %#v err=%v", target, err)
	}
	job, err := buildFilmGenerationTargetJob("audio", target.Shot, target.Dialogue, document.ProjectID, "provider", "voice-model", "task", "parent", "job", strings.Repeat("a", 64), filmGenerationConfig{Format: "mp3"}, nil, document.UpdatedAt)
	if err != nil {
		t.Fatal(err)
	}
	binding, _ := filmJobBinding(job)
	if binding == nil || binding.DialogueID != dialogue.ID || job.Prompt != dialogue.Text {
		t.Fatalf("dialogue repair job lost its target: job=%#v binding=%#v", job, binding)
	}
}

func TestFilmGenerationRunCreatesExistingServerJobIdempotently(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	body := filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "board-pass-1")

	first := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", body)
	if first.Code != http.StatusAccepted {
		t.Fatalf("first run: %d %s", first.Code, first.Body.String())
	}
	if backend.atomicBatchCalls.Load() != 1 {
		t.Fatalf("Film media generation did not atomically commit aggregate, jobs, quota, and credits")
	}
	created := decodeFilmResponse(t, first)
	if created.Stages[2].Status != filmStatusRunning || len(created.Tasks) < 2 {
		t.Fatalf("stage/task state = %#v %#v", created.Stages[2], created.Tasks)
	}
	task := created.Tasks[len(created.Tasks)-1]
	if task.GenerationJobID == "" || task.ShotID != document.Shots[0].ID || task.Status != filmStatusRunning {
		t.Fatalf("generation task was not bound: %#v", task)
	}
	if task.Snapshot == nil || task.Snapshot.Prompt != document.Shots[0].Description ||
		task.Snapshot.ProviderID != "provider-a" || task.Snapshot.Model != "model-a" ||
		task.Snapshot.ShotRevision != document.Shots[0].Revision || task.Snapshot.EstimatedGenerations != 1 {
		t.Fatalf("generation task did not freeze its production inputs: %#v", task.Snapshot)
	}
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err != nil || job.Kind != "image" || job.Status != "queued" || job.ProjectID != "film-api" {
		t.Fatalf("generation job = %#v err=%v", job, err)
	}

	second := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", body)
	if second.Code != http.StatusOK {
		t.Fatalf("idempotent replay: %d %s", second.Code, second.Body.String())
	}
	replayed := decodeFilmResponse(t, second)
	if len(replayed.Tasks) != len(created.Tasks) {
		t.Fatalf("idempotent replay duplicated tasks: %d -> %d", len(created.Tasks), len(replayed.Tasks))
	}

	conflictBody := filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "board-pass-1")
	conflictBody = bytes.Replace(conflictBody, []byte(`"model-a"`), []byte(`"different-model"`), 1)
	conflict := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", conflictBody)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("idempotency mismatch accepted: %d %s", conflict.Code, conflict.Body.String())
	}
}

func TestFilmGenerationRunCreatesDurableParentJobInAtomicBatch(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "parent-job-pass"))
	if response.Code != http.StatusAccepted {
		t.Fatalf("run Film stage: %d %s", response.Code, response.Body.String())
	}
	created := decodeFilmResponse(t, response)
	task := created.Tasks[len(created.Tasks)-1]

	var taskJSON map[string]json.RawMessage
	rawTask, _ := json.Marshal(task)
	if json.Unmarshal(rawTask, &taskJSON) != nil || len(taskJSON["parentGenerationJobId"]) == 0 {
		t.Fatalf("Film task has no durable parent generation job binding: %s", rawTask)
	}
	var parentID string
	if json.Unmarshal(taskJSON["parentGenerationJobId"], &parentID) != nil || parentID == "" || parentID == task.ID || parentID == task.GenerationJobID {
		t.Fatalf("Film task parent binding is not a distinct generation job: task=%#v parent=%q", task, parentID)
	}
	parent, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, parentID)
	if err != nil || parent.Kind != "film-stage" || parent.Status != "queued" || parent.ProjectID != "film-api" {
		t.Fatalf("durable Film stage parent = %#v err=%v", parent, err)
	}
	child, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err != nil {
		t.Fatal(err)
	}
	var childParameters struct {
		Film struct {
			ParentGenerationJobID string `json:"parentGenerationJobId"`
		} `json:"film"`
	}
	if json.Unmarshal(child.Parameters, &childParameters) != nil || childParameters.Film.ParentGenerationJobID != parentID {
		t.Fatalf("child generation binding does not point to parent %q: %s", parentID, child.Parameters)
	}
	if backend.atomicBatchCalls.Load() != 1 {
		t.Fatalf("parent and child were not created in one Film batch transaction: %d calls", backend.atomicBatchCalls.Load())
	}
}

func TestAggregateFilmStageGenerationJobDerivesTerminalAndPartialStates(t *testing.T) {
	now := "2026-08-11T01:00:00Z"
	parent, err := buildFilmStageGenerationJob("film-api", "storyboard", "job-parent", strings.Repeat("a", 64), now, []string{"job-a", "job-b"}, []int{3, 3})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		statuses   []string
		wantStatus string
		wantResult filmStageGenerationResult
	}{
		{name: "queued", statuses: []string{"queued", "queued"}, wantStatus: "queued", wantResult: filmStageGenerationResult{Outcome: "queued", Total: 2, Queued: 2, Progress: 0, ActualCredits: 0}},
		{name: "running", statuses: []string{"succeeded", "running"}, wantStatus: "running", wantResult: filmStageGenerationResult{Outcome: "running", Total: 2, Running: 1, Succeeded: 1, Progress: 0.75, ActualCredits: 3}},
		{name: "succeeded", statuses: []string{"succeeded", "succeeded"}, wantStatus: "succeeded", wantResult: filmStageGenerationResult{Outcome: "succeeded", Total: 2, Succeeded: 2, Progress: 1, ActualCredits: 6}},
		{name: "failed", statuses: []string{"failed", "failed"}, wantStatus: "failed", wantResult: filmStageGenerationResult{Outcome: "failed", Total: 2, Failed: 2, Progress: 1}},
		{name: "cancelled", statuses: []string{"cancelled", "cancelled"}, wantStatus: "cancelled", wantResult: filmStageGenerationResult{Outcome: "cancelled", Total: 2, Cancelled: 2, Progress: 1}},
		{name: "partial failure", statuses: []string{"succeeded", "failed"}, wantStatus: "failed", wantResult: filmStageGenerationResult{Outcome: "partial_failure", Total: 2, Succeeded: 1, Failed: 1, Progress: 1, ActualCredits: 3}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			children := make([]store.GenerationJob, len(test.statuses))
			for index, status := range test.statuses {
				childID := []string{"job-a", "job-b"}[index]
				binding := &filmGenerationBinding{ProjectID: "film-api", Stage: "storyboard", ShotID: "shot-one", TaskID: "task-" + childID, ParentGenerationJobID: parent.ID, RequestHash: strings.Repeat("a", 64)}
				parameters, _ := json.Marshal(persistedImageJobParameters{Executor: serverExecutorMarker, RequestHash: strings.Repeat("a", 64), Film: binding, EstimatedCredits: 3})
				children[index] = store.GenerationJob{ID: childID, ProjectID: "film-api", Kind: "image", Status: status, Parameters: parameters, Result: json.RawMessage(`{}`), UpdatedAt: now}
			}
			got, err := aggregateFilmStageGenerationJob(parent, children)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != test.wantStatus {
				t.Fatalf("aggregate status = %q, want %q", got.Status, test.wantStatus)
			}
			var result filmStageGenerationResult
			if json.Unmarshal(got.Result, &result) != nil || result != test.wantResult {
				t.Fatalf("aggregate result = %#v, want %#v", result, test.wantResult)
			}
		})
	}
}

func TestFilmGenerationJobViewsAggregateWithoutMutatingParentOnRead(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	run := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "parent-list-pass"))
	created := decodeFilmResponse(t, run)
	task := created.Tasks[len(created.Tasks)-1]
	child, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err != nil {
		t.Fatal(err)
	}
	child.Status = "running"
	if err := backend.PutGenerationJob(t.Context(), store.DefaultTenantID, child); err != nil {
		t.Fatal(err)
	}

	listed := request(t, handler, http.MethodGet, "/api/film/projects/film-api/generation-jobs", nil)
	var contract struct {
		Data struct {
			GenerationJobs []filmGenerationJobView `json:"generationJobs"`
		} `json:"data"`
	}
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &contract) != nil || len(contract.Data.GenerationJobs) != 2 {
		t.Fatalf("real parent/child list = %d %s", listed.Code, listed.Body.String())
	}
	parentView, childView := contract.Data.GenerationJobs[0], contract.Data.GenerationJobs[1]
	if parentView.ID != task.ParentGenerationJobID || parentView.ParentID != "" || parentView.Status != "running" || childView.ID != task.GenerationJobID || childView.ParentID != task.ParentGenerationJobID {
		t.Fatalf("real parent/child tree is incorrect: parent=%#v child=%#v task=%#v", parentView, childView, task)
	}
	parent, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.ParentGenerationJobID)
	if err != nil || parent.Status != "queued" {
		t.Fatalf("parent read unexpectedly mutated storage = %#v err=%v", parent, err)
	}
	global := request(t, handler, http.MethodGet, "/api/generation-jobs/"+task.ParentGenerationJobID, nil)
	var globalJob store.GenerationJob
	if global.Code != http.StatusOK || json.Unmarshal(global.Body.Bytes(), &globalJob) != nil || globalJob.Status != "running" {
		t.Fatalf("global parent view was not aggregated: %d %s", global.Code, global.Body.String())
	}
}

func TestCancelFilmStageParentCascadesAndCannotBeRevivedByAggregation(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	created := decodeFilmResponse(t, request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "parent-cancel-pass")))
	task := created.Tasks[len(created.Tasks)-1]
	canceled := request(t, handler, http.MethodPost, "/api/generation-jobs/"+task.ParentGenerationJobID+"/cancel", nil)
	if canceled.Code != http.StatusOK {
		t.Fatalf("cancel parent: %d %s", canceled.Code, canceled.Body.String())
	}
	child, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if child.Status != "cancelled" {
		t.Fatalf("child was not cancelled with parent: %#v", child)
	}
	view := request(t, handler, http.MethodGet, "/api/generation-jobs/"+task.ParentGenerationJobID, nil)
	var parentView store.GenerationJob
	if view.Code != http.StatusOK || json.Unmarshal(view.Body.Bytes(), &parentView) != nil || parentView.Status != "cancelled" {
		t.Fatalf("cancelled parent was revived: %d %s", view.Code, view.Body.String())
	}
}

func TestCancelFilmStageParentReportsChildCancellationFailure(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	created := decodeFilmResponse(t, request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "parent-cancel-child-failure")))
	task := created.Tasks[len(created.Tasks)-1]
	backend.generationCancelErrors = map[string]error{tenantKey(store.DefaultTenantID, task.GenerationJobID): errors.New("database unavailable")}

	canceled := request(t, handler, http.MethodPost, "/api/generation-jobs/"+task.ParentGenerationJobID+"/cancel", nil)
	if canceled.Code != http.StatusInternalServerError {
		t.Fatalf("child cancellation failure was hidden: %d %s", canceled.Code, canceled.Body.String())
	}
	parent, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.ParentGenerationJobID)
	if parent.Status != "queued" {
		t.Fatalf("parent was cancelled before its child: %#v", parent)
	}
}

func TestCancelFilmStageParentRejectsReusedMismatchedChildID(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	created := decodeFilmResponse(t, request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "parent-cancel-reused-child")))
	task := created.Tasks[len(created.Tasks)-1]
	child, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err != nil {
		t.Fatal(err)
	}
	child.ProjectID = "unrelated-project"
	if err := backend.PutGenerationJob(t.Context(), store.DefaultTenantID, child); err != nil {
		t.Fatal(err)
	}

	canceled := request(t, handler, http.MethodPost, "/api/generation-jobs/"+task.ParentGenerationJobID+"/cancel", nil)
	if canceled.Code != http.StatusConflict {
		t.Fatalf("mismatched child cancellation = %d %s", canceled.Code, canceled.Body.String())
	}
	child, _ = backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if child.Status != "queued" {
		t.Fatalf("unrelated reused child was cancelled: %#v", child)
	}
}

func TestFilmGenerationJobAPIsSyncAndRetryWithoutForgingCompletion(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	if err := backend.PutModelCreditConfig(t.Context(), store.DefaultTenantID, store.ModelCreditConfig{DefaultCredits: 1, ModelCosts: []store.ModelCreditCost{{Model: "model-a", Credits: 5}}}); err != nil {
		t.Fatal(err)
	}
	run := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "job-api-pass"))
	created := decodeFilmResponse(t, run)
	task := created.Tasks[len(created.Tasks)-1]

	listed := request(t, handler, http.MethodGet, "/api/film/projects/film-api/generation-jobs", nil)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte(task.GenerationJobID)) {
		t.Fatalf("list jobs: %d %s", listed.Code, listed.Body.String())
	}
	var contract struct {
		Data struct {
			Tasks          []filmTask              `json:"tasks"`
			GenerationJobs []filmGenerationJobView `json:"generationJobs"`
		} `json:"data"`
	}
	if json.Unmarshal(listed.Body.Bytes(), &contract) != nil || contract.Data.Tasks == nil || contract.Data.GenerationJobs == nil || len(contract.Data.Tasks) == 0 || len(contract.Data.GenerationJobs) < 2 || contract.Data.GenerationJobs[0].ParentID != "" || contract.Data.GenerationJobs[1].ParentID == "" {
		t.Fatalf("job hierarchy is ambiguous: %s", listed.Body.String())
	}
	var topLevel map[string]json.RawMessage
	var data map[string]json.RawMessage
	if json.Unmarshal(listed.Body.Bytes(), &topLevel) != nil || len(topLevel) != 1 || topLevel["data"] == nil ||
		json.Unmarshal(topLevel["data"], &data) != nil || len(data) != 2 || data["tasks"] == nil || data["generationJobs"] == nil {
		t.Fatalf("generation job contract must be data:{tasks,generationJobs}: %s", listed.Body.String())
	}

	job, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	job.Status, job.Error = "failed", "provider-secret-detail"
	_ = backend.PutGenerationJob(t.Context(), store.DefaultTenantID, job)
	syncBody, _ := json.Marshal(map[string]any{"revision": created.Revision})
	failedSync := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+task.GenerationJobID+"/sync", syncBody)
	if failedSync.Code != http.StatusOK || bytes.Contains(failedSync.Body.Bytes(), []byte("provider-secret-detail")) {
		t.Fatalf("failed sync leaked provider detail: %d %s", failedSync.Code, failedSync.Body.String())
	}
	failedDocument := decodeFilmResponse(t, failedSync)
	if failedDocument.Tasks[len(failedDocument.Tasks)-1].Status != filmStatusFailed {
		t.Fatalf("failed job was not synchronized: %#v", failedDocument.Tasks)
	}

	batchCallsBeforeRetry := backend.atomicBatchCalls.Load()
	if err := backend.PutModelCreditConfig(t.Context(), store.DefaultTenantID, store.ModelCreditConfig{DefaultCredits: 1, ModelCosts: []store.ModelCreditCost{{Model: "model-a", Credits: 7}}}); err != nil {
		t.Fatal(err)
	}
	retried := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+task.GenerationJobID+"/retry", nil)
	if retried.Code != http.StatusAccepted || bytes.Contains(retried.Body.Bytes(), []byte(task.GenerationJobID+`"`)) {
		t.Fatalf("retry: %d %s", retried.Code, retried.Body.String())
	}
	var retryPayload struct {
		Data map[string]any `json:"data"`
	}
	_ = json.Unmarshal(retried.Body.Bytes(), &retryPayload)
	retryID, _ := retryPayload.Data["id"].(string)
	retryJob, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, retryID)
	if err != nil || retryJob.Status != "queued" {
		t.Fatalf("retry job = %#v err=%v", retryJob, err)
	}
	var retryParameters persistedImageJobParameters
	if json.Unmarshal(retryJob.Parameters, &retryParameters) != nil || retryParameters.EstimatedCredits != 7 || len(backend.lastReservations) != 1 || backend.lastReservations[0].ExpectedCredits == nil || *backend.lastReservations[0].ExpectedCredits != 7 {
		t.Fatalf("retry did not freeze its current exact quote: %#v %#v", retryParameters, backend.lastReservations)
	}
	if got := backend.atomicBatchCalls.Load(); got != batchCallsBeforeRetry+1 {
		t.Fatalf("retry did not atomically commit its Film task and GenerationJob: batch calls %d -> %d", batchCallsBeforeRetry, got)
	}

	// Retrying only creates a queued real job; it cannot bind media or mark the
	// film task complete before that job succeeds and is explicitly synced.
	status := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
	if status.Shots[0].ImageStorageKey != "" || status.Tasks[len(status.Tasks)-1].Status != filmStatusRunning || status.Tasks[len(status.Tasks)-1].Snapshot.EstimatedCredits != 7 {
		t.Fatalf("retry forged completion: %#v %#v", status.Shots[0], status.Tasks[len(status.Tasks)-1])
	}
}

func TestCancelFilmGenerationJobSynchronizesAlreadySucceededJob(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	run := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "cancel-after-success"))
	running := decodeFilmResponse(t, run)
	task := running.Tasks[len(running.Tasks)-1]
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err != nil {
		t.Fatal(err)
	}
	media := []byte("winner")
	job.Status = "succeeded"
	job.Result = json.RawMessage(`{"items":[{"storageKey":"image:cancel-winner","mimeType":"image/png","bytes":6}]}`)
	if err := backend.PutGenerationJob(t.Context(), store.DefaultTenantID, job); err != nil {
		t.Fatal(err)
	}
	if response := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:cancel-winner", media, map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusNoContent {
		t.Fatalf("seed winner media: %d %s", response.Code, response.Body.String())
	}

	canceled := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+job.ID+"/cancel", nil)
	if canceled.Code != http.StatusOK {
		t.Fatalf("cancel successful job: %d %s", canceled.Code, canceled.Body.String())
	}
	current := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
	latest := current.Tasks[len(current.Tasks)-1]
	if latest.Status != filmStatusNeedsReview || current.Shots[0].ImageStorageKey != "image:cancel-winner" || current.Shots[0].ImageGenerationJobID != job.ID {
		t.Fatalf("successful generation split from film task: task=%#v shot=%#v", latest, current.Shots[0])
	}
}

func TestFilmAgentGenerationStageQueuesRealJobAndRequiresProviderInputs(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	missingArguments := confirmFilmAgentArguments(t, handler, "film.run_stage", map[string]any{
		"projectId": "film-api", "stage": "storyboard", "revision": document.Stages[2].Revision,
	})
	missingBody, _ := json.Marshal(map[string]any{
		"tool":      "film.run_stage",
		"arguments": missingArguments,
	})
	missing := request(t, handler, http.MethodPost, "/api/agent/execute", missingBody)
	if missing.Code != http.StatusBadRequest || !bytes.Contains(bytes.ToLower(missing.Body.Bytes()), []byte("provider")) {
		t.Fatalf("agent generation missing provider/model was not clearly rejected: %d %s", missing.Code, missing.Body.String())
	}

	arguments := confirmFilmAgentArguments(t, handler, "film.run_stage", map[string]any{
		"projectId": "film-api", "stage": "storyboard", "revision": document.Stages[2].Revision,
		"shotIds": []string{document.Shots[0].ID}, "providerId": "provider-agent", "model": "model-agent",
		"config": map[string]any{"size": "1024x1024"}, "idempotencyKey": "agent-board-pass",
	})
	body, _ := json.Marshal(map[string]any{
		"tool":      "film.run_stage",
		"arguments": arguments,
	})
	response := request(t, handler, http.MethodPost, "/api/agent/execute", body)
	if response.Code != http.StatusOK {
		t.Fatalf("agent generation run: %d %s", response.Code, response.Body.String())
	}
	current := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
	task := current.Tasks[len(current.Tasks)-1]
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err != nil || task.Status != filmStatusRunning || job.Status != "queued" || job.Kind != "image" {
		t.Fatalf("agent did not queue a real generation job: task=%#v job=%#v err=%v", task, job, err)
	}
}

func TestFilmOldGenerationJobCannotOverwriteLatestShotMedia(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	firstRun := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "old-round"))
	firstDocument := decodeFilmResponse(t, firstRun)
	oldTask := firstDocument.Tasks[len(firstDocument.Tasks)-1]
	oldJob, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, oldTask.GenerationJobID)
	oldJob.Status = "failed"
	_ = backend.PutGenerationJob(t.Context(), store.DefaultTenantID, oldJob)
	syncBody, _ := json.Marshal(map[string]any{"revision": firstDocument.Revision})
	failed := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+oldJob.ID+"/sync", syncBody)
	failedDocument := decodeFilmResponse(t, failed)
	secondRun := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", filmGenerationRunBody(t, failedDocument.Stages[2].Revision, failedDocument.Shots[0].ID, "new-round"))
	secondDocument := decodeFilmResponse(t, secondRun)
	newTask := secondDocument.Tasks[len(secondDocument.Tasks)-1]
	newJob, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, newTask.GenerationJobID)
	newJob.Status = "succeeded"
	newJob.Result = json.RawMessage(`{"items":[{"storageKey":"image:new-round","mimeType":"image/png","bytes":3}]}`)
	_ = backend.PutGenerationJob(t.Context(), store.DefaultTenantID, newJob)
	_ = requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:new-round", []byte("new"), map[string]string{"Content-Type": "image/png"})
	syncBody, _ = json.Marshal(map[string]any{"revision": secondDocument.Revision})
	newSync := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+newJob.ID+"/sync", syncBody)
	current := decodeFilmResponse(t, newSync)
	historicalRetry := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+oldJob.ID+"/retry", nil)
	if historicalRetry.Code != http.StatusConflict {
		t.Fatalf("old job retry accepted: %d %s", historicalRetry.Code, historicalRetry.Body.String())
	}

	oldJob.Status = "succeeded"
	oldJob.Result = json.RawMessage(`{"items":[{"storageKey":"image:old-round","mimeType":"image/png","bytes":3}]}`)
	_ = backend.PutGenerationJob(t.Context(), store.DefaultTenantID, oldJob)
	_ = requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:old-round", []byte("old"), map[string]string{"Content-Type": "image/png"})
	syncBody, _ = json.Marshal(map[string]any{"revision": current.Revision})
	late := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+oldJob.ID+"/sync", syncBody)
	if late.Code != http.StatusConflict {
		t.Fatalf("old job late sync accepted: %d %s", late.Code, late.Body.String())
	}
	final := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
	if final.Shots[0].ImageStorageKey != "image:new-round" || final.Shots[0].ImageGenerationJobID != newJob.ID {
		t.Fatalf("old job overwrote latest media: %#v", final.Shots[0])
	}
}

func TestCanceledFilmTaskCannotBeRevivedByLateJobSync(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	run := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "cancel-race"))
	running := decodeFilmResponse(t, run)
	task := running.Tasks[len(running.Tasks)-1]
	canceled := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+task.GenerationJobID+"/cancel", nil)
	if canceled.Code != http.StatusOK {
		t.Fatalf("cancel: %d %s", canceled.Code, canceled.Body.String())
	}
	current := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
	job, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	job.Status = "succeeded"
	job.Result = json.RawMessage(`{"items":[{"storageKey":"image:canceled-late","mimeType":"image/png","bytes":4}]}`)
	_ = backend.PutGenerationJob(t.Context(), store.DefaultTenantID, job)
	_ = requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:canceled-late", []byte("late"), map[string]string{"Content-Type": "image/png"})
	syncBody, _ := json.Marshal(map[string]any{"revision": current.Revision})
	late := request(t, handler, http.MethodPost, "/api/film/projects/film-api/generation-jobs/"+job.ID+"/sync", syncBody)
	if late.Code != http.StatusConflict {
		t.Fatalf("canceled task was revived: %d %s", late.Code, late.Body.String())
	}
	final := decodeFilmResponse(t, request(t, handler, http.MethodGet, "/api/film/projects/film-api/status", nil))
	if final.Shots[0].ImageStorageKey != "" || final.Tasks[len(final.Tasks)-1].Status != filmStatusCanceled {
		t.Fatalf("canceled task/media state revived: %#v %#v", final.Tasks, final.Shots[0])
	}
}

func TestFilmGenerationSyncRequiresSucceededTenantBlobAndMIME(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	run := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "sync-pass"))
	created := decodeFilmResponse(t, run)
	task := created.Tasks[len(created.Tasks)-1]
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err != nil {
		t.Fatal(err)
	}
	job.Status = "succeeded"
	job.Result = json.RawMessage(`{"items":[{"storageKey":"image:film-sync","mimeType":"image/png","bytes":7}]}`)
	if err := backend.PutGenerationJob(t.Context(), store.DefaultTenantID, job); err != nil {
		t.Fatal(err)
	}

	syncBody, _ := json.Marshal(map[string]any{"revision": created.Stages[2].Revision})
	missing := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/sync", syncBody)
	if missing.Code != http.StatusOK {
		t.Fatalf("sync missing blob: %d %s", missing.Code, missing.Body.String())
	}
	missingDocument := decodeFilmResponse(t, missing)
	if missingDocument.Shots[0].ImageStorageKey != "" || missingDocument.Tasks[len(missingDocument.Tasks)-1].Status != filmStatusFailed {
		t.Fatalf("missing blob was bound: %#v %#v", missingDocument.Shots[0], missingDocument.Tasks[len(missingDocument.Tasks)-1])
	}

	// A retry creates a fresh task for the failed shot. A tenant object with a
	// MIME that differs from the successful job result must still be rejected.
	run = request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, missingDocument.Stages[2].Revision, missingDocument.Shots[0].ID, "sync-pass-2"))
	retryDocument := decodeFilmResponse(t, run)
	retryTask := retryDocument.Tasks[len(retryDocument.Tasks)-1]
	retryJob, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, retryTask.GenerationJobID)
	retryJob.Status = "succeeded"
	retryJob.Result = json.RawMessage(`{"items":[{"storageKey":"image:film-sync-wrong-mime","mimeType":"image/png","bytes":7}]}`)
	_ = backend.PutGenerationJob(t.Context(), store.DefaultTenantID, retryJob)
	put := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:film-sync-wrong-mime", []byte("payload"), map[string]string{"Content-Type": "audio/mpeg"})
	if put.Code != http.StatusNoContent {
		t.Fatalf("seed blob: %d %s", put.Code, put.Body.String())
	}
	syncBody, _ = json.Marshal(map[string]any{"revision": retryDocument.Stages[2].Revision})
	wrongMIME := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/sync", syncBody)
	if wrongMIME.Code != http.StatusOK {
		t.Fatalf("sync wrong MIME: %d %s", wrongMIME.Code, wrongMIME.Body.String())
	}
	wrongMIMEDocument := decodeFilmResponse(t, wrongMIME)
	if wrongMIMEDocument.Shots[0].ImageStorageKey != "" || wrongMIMEDocument.Tasks[len(wrongMIMEDocument.Tasks)-1].Status != filmStatusFailed {
		t.Fatalf("wrong MIME blob was bound: %#v", wrongMIMEDocument.Shots[0])
	}

	// A third task proves the successful binding path remains available for a
	// single-shot retry after partial failures.
	run = request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, wrongMIMEDocument.Stages[2].Revision, wrongMIMEDocument.Shots[0].ID, "sync-pass-3"))
	goodDocument := decodeFilmResponse(t, run)
	goodTask := goodDocument.Tasks[len(goodDocument.Tasks)-1]
	goodJob, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, goodTask.GenerationJobID)
	goodJob.Status = "succeeded"
	goodJob.Result = json.RawMessage(`{"items":[{"storageKey":"image:film-sync","mimeType":"image/png","bytes":7}]}`)
	_ = backend.PutGenerationJob(t.Context(), store.DefaultTenantID, goodJob)
	put = requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:film-sync", []byte("payload"), map[string]string{"Content-Type": "image/png"})
	if put.Code != http.StatusNoContent {
		t.Fatalf("seed matching blob: %d %s", put.Code, put.Body.String())
	}
	syncBody, _ = json.Marshal(map[string]any{"revision": goodDocument.Stages[2].Revision})
	synced := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/sync", syncBody)
	if synced.Code != http.StatusOK {
		t.Fatalf("sync: %d %s", synced.Code, synced.Body.String())
	}
	finalDocument := decodeFilmResponse(t, synced)
	digest := sha256.Sum256([]byte("payload"))
	if finalDocument.Shots[0].ImageStorageKey != "image:film-sync" || finalDocument.Shots[0].ImageSHA256 != hex.EncodeToString(digest[:]) || finalDocument.Shots[0].ImageGenerationJobID != goodJob.ID || finalDocument.Stages[2].Status != filmStatusNeedsReview {
		t.Fatalf("successful media was not bound: %#v %#v", finalDocument.Shots[0], finalDocument.Stages[2])
	}
}

func TestLastFrameGenerationResultRequiresImageMIME(t *testing.T) {
	server, _, handler := filmAPIServerHandler(t)
	put := requestWithHeaders(t, handler, http.MethodPut, "/api/blobs/image:last-frame-wrong-mime", []byte("payload"), map[string]string{"Content-Type": "audio/mpeg"})
	if put.Code != http.StatusNoContent {
		t.Fatalf("seed blob: %d %s", put.Code, put.Body.String())
	}
	job := store.GenerationJob{Result: json.RawMessage(`{"items":[{"storageKey":"image:last-frame-wrong-mime","mimeType":"audio/mpeg","bytes":7}]}`)}
	if _, err := validFilmGenerationResult(t.Context(), server, store.DefaultTenantID, "last_frame", job); err == nil {
		t.Fatal("last-frame generation accepted non-image media")
	}
}

func TestPublicBlobAPIRejectsProtectedFilmNamespace(t *testing.T) {
	_, handler := filmAPIHandler(t)
	key := "/api/blobs/film:media:image:protected"
	if response := requestWithHeaders(t, handler, http.MethodPut, key, []byte("payload"), map[string]string{"Content-Type": "image/png"}); response.Code != http.StatusForbidden {
		t.Fatalf("protected PUT: %d %s", response.Code, response.Body.String())
	}
	if response := request(t, handler, http.MethodDelete, key, nil); response.Code != http.StatusForbidden {
		t.Fatalf("protected DELETE: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmEditCancelsQueuedGenerationAndRejectsDirectStorageBinding(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	run := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "cancel-pass"))
	running := decodeFilmResponse(t, run)
	task := running.Tasks[len(running.Tasks)-1]

	directBody, _ := json.Marshal(map[string]any{"revision": running.Shots[0].Revision, "imageStorageKey": "image:untrusted"})
	direct := request(t, handler, http.MethodPut, "/api/film/projects/film-api/shots/"+running.Shots[0].ID, directBody)
	if direct.Code != http.StatusUnprocessableEntity {
		t.Fatalf("direct storage binding accepted: %d %s", direct.Code, direct.Body.String())
	}

	editBody, _ := json.Marshal(map[string]any{"revision": running.Shots[0].Revision, "description": "A revised action."})
	edited := request(t, handler, http.MethodPut, "/api/film/projects/film-api/shots/"+running.Shots[0].ID, editBody)
	if edited.Code != http.StatusOK {
		t.Fatalf("edit: %d %s", edited.Code, edited.Body.String())
	}
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, task.GenerationJobID)
	if err != nil || job.Status != "cancelled" {
		t.Fatalf("invalidated job was not cancelled through store path: %#v err=%v", job, err)
	}
}

func TestFilmGenerationCASLoserDoesNotCancelWinnerReferencedJob(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	body := filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "concurrent-idempotency")
	firstBlocked := make(chan struct{})
	releaseFirst := make(chan struct{})
	var calls atomic.Int32
	backend.casHook = func() {
		if calls.Add(1) == 1 {
			close(firstBlocked)
			<-releaseFirst
		}
	}
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		firstDone <- request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", body)
	}()
	<-firstBlocked
	second := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run", body)
	close(releaseFirst)
	first := <-firstDone
	if second.Code != http.StatusAccepted || first.Code != http.StatusConflict {
		t.Fatalf("concurrent results first=%d second=%d", first.Code, second.Code)
	}
	winner := decodeFilmResponse(t, second)
	jobID := winner.Tasks[len(winner.Tasks)-1].GenerationJobID
	job, err := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, jobID)
	if err != nil || job.Status != "queued" {
		t.Fatalf("CAS loser canceled winner job: %#v err=%v", job, err)
	}
}

func TestFilmMutationCancelsInvalidatedJobOnlyAfterCAS(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	run := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/run",
		filmGenerationRunBody(t, document.Stages[2].Revision, document.Shots[0].ID, "post-cas-cancel"))
	running := decodeFilmResponse(t, run)
	jobID := running.Tasks[len(running.Tasks)-1].GenerationJobID
	blocked := make(chan struct{})
	release := make(chan struct{})
	backend.casHook = func() { close(blocked); <-release }
	body, _ := json.Marshal(map[string]any{"revision": running.Shots[0].Revision, "title": "Changed after CAS"})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- request(t, handler, http.MethodPut, "/api/film/projects/film-api/shots/"+running.Shots[0].ID, body)
	}()
	<-blocked
	job, _ := backend.GetGenerationJob(t.Context(), store.DefaultTenantID, jobID)
	if job.Status != "queued" {
		t.Fatalf("job canceled before film CAS: %#v", job)
	}
	close(release)
	response := <-done
	if response.Code != http.StatusOK {
		t.Fatalf("mutation: %d %s", response.Code, response.Body.String())
	}
	job, _ = backend.GetGenerationJob(t.Context(), store.DefaultTenantID, jobID)
	if job.Status != "cancelled" {
		t.Fatalf("job not canceled after CAS: %#v", job)
	}
}

func TestFilmGenerationSyncCannotReadAnotherTenantJob(t *testing.T) {
	backend, handler := filmAPIHandler(t)
	document := prepareFilmGenerationStage(t, handler)
	timestamp := document.UpdatedAt
	document.Tasks = append(document.Tasks, filmTask{
		ID: "task_cross_tenant", Revision: 1, Stage: "storyboard", ShotID: document.Shots[0].ID,
		Title: "Cross tenant", Status: filmStatusRunning, CreatedAt: timestamp, UpdatedAt: timestamp,
		GenerationJobID: "job_cross_tenant", IdempotencyKey: "cross-tenant", RequestHash: strings.Repeat("a", 64),
	})
	document.Stages[2].Status = filmStatusRunning
	raw, _ := json.Marshal(document)
	record, _ := backend.GetFilmProject(t.Context(), store.DefaultTenantID, "film-api")
	if _, err := backend.CompareAndSwapFilmProject(t.Context(), store.DefaultTenantID, "film-api", record.Revision, raw); err != nil {
		t.Fatal(err)
	}
	job := store.GenerationJob{ID: "job_cross_tenant", ProjectID: "film-api", Kind: "image", Status: "succeeded", Prompt: "x", ProviderID: "p", Model: "m", Parameters: json.RawMessage(`{"executor":"server","requestHash":"` + strings.Repeat("a", 64) + `"}`), Result: json.RawMessage(`{"items":[{"storageKey":"image:other","mimeType":"image/png","bytes":1}]}`), CreatedAt: timestamp, UpdatedAt: timestamp}
	if err := backend.CreateGenerationJob(t.Context(), "tenant-b", job); err != nil {
		t.Fatal(err)
	}

	syncBody, _ := json.Marshal(map[string]any{"revision": document.Stages[2].Revision})
	response := request(t, handler, http.MethodPost, "/api/film/projects/film-api/stages/storyboard/sync", syncBody)
	if response.Code != http.StatusOK || decodeFilmResponse(t, response).Shots[0].ImageStorageKey != "" {
		t.Fatalf("cross-tenant job was bound: %d %s", response.Code, response.Body.String())
	}
}

func TestFilmAudioInputsFreezeDialogueEmotionUnlessExplicitlyOverridden(t *testing.T) {
	document := newFilmDocument("film-emotion")
	shot := filmShot{ID: "shot-emotion"}
	document.Dialogues = []filmDialogue{
		{ID: "dialogue-1", ShotID: shot.ID, Order: 0, Text: "Wait.", Emotion: "controlled fear"},
		{ID: "dialogue-2", ShotID: shot.ID, Order: 1, Text: "Run!", Emotion: "urgent"},
	}
	prepared, config := filmAudioInputs(document, shot, filmGenerationConfig{})
	if prepared.Subtitle != "Wait.\nRun!" || config.Instructions != "Emotion direction: controlled fear; urgent" {
		t.Fatalf("audio inputs did not freeze emotional direction: shot=%#v config=%#v", prepared, config)
	}
	_, explicit := filmAudioInputs(document, shot, filmGenerationConfig{Instructions: "whispered"})
	if explicit.Instructions != "whispered" {
		t.Fatalf("explicit audio direction was overwritten: %#v", explicit)
	}
}
