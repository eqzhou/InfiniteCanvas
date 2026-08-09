package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const maxWorkspaceReplaceBytes = 128 << 20

var workspaceTransactionStateKeys = []string{"assets", "config", "prompts", workflowTemplateStateKey, secretStateKey}

type workspaceReplaceRequest struct {
	ExpectedVersion   string                `json:"expectedVersion"`
	Projects          []json.RawMessage     `json:"projects"`
	Films             []workspaceFilmInput  `json:"films"`
	GenerationJobs    []store.GenerationJob `json:"generationJobs"`
	Assets            json.RawMessage       `json:"assets"`
	Config            json.RawMessage       `json:"config"`
	Prompts           json.RawMessage       `json:"prompts"`
	WorkflowTemplates json.RawMessage       `json:"workflowTemplates"`
}

type workspaceFilmInput struct {
	Revision int                `json:"revision"`
	Document filmDocument       `json:"document"`
	Media    []filmRestoreMedia `json:"media"`
}

type projectAggregateReplaceRequest struct {
	ExpectedVersion string              `json:"expectedVersion"`
	Project         json.RawMessage     `json:"project"`
	Film            *workspaceFilmInput `json:"film,omitempty"`
}

type workspaceRollbackRequest struct {
	ExpectedVersion string `json:"expectedVersion"`
	RestoreToken    string `json:"restoreToken"`
}

type workspaceJSONNumber string

func canonicalWorkspaceJSONNumber(number json.Number) (workspaceJSONNumber, error) {
	value := string(number)
	sign := ""
	if strings.HasPrefix(value, "-") {
		sign, value = "-", value[1:]
	}
	exponent := new(big.Int)
	exponent.SetInt64(0)
	if index := strings.IndexAny(value, "eE"); index >= 0 {
		if _, ok := exponent.SetString(value[index+1:], 10); !ok {
			return "", errors.New("invalid JSON number")
		}
		value = value[:index]
	}
	fractionDigits := 0
	if index := strings.IndexByte(value, '.'); index >= 0 {
		fractionDigits = len(value) - index - 1
		value = value[:index] + value[index+1:]
	}
	value = strings.TrimLeft(value, "0")
	if value == "" {
		return "0", nil
	}
	trailingZeros := len(value) - len(strings.TrimRight(value, "0"))
	value = strings.TrimRight(value, "0")
	exponent.Sub(exponent, big.NewInt(int64(fractionDigits)))
	exponent.Add(exponent, big.NewInt(int64(trailingZeros)))
	return workspaceJSONNumber(sign + value + "e" + exponent.String()), nil
}

func decodeStrictWorkspaceJSONValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		if number, ok := token.(json.Number); ok {
			return canonicalWorkspaceJSONNumber(number)
		}
		return token, nil
	}
	switch delimiter {
	case '{':
		object := map[string]any{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			key, ok := keyToken.(string)
			if err != nil || !ok {
				return nil, errors.New("invalid JSON object")
			}
			if _, duplicate := object[key]; duplicate {
				return nil, errors.New("duplicate JSON object key")
			}
			value, err := decodeStrictWorkspaceJSONValue(decoder)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		if closing, err := decoder.Token(); err != nil || closing != json.Delim('}') {
			return nil, errors.New("invalid JSON object")
		}
		return object, nil
	case '[':
		array := []any{}
		for decoder.More() {
			value, err := decodeStrictWorkspaceJSONValue(decoder)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		if closing, err := decoder.Token(); err != nil || closing != json.Delim(']') {
			return nil, errors.New("invalid JSON array")
		}
		return array, nil
	default:
		return nil, errors.New("invalid JSON delimiter")
	}
}

func decodeStrictWorkspaceJSON(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := decodeStrictWorkspaceJSONValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("invalid trailing JSON data")
	}
	return value, nil
}

func workspaceJSONSemanticEqual(left, right []byte) bool {
	leftValue, leftErr := decodeStrictWorkspaceJSON(left)
	rightValue, rightErr := decodeStrictWorkspaceJSON(right)
	return leftErr == nil && rightErr == nil && reflect.DeepEqual(leftValue, rightValue)
}

func normalizeWorkspaceVersion(value string) string {
	return strings.Trim(strings.TrimSpace(value), `"`)
}

func validateWorkspaceReplacement(input workspaceReplaceRequest) (store.WorkspaceSnapshot, error) {
	if input.Projects == nil || input.Films == nil || input.GenerationJobs == nil || input.Assets == nil || input.Config == nil || input.Prompts == nil || input.WorkflowTemplates == nil ||
		len(input.Projects) > maxProjectCount || len(input.Films) > maxProjectCount || len(input.GenerationJobs) > maxGenerationRestoreItems {
		return store.WorkspaceSnapshot{}, errors.New("workspace exceeds its project limit")
	}
	snapshot := store.WorkspaceSnapshot{Projects: make([]store.WorkspaceProject, 0, len(input.Projects)), Films: make([]store.WorkspaceFilm, 0, len(input.Films)), GenerationJobs: make([]store.WorkspaceGenerationJob, 0, len(input.GenerationJobs))}
	projectKinds := make(map[string]string, len(input.Projects))
	total := 0
	for _, raw := range input.Projects {
		total += len(raw)
		if len(raw) == 0 || len(raw) > maxProjectBytes || total > maxWorkspaceReplaceBytes {
			return store.WorkspaceSnapshot{}, errors.New("workspace exceeds its storage limit")
		}
		var document map[string]any
		decoder := json.NewDecoder(bytes.NewReader(raw))
		if decoder.Decode(&document) != nil || ensureJSONEOF(decoder) != nil || document == nil {
			return store.WorkspaceSnapshot{}, errors.New("workspace project is invalid")
		}
		id, _ := document["id"].(string)
		if !validProjectID(id) || projectKinds[id] != "" {
			return store.WorkspaceSnapshot{}, errors.New("workspace project id is invalid or duplicated")
		}
		if err := validateProjectDocument(document); err != nil {
			return store.WorkspaceSnapshot{}, err
		}
		kind, _ := document["projectKind"].(string)
		projectKinds[id] = kind
		snapshot.Projects = append(snapshot.Projects, store.WorkspaceProject{ID: id, Document: append([]byte(nil), raw...)})
	}
	filmIDs := make(map[string]struct{}, len(input.Films))
	for index := range input.Films {
		film := input.Films[index]
		film.Document = migrateFilmDocumentTopology(film.Document)
		input.Films[index].Document = film.Document
		raw, err := json.Marshal(film.Document)
		total += len(raw)
		if err != nil || len(raw) > maxProjectBytes || total > maxWorkspaceReplaceBytes || projectKinds[film.Document.ProjectID] != "film" {
			return store.WorkspaceSnapshot{}, errors.New("workspace Film aggregate is invalid")
		}
		if _, duplicate := filmIDs[film.Document.ProjectID]; duplicate {
			return store.WorkspaceSnapshot{}, errors.New("workspace Film aggregate is duplicated")
		}
		if film.Revision < 0 {
			return store.WorkspaceSnapshot{}, errors.New("workspace Film revision is invalid")
		}
		if err := validateFilmAggregate(film.Document, film.Document.ProjectID); err != nil {
			return store.WorkspaceSnapshot{}, err
		}
		if err := validateFilmRestoreMediaMetadata(film.Document, film.Media); err != nil {
			return store.WorkspaceSnapshot{}, err
		}
		filmIDs[film.Document.ProjectID] = struct{}{}
		snapshot.Films = append(snapshot.Films, store.WorkspaceFilm{ProjectID: film.Document.ProjectID, Revision: film.Revision, Document: raw})
	}
	jobIDs := map[string]struct{}{}
	for _, job := range input.GenerationJobs {
		if !validGenerationJob(job) || job.Status == "deleted" || isServerGenerationJob(job) && (job.Status == "queued" || job.Status == "running") {
			return store.WorkspaceSnapshot{}, errors.New("workspace generation history is invalid")
		}
		if _, duplicate := jobIDs[job.ID]; duplicate {
			return store.WorkspaceSnapshot{}, errors.New("workspace generation history is duplicated")
		}
		jobIDs[job.ID] = struct{}{}
		snapshot.GenerationJobs = append(snapshot.GenerationJobs, store.WorkspaceGenerationJob{Job: job})
	}
	states := []struct {
		key   string
		value json.RawMessage
		limit int
	}{
		{key: "assets", value: input.Assets, limit: maxStateBytes}, {key: "config", value: input.Config, limit: maxStateBytes},
		{key: "prompts", value: input.Prompts, limit: maxStateBytes}, {key: workflowTemplateStateKey, value: input.WorkflowTemplates, limit: maxWorkflowTemplateDocumentBytes},
	}
	for _, state := range states {
		total += len(state.value)
		if len(state.value) == 0 || len(state.value) > state.limit || total > maxWorkspaceReplaceBytes || !json.Valid(state.value) {
			return store.WorkspaceSnapshot{}, errors.New("workspace state is invalid or oversized")
		}
		if state.key == "config" {
			if _, err := decodeStrictWorkspaceJSON(state.value); err != nil {
				return store.WorkspaceSnapshot{}, errors.New("workspace state is invalid or oversized")
			}
		}
		snapshot.States = append(snapshot.States, store.WorkspaceState{Key: state.key, Exists: true, Value: append([]byte(nil), state.value...)})
	}
	var templates workflowTemplateDocument
	decoder := json.NewDecoder(bytes.NewReader(input.WorkflowTemplates))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&templates) != nil || ensureJSONEOF(decoder) != nil || templates.Version != 1 || templates.Templates == nil || len(templates.Templates) > maxWorkflowTemplates {
		return store.WorkspaceSnapshot{}, errors.New("workspace workflow templates are invalid")
	}
	for _, template := range templates.Templates {
		if validateWorkflowTemplate(template) != nil || template.Scope != "personal" {
			return store.WorkspaceSnapshot{}, errors.New("workspace workflow templates are invalid")
		}
	}
	return snapshot, nil
}

func (s *Server) authorizeWorkspaceConfigReplacement(w http.ResponseWriter, r *http.Request, requested []byte, snapshot *store.WorkspaceSnapshot) (bool, bool) {
	values, err := s.store.GetStates(r.Context(), tenantIDFrom(r), []string{"config", secretStateKey})
	if err != nil {
		http.Error(w, "failed to read tenant config", http.StatusInternalServerError)
		return false, false
	}
	currentConfig := values["config"]
	currentSecrets := values[secretStateKey]
	configChanged := !workspaceJSONSemanticEqual(currentConfig, requested)
	if configChanged {
		if !s.requireTenantAdmin(w, r, "state unavailable") {
			return false, false
		}
		if err := s.preventTenantObjectStorageRebind(r.Context(), tenantIDFrom(r), requested); errors.Is(err, errTenantObjectStorageRebind) {
			http.Error(w, "object storage destination cannot be changed while data exists", http.StatusConflict)
			return false, false
		} else if err != nil {
			http.Error(w, "invalid object storage configuration", http.StatusBadRequest)
			return false, false
		}
		if currentSecrets != nil {
			http.Error(w, "config and secrets must be saved together", http.StatusConflict)
			return false, false
		}
	}
	snapshot.States = append(snapshot.States, store.WorkspaceState{
		Key: secretStateKey, Exists: currentSecrets != nil, Value: bytes.Clone(currentSecrets),
	})
	return configChanged, true
}

func (s *Server) replaceWorkspace(w http.ResponseWriter, r *http.Request) {
	backend, ok := s.store.(store.WorkspaceStore)
	if !ok {
		http.Error(w, "transactional workspace replacement is unavailable", http.StatusServiceUnavailable)
		return
	}
	var input workspaceReplaceRequest
	if err := decodeFilmRequest(w, r, maxWorkspaceReplaceBytes, &input); err != nil {
		http.Error(w, "invalid or oversized workspace", http.StatusBadRequest)
		return
	}
	input.ExpectedVersion = normalizeWorkspaceVersion(input.ExpectedVersion)
	if !strings.HasPrefix(input.ExpectedVersion, "w1-") || len(input.ExpectedVersion) != 67 {
		http.Error(w, "invalid workspace version", http.StatusBadRequest)
		return
	}
	snapshot, err := validateWorkspaceReplacement(input)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	tenantID := tenantIDFrom(r)
	configChanged, ok := s.authorizeWorkspaceConfigReplacement(w, r, input.Config, &snapshot)
	if !ok {
		return
	}
	createdByProject := make(map[string][]string, len(snapshot.Films))
	createdMedia := []store.WorkspaceMedia{}
	migrated := map[string]struct{}{}
	cleanup := func() {
		for projectID, keys := range createdByProject {
			s.cleanupRestoredFilmBlobs(r.Context(), tenantID, userIDFrom(r), projectID, keys)
		}
	}
	filmBackend, _ := s.store.(store.FilmStore)
	for index := range snapshot.Films {
		var document filmDocument
		if json.Unmarshal(snapshot.Films[index].Document, &document) != nil {
			cleanup()
			http.Error(w, "workspace Film aggregate is invalid", http.StatusUnprocessableEntity)
			return
		}
		allowedProtected := map[string]struct{}{}
		if filmBackend != nil {
			if current, currentErr := filmBackend.GetFilmProject(r.Context(), tenantID, document.ProjectID); currentErr == nil {
				var currentDocument filmDocument
				if json.Unmarshal(current.Document, &currentDocument) != nil {
					cleanup()
					http.Error(w, "current Film aggregate is invalid", http.StatusInternalServerError)
					return
				}
				allowedProtected = protectedFilmDocumentKeys(currentDocument)
			} else if !errors.Is(currentErr, store.ErrNotFound) {
				cleanup()
				http.Error(w, "current Film aggregate could not be read", http.StatusInternalServerError)
				return
			}
		}
		next, created, migratedKeys, restoreErr := s.rehydrateRestoredFilmMedia(r.Context(), tenantID, userIDFrom(r), document, input.Films[index].Media, allowedProtected)
		createdByProject[document.ProjectID] = append(createdByProject[document.ProjectID], created...)
		for _, key := range created {
			createdMedia = append(createdMedia, store.WorkspaceMedia{ProjectID: document.ProjectID, StorageKey: key})
		}
		if restoreErr != nil {
			cleanup()
			http.Error(w, restoreErr.Error(), http.StatusUnprocessableEntity)
			return
		}
		for _, key := range migratedKeys {
			migrated[key] = struct{}{}
		}
		raw, marshalErr := json.Marshal(next)
		if marshalErr != nil || len(raw) > maxProjectBytes {
			cleanup()
			http.Error(w, "workspace Film aggregate exceeds its storage limit", http.StatusUnprocessableEntity)
			return
		}
		snapshot.Films[index].Document = raw
	}
	token, digest, err := newFilmRestoreToken()
	if err != nil {
		cleanup()
		http.Error(w, "failed to create workspace restore token", http.StatusInternalServerError)
		return
	}
	result, err := backend.ReplaceWorkspace(r.Context(), tenantID, input.ExpectedVersion, digest, time.Now().Add(filmRestoreTokenTTL), snapshot, createdMedia)
	if errors.Is(err, store.ErrConflict) {
		cleanup()
		http.Error(w, "workspace changed; reload before replacing", http.StatusConflict)
		return
	}
	if err != nil {
		cleanup()
		http.Error(w, "workspace replacement failed", http.StatusInternalServerError)
		return
	}
	if configChanged {
		s.InvalidateTenantBlobStore(tenantID)
	}
	w.Header().Set("ETag", `"`+result.Version+`"`)
	migratedStorageKeys := make([]string, 0, len(migrated))
	for key := range migrated {
		migratedStorageKeys = append(migratedStorageKeys, key)
	}
	sort.Strings(migratedStorageKeys)
	writeJSON(w, map[string]any{"data": map[string]any{"version": result.Version, "restoreToken": token, "migratedStorageKeys": migratedStorageKeys}})
}

func (s *Server) replaceProjectAggregate(w http.ResponseWriter, r *http.Request) {
	backend, ok := s.store.(store.WorkspaceStore)
	if !ok {
		http.Error(w, "transactional project replacement is unavailable", http.StatusServiceUnavailable)
		return
	}
	var input projectAggregateReplaceRequest
	if err := decodeFilmRequest(w, r, maxWorkspaceReplaceBytes, &input); err != nil {
		http.Error(w, "invalid or oversized project aggregate", http.StatusBadRequest)
		return
	}
	input.ExpectedVersion = normalizeWorkspaceVersion(input.ExpectedVersion)
	if len(input.ExpectedVersion) != 67 || !strings.HasPrefix(input.ExpectedVersion, "w1-") || len(input.Project) == 0 || len(input.Project) > maxProjectBytes {
		http.Error(w, "invalid project aggregate", http.StatusBadRequest)
		return
	}
	var projectDocument map[string]any
	decoder := json.NewDecoder(bytes.NewReader(input.Project))
	if decoder.Decode(&projectDocument) != nil || ensureJSONEOF(decoder) != nil || validateProjectDocument(projectDocument) != nil {
		http.Error(w, "invalid project aggregate", http.StatusUnprocessableEntity)
		return
	}
	projectID, _ := projectDocument["id"].(string)
	pathID := chi.URLParam(r, "id")
	if !validProjectID(projectID) || pathID != "" && pathID != projectID {
		http.Error(w, "invalid project aggregate", http.StatusUnprocessableEntity)
		return
	}
	projectKind, _ := projectDocument["projectKind"].(string)
	if projectKind == "film" && input.Film == nil || projectKind != "film" && input.Film != nil {
		http.Error(w, "project and Film aggregate do not match", http.StatusUnprocessableEntity)
		return
	}
	tenantID := tenantIDFrom(r)
	project := store.WorkspaceProject{ID: projectID, Document: append([]byte(nil), input.Project...)}
	var film *store.WorkspaceFilm
	created := []string{}
	migrated := []string{}
	if input.Film != nil {
		if input.Film.Revision < 0 || validateFilmAggregate(input.Film.Document, projectID) != nil || validateFilmRestoreMediaMetadata(input.Film.Document, input.Film.Media) != nil {
			http.Error(w, "invalid Film aggregate or media metadata", http.StatusUnprocessableEntity)
			return
		}
		allowed := map[string]struct{}{}
		if filmBackend, ok := s.store.(store.FilmStore); ok {
			if current, err := filmBackend.GetFilmProject(r.Context(), tenantID, projectID); err == nil {
				var currentDocument filmDocument
				if json.Unmarshal(current.Document, &currentDocument) != nil {
					http.Error(w, "current Film aggregate is invalid", http.StatusInternalServerError)
					return
				}
				allowed = protectedFilmDocumentKeys(currentDocument)
			} else if !errors.Is(err, store.ErrNotFound) {
				http.Error(w, "current Film aggregate could not be read", http.StatusInternalServerError)
				return
			}
		}
		next, keys, migratedKeys, err := s.rehydrateRestoredFilmMedia(r.Context(), tenantID, userIDFrom(r), input.Film.Document, input.Film.Media, allowed)
		if err != nil {
			writeFilmOperationError(w, err)
			return
		}
		created, migrated = keys, migratedKeys
		raw, _ := json.Marshal(next)
		film = &store.WorkspaceFilm{ProjectID: projectID, Revision: input.Film.Revision, Document: raw}
	}
	cleanup := func() { s.cleanupRestoredFilmBlobs(r.Context(), tenantID, userIDFrom(r), projectID, created) }
	token, digest, err := newFilmRestoreToken()
	if err != nil {
		cleanup()
		http.Error(w, "failed to create project restore token", http.StatusInternalServerError)
		return
	}
	createdMedia := make([]store.WorkspaceMedia, 0, len(created))
	for _, key := range created {
		createdMedia = append(createdMedia, store.WorkspaceMedia{ProjectID: projectID, StorageKey: key})
	}
	result, err := backend.ReplaceWorkspaceProject(r.Context(), tenantID, projectID, input.ExpectedVersion, digest, time.Now().Add(filmRestoreTokenTTL), project, film, createdMedia)
	if errors.Is(err, store.ErrConflict) {
		cleanup()
		http.Error(w, "workspace changed; reload before replacing", http.StatusConflict)
		return
	}
	if err != nil {
		cleanup()
		http.Error(w, "project aggregate replacement failed", http.StatusInternalServerError)
		return
	}
	sort.Strings(migrated)
	w.Header().Set("ETag", `"`+result.Version+`"`)
	writeJSON(w, map[string]any{"data": map[string]any{"version": result.Version, "restoreToken": token, "migratedStorageKeys": migrated}})
}

func (s *Server) rollbackWorkspace(w http.ResponseWriter, r *http.Request) {
	backend, ok := s.store.(store.WorkspaceStore)
	if !ok {
		http.Error(w, "transactional workspace rollback is unavailable", http.StatusServiceUnavailable)
		return
	}
	var input workspaceRollbackRequest
	if err := decodeFilmRequest(w, r, 4096, &input); err != nil {
		http.Error(w, "invalid workspace rollback request", http.StatusBadRequest)
		return
	}
	input.ExpectedVersion = normalizeWorkspaceVersion(input.ExpectedVersion)
	digest, err := filmRestoreTokenDigest(input.RestoreToken)
	if err != nil || !strings.HasPrefix(input.ExpectedVersion, "w1-") || len(input.ExpectedVersion) != 67 {
		http.Error(w, "invalid workspace rollback request", http.StatusBadRequest)
		return
	}
	result, err := backend.RollbackWorkspace(r.Context(), tenantIDFrom(r), input.ExpectedVersion, digest, time.Now())
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "workspace restore token not found", http.StatusNotFound)
		return
	}
	if errors.Is(err, store.ErrConflict) {
		http.Error(w, "workspace changed; rollback was not applied", http.StatusConflict)
		return
	}
	if err != nil {
		http.Error(w, "workspace rollback failed", http.StatusInternalServerError)
		return
	}
	cleanupPending := false
	for _, projectID := range result.CleanupProjectIDs {
		pending, cleanupErr := s.processFilmCleanupGenerations(r.Context(), tenantIDFrom(r), userIDFrom(r), projectID)
		if cleanupErr != nil || pending {
			cleanupPending = true
		}
	}
	w.Header().Set("ETag", `"`+result.Version+`"`)
	writeJSON(w, map[string]any{"data": map[string]any{"version": result.Version, "cleanupPending": cleanupPending}})
}
