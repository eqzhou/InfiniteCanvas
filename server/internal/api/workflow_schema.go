package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	maxWorkflowTemplateBytes = 256 << 10
	maxWorkflowTemplates     = 1000
)

var workflowIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var workflowPlaceholderPattern = regexp.MustCompile(`\{\{([A-Za-z0-9][A-Za-z0-9_-]{0,127})\}\}`)

type workflowVariable struct {
	ID       string          `json:"id"`
	Kind     string          `json:"kind"`
	Label    string          `json:"label"`
	Required bool            `json:"required"`
	Options  []string        `json:"options,omitempty"`
	Default  json.RawMessage `json:"default,omitempty"`
	Min      *float64        `json:"min,omitempty"`
	Max      *float64        `json:"max,omitempty"`
}

type workflowStepReference struct {
	Source     string          `json:"source"`
	VariableID string          `json:"variableId,omitempty"`
	StepID     string          `json:"stepId,omitempty"`
	Output     json.RawMessage `json:"output,omitempty"`
}

type workflowStepParameters struct {
	Size                  string `json:"size"`
	Quality               string `json:"quality,omitempty"`
	Count                 int    `json:"count"`
	TransparentBackground bool   `json:"transparentBackground,omitempty"`
}

type workflowStep struct {
	ID             string                  `json:"id"`
	Title          string                  `json:"title"`
	PromptTemplate string                  `json:"promptTemplate"`
	ProviderID     string                  `json:"providerId"`
	Model          string                  `json:"model,omitempty"`
	Parameters     workflowStepParameters  `json:"parameters"`
	References     []workflowStepReference `json:"references"`
}

type workflowTemplate struct {
	SchemaVersion int                `json:"schemaVersion"`
	ID            string             `json:"id"`
	Revision      int                `json:"revision"`
	Scope         string             `json:"scope"`
	Title         string             `json:"title"`
	Description   string             `json:"description"`
	Category      string             `json:"category"`
	Variables     []workflowVariable `json:"variables"`
	Steps         []workflowStep     `json:"steps"`
	CreatedAt     string             `json:"createdAt"`
	UpdatedAt     string             `json:"updatedAt"`
}

type workflowRunParameters struct {
	Executor         string                     `json:"executor"`
	BillingUserID    string                     `json:"billingUserId,omitempty"`
	RequestHash      string                     `json:"requestHash"`
	TemplateID       string                     `json:"templateId"`
	TemplateRevision int                        `json:"templateRevision"`
	TemplateSnapshot workflowTemplate           `json:"templateSnapshot"`
	Values           map[string]json.RawMessage `json:"values"`
}

type workflowStepRunState struct {
	Status      string   `json:"status"`
	ChildJobID  string   `json:"childJobId,omitempty"`
	StorageKeys []string `json:"storageKeys,omitempty"`
	Error       string   `json:"error,omitempty"`
}

type workflowRunResult struct {
	Steps             map[string]workflowStepRunState `json:"steps"`
	OutputStorageKeys []string                        `json:"outputStorageKeys"`
}

func decodeWorkflowTemplate(value []byte) (workflowTemplate, error) {
	if len(value) == 0 || len(value) > maxWorkflowTemplateBytes {
		return workflowTemplate{}, errors.New("workflow template exceeds size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	var template workflowTemplate
	if err := decoder.Decode(&template); err != nil || ensureJSONEOF(decoder) != nil {
		return workflowTemplate{}, errors.New("invalid workflow template json")
	}
	if err := validateWorkflowTemplate(template); err != nil {
		return workflowTemplate{}, err
	}
	return template, nil
}

func validateWorkflowTemplate(template workflowTemplate) error {
	if template.SchemaVersion != 1 || !workflowIDPattern.MatchString(template.ID) || template.Revision < 1 ||
		(template.Scope != "personal" && template.Scope != "public") || strings.TrimSpace(template.Title) == "" ||
		len(template.Title) > 500 || len(template.Description) > 10_000 || len(template.Category) > 200 ||
		len(template.Variables) > 32 || len(template.Steps) < 1 || len(template.Steps) > 16 {
		return errors.New("invalid workflow template fields")
	}
	if _, err := time.Parse(time.RFC3339Nano, template.CreatedAt); err != nil {
		return errors.New("invalid workflow template createdAt")
	}
	if _, err := time.Parse(time.RFC3339Nano, template.UpdatedAt); err != nil {
		return errors.New("invalid workflow template updatedAt")
	}
	variables := make(map[string]workflowVariable, len(template.Variables))
	for _, variable := range template.Variables {
		if err := validateWorkflowVariable(variable); err != nil {
			return err
		}
		if _, exists := variables[variable.ID]; exists {
			return errors.New("duplicate workflow variable id")
		}
		variables[variable.ID] = variable
	}
	steps := make(map[string]workflowStep, len(template.Steps))
	totalResults := 0
	for _, step := range template.Steps {
		if !workflowIDPattern.MatchString(step.ID) || strings.TrimSpace(step.Title) == "" || len(step.Title) > 500 ||
			strings.TrimSpace(step.PromptTemplate) == "" || len(step.PromptTemplate) > 100_000 ||
			len(step.ProviderID) > 128 || len(step.Model) > 500 || !imageSizePattern.MatchString(step.Parameters.Size) ||
			len(step.Parameters.Quality) > 50 || step.Parameters.Count < 1 || step.Parameters.Count > maxImageGenerationCount || len(step.References) > 16 {
			return errors.New("invalid workflow step")
		}
		if _, exists := steps[step.ID]; exists {
			return errors.New("duplicate workflow step id")
		}
		steps[step.ID] = step
		totalResults += step.Parameters.Count
	}
	if totalResults > maxImageGenerationCount*16 {
		return errors.New("workflow result count exceeds limit")
	}
	for _, step := range template.Steps {
		if err := validateWorkflowPrompt(step.PromptTemplate, variables); err != nil {
			return err
		}
		for _, reference := range step.References {
			switch reference.Source {
			case "variable":
				variable, ok := variables[reference.VariableID]
				if !ok || variable.Kind != "image" || reference.StepID != "" || len(reference.Output) != 0 {
					return errors.New("invalid workflow variable reference")
				}
			case "step":
				source, ok := steps[reference.StepID]
				if !ok || reference.StepID == step.ID || reference.VariableID != "" ||
					!validWorkflowOutput(reference.Output, source.Parameters.Count) {
					return errors.New("invalid workflow step reference")
				}
			default:
				return errors.New("invalid workflow reference source")
			}
		}
	}
	if _, err := workflowTopologicalOrder(template); err != nil {
		return err
	}
	return nil
}

func validateWorkflowVariable(variable workflowVariable) error {
	if !workflowIDPattern.MatchString(variable.ID) || strings.TrimSpace(variable.Label) == "" || len(variable.Label) > 500 {
		return errors.New("invalid workflow variable")
	}
	switch variable.Kind {
	case "text", "textarea":
		if len(variable.Options) != 0 || variable.Min != nil || variable.Max != nil || !validOptionalJSONType(variable.Default, "string") {
			return errors.New("invalid workflow text variable")
		}
	case "select":
		if len(variable.Options) < 1 || len(variable.Options) > 100 || variable.Min != nil || variable.Max != nil {
			return errors.New("invalid workflow select variable")
		}
		seen := map[string]struct{}{}
		for _, option := range variable.Options {
			if option == "" || len(option) > 500 {
				return errors.New("invalid workflow select option")
			}
			seen[option] = struct{}{}
		}
		if len(seen) != len(variable.Options) || !validOptionalJSONType(variable.Default, "string") {
			return errors.New("invalid workflow select default")
		}
	case "number":
		if variable.Min == nil || variable.Max == nil || *variable.Min > *variable.Max || len(variable.Options) != 0 || !validOptionalJSONType(variable.Default, "number") {
			return errors.New("invalid workflow number variable")
		}
	case "boolean":
		if variable.Required || len(variable.Options) != 0 || variable.Min != nil || variable.Max != nil || !validRequiredJSONType(variable.Default, "bool") {
			return errors.New("invalid workflow boolean variable")
		}
	case "image":
		if len(variable.Default) != 0 || len(variable.Options) != 0 || variable.Min != nil || variable.Max != nil {
			return errors.New("invalid workflow image variable")
		}
	default:
		return errors.New("invalid workflow variable kind")
	}
	return nil
}

func validOptionalJSONType(value json.RawMessage, kind string) bool {
	return len(value) == 0 || validRequiredJSONType(value, kind)
}

func validRequiredJSONType(value json.RawMessage, kind string) bool {
	if len(value) == 0 {
		return false
	}
	var decoded any
	if json.Unmarshal(value, &decoded) != nil {
		return false
	}
	switch kind {
	case "string":
		_, ok := decoded.(string)
		return ok
	case "number":
		_, ok := decoded.(float64)
		return ok
	case "bool":
		_, ok := decoded.(bool)
		return ok
	}
	return false
}

func validateWorkflowPrompt(prompt string, variables map[string]workflowVariable) error {
	for _, match := range workflowPlaceholderPattern.FindAllStringSubmatch(prompt, -1) {
		variable, ok := variables[match[1]]
		if !ok || variable.Kind == "image" {
			return errors.New("invalid workflow prompt placeholder")
		}
	}
	remainder := workflowPlaceholderPattern.ReplaceAllString(prompt, "")
	if strings.Contains(remainder, "{{") || strings.Contains(remainder, "}}") {
		return errors.New("unsafe workflow prompt placeholder")
	}
	return nil
}

func validWorkflowOutput(value json.RawMessage, sourceCount int) bool {
	var label string
	if json.Unmarshal(value, &label) == nil {
		return label == "all"
	}
	var index int
	return json.Unmarshal(value, &index) == nil && index >= 0 && index < sourceCount
}

func workflowTopologicalOrder(template workflowTemplate) ([]string, error) {
	dependencies := make(map[string]map[string]struct{}, len(template.Steps))
	for _, step := range template.Steps {
		dependencies[step.ID] = map[string]struct{}{}
		for _, reference := range step.References {
			if reference.Source == "step" {
				dependencies[step.ID][reference.StepID] = struct{}{}
			}
		}
	}
	order := make([]string, 0, len(template.Steps))
	resolved := map[string]struct{}{}
	for len(order) < len(template.Steps) {
		progress := false
		for _, step := range template.Steps {
			if _, ok := resolved[step.ID]; ok {
				continue
			}
			ready := true
			for dependency := range dependencies[step.ID] {
				if _, ok := resolved[dependency]; !ok {
					ready = false
					break
				}
			}
			if ready {
				resolved[step.ID] = struct{}{}
				order = append(order, step.ID)
				progress = true
			}
		}
		if !progress {
			return nil, errors.New("workflow contains a cycle")
		}
	}
	return order, nil
}

func workflowTemplateBytes(template workflowTemplate) []byte {
	value, err := json.Marshal(template)
	if err != nil {
		panic(fmt.Sprintf("marshal validated workflow template: %v", err))
	}
	return value
}

func normalizeWorkflowValues(template workflowTemplate, input map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	variables := make(map[string]workflowVariable, len(template.Variables))
	for _, variable := range template.Variables {
		variables[variable.ID] = variable
	}
	for id := range input {
		if _, ok := variables[id]; !ok {
			return nil, fmt.Errorf("unknown workflow value %s", id)
		}
	}
	normalized := make(map[string]json.RawMessage, len(template.Variables))
	for _, variable := range template.Variables {
		value := input[variable.ID]
		if len(value) == 0 && len(variable.Default) != 0 {
			value = variable.Default
		}
		switch variable.Kind {
		case "text", "textarea":
			var text string
			if json.Unmarshal(value, &text) != nil || len(text) > 20_000 || (variable.Required && strings.TrimSpace(text) == "") {
				return nil, fmt.Errorf("invalid workflow value %s", variable.ID)
			}
		case "select":
			var selected string
			if json.Unmarshal(value, &selected) != nil {
				return nil, fmt.Errorf("invalid workflow value %s", variable.ID)
			}
			found := false
			for _, option := range variable.Options {
				found = found || selected == option
			}
			if !found {
				return nil, fmt.Errorf("invalid workflow value %s", variable.ID)
			}
		case "number":
			var number float64
			if json.Unmarshal(value, &number) != nil || variable.Min == nil || variable.Max == nil || number < *variable.Min || number > *variable.Max {
				return nil, fmt.Errorf("invalid workflow value %s", variable.ID)
			}
		case "boolean":
			var boolean bool
			if json.Unmarshal(value, &boolean) != nil {
				return nil, fmt.Errorf("invalid workflow value %s", variable.ID)
			}
		case "image":
			var keys []string
			if json.Unmarshal(value, &keys) != nil || len(keys) > 16 || (variable.Required && len(keys) == 0) {
				return nil, fmt.Errorf("invalid workflow value %s", variable.ID)
			}
			seen := map[string]struct{}{}
			for _, key := range keys {
				if _, ok := blobFilename(key); !ok {
					return nil, fmt.Errorf("invalid workflow image value %s", variable.ID)
				}
				seen[key] = struct{}{}
			}
			if len(seen) != len(keys) {
				return nil, fmt.Errorf("duplicate workflow image value %s", variable.ID)
			}
		}
		normalized[variable.ID] = append(json.RawMessage(nil), value...)
	}
	return normalized, nil
}

func initialWorkflowRunResult(template workflowTemplate) workflowRunResult {
	steps := make(map[string]workflowStepRunState, len(template.Steps))
	for _, step := range template.Steps {
		steps[step.ID] = workflowStepRunState{Status: "pending"}
	}
	return workflowRunResult{Steps: steps, OutputStorageKeys: []string{}}
}

func compileServerWorkflowPrompt(step workflowStep, values map[string]json.RawMessage) (string, error) {
	var compileErr error
	compiled := workflowPlaceholderPattern.ReplaceAllStringFunc(step.PromptTemplate, func(match string) string {
		parts := workflowPlaceholderPattern.FindStringSubmatch(match)
		var value any
		if len(parts) != 2 || json.Unmarshal(values[parts[1]], &value) != nil {
			compileErr = errors.New("unresolved workflow placeholder")
			return ""
		}
		switch typed := value.(type) {
		case string:
			return typed
		case float64, bool:
			return fmt.Sprint(typed)
		default:
			compileErr = errors.New("invalid workflow placeholder value")
			return ""
		}
	})
	if compileErr != nil || strings.Contains(compiled, "{{") || strings.Contains(compiled, "}}") || len(compiled) > 100_000 {
		return "", errors.New("failed to compile workflow prompt")
	}
	return compiled, nil
}

func workflowStepReferenceKeys(step workflowStep, values map[string]json.RawMessage, result workflowRunResult) ([]string, error) {
	keys := make([]string, 0, 16)
	seen := map[string]struct{}{}
	appendKey := func(key string) {
		if _, exists := seen[key]; !exists {
			seen[key] = struct{}{}
			keys = append(keys, key)
		}
	}
	for _, reference := range step.References {
		if reference.Source == "variable" {
			var valuesForVariable []string
			if json.Unmarshal(values[reference.VariableID], &valuesForVariable) != nil {
				return nil, errors.New("invalid workflow image reference")
			}
			for _, key := range valuesForVariable {
				appendKey(key)
			}
			continue
		}
		outputs := result.Steps[reference.StepID].StorageKeys
		var all string
		if json.Unmarshal(reference.Output, &all) == nil && all == "all" {
			for _, key := range outputs {
				appendKey(key)
			}
			continue
		}
		var index int
		if json.Unmarshal(reference.Output, &index) != nil || index < 0 || index >= len(outputs) {
			return nil, errors.New("workflow step output is unavailable")
		}
		appendKey(outputs[index])
	}
	if len(keys) > 16 {
		return nil, errors.New("workflow step references exceed limit")
	}
	return keys, nil
}

func finalizeServerWorkflowResult(template workflowTemplate, result workflowRunResult) (string, workflowRunResult) {
	for _, step := range template.Steps {
		state := result.Steps[step.ID]
		if state.Status != "pending" {
			continue
		}
		for _, reference := range step.References {
			if reference.Source != "step" {
				continue
			}
			dependency := result.Steps[reference.StepID].Status
			if dependency == "failed" || dependency == "cancelled" || dependency == "skipped" {
				result.Steps[step.ID] = workflowStepRunState{Status: "skipped"}
				break
			}
		}
	}
	allTerminal := true
	hasFailure := false
	hasSuccess := false
	allCancelledOrSkipped := true
	for _, step := range template.Steps {
		status := result.Steps[step.ID].Status
		hasFailure = hasFailure || status == "failed"
		hasSuccess = hasSuccess || status == "succeeded"
		allCancelledOrSkipped = allCancelledOrSkipped && (status == "cancelled" || status == "skipped")
		allTerminal = allTerminal && (status == "succeeded" || status == "failed" || status == "cancelled" || status == "skipped")
	}
	if hasFailure {
		return "failed", result
	}
	if allTerminal && allCancelledOrSkipped && !hasSuccess {
		return "cancelled", result
	}
	if !allTerminal {
		return "running", result
	}
	dependedOn := map[string]struct{}{}
	for _, step := range template.Steps {
		for _, reference := range step.References {
			if reference.Source == "step" {
				dependedOn[reference.StepID] = struct{}{}
			}
		}
	}
	result.OutputStorageKeys = []string{}
	for _, step := range template.Steps {
		if _, exists := dependedOn[step.ID]; !exists {
			result.OutputStorageKeys = append(result.OutputStorageKeys, result.Steps[step.ID].StorageKeys...)
		}
	}
	return "succeeded", result
}
