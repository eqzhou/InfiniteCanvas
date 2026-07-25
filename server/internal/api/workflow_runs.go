package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

type createWorkflowJobRequest struct {
	ID               string                     `json:"id"`
	ProjectID        string                     `json:"projectId,omitempty"`
	TemplateSnapshot json.RawMessage            `json:"templateSnapshot"`
	Values           map[string]json.RawMessage `json:"values"`
}

func (s *Server) createServerWorkflowJob(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeServerGeneration(w, r) {
		return
	}
	if s.store == nil || s.imageExecutor == nil || s.secrets == nil {
		http.Error(w, "server workflow generation is unavailable", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxGenerationJobBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input createWorkflowJobRequest
	if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil || !validProjectID(input.ID) ||
		(input.ProjectID != "" && !validProjectID(input.ProjectID)) || input.Values == nil {
		http.Error(w, "invalid workflow generation job", http.StatusBadRequest)
		return
	}
	template, err := decodeWorkflowTemplate(input.TemplateSnapshot)
	if err != nil {
		http.Error(w, "invalid workflow template snapshot", http.StatusBadRequest)
		return
	}
	values, err := normalizeWorkflowValues(template, input.Values)
	if err != nil {
		http.Error(w, "invalid workflow values", http.StatusBadRequest)
		return
	}
	tenantID := tenantIDFrom(r)
	referencedVariables := map[string]struct{}{}
	for _, step := range template.Steps {
		for _, reference := range step.References {
			if reference.Source == "variable" {
				referencedVariables[reference.VariableID] = struct{}{}
			}
		}
	}
	uniqueReferences := map[string]struct{}{}
	totalReferenceBytes := 0
	for _, variable := range template.Variables {
		if variable.Kind != "image" {
			continue
		}
		var keys []string
		_ = json.Unmarshal(values[variable.ID], &keys)
		if _, used := referencedVariables[variable.ID]; !used {
			continue
		}
		for _, key := range keys {
			if _, seen := uniqueReferences[key]; seen {
				continue
			}
			uniqueReferences[key] = struct{}{}
			if len(uniqueReferences) > 16 {
				http.Error(w, "workflow image values exceed reference count limit", http.StatusBadRequest)
				return
			}
			image, err := s.readTenantImageBlobContext(r.Context(), tenantID, key)
			if err != nil {
				http.Error(w, "workflow image values must be valid tenant PNG or JPEG blobs", http.StatusBadRequest)
				return
			}
			totalReferenceBytes += len(image.Data)
			if totalReferenceBytes > maxGeneratedTotalBytes {
				http.Error(w, "workflow image values exceed total size limit", http.StatusBadRequest)
				return
			}
		}
	}
	requestHash, err := hashWorkflowRequest(input.ProjectID, template, values)
	if err != nil {
		http.Error(w, "invalid workflow generation job", http.StatusBadRequest)
		return
	}
	parameters, _ := json.Marshal(workflowRunParameters{
		Executor: "workflow", RequestHash: requestHash, TemplateID: template.ID,
		TemplateRevision: template.Revision, TemplateSnapshot: template, Values: values,
	})
	result, _ := json.Marshal(initialWorkflowRunResult(template))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	job := store.GenerationJob{
		ID: input.ID, ProjectID: input.ProjectID, Kind: "workflow", Status: "queued", Prompt: template.Title,
		Parameters: parameters, Result: result, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.store.CheckGenerationQuota(r.Context(), tenantID); errors.Is(err, store.ErrQuotaExceeded) {
		http.Error(w, "generation quota exceeded", http.StatusTooManyRequests)
		return
	} else if err != nil {
		http.Error(w, "failed to check generation quota", http.StatusInternalServerError)
		return
	}
	if err := s.store.CreateGenerationJob(r.Context(), tenantID, job); errors.Is(err, store.ErrConflict) {
		existing, getErr := s.store.GetGenerationJob(r.Context(), tenantID, job.ID)
		if getErr == nil && matchingWorkflowRequest(existing, requestHash) {
			writeJSON(w, existing)
			return
		}
		http.Error(w, "generation job id already belongs to another request", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to store workflow generation job", http.StatusInternalServerError)
		return
	}
	s.notifyWorkflowWorkers()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, job)
}

func hashWorkflowRequest(projectID string, template workflowTemplate, values map[string]json.RawMessage) (string, error) {
	value, err := json.Marshal(struct {
		ProjectID string                     `json:"projectId,omitempty"`
		Template  workflowTemplate           `json:"templateSnapshot"`
		Values    map[string]json.RawMessage `json:"values"`
	}{projectID, template, values})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:]), nil
}

func matchingWorkflowRequest(job store.GenerationJob, requestHash string) bool {
	if job.Kind != "workflow" {
		return false
	}
	var parameters workflowRunParameters
	decoder := json.NewDecoder(bytes.NewReader(job.Parameters))
	decoder.DisallowUnknownFields()
	return decoder.Decode(&parameters) == nil && ensureJSONEOF(decoder) == nil &&
		parameters.Executor == "workflow" && parameters.RequestHash == requestHash
}
