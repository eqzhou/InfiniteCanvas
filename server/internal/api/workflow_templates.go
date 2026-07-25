package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const workflowTemplateStateKey = "workflow-templates"
const maxWorkflowTemplateDocumentBytes = 8 << 20

type workflowTemplateDocument struct {
	Version   int                `json:"version"`
	Templates []workflowTemplate `json:"templates"`
}

func (s *Server) loadWorkflowTemplates(r *http.Request) ([]workflowTemplate, error) {
	templates, _, err := s.loadWorkflowTemplateSnapshot(r)
	return templates, err
}

func (s *Server) loadWorkflowTemplateSnapshot(r *http.Request) ([]workflowTemplate, []byte, error) {
	value, err := s.store.GetState(r.Context(), tenantIDFrom(r), workflowTemplateStateKey)
	if errors.Is(err, store.ErrNotFound) {
		return []workflowTemplate{}, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var document workflowTemplateDocument
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || ensureJSONEOF(decoder) != nil || document.Version != 1 ||
		document.Templates == nil || len(document.Templates) > maxWorkflowTemplates {
		return nil, nil, errors.New("invalid stored workflow templates")
	}
	ids := map[string]struct{}{}
	for _, template := range document.Templates {
		if validateWorkflowTemplate(template) != nil || template.Scope != "personal" {
			return nil, nil, errors.New("invalid stored workflow template")
		}
		if _, exists := ids[template.ID]; exists {
			return nil, nil, errors.New("duplicate stored workflow template")
		}
		ids[template.ID] = struct{}{}
	}
	return document.Templates, append([]byte(nil), value...), nil
}

func (s *Server) persistWorkflowTemplatesCAS(r *http.Request, expected []byte, templates []workflowTemplate) error {
	value, err := json.Marshal(workflowTemplateDocument{Version: 1, Templates: templates})
	if err != nil {
		return err
	}
	return s.store.CompareAndSwapState(r.Context(), tenantIDFrom(r), workflowTemplateStateKey, expected, value)
}

func (s *Server) listWorkflowTemplates(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "workflow templates require persistent storage", http.StatusServiceUnavailable)
		return
	}
	templates, err := s.loadWorkflowTemplates(r)
	if err != nil {
		http.Error(w, "failed to read workflow templates", http.StatusInternalServerError)
		return
	}
	writeJSON(w, templates)
}

func decodeWorkflowTemplateRequest(w http.ResponseWriter, r *http.Request) (workflowTemplate, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkflowTemplateBytes)
	var raw json.RawMessage
	decoder := json.NewDecoder(r.Body)
	if decoder.Decode(&raw) != nil || ensureJSONEOF(decoder) != nil {
		return workflowTemplate{}, errors.New("invalid workflow template")
	}
	return decodeWorkflowTemplate(raw)
}

func (s *Server) putWorkflowTemplate(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "workflow templates require persistent storage", http.StatusServiceUnavailable)
		return
	}
	template, err := decodeWorkflowTemplateRequest(w, r)
	id := chi.URLParam(r, "id")
	if err != nil || template.ID != id || template.Scope != "personal" {
		http.Error(w, "invalid personal workflow template", http.StatusBadRequest)
		return
	}
	for attempt := 0; attempt < 5; attempt++ {
		templates, expected, err := s.loadWorkflowTemplateSnapshot(r)
		if err != nil {
			http.Error(w, "failed to read workflow templates", http.StatusInternalServerError)
			return
		}
		nextTemplate := template
		found := false
		for index := range templates {
			if templates[index].ID == id {
				nextTemplate.Revision = templates[index].Revision + 1
				templates[index] = nextTemplate
				found = true
				break
			}
		}
		if !found {
			nextTemplate.Revision = 1
			templates = append(templates, nextTemplate)
		}
		if err := s.persistWorkflowTemplatesCAS(r, expected, templates); errors.Is(err, store.ErrConflict) {
			continue
		} else if err != nil {
			http.Error(w, "failed to store workflow template", http.StatusInternalServerError)
			return
		}
		writeJSON(w, nextTemplate)
		return
	}
	http.Error(w, "workflow template was modified concurrently", http.StatusConflict)
}

func (s *Server) replaceWorkflowTemplates(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "workflow templates require persistent storage", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkflowTemplateDocumentBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var document workflowTemplateDocument
	if decoder.Decode(&document) != nil || ensureJSONEOF(decoder) != nil || document.Version != 1 ||
		document.Templates == nil || len(document.Templates) > maxWorkflowTemplates {
		http.Error(w, "invalid workflow template document", http.StatusBadRequest)
		return
	}
	ids := map[string]struct{}{}
	for _, template := range document.Templates {
		if validateWorkflowTemplate(template) != nil || template.Scope != "personal" {
			http.Error(w, "invalid personal workflow template", http.StatusBadRequest)
			return
		}
		if _, exists := ids[template.ID]; exists {
			http.Error(w, "duplicate workflow template id", http.StatusBadRequest)
			return
		}
		ids[template.ID] = struct{}{}
	}
	_, expected, err := s.loadWorkflowTemplateSnapshot(r)
	if err != nil {
		http.Error(w, "failed to read workflow templates", http.StatusInternalServerError)
		return
	}
	if err := s.persistWorkflowTemplatesCAS(r, expected, document.Templates); errors.Is(err, store.ErrConflict) {
		http.Error(w, "workflow templates were modified concurrently", http.StatusConflict)
		return
	} else if err != nil {
		http.Error(w, "failed to store workflow templates", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteWorkflowTemplate(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		http.Error(w, "workflow templates require persistent storage", http.StatusServiceUnavailable)
		return
	}
	id := chi.URLParam(r, "id")
	if !workflowIDPattern.MatchString(id) {
		http.Error(w, "invalid workflow template id", http.StatusBadRequest)
		return
	}
	for attempt := 0; attempt < 5; attempt++ {
		templates, expected, err := s.loadWorkflowTemplateSnapshot(r)
		if err != nil {
			http.Error(w, "failed to read workflow templates", http.StatusInternalServerError)
			return
		}
		next := make([]workflowTemplate, 0, len(templates))
		found := false
		for _, template := range templates {
			if template.ID == id {
				found = true
				continue
			}
			next = append(next, template)
		}
		if !found {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err := s.persistWorkflowTemplatesCAS(r, expected, next); errors.Is(err, store.ErrConflict) {
			continue
		} else if err != nil {
			http.Error(w, "failed to delete workflow template", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Error(w, "workflow template was modified concurrently", http.StatusConflict)
}
