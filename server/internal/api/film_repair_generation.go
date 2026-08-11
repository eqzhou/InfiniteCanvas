package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

type preparedFilmRepairGeneration struct {
	document     filmDocument
	reservations []store.FilmGenerationReservation
	stage        string
}

func filmRepairGenerationTarget(document filmDocument, repair filmRepairProposal) (filmGenerationTarget, error) {
	var target filmGenerationTarget
	for _, shot := range document.Shots {
		if repair.TargetType == "shot" && shot.ID == repair.TargetID {
			return filmGenerationTarget{Shot: shot}, nil
		}
		if repair.TargetType == "dialogue" {
			for index := range document.Dialogues {
				dialogue := document.Dialogues[index]
				if dialogue.ID == repair.TargetID && dialogue.ShotID == shot.ID {
					return filmGenerationTarget{Shot: shot, Dialogue: &dialogue}, nil
				}
			}
		}
	}
	return target, errors.New("repair target not found")
}

func filmRepairLifecycleStage(stage string) string {
	if stage == "last_frame" {
		return "first_frame"
	}
	return stage
}

func (s *Server) applyFilmRegenerativeRepair(w http.ResponseWriter, r *http.Request, input filmRepairApplyRequest, repair filmRepairProposal) {
	atomicBackend, ok := s.store.(store.FilmGenerationBatchStore)
	if !ok {
		writeFilmError(w, http.StatusServiceUnavailable, "film_generation_atomic_store_required", "Film repair generation requires atomic task persistence")
		return
	}
	if !s.requireAllowedModel(w, r, strings.TrimSpace(input.Model)) {
		return
	}
	if err := validateFilmGenerationConfig(repair.RegenerationStage, *input.Config); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	_, record, document, loaded := s.loadFilmProduction(w, r, true)
	if !loaded {
		return
	}
	currentRepair, found := findFilmRepairProposal(document, repair.ID)
	if !found || currentRepair.ExpectedRevision != input.Revision {
		writeFilmError(w, http.StatusConflict, "revision_conflict", "repair revision conflict")
		return
	}
	target, targetErr := filmRepairGenerationTarget(document, currentRepair)
	if targetErr != nil {
		writeFilmOperationError(w, targetErr)
		return
	}
	providerID, model := s.filmGenerationProvider(r.Context(), tenantIDFrom(r), currentRepair.RegenerationStage, input.ProviderID, input.Model)
	replayInput := filmGenerationRunRequest{ShotIDs: []string{target.Shot.ID}, ProviderID: providerID, Model: model, Config: *input.Config, IdempotencyKey: strings.TrimSpace(input.IdempotencyKey)}
	replayHash, hashErr := filmGenerationTargetRequestHash(document.ProjectID, currentRepair.RegenerationStage, []filmGenerationTarget{target}, replayInput)
	if hashErr != nil {
		writeFilmRepairGenerationError(w, hashErr)
		return
	}
	if currentRepair.AppliedAt != "" {
		parentJobID := stableFilmID("job-stage-repair", document.ProjectID, currentRepair.ID, strings.TrimSpace(input.IdempotencyKey))
		for _, task := range document.Tasks {
			if task.ParentGenerationJobID == parentJobID && filmTaskTargetID(task) == currentRepair.TargetID && task.Stage == currentRepair.RegenerationStage && task.IdempotencyKey == strings.TrimSpace(input.IdempotencyKey) {
				if task.RequestHash != replayHash || task.Snapshot == nil || input.ExpectedCredits == nil || task.Snapshot.EstimatedCredits != *input.ExpectedCredits {
					writeFilmError(w, http.StatusConflict, "idempotency_conflict", "idempotency key belongs to a different repair generation request")
					return
				}
				s.writeFilmDocument(w, r, http.StatusOK, record, document)
				return
			}
		}
		writeFilmError(w, http.StatusConflict, "repair_already_applied", "Repair was already applied")
		return
	}
	if err := validateFilmStageDependencies(document, filmRepairLifecycleStage(currentRepair.RegenerationStage)); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	tenantID := tenantIDFrom(r)
	if err := s.validateFilmGenerationReferences(r.Context(), tenantID, currentRepair.RegenerationStage, input.Config.ReferenceStorageKeys); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	prepared, err := s.prepareFilmRepairGeneration(r, document, currentRepair, input)
	if err != nil {
		writeFilmRepairGenerationError(w, err)
		return
	}
	if err := validateFilmAggregateLimits(prepared.document); err != nil {
		writeFilmOperationError(w, err)
		return
	}
	raw, err := json.Marshal(prepared.document)
	if err != nil || len(raw) > maxProjectBytes {
		writeFilmError(w, http.StatusUnprocessableEntity, "film_document_too_large", "Film production exceeds its storage limit")
		return
	}
	updated, err := atomicBackend.CreateFilmGenerationBatch(r.Context(), tenantID, userIDFrom(r), record.ProjectID, record.Revision, raw, prepared.reservations)
	if err != nil {
		writeFilmRepairGenerationError(w, err)
		return
	}
	s.notifyFilmGenerationWorkers(prepared.stage)
	s.writeFilmDocument(w, r, http.StatusAccepted, updated, prepared.document)
}

func (s *Server) prepareFilmRepairGeneration(r *http.Request, document filmDocument, repair filmRepairProposal, input filmRepairApplyRequest) (preparedFilmRepairGeneration, error) {
	next := cloneFilmDocument(document)
	for reportIndex := range next.QualityReports {
		for repairIndex := range next.QualityReports[reportIndex].Repairs {
			if next.QualityReports[reportIndex].Repairs[repairIndex].ID == repair.ID {
				next.QualityReports[reportIndex].Repairs[repairIndex].Approved = true
			}
		}
	}
	patched, err := applyFilmRepair(next, repair.ID)
	if err != nil {
		return preparedFilmRepairGeneration{}, err
	}
	stage := repair.RegenerationStage
	target, err := filmRepairGenerationTarget(patched, repair)
	if err != nil {
		return preparedFilmRepairGeneration{}, err
	}
	shot := target.Shot
	stageIndex, currentStage, err := findFilmStage(patched, filmRepairLifecycleStage(stage))
	if err != nil {
		return preparedFilmRepairGeneration{}, err
	}
	providerID, model := s.filmGenerationProvider(r.Context(), tenantIDFrom(r), stage, input.ProviderID, input.Model)
	if strings.TrimSpace(model) == "" {
		return preparedFilmRepairGeneration{}, errors.New("selected generation model is unavailable")
	}
	runInput := filmGenerationRunRequest{ShotIDs: []string{shot.ID}, ProviderID: providerID, Model: model, Config: *input.Config, IdempotencyKey: strings.TrimSpace(input.IdempotencyKey)}
	requestHash, err := filmGenerationTargetRequestHash(document.ProjectID, stage, []filmGenerationTarget{target}, runInput)
	if err != nil {
		return preparedFilmRepairGeneration{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	parentJobID := stableFilmID("job-stage-repair", document.ProjectID, repair.ID, runInput.IdempotencyKey)
	targetID := filmGenerationTargetID(target)
	childJobID := stableFilmID("job-repair", document.ProjectID, repair.ID, runInput.IdempotencyKey, targetID)
	taskID := stableFilmID("task-repair", document.ProjectID, repair.ID, runInput.IdempotencyKey, targetID)
	if _, getErr := s.store.GetGenerationJob(r.Context(), tenantIDFrom(r), parentJobID); getErr == nil {
		return preparedFilmRepairGeneration{}, errors.New("repair idempotency key already has a generation job")
	} else if !errors.Is(getErr, store.ErrNotFound) {
		return preparedFilmRepairGeneration{}, getErr
	}
	jobShot, jobConfig := shot, *input.Config
	if stage == "audio" {
		jobShot, jobConfig = filmDialogueAudioInputs(patched, target, jobConfig)
	}
	if stage == "video" && (shot.FirstFrameStorageKey != "" || shot.LastFrameStorageKey != "") {
		jobConfig.ReferenceStorageKeys = orderedFilmVideoReferences(shot, jobConfig.ReferenceStorageKeys)
		if err := s.validateFilmGenerationReferences(r.Context(), tenantIDFrom(r), stage, jobConfig.ReferenceStorageKeys); err != nil {
			return preparedFilmRepairGeneration{}, err
		}
	}
	selectedProviderID, snapshot, err := s.snapshotGenerationChannel(r.Context(), tenantIDFrom(r), filmStageGenerationKind(stage), childJobID, providerID, model)
	if err != nil {
		return preparedFilmRepairGeneration{}, errors.New("no eligible generation provider is available")
	}
	selectedModel := model
	capabilityVersion, generationMode := "", ""
	if snapshot != nil {
		selectedModel = snapshot.Model
		catalog, catalogErr := s.buildMediaCapabilityCatalog(r.Context(), tenantIDFrom(r))
		if catalogErr != nil {
			return preparedFilmRepairGeneration{}, errors.New("media capability catalog is unavailable")
		}
		generationMode = filmGenerationMode(stage, jobShot, jobConfig)
		for _, capability := range catalog.Models {
			if capability.ChannelID == selectedProviderID && capability.Model == selectedModel && capability.Kind == filmStageGenerationKind(stage) && validateMediaCapabilityRequest(capability, generationMode, jobConfig) == nil {
				capabilityVersion = catalog.Version
				break
			}
		}
		if capabilityVersion == "" {
			return preparedFilmRepairGeneration{}, errors.New("selected shared model does not advertise the requested generation mode")
		}
	}
	allowed, policyErr := s.modelAllowedByPolicy(r.Context(), tenantIDFrom(r), selectedModel)
	if policyErr != nil {
		return preparedFilmRepairGeneration{}, errFilmRepairPolicyUnavailable
	}
	if !allowed {
		return preparedFilmRepairGeneration{}, errFilmRepairModelNotAllowed
	}
	parentJob, err := buildFilmStageGenerationJob(document.ProjectID, stage, parentJobID, requestHash, now, []string{childJobID}, []int{*input.ExpectedCredits})
	if err != nil {
		return preparedFilmRepairGeneration{}, err
	}
	childJob, err := buildFilmGenerationTargetJob(stage, jobShot, target.Dialogue, document.ProjectID, selectedProviderID, selectedModel, taskID, parentJobID, childJobID, requestHash, jobConfig, snapshot, now)
	if err != nil {
		return preparedFilmRepairGeneration{}, err
	}
	if err := setFilmGenerationJobCreditQuote(&childJob, *input.ExpectedCredits); err != nil {
		return preparedFilmRepairGeneration{}, err
	}
	repairSnapshot := buildFilmGenerationTargetSnapshotWithCapability(patched, jobShot, target.Dialogue, selectedProviderID, selectedModel, jobConfig, now, capabilityVersion, generationMode)
	repairSnapshot.EstimatedCredits = *input.ExpectedCredits
	dialogueID := ""
	if target.Dialogue != nil {
		dialogueID = target.Dialogue.ID
	}
	patched.Tasks = append(patched.Tasks, filmTask{ID: taskID, Revision: 1, Stage: stage, ShotID: shot.ID, DialogueID: dialogueID, Title: "Repair and regenerate " + stage + " for " + shot.Title, Status: filmStatusRunning, Progress: 0, CreatedAt: now, UpdatedAt: now, GenerationJobID: childJobID, ParentGenerationJobID: parentJobID, IdempotencyKey: runInput.IdempotencyKey, RequestHash: requestHash, Snapshot: repairSnapshot})
	if len(patched.Tasks) > 1_000 {
		return preparedFilmRepairGeneration{}, errors.New("film task retention limit reached")
	}
	currentStage.Status, currentStage.Error, currentStage.UpdatedAt = filmStatusRunning, "", now
	currentStage.Revision++
	patched.Stages[stageIndex] = currentStage
	patched.UpdatedAt = now
	meta, _ := json.Marshal(map[string]any{"jobId": childJob.ID, "kind": childJob.Kind, "executor": serverExecutorMarker, "filmProjectId": document.ProjectID, "shotId": shot.ID, "dialogueId": dialogueID, "parentJobId": parentJobID, "repairId": repair.ID})
	reservations := []store.FilmGenerationReservation{{Job: parentJob, Units: 0, UsageMeta: json.RawMessage(`{}`)}, {Job: childJob, Units: 1, UsageMeta: meta, ExpectedCredits: input.ExpectedCredits}}
	return preparedFilmRepairGeneration{document: patched, reservations: reservations, stage: stage}, nil
}

var errFilmRepairModelNotAllowed = errors.New("repair generation model is not allowed")
var errFilmRepairPolicyUnavailable = errors.New("repair generation model policy is unavailable")

func containsFilmStorageKey(keys []string, wanted string) bool {
	for _, key := range keys {
		if key == wanted {
			return true
		}
	}
	return false
}

func containsFilmMode(modes []string, wanted string) bool {
	for _, mode := range modes {
		if mode == wanted {
			return true
		}
	}
	return false
}

func writeFilmRepairGenerationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errFilmRepairModelNotAllowed):
		writeFilmError(w, http.StatusForbidden, "model_not_allowed", modelNotAllowedMessage)
	case errors.Is(err, errFilmRepairPolicyUnavailable):
		writeFilmError(w, http.StatusInternalServerError, "site_policy_unavailable", "Film generation policy is unavailable")
	case errors.Is(err, store.ErrConflict) || strings.Contains(err.Error(), "idempotency"):
		writeFilmError(w, http.StatusConflict, "revision_conflict", "Film production changed; reload before retrying")
	case errors.Is(err, store.ErrQuotaExceeded), errors.Is(err, store.ErrInsufficientCredits), errors.Is(err, store.ErrBanned), errors.Is(err, store.ErrGone), errors.Is(err, store.ErrUnauthorized):
		writeFilmOperationError(w, filmGenerationStoreError(err))
	case strings.Contains(err.Error(), "provider"), strings.Contains(err.Error(), "capability") || strings.Contains(err.Error(), "shared model"):
		writeFilmError(w, http.StatusUnprocessableEntity, "provider_unavailable", err.Error())
	default:
		writeFilmOperationError(w, err)
	}
}
