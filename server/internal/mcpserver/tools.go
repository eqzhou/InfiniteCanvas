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
		Name:        "board.get_state",
		Title:       "Get live board state",
		Description: "Return the active browser route, project, selection, and viewport.",
		InputSchema: objectSchema(map[string]any{}),
		Annotations: map[string]any{"readOnlyHint": true},
	},
	{
		Name:        "board.get_selection",
		Title:       "Get live selection",
		Description: "Return selected node ids and complete selected nodes from the browser.",
		InputSchema: objectSchema(map[string]any{}),
		Annotations: map[string]any{"readOnlyHint": true},
	},
	{
		Name:        "board.export_snapshot",
		Title:       "Export board PNG",
		Description: "Render the visible browser canvas to PNG and return a protected local URL.",
		InputSchema: objectSchema(map[string]any{}),
		Annotations: map[string]any{"readOnlyHint": true},
	},
	{
		Name:        "board.apply_ops",
		Title:       "Apply atomic board operations",
		Description: "Validate a complete operation batch in the browser and commit it atomically.",
		InputSchema: objectSchema(map[string]any{
			"operations": map[string]any{
				"type": "array", "minItems": 1, "maxItems": 1000,
				"items": map[string]any{"type": "object"},
			},
		}, "operations"),
	},
	{
		Name:        "board.create_text_node",
		Title:       "Create text node",
		Description: "Create and select a text node in the active browser canvas.",
		InputSchema: objectSchema(map[string]any{
			"id":      map[string]any{"type": "string"},
			"title":   map[string]any{"type": "string", "maxLength": 500},
			"content": map[string]any{"type": "string", "maxLength": 512000},
			"x":       map[string]any{"type": "number"},
			"y":       map[string]any{"type": "number"},
		}, "content"),
	},
	{
		Name:        "board.create_image_prompt_flow",
		Title:       "Create image prompt flow",
		Description: "Create a configuration node, execute image generation, and connect the results.",
		InputSchema: objectSchema(map[string]any{
			"prompt": map[string]any{"type": "string", "maxLength": 32000},
			"model":  map[string]any{"type": "string", "maxLength": 200},
			"size":   map[string]any{"type": "string", "maxLength": 50},
			"count":  map[string]any{"type": "integer", "minimum": 1, "maximum": 8},
			"x":      map[string]any{"type": "number"},
			"y":      map[string]any{"type": "number"},
		}, "prompt"),
	},
	{
		Name:        "asset.search",
		Title:       "Search assets",
		Description: "Search the OpenBoard asset library in the connected browser.",
		InputSchema: objectSchema(map[string]any{"query": map[string]any{"type": "string", "maxLength": 200}}),
		Annotations: map[string]any{"readOnlyHint": true},
	},
	{
		Name:        "asset.insert",
		Title:       "Insert asset",
		Description: "Insert an asset into the active browser canvas.",
		InputSchema: objectSchema(map[string]any{
			"id": projectIDProperty(), "x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"},
		}, "id"),
	},
	{
		Name:        "prompt.search",
		Title:       "Search prompts",
		Description: "Search the OpenBoard prompt library in the connected browser.",
		InputSchema: objectSchema(map[string]any{"query": map[string]any{"type": "string", "maxLength": 200}}),
		Annotations: map[string]any{"readOnlyHint": true},
	},
	{
		Name:        "prompt.insert",
		Title:       "Insert prompt",
		Description: "Insert a prompt as a text node in the active browser canvas.",
		InputSchema: objectSchema(map[string]any{
			"id": projectIDProperty(), "x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"},
		}, "id"),
	},
	{
		Name:        "site.navigate",
		Title:       "Navigate OpenBoard",
		Description: "Navigate the connected OpenBoard browser to an allowed application route.",
		InputSchema: objectSchema(map[string]any{"path": map[string]any{"type": "string", "maxLength": 200}}, "path"),
	},
	{
		Name:        "generation_get_status",
		Title:       "Get generation task status",
		Description: "Query unified canvas node or image/video workbench generation status in the bound browser tab.",
		InputSchema: objectSchema(map[string]any{
			"taskId": projectIDProperty(),
			"nodeIds": map[string]any{
				"type": "array", "minItems": 1, "maxItems": 100,
				"items": projectIDProperty(), "uniqueItems": true,
			},
		}),
		Annotations: map[string]any{"readOnlyHint": true},
	},
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
	{
		Name:        "film.status",
		Title:       "Get film production status",
		Description: "Return a tenant-scoped film production, stages, tasks, and capability status.",
		InputSchema: objectSchema(map[string]any{"projectId": projectIDProperty()}, "projectId"),
		Annotations: map[string]any{"readOnlyHint": true},
	},
	{
		Name:        "film.list",
		Title:       "List film production entities",
		Description: "List episodes, shots, assets, stages, tasks, or deliverables in a film production.",
		InputSchema: objectSchema(map[string]any{
			"projectId": projectIDProperty(),
			"resource":  map[string]any{"type": "string", "enum": []string{"episodes", "scenes", "shots", "assets", "stages", "tasks", "deliverables"}},
		}, "projectId", "resource"),
		Annotations: map[string]any{"readOnlyHint": true},
	},
	{
		Name:        "film.check",
		Title:       "Check film production",
		Description: "Run deterministic quality checks and return unapproved repair proposals without persisting them.",
		InputSchema: objectSchema(map[string]any{"projectId": projectIDProperty()}, "projectId"),
		Annotations: map[string]any{"readOnlyHint": true},
	},
	{
		Name:        "film.proposals",
		Title:       "List film repair proposals",
		Description: "List persisted quality reports and repair proposal state without approving or applying changes.",
		InputSchema: objectSchema(map[string]any{"projectId": projectIDProperty()}, "projectId"),
		Annotations: map[string]any{"readOnlyHint": true},
	},
	{
		Name:        "film.validate",
		Title:       "Validate film production",
		Description: "Run quality validation and persist non-destructive repair proposals.",
		InputSchema: objectSchema(map[string]any{"projectId": projectIDProperty()}, "projectId"),
	},
	{
		Name:        "film.run_stage",
		Title:       "Run film stage",
		Description: "Run a dependency-checked film stage at its exact optimistic revision. Generation stages require providerId, model, config, and idempotencyKey.",
		InputSchema: objectSchema(map[string]any{
			"projectId":  projectIDProperty(),
			"stage":      map[string]any{"type": "string", "enum": []string{"decompose", "script", "storyboard", "audio", "video", "compose", "delivery"}},
			"revision":   map[string]any{"type": "integer", "minimum": 1},
			"shotIds":    map[string]any{"type": "array", "items": projectIDProperty(), "maxItems": 1000, "uniqueItems": true},
			"providerId": projectIDProperty(),
			"model":      map[string]any{"type": "string", "maxLength": 500},
			"config": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{
				"size": map[string]any{"type": "string"}, "quality": map[string]any{"type": "string"},
				"ratio": map[string]any{"type": "string"}, "resolution": map[string]any{"type": "string"},
				"seconds": map[string]any{"type": "integer"}, "generateAudio": map[string]any{"type": "boolean"},
				"watermark": map[string]any{"type": "boolean"}, "negativePrompt": map[string]any{"type": "string"},
				"referenceStorageKeys": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": 16},
				"voice":                map[string]any{"type": "string"}, "format": map[string]any{"type": "string"},
				"speed": map[string]any{"type": "number"}, "instructions": map[string]any{"type": "string"},
			}},
			"idempotencyKey": map[string]any{"type": "string", "minLength": 1, "maxLength": 128},
		}, "projectId", "stage", "revision"),
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
