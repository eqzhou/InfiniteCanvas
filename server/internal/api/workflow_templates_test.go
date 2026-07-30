package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

const validPersonalWorkflowTemplate = `{
  "schemaVersion":1,
  "id":"personal_story",
  "revision":1,
  "scope":"personal",
  "title":"角色故事",
  "description":"两步系列图",
  "category":"系列图",
  "variables":[{"id":"subject","kind":"textarea","label":"主体","required":true}],
  "steps":[
    {"id":"base","title":"主图","promptTemplate":"{{subject}} 主图","providerId":"","parameters":{"size":"1024x1024","count":1},"references":[]},
    {"id":"scene","title":"场景","promptTemplate":"{{subject}} 场景","providerId":"","parameters":{"size":"1024x1024","count":1},"references":[{"source":"step","stepId":"base","output":0}]}
  ],
  "createdAt":"2026-07-24T00:00:00Z",
  "updatedAt":"2026-07-24T00:00:00Z"
}`

func TestWorkflowTemplateCRUDAndBulkReplace(t *testing.T) {
	handler := persistentHandler(t)
	created := request(t, handler, http.MethodPut, "/api/workflow-templates/personal_story", []byte(validPersonalWorkflowTemplate))
	if created.Code != http.StatusOK || !bytes.Contains(created.Body.Bytes(), []byte(`"id": "personal_story"`)) {
		t.Fatalf("save template: %d %s", created.Code, created.Body.String())
	}
	listed := request(t, handler, http.MethodGet, "/api/workflow-templates", nil)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte(`"title": "角色故事"`)) {
		t.Fatalf("list templates: %d %s", listed.Code, listed.Body.String())
	}
	replaced := request(t, handler, http.MethodPut, "/api/workflow-templates", []byte(`{"version":1,"templates":[]}`))
	if replaced.Code != http.StatusNoContent {
		t.Fatalf("replace templates: %d %s", replaced.Code, replaced.Body.String())
	}
	listed = request(t, handler, http.MethodGet, "/api/workflow-templates", nil)
	if listed.Code != http.StatusOK || listed.Body.String() != "[]\n" {
		t.Fatalf("empty templates: %d %q", listed.Code, listed.Body.String())
	}
}

func TestWorkflowTemplateResponsePreservesOptionalRequiredFlag(t *testing.T) {
	handler := persistentHandler(t)
	template := bytes.Replace(
		[]byte(validPersonalWorkflowTemplate),
		[]byte(`"variables":[{"id":"subject","kind":"textarea","label":"主体","required":true}]`),
		[]byte(`"variables":[{"id":"reference","kind":"image","label":"参考图","required":false}]`),
		1,
	)
	template = bytes.Replace(template, []byte(`{{subject}} `), nil, -1)

	created := request(t, handler, http.MethodPut, "/api/workflow-templates/personal_story", template)
	if created.Code != http.StatusOK || !bytes.Contains(created.Body.Bytes(), []byte(`"required": false`)) {
		t.Fatalf("optional required flag was lost: %d %s", created.Code, created.Body.String())
	}
}

func TestWorkflowTemplateRejectsPublicScopeAndCyclesWithoutMutation(t *testing.T) {
	handler := persistentHandler(t)
	public := bytes.Replace([]byte(validPersonalWorkflowTemplate), []byte(`"scope":"personal"`), []byte(`"scope":"public"`), 1)
	if got := request(t, handler, http.MethodPut, "/api/workflow-templates/personal_story", public); got.Code != http.StatusBadRequest {
		t.Fatalf("public template status = %d %s", got.Code, got.Body.String())
	}
	cycle := bytes.Replace([]byte(validPersonalWorkflowTemplate), []byte(`"references":[]`), []byte(`"references":[{"source":"step","stepId":"scene","output":0}]`), 1)
	if got := request(t, handler, http.MethodPut, "/api/workflow-templates/personal_story", cycle); got.Code != http.StatusBadRequest {
		t.Fatalf("cycle template status = %d %s", got.Code, got.Body.String())
	}
	listed := request(t, handler, http.MethodGet, "/api/workflow-templates", nil)
	if listed.Code != http.StatusOK || listed.Body.String() != "[]\n" {
		t.Fatalf("invalid writes changed catalog: %d %q", listed.Code, listed.Body.String())
	}
}

func TestWorkflowTemplateEnforcesAggregateOutputsAndReferenceIndexes(t *testing.T) {
	var template workflowTemplate
	if err := json.Unmarshal([]byte(validPersonalWorkflowTemplate), &template); err != nil {
		t.Fatal(err)
	}
	template.Steps[1].References[0].Output = json.RawMessage(`1`)
	if err := validateWorkflowTemplate(template); err == nil {
		t.Fatal("reference outside the source step result count must fail")
	}
	template.Steps = nil
	for index := 0; index < 9; index++ {
		template.Steps = append(template.Steps, workflowStep{
			ID: "step_" + string(rune('a'+index)), Title: "Step", PromptTemplate: "render", ProviderID: "",
			Parameters: workflowStepParameters{Size: "1024x1024", Count: 8}, References: []workflowStepReference{},
		})
	}
	if err := validateWorkflowTemplate(template); err == nil {
		t.Fatal("workflow with more than 64 aggregate results must fail")
	}
}
