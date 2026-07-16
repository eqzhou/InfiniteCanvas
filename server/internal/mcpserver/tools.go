package mcpserver

type toolDefinition struct {
	Name        string         `json:"name"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
}

func objectSchema(properties map[string]any, required ...string) map[string]any {
	return map[string]any{
		"type":                 "object",
		"properties":           properties,
		"required":             required,
		"additionalProperties": false,
	}
}

func projectIDProperty() map[string]any {
	return map[string]any{
		"type":        "string",
		"description": "OpenBoard project id",
		"pattern":     "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
	}
}

var boardTools = []toolDefinition{
	{
		Name:        "board.list_nodes",
		Title:       "List board nodes",
		Description: "List every node in a persisted OpenBoard project.",
		InputSchema: objectSchema(map[string]any{"projectId": projectIDProperty()}, "projectId"),
		Annotations: map[string]any{"readOnlyHint": true},
	},
	{
		Name:        "board.add_node",
		Title:       "Add board node",
		Description: "Add a fully specified node to a persisted OpenBoard project.",
		InputSchema: objectSchema(map[string]any{
			"projectId": projectIDProperty(),
			"node": map[string]any{
				"type":        "object",
				"description": "Board node with id, type, title, position, width, height, and metadata",
			},
		}, "projectId", "node"),
	},
	{
		Name:        "board.update_node",
		Title:       "Update board node",
		Description: "Merge a validated patch into an existing board node.",
		InputSchema: objectSchema(map[string]any{
			"projectId": projectIDProperty(),
			"id":        projectIDProperty(),
			"patch":     map[string]any{"type": "object"},
		}, "projectId", "id", "patch"),
	},
	{
		Name:        "board.delete_nodes",
		Title:       "Delete board nodes",
		Description: "Delete board nodes and all edges connected to them.",
		InputSchema: objectSchema(map[string]any{
			"projectId": projectIDProperty(),
			"ids": map[string]any{
				"type":     "array",
				"minItems": 1,
				"maxItems": 1000,
				"items":    projectIDProperty(),
			},
		}, "projectId", "ids"),
		Annotations: map[string]any{"destructiveHint": true},
	},
	{
		Name:        "board.connect",
		Title:       "Connect board nodes",
		Description: "Create a directed edge between two existing board nodes.",
		InputSchema: objectSchema(map[string]any{
			"projectId": projectIDProperty(),
			"id":        projectIDProperty(),
			"from":      projectIDProperty(),
			"to":        projectIDProperty(),
		}, "projectId", "id", "from", "to"),
	},
	{
		Name:        "board.export_json",
		Title:       "Read board document",
		Description: "Return the complete persisted OpenBoard project document.",
		InputSchema: objectSchema(map[string]any{"projectId": projectIDProperty()}, "projectId"),
		Annotations: map[string]any{"readOnlyHint": true},
	},
}

func knownTool(name string) bool {
	for _, tool := range boardTools {
		if tool.Name == name {
			return true
		}
	}
	return false
}
