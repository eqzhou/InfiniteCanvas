package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const maxAgentRequestBytes = 32 << 20
const agentConfirmationTTL = 2 * time.Minute
const maxAgentConfirmations = 4096
const maxAgentConfirmationsPerScope = 64

type agentConfirmationRecord struct {
	Scope     agentScope
	Digest    string
	ExpiresAt time.Time
}

func highImpactFilmAgentTool(tool string) bool {
	switch tool {
	case "film.validate", "film.run_stage", "film.approve_stage", "film.waive_stage", "film.apply_repair", "film.export":
		return true
	default:
		return false
	}
}

func effectiveAgentScope(scope agentScope) agentScope {
	if scope.tenantID == "" {
		scope.tenantID = store.DefaultTenantID
	}
	if scope.userID == "" {
		scope.userID = "local-process"
	}
	return scope
}

func agentConfirmationDigest(tool string, arguments json.RawMessage) (string, error) {
	var values map[string]any
	decoder := json.NewDecoder(bytes.NewReader(arguments))
	decoder.UseNumber()
	if decoder.Decode(&values) != nil || ensureJSONEOF(decoder) != nil || values == nil {
		return "", errors.New("confirmation arguments are invalid")
	}
	delete(values, "confirmationToken")
	projectID, _ := values["projectId"].(string)
	projectID = strings.TrimSpace(projectID)
	if !validProjectID(projectID) {
		return "", errors.New("confirmation projectId is invalid")
	}
	canonical, err := json.Marshal(values)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(append([]byte(tool+"\x00"+projectID+"\x00"), canonical...))
	return hex.EncodeToString(hash[:]), nil
}

func (s *Server) issueAgentConfirmation(w http.ResponseWriter, r *http.Request) {
	user, authenticated := authUserFrom(r.Context())
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	_, trustedOrigin := s.runtimeOrigins[origin]
	if !authenticated || strings.TrimSpace(user.ID) == "" || !trustedOrigin ||
		!strings.EqualFold(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")), "same-origin") {
		writeToolError(w, http.StatusForbidden, "interactive user confirmation is required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request agentRequest
	if decoder.Decode(&request) != nil || ensureJSONEOF(decoder) != nil || !highImpactFilmAgentTool(request.Tool) {
		writeToolError(w, http.StatusBadRequest, "invalid confirmation request")
		return
	}
	digest, err := agentConfirmationDigest(request.Tool, request.Arguments)
	if err != nil {
		writeToolError(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now().UTC()
	expiresAt := now.Add(agentConfirmationTTL)
	scope := effectiveAgentScope(requestAgentScope(r))
	s.agentConfirmationMu.Lock()
	scopeCount := 0
	for existingToken, record := range s.agentConfirmations {
		if now.After(record.ExpiresAt) {
			delete(s.agentConfirmations, existingToken)
			continue
		}
		if record.Scope == scope {
			scopeCount++
		}
	}
	if len(s.agentConfirmations) >= maxAgentConfirmations || scopeCount >= maxAgentConfirmationsPerScope {
		s.agentConfirmationMu.Unlock()
		writeToolError(w, http.StatusTooManyRequests, "too many pending confirmations")
		return
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		s.agentConfirmationMu.Unlock()
		writeToolError(w, http.StatusInternalServerError, "failed to issue confirmation")
		return
	}
	token := hex.EncodeToString(random)
	s.agentConfirmations[token] = agentConfirmationRecord{Scope: scope, Digest: digest, ExpiresAt: expiresAt}
	s.agentConfirmationMu.Unlock()
	writeJSON(w, map[string]any{"token": token, "expiresAt": expiresAt.Format(time.RFC3339Nano)})
}

func (s *Server) consumeAgentConfirmation(scope agentScope, tool string, arguments json.RawMessage) error {
	if !highImpactFilmAgentTool(tool) {
		return nil
	}
	var values struct {
		Token string `json:"confirmationToken"`
	}
	if json.Unmarshal(arguments, &values) != nil || len(values.Token) != 64 {
		return badToolRequest("a valid one-time confirmation token is required")
	}
	digest, err := agentConfirmationDigest(tool, arguments)
	if err != nil {
		return badToolRequest(err.Error())
	}
	s.agentConfirmationMu.Lock()
	record, found := s.agentConfirmations[values.Token]
	if found {
		delete(s.agentConfirmations, values.Token)
	}
	s.agentConfirmationMu.Unlock()
	if !found || record.Scope != effectiveAgentScope(scope) || record.Digest != digest || time.Now().UTC().After(record.ExpiresAt) {
		return badToolRequest("a valid one-time confirmation token is required")
	}
	return nil
}

type agentRequest struct {
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
}

type projectArguments struct {
	ProjectID         string `json:"projectId"`
	ConfirmationToken string `json:"confirmationToken,omitempty"`
}

type addNodeArguments struct {
	ProjectID string         `json:"projectId"`
	Node      map[string]any `json:"node"`
}

type updateNodeArguments struct {
	ProjectID string         `json:"projectId"`
	ID        string         `json:"id"`
	Patch     map[string]any `json:"patch"`
}

type deleteNodesArguments struct {
	ProjectID string   `json:"projectId"`
	IDs       []string `json:"ids"`
}

type connectArguments struct {
	ProjectID string `json:"projectId"`
	ID        string `json:"id"`
	From      string `json:"from"`
	To        string `json:"to"`
}

type toolError struct {
	status  int
	message string
}

func (e *toolError) Error() string { return e.message }

func badToolRequest(message string) error {
	return &toolError{status: http.StatusBadRequest, message: message}
}

func (s *Server) executeAgentTool(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAgentRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request agentRequest
	if err := decoder.Decode(&request); err != nil || ensureJSONEOF(decoder) != nil {
		writeToolError(w, http.StatusBadRequest, "invalid agent request")
		return
	}
	if request.Tool == "" || len(request.Arguments) == 0 {
		writeToolError(w, http.StatusBadRequest, "tool and arguments are required")
		return
	}

	data, err := s.executeTool(r.Context(), requestAgentScope(r), request.Tool, request.Arguments)
	if err != nil {
		var typed *toolError
		if errors.As(err, &typed) {
			writeToolError(w, typed.status, typed.message)
			return
		}
		writeToolError(w, http.StatusInternalServerError, "agent tool failed")
		return
	}
	writeJSON(w, map[string]any{"ok": true, "data": data})
}

// ExecuteTool implements the MCP tool executor interface and runs tools under the
// default local tenant. HTTP callers should use executeTool with the request tenant.
func (s *Server) ExecuteTool(tool string, arguments json.RawMessage) (any, error) {
	return s.executeTool(context.Background(), agentScope{}, tool, arguments)
}

func (s *Server) executeTool(ctx context.Context, scope agentScope, tool string, arguments json.RawMessage) (any, error) {
	if isBrowserRuntimeTool(tool) {
		toolCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		result, err := s.runtime.command(toolCtx, scope, tool, arguments)
		if err != nil {
			return nil, err
		}
		var decoded any
		if err := json.Unmarshal(result, &decoded); err != nil {
			return nil, fmt.Errorf("decode browser runtime result: %w", err)
		}
		return decoded, nil
	}
	if err := s.consumeAgentConfirmation(scope, tool, arguments); err != nil {
		return nil, err
	}
	tenantID := scope.tenantID
	if tenantID == "" {
		tenantID = store.DefaultTenantID
	}
	if isReadOnlyServerTool(tool) {
		return s.runAgentTool(ctx, tenantID, tool, arguments)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	release, err := s.acquireWriteLock()
	if err != nil {
		return nil, err
	}
	defer release()
	return s.runAgentTool(ctx, tenantID, tool, arguments)
}

func isReadOnlyServerTool(tool string) bool {
	switch tool {
	case "board.list_nodes", "board.export_json", "film.status", "film.list", "film.check", "film.proposals", "film.next_steps":
		return true
	default:
		return false
	}
}

func isBrowserRuntimeTool(tool string) bool {
	switch tool {
	case "board.get_state", "board.get_selection", "board.export_snapshot", "board.apply_ops",
		"board.create_text_node", "board.create_image_prompt_flow", "asset.search", "asset.insert",
		"prompt.search", "prompt.insert", "site.navigate":
		return true
	case "generation_get_status":
		return true
	default:
		return false
	}
}

func (s *Server) runAgentTool(ctx context.Context, tenantID string, tool string, raw json.RawMessage) (any, error) {
	switch tool {
	case "film.status", "film.list", "film.check", "film.proposals", "film.next_steps", "film.validate", "film.run_stage", "film.approve_stage", "film.waive_stage", "film.apply_repair", "film.export":
		return s.runFilmAgentTool(ctx, tenantID, tool, raw)
	case "board.list_nodes":
		var args projectArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		project, err := s.loadProjectDocument(ctx, tenantID, args.ProjectID)
		if err != nil {
			return nil, err
		}
		return projectNodes(project), nil
	case "board.export_json":
		var args projectArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		return s.loadProjectDocument(ctx, tenantID, args.ProjectID)
	case "board.add_node":
		var args addNodeArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if err := validateNode(args.Node); err != nil {
			return nil, badToolRequest(err.Error())
		}
		project, err := s.loadProjectDocument(ctx, tenantID, args.ProjectID)
		if err != nil {
			return nil, err
		}
		nodes := projectNodes(project)
		id := args.Node["id"].(string)
		if findObjectByID(nodes, id) >= 0 {
			return nil, badToolRequest("node id already exists")
		}
		project["nodes"] = append(nodes, args.Node)
		if err := s.saveProjectDocument(ctx, tenantID, args.ProjectID, project); err != nil {
			return nil, err
		}
		return args.Node, nil
	case "board.update_node":
		var args updateNodeArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if !validProjectID(args.ID) || args.Patch == nil {
			return nil, badToolRequest("invalid node id or patch")
		}
		project, err := s.loadProjectDocument(ctx, tenantID, args.ProjectID)
		if err != nil {
			return nil, err
		}
		nodes := projectNodes(project)
		index := findObjectByID(nodes, args.ID)
		if index < 0 {
			return nil, &toolError{status: http.StatusNotFound, message: "node not found"}
		}
		updated := mergeNode(nodes[index], args.Patch)
		if updatedID, _ := updated["id"].(string); updatedID != args.ID {
			return nil, badToolRequest("node id cannot be changed")
		}
		if err := validateNode(updated); err != nil {
			return nil, badToolRequest(err.Error())
		}
		nextNodes := append([]map[string]any(nil), nodes...)
		nextNodes[index] = updated
		project["nodes"] = nextNodes
		if err := s.saveProjectDocument(ctx, tenantID, args.ProjectID, project); err != nil {
			return nil, err
		}
		return updated, nil
	case "board.delete_nodes":
		var args deleteNodesArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if len(args.IDs) == 0 || len(args.IDs) > 1_000 {
			return nil, badToolRequest("ids must contain between 1 and 1000 node ids")
		}
		deleted := make(map[string]struct{}, len(args.IDs))
		for _, id := range args.IDs {
			if !validProjectID(id) {
				return nil, badToolRequest("invalid node id")
			}
			deleted[id] = struct{}{}
		}
		project, err := s.loadProjectDocument(ctx, tenantID, args.ProjectID)
		if err != nil {
			return nil, err
		}
		remaining := deleteObjects(projectNodes(project), deleted)
		remaining = pruneDeletedNodeReferences(remaining, deleted)
		project["nodes"] = remaining
		project["edges"] = deleteConnectedEdges(projectEdges(project), deleted)
		if err := s.saveProjectDocument(ctx, tenantID, args.ProjectID, project); err != nil {
			return nil, err
		}
		return map[string]any{"deleted": args.IDs}, nil
	case "board.connect":
		var args connectArguments
		if err := decodeToolArguments(raw, &args); err != nil {
			return nil, err
		}
		if !validProjectID(args.ID) || !validProjectID(args.From) || !validProjectID(args.To) || args.From == args.To {
			return nil, badToolRequest("invalid edge endpoints or id")
		}
		project, err := s.loadProjectDocument(ctx, tenantID, args.ProjectID)
		if err != nil {
			return nil, err
		}
		nodes := projectNodes(project)
		if findObjectByID(nodes, args.From) < 0 || findObjectByID(nodes, args.To) < 0 {
			return nil, badToolRequest("edge endpoint does not exist")
		}
		edges := projectEdges(project)
		if findObjectByID(edges, args.ID) >= 0 {
			return nil, badToolRequest("edge id already exists")
		}
		for _, edge := range edges {
			if edge["from"] == args.From && edge["to"] == args.To {
				return nil, badToolRequest("edge already exists")
			}
		}
		edge := map[string]any{"id": args.ID, "from": args.From, "to": args.To}
		project["edges"] = append(edges, edge)
		if err := s.saveProjectDocument(ctx, tenantID, args.ProjectID, project); err != nil {
			return nil, err
		}
		return edge, nil
	default:
		return nil, badToolRequest("unknown or disallowed agent tool")
	}
}

func decodeToolArguments(raw json.RawMessage, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil || ensureJSONEOF(decoder) != nil {
		return badToolRequest("invalid tool arguments")
	}
	return nil
}

func (s *Server) loadProjectDocument(ctx context.Context, tenantID, id string) (map[string]any, error) {
	if !validProjectID(id) {
		return nil, badToolRequest("invalid project id")
	}
	if tenantID == "" {
		tenantID = store.DefaultTenantID
	}
	var body []byte
	var err error
	if s.store != nil {
		body, err = s.store.GetProject(ctx, tenantID, id)
	} else {
		body, err = os.ReadFile(filepath.Join(s.projectsDir(), id+".json"))
	}
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, store.ErrNotFound) {
		return nil, &toolError{status: http.StatusNotFound, message: "project not found"}
	}
	if err != nil {
		return nil, err
	}
	var project map[string]any
	if err := json.Unmarshal(body, &project); err != nil || project == nil {
		return nil, fmt.Errorf("stored project is invalid")
	}
	return project, nil
}

func (s *Server) saveProjectDocument(ctx context.Context, tenantID, id string, project map[string]any) error {
	project["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	if err := validateProjectDocument(project); err != nil {
		return badToolRequest(err.Error())
	}
	body, err := json.MarshalIndent(project, "", "  ")
	if err != nil {
		return err
	}
	if len(body) > maxProjectBytes {
		return badToolRequest("project exceeds the persisted size limit")
	}
	if s.store != nil {
		if tenantID == "" {
			tenantID = store.DefaultTenantID
		}
		return s.store.PutProject(ctx, tenantID, id, body)
	}
	return atomicWriteFile(filepath.Join(s.projectsDir(), id+".json"), body, 0o600)
}

func validateProjectDocument(project map[string]any) error {
	id, idOK := project["id"].(string)
	title, titleOK := project["title"].(string)
	createdAt, createdOK := project["createdAt"].(string)
	updatedAt, updatedOK := project["updatedAt"].(string)
	rawNodeCount, nodesOK := objectArrayShape(project["nodes"])
	rawEdgeCount, edgesOK := objectArrayShape(project["edges"])
	chatSessions, chatsOK := project["chatSessions"].([]any)
	background, backgroundOK := project["backgroundMode"].(string)
	viewport, viewportOK := project["viewport"].(map[string]any)
	if !idOK || !validProjectID(id) || !titleOK || len(title) > 500 || !createdOK || !updatedOK ||
		!nodesOK || !edgesOK || !chatsOK || len(chatSessions) > 1_000 || !backgroundOK || !viewportOK {
		return errors.New("invalid project document shape")
	}
	if schemaValue, exists := project["schemaVersion"]; exists {
		schemaVersion, ok := finiteJSONNumber(schemaValue)
		if !ok || schemaVersion < 1 || schemaVersion > 3 || schemaVersion != math.Trunc(schemaVersion) {
			return errors.New("unsupported project schemaVersion")
		}
		kind, hasKind := project["projectKind"].(string)
		if schemaVersion == 3 && (!hasKind || (kind != "canvas" && kind != "film")) {
			return errors.New("schema v3 requires projectKind canvas or film")
		}
		if schemaVersion < 3 && hasKind && kind != "canvas" {
			return errors.New("legacy projects must be canvas projects")
		}
	} else if kind, hasKind := project["projectKind"].(string); hasKind && kind != "canvas" {
		return errors.New("legacy projects must be canvas projects")
	}
	if _, err := time.Parse(time.RFC3339, createdAt); err != nil {
		return errors.New("invalid project createdAt")
	}
	if _, err := time.Parse(time.RFC3339, updatedAt); err != nil {
		return errors.New("invalid project updatedAt")
	}
	if background != "dots" && background != "lines" && background != "blank" {
		return errors.New("invalid project background")
	}
	vx, vxOK := finiteJSONNumber(viewport["x"])
	vy, vyOK := finiteJSONNumber(viewport["y"])
	vk, vkOK := finiteJSONNumber(viewport["k"])
	if !vxOK || !vyOK || !vkOK || math.Abs(vx) > 1e9 || math.Abs(vy) > 1e9 || vk < 0.05 || vk > 8 {
		return errors.New("invalid project viewport")
	}
	if active := project["activeChatId"]; active != nil {
		if _, ok := active.(string); !ok {
			return errors.New("invalid activeChatId")
		}
	}
	nodes := projectNodes(project)
	edges := projectEdges(project)
	if len(nodes) != rawNodeCount || len(edges) != rawEdgeCount {
		return errors.New("nodes and edges must contain only objects")
	}
	if len(nodes) > 10_000 || len(edges) > 30_000 {
		return errors.New("project exceeds node or edge limits")
	}
	nodeIDs := make(map[string]struct{}, len(nodes))
	nodeTypes := make(map[string]string, len(nodes))
	for _, node := range nodes {
		if err := validateNode(node); err != nil {
			return err
		}
		id := node["id"].(string)
		if _, duplicate := nodeIDs[id]; duplicate {
			return errors.New("duplicate node id")
		}
		nodeIDs[id] = struct{}{}
		nodeTypes[id], _ = node["type"].(string)
	}
	owners := make(map[string]string)
	for _, node := range nodes {
		if node["type"] != "group" {
			continue
		}
		metadata := node["metadata"].(map[string]any)
		children, ok := metadata["childIds"].([]any)
		if !ok || len(children) == 0 {
			return errors.New("group must contain childIds")
		}
		for _, value := range children {
			childID, ok := value.(string)
			if !ok {
				return errors.New("invalid group child id")
			}
			if _, exists := nodeIDs[childID]; !exists || nodeTypes[childID] == "group" {
				return errors.New("group references an unknown child")
			}
			if owner := owners[childID]; owner != "" {
				return errors.New("node belongs to multiple groups")
			}
			owners[childID] = node["id"].(string)
		}
	}
	edgeIDs := make(map[string]struct{}, len(edges))
	for _, edge := range edges {
		id, idOK := edge["id"].(string)
		from, fromOK := edge["from"].(string)
		to, toOK := edge["to"].(string)
		if !idOK || !fromOK || !toOK || !validProjectID(id) || from == to {
			return errors.New("invalid edge")
		}
		if _, duplicate := edgeIDs[id]; duplicate {
			return errors.New("duplicate edge id")
		}
		edgeIDs[id] = struct{}{}
		if _, ok := nodeIDs[from]; !ok {
			return errors.New("edge references an unknown node")
		}
		if _, ok := nodeIDs[to]; !ok {
			return errors.New("edge references an unknown node")
		}
	}
	return nil
}

func objectArrayShape(value any) (int, bool) {
	if typed, ok := value.([]map[string]any); ok {
		return len(typed), true
	}
	items, ok := value.([]any)
	if !ok {
		return 0, false
	}
	for _, item := range items {
		if _, ok := item.(map[string]any); !ok {
			return 0, false
		}
	}
	return len(items), true
}

func projectNodes(project map[string]any) []map[string]any {
	return objectArray(project["nodes"])
}

func projectEdges(project map[string]any) []map[string]any {
	return objectArray(project["edges"])
}

func objectArray(value any) []map[string]any {
	items, _ := value.([]any)
	if typed, ok := value.([]map[string]any); ok {
		return typed
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if object, ok := item.(map[string]any); ok {
			result = append(result, object)
		}
	}
	return result
}

func validateNode(node map[string]any) error {
	id, _ := node["id"].(string)
	typeName, _ := node["type"].(string)
	title, titleOK := node["title"].(string)
	position, positionOK := node["position"].(map[string]any)
	width, widthOK := finiteJSONNumber(node["width"])
	height, heightOK := finiteJSONNumber(node["height"])
	_, metadataOK := node["metadata"].(map[string]any)
	allowedType := typeName == "text" || typeName == "image" || typeName == "config" || typeName == "video" ||
		typeName == "audio" || typeName == "panorama" || typeName == "director" || typeName == "group" || typeName == "plugin"
	if !validProjectID(id) || !allowedType || !titleOK || len(title) > 500 || !positionOK || !widthOK || !heightOK || !metadataOK {
		return errors.New("invalid node shape")
	}
	x, xOK := finiteJSONNumber(position["x"])
	y, yOK := finiteJSONNumber(position["y"])
	if !xOK || !yOK || math.Abs(x) > 1e9 || math.Abs(y) > 1e9 || width < 24 || width > 100_000 || height < 24 || height > 100_000 {
		return errors.New("invalid node geometry")
	}
	return nil
}

func finiteJSONNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	return number, ok && !math.IsNaN(number) && !math.IsInf(number, 0)
}

func findObjectByID(objects []map[string]any, id string) int {
	for index, object := range objects {
		if object["id"] == id {
			return index
		}
	}
	return -1
}

func mergeNode(node, patch map[string]any) map[string]any {
	result := make(map[string]any, len(node)+len(patch))
	for key, value := range node {
		result[key] = value
	}
	for key, value := range patch {
		if key == "metadata" {
			metadata, _ := node["metadata"].(map[string]any)
			metadataPatch, ok := value.(map[string]any)
			if !ok {
				result[key] = value
				continue
			}
			merged := make(map[string]any, len(metadata)+len(metadataPatch))
			for metadataKey, metadataValue := range metadata {
				merged[metadataKey] = metadataValue
			}
			for metadataKey, metadataValue := range metadataPatch {
				merged[metadataKey] = metadataValue
			}
			result[key] = merged
			continue
		}
		result[key] = value
	}
	return result
}

func deleteObjects(objects []map[string]any, deleted map[string]struct{}) []map[string]any {
	result := make([]map[string]any, 0, len(objects))
	for _, object := range objects {
		id, _ := object["id"].(string)
		if _, remove := deleted[id]; !remove {
			result = append(result, object)
		}
	}
	return result
}

func deleteConnectedEdges(edges []map[string]any, deleted map[string]struct{}) []map[string]any {
	result := make([]map[string]any, 0, len(edges))
	for _, edge := range edges {
		from, _ := edge["from"].(string)
		to, _ := edge["to"].(string)
		_, fromDeleted := deleted[from]
		_, toDeleted := deleted[to]
		if !fromDeleted && !toDeleted {
			result = append(result, edge)
		}
	}
	return result
}

func pruneDeletedNodeReferences(nodes []map[string]any, deleted map[string]struct{}) []map[string]any {
	result := make([]map[string]any, 0, len(nodes))
	for _, node := range nodes {
		metadata, _ := node["metadata"].(map[string]any)
		nextMetadata := make(map[string]any, len(metadata))
		for key, value := range metadata {
			nextMetadata[key] = value
		}
		for _, key := range []string{"childIds", "batchChildIds", "inputOrder"} {
			values, ok := nextMetadata[key].([]any)
			if !ok {
				continue
			}
			kept := make([]any, 0, len(values))
			for _, value := range values {
				id, _ := value.(string)
				if _, remove := deleted[id]; !remove {
					kept = append(kept, value)
				}
			}
			nextMetadata[key] = kept
		}
		if node["type"] == "group" {
			children, _ := nextMetadata["childIds"].([]any)
			if len(children) == 0 {
				if id, ok := node["id"].(string); ok {
					deleted[id] = struct{}{}
				}
				continue
			}
		}
		nextNode := make(map[string]any, len(node))
		for key, value := range node {
			nextNode[key] = value
		}
		nextNode["metadata"] = nextMetadata
		result = append(result, nextNode)
	}
	return result
}

func writeToolError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":    false,
		"error": map[string]any{"message": message},
	})
}
