package store

import (
	"encoding/json"
	"fmt"
)

const (
	maxFilmProjectionRelations          = 50_000
	maxFilmProjectionRelationsPerEntity = 1_000
)

type filmEntityProjection struct {
	EntityType        string
	EntityID          string
	Revision          int
	AggregateRevision int
	Position          int
	Status            string
	Document          json.RawMessage
}

type filmEntityRelationProjection struct {
	RelationType      string
	SourceType        string
	SourceID          string
	TargetType        string
	TargetID          string
	Position          int
	AggregateRevision int
}

type filmProjectionIdentity struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
	Order    *int   `json:"order"`
	Status   string `json:"status"`
}

type filmProjectionScene struct {
	ID        string `json:"id"`
	EpisodeID string `json:"episodeId"`
}

type filmProjectionShot struct {
	ID                 string   `json:"id"`
	SceneID            string   `json:"sceneId"`
	IdentityVersionIDs []string `json:"identityVersionIds"`
	StyleAssetID       string   `json:"styleAssetId"`
}

type filmProjectionDialogue struct {
	ID               string `json:"id"`
	ShotID           string `json:"shotId"`
	CharacterAssetID string `json:"characterAssetId"`
	VoiceAssetID     string `json:"voiceAssetId"`
}

type filmProjectionAsset struct {
	ID            string   `json:"id"`
	ParentAssetID string   `json:"parentAssetId"`
	EpisodeIDs    []string `json:"episodeIds"`
	SceneIDs      []string `json:"sceneIds"`
	ShotIDs       []string `json:"shotIds"`
}

// buildFilmRelationalProjection derives queryable rows from the authoritative
// aggregate document. Callers replace the complete projection in the same
// transaction as the aggregate CAS; these rows must never be updated directly.
func buildFilmRelationalProjection(document []byte, aggregateRevision int) ([]filmEntityProjection, []filmEntityRelationProjection, error) {
	if aggregateRevision < 1 {
		return nil, nil, ErrInvalidInput
	}
	var aggregate map[string]json.RawMessage
	if json.Unmarshal(document, &aggregate) != nil {
		return nil, nil, ErrInvalidInput
	}
	type collectionSpec struct {
		field      string
		entityType string
	}
	collections := []collectionSpec{
		{"episodes", "episode"}, {"scenes", "scene"}, {"shots", "shot"}, {"dialogues", "dialogue"},
		{"assets", "asset"}, {"stages", "stage_approval"}, {"tasks", "task"},
		{"qualityReports", "quality_report"}, {"deliverables", "deliverable"},
		{"adoptions", "adoption"}, {"versions", "entity_version"},
	}
	entities := make([]filmEntityProjection, 0)
	entityKeys := map[string]struct{}{}
	collectionDocuments := map[string][]json.RawMessage{}
	for _, spec := range collections {
		values, err := decodeFilmProjectionCollection(aggregate[spec.field])
		if err != nil {
			return nil, nil, err
		}
		collectionDocuments[spec.field] = values
		for position, raw := range values {
			var identity filmProjectionIdentity
			if json.Unmarshal(raw, &identity) != nil || identity.ID == "" || identity.Revision < 1 {
				return nil, nil, ErrInvalidInput
			}
			key := filmProjectionEntityKey(spec.entityType, identity.ID)
			if _, exists := entityKeys[key]; exists {
				return nil, nil, ErrInvalidInput
			}
			entityKeys[key] = struct{}{}
			entities = append(entities, filmEntityProjection{
				EntityType: spec.entityType, EntityID: identity.ID, Revision: identity.Revision,
				AggregateRevision: aggregateRevision, Position: projectionPosition(identity.Order, position),
				Status: identity.Status, Document: append(json.RawMessage(nil), raw...),
			})
		}
	}
	for _, spec := range []collectionSpec{{"source", "source"}, {"timeline", "timeline"}} {
		raw := aggregate[spec.field]
		if len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var identity struct {
			Revision int `json:"revision"`
		}
		if json.Unmarshal(raw, &identity) != nil || identity.Revision < 0 {
			return nil, nil, ErrInvalidInput
		}
		if identity.Revision == 0 {
			identity.Revision = 1
		}
		entityKeys[filmProjectionEntityKey(spec.entityType, spec.entityType)] = struct{}{}
		entities = append(entities, filmEntityProjection{
			EntityType: spec.entityType, EntityID: spec.entityType, Revision: identity.Revision,
			AggregateRevision: aggregateRevision, Document: append(json.RawMessage(nil), raw...),
		})
	}
	projectionRevision := 1
	if raw := aggregate["projectionRevision"]; len(raw) > 0 && json.Unmarshal(raw, &projectionRevision) != nil {
		return nil, nil, ErrInvalidInput
	}
	if projectionRevision < 1 {
		projectionRevision = 1
	}
	projectionDocument, _ := json.Marshal(map[string]int{"revision": projectionRevision})
	entityKeys[filmProjectionEntityKey("projection", "projection")] = struct{}{}
	entities = append(entities, filmEntityProjection{
		EntityType: "projection", EntityID: "projection", Revision: projectionRevision,
		AggregateRevision: aggregateRevision, Document: projectionDocument,
	})

	relations := make([]filmEntityRelationProjection, 0)
	relationKeys := map[string]struct{}{}
	relationFanout := map[string]int{}
	appendRelation := func(relationType, sourceType, sourceID, targetType, targetID string, position int) error {
		if sourceID == "" || targetID == "" {
			return ErrInvalidInput
		}
		if _, exists := entityKeys[filmProjectionEntityKey(sourceType, sourceID)]; !exists {
			return ErrInvalidInput
		}
		if _, exists := entityKeys[filmProjectionEntityKey(targetType, targetID)]; !exists {
			return ErrInvalidInput
		}
		relationKey := fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%s", relationType, sourceType, sourceID, targetType, targetID)
		if _, exists := relationKeys[relationKey]; exists {
			return ErrInvalidInput
		}
		sourceKey := filmProjectionEntityKey(sourceType, sourceID)
		if len(relations) >= maxFilmProjectionRelations || relationFanout[sourceKey] >= maxFilmProjectionRelationsPerEntity {
			return ErrInvalidInput
		}
		relationKeys[relationKey] = struct{}{}
		relationFanout[sourceKey]++
		relations = append(relations, filmEntityRelationProjection{
			RelationType: relationType, SourceType: sourceType, SourceID: sourceID,
			TargetType: targetType, TargetID: targetID, Position: position,
			AggregateRevision: aggregateRevision,
		})
		return nil
	}
	for _, raw := range collectionDocuments["scenes"] {
		var scene filmProjectionScene
		if json.Unmarshal(raw, &scene) != nil || appendRelation("scene_episode", "scene", scene.ID, "episode", scene.EpisodeID, 0) != nil {
			return nil, nil, ErrInvalidInput
		}
	}
	for _, raw := range collectionDocuments["shots"] {
		var shot filmProjectionShot
		if json.Unmarshal(raw, &shot) != nil || appendRelation("shot_scene", "shot", shot.ID, "scene", shot.SceneID, 0) != nil {
			return nil, nil, ErrInvalidInput
		}
		for position, assetID := range shot.IdentityVersionIDs {
			if err := appendRelation("shot_identity", "shot", shot.ID, "asset", assetID, position); err != nil {
				return nil, nil, err
			}
		}
		if shot.StyleAssetID != "" {
			if err := appendRelation("shot_style", "shot", shot.ID, "asset", shot.StyleAssetID, 0); err != nil {
				return nil, nil, err
			}
		}
	}
	for _, raw := range collectionDocuments["dialogues"] {
		var dialogue filmProjectionDialogue
		if json.Unmarshal(raw, &dialogue) != nil || appendRelation("dialogue_shot", "dialogue", dialogue.ID, "shot", dialogue.ShotID, 0) != nil {
			return nil, nil, ErrInvalidInput
		}
		for _, relation := range []struct{ relationType, assetID string }{{"dialogue_character", dialogue.CharacterAssetID}, {"dialogue_voice", dialogue.VoiceAssetID}} {
			if relation.assetID != "" {
				if err := appendRelation(relation.relationType, "dialogue", dialogue.ID, "asset", relation.assetID, 0); err != nil {
					return nil, nil, err
				}
			}
		}
	}
	for _, raw := range collectionDocuments["assets"] {
		var asset filmProjectionAsset
		if json.Unmarshal(raw, &asset) != nil {
			return nil, nil, ErrInvalidInput
		}
		if asset.ParentAssetID != "" {
			if err := appendRelation("asset_parent", "asset", asset.ID, "asset", asset.ParentAssetID, 0); err != nil {
				return nil, nil, err
			}
		}
		for _, scope := range []struct {
			relationType string
			targetType   string
			ids          []string
		}{{"asset_episode", "episode", asset.EpisodeIDs}, {"asset_scene", "scene", asset.SceneIDs}, {"asset_shot", "shot", asset.ShotIDs}} {
			for position, targetID := range scope.ids {
				if err := appendRelation(scope.relationType, "asset", asset.ID, scope.targetType, targetID, position); err != nil {
					return nil, nil, err
				}
			}
		}
	}
	return entities, relations, nil
}

func decodeFilmProjectionCollection(raw json.RawMessage) ([]json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var values []json.RawMessage
	if json.Unmarshal(raw, &values) != nil {
		return nil, ErrInvalidInput
	}
	return values, nil
}

func filmProjectionEntityKey(entityType, entityID string) string {
	return fmt.Sprintf("%s\x00%s", entityType, entityID)
}

func projectionPosition(order *int, fallback int) int {
	if order != nil {
		return *order
	}
	return fallback
}
