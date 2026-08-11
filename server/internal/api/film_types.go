package api

import "encoding/json"

const (
	filmStatusDraft       = "draft"
	filmStatusRunning     = "running"
	filmStatusNeedsReview = "needs_review"
	filmStatusApproved    = "approved"
	filmStatusFailed      = "failed"
	filmStatusCanceled    = "canceled"
)

type filmSource struct {
	Revision     int    `json:"revision"`
	Text         string `json:"text"`
	Format       string `json:"format"`
	OriginalName string `json:"originalName,omitempty"`
	ImportedAt   string `json:"importedAt"`
}

type filmEpisode struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
	Order    int    `json:"order"`
	Title    string `json:"title"`
	Synopsis string `json:"synopsis"`
	Status   string `json:"status"`
}

type filmScene struct {
	ID             string              `json:"id"`
	Revision       int                 `json:"revision"`
	EpisodeID      string              `json:"episodeId"`
	Order          int                 `json:"order"`
	Heading        string              `json:"heading"`
	Synopsis       string              `json:"synopsis"`
	Status         string              `json:"status"`
	DirectorSource *filmDirectorSource `json:"directorSource,omitempty"`
}

type filmShot struct {
	ID                        string              `json:"id"`
	Revision                  int                 `json:"revision"`
	SceneID                   string              `json:"sceneId"`
	Order                     int                 `json:"order"`
	Title                     string              `json:"title"`
	Description               string              `json:"description"`
	Status                    string              `json:"status"`
	DurationSeconds           float64             `json:"durationSeconds"`
	AspectRatio               string              `json:"aspectRatio"`
	IdentityVersionIDs        []string            `json:"identityVersionIds"`
	StyleAssetID              string              `json:"styleAssetId,omitempty"`
	ImageStorageKey           string              `json:"imageStorageKey,omitempty"`
	ImageSHA256               string              `json:"imageSha256,omitempty"`
	ImageObjectVersion        string              `json:"imageObjectVersion,omitempty"`
	ImageGenerationJobID      string              `json:"imageGenerationJobId,omitempty"`
	FirstFrameStorageKey      string              `json:"firstFrameStorageKey,omitempty"`
	FirstFrameSHA256          string              `json:"firstFrameSha256,omitempty"`
	FirstFrameObjectVersion   string              `json:"firstFrameObjectVersion,omitempty"`
	FirstFrameGenerationJobID string              `json:"firstFrameGenerationJobId,omitempty"`
	LastFrameStorageKey       string              `json:"lastFrameStorageKey,omitempty"`
	LastFrameSHA256           string              `json:"lastFrameSha256,omitempty"`
	LastFrameObjectVersion    string              `json:"lastFrameObjectVersion,omitempty"`
	LastFrameGenerationJobID  string              `json:"lastFrameGenerationJobId,omitempty"`
	VideoStorageKey           string              `json:"videoStorageKey,omitempty"`
	VideoSHA256               string              `json:"videoSha256,omitempty"`
	VideoObjectVersion        string              `json:"videoObjectVersion,omitempty"`
	VideoGenerationJobID      string              `json:"videoGenerationJobId,omitempty"`
	AudioStorageKey           string              `json:"audioStorageKey,omitempty"`
	AudioSHA256               string              `json:"audioSha256,omitempty"`
	AudioObjectVersion        string              `json:"audioObjectVersion,omitempty"`
	AudioGenerationJobID      string              `json:"audioGenerationJobId,omitempty"`
	Subtitle                  string              `json:"subtitle,omitempty"`
	MediaMIMEType             string              `json:"mediaMimeType,omitempty"`
	MediaProvenance           string              `json:"mediaProvenance,omitempty"`
	StoryboardDirectorSource  *filmDirectorSource `json:"storyboardDirectorSource,omitempty"`
	FirstFrameDirectorSource  *filmDirectorSource `json:"firstFrameDirectorSource,omitempty"`
	LastFrameDirectorSource   *filmDirectorSource `json:"lastFrameDirectorSource,omitempty"`
}

type filmDirectorSource struct {
	Revision       int             `json:"revision"`
	TargetField    string          `json:"targetField"`
	CaptureID      string          `json:"captureId"`
	DirectorNodeID string          `json:"directorNodeId"`
	CameraID       string          `json:"cameraId"`
	CameraName     string          `json:"cameraName"`
	Width          int             `json:"width"`
	Height         int             `json:"height"`
	StorageKey     string          `json:"storageKey"`
	SHA256         string          `json:"sha256"`
	ObjectVersion  string          `json:"objectVersion"`
	Snapshot       json.RawMessage `json:"snapshot"`
	AdoptedAt      string          `json:"adoptedAt"`
}

type filmAsset struct {
	ID                 string   `json:"id"`
	Revision           int      `json:"revision"`
	Kind               string   `json:"kind"`
	Title              string   `json:"title"`
	Status             string   `json:"status"`
	ParentAssetID      string   `json:"parentAssetId,omitempty"`
	Description        string   `json:"description"`
	MediaStorageKey    string   `json:"mediaStorageKey,omitempty"`
	MediaMIMEType      string   `json:"mediaMimeType,omitempty"`
	MediaSHA256        string   `json:"mediaSha256,omitempty"`
	MediaObjectVersion string   `json:"mediaObjectVersion,omitempty"`
	MediaProvenance    string   `json:"mediaProvenance,omitempty"`
	Voice              string   `json:"voice,omitempty"`
	StylePrompt        string   `json:"stylePrompt,omitempty"`
	AspectRatio        string   `json:"aspectRatio,omitempty"`
	AgeStage           string   `json:"ageStage,omitempty"`
	Costume            string   `json:"costume,omitempty"`
	StoryPeriod        string   `json:"storyPeriod,omitempty"`
	IsDefault          bool     `json:"isDefault,omitempty"`
	EpisodeIDs         []string `json:"episodeIds,omitempty"`
	SceneIDs           []string `json:"sceneIds,omitempty"`
	ShotIDs            []string `json:"shotIds,omitempty"`
}

type filmDialogue struct {
	ID                   string `json:"id"`
	Revision             int    `json:"revision"`
	ShotID               string `json:"shotId"`
	Order                int    `json:"order"`
	Kind                 string `json:"kind"`
	CharacterAssetID     string `json:"characterAssetId,omitempty"`
	VoiceAssetID         string `json:"voiceAssetId,omitempty"`
	Emotion              string `json:"emotion,omitempty"`
	Text                 string `json:"text"`
	Status               string `json:"status"`
	AudioStorageKey      string `json:"audioStorageKey,omitempty"`
	AudioSHA256          string `json:"audioSha256,omitempty"`
	AudioObjectVersion   string `json:"audioObjectVersion,omitempty"`
	AudioGenerationJobID string `json:"audioGenerationJobId,omitempty"`
}

type filmStage struct {
	ID        string `json:"id"`
	Revision  int    `json:"revision"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updatedAt"`
	Error     string `json:"error,omitempty"`
}

type filmStoryRelationship struct {
	CharacterAssetID        string `json:"characterAssetId"`
	RelatedCharacterAssetID string `json:"relatedCharacterAssetId"`
	Relation                string `json:"relation"`
	Description             string `json:"description,omitempty"`
}

type filmStoryBeat struct {
	ID          string `json:"id"`
	EpisodeID   string `json:"episodeId"`
	Order       int    `json:"order"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

type filmCharacterArc struct {
	CharacterAssetID string `json:"characterAssetId"`
	Summary          string `json:"summary"`
}

type filmStoryBible struct {
	Summary       string                  `json:"summary,omitempty"`
	Theme         string                  `json:"theme,omitempty"`
	Timeline      []string                `json:"timeline,omitempty"`
	Relationships []filmStoryRelationship `json:"relationships,omitempty"`
	Beats         []filmStoryBeat         `json:"beats,omitempty"`
	CharacterArcs []filmCharacterArc      `json:"characterArcs,omitempty"`
}

type filmTask struct {
	ID                    string                      `json:"id"`
	Revision              int                         `json:"revision"`
	Stage                 string                      `json:"stage"`
	ShotID                string                      `json:"shotId,omitempty"`
	DialogueID            string                      `json:"dialogueId,omitempty"`
	Title                 string                      `json:"title"`
	Status                string                      `json:"status"`
	Progress              float64                     `json:"progress"`
	CreatedAt             string                      `json:"createdAt"`
	UpdatedAt             string                      `json:"updatedAt"`
	GenerationJobID       string                      `json:"generationJobId,omitempty"`
	ParentGenerationJobID string                      `json:"parentGenerationJobId,omitempty"`
	IdempotencyKey        string                      `json:"idempotencyKey,omitempty"`
	RequestHash           string                      `json:"requestHash,omitempty"`
	Error                 string                      `json:"error,omitempty"`
	Snapshot              *filmGenerationSnapshot     `json:"snapshot,omitempty"`
	TextSnapshot          *filmTextGenerationSnapshot `json:"textSnapshot,omitempty"`
}

type filmTextGenerationSnapshot struct {
	SourceRevision       int    `json:"sourceRevision"`
	SourceSHA256         string `json:"sourceSha256"`
	ProviderID           string `json:"providerId"`
	Model                string `json:"model"`
	PromptVersion        string `json:"promptVersion"`
	OutputSchema         string `json:"outputSchema"`
	ScriptMode           string `json:"scriptMode,omitempty"`
	TargetEntityID       string `json:"targetEntityId,omitempty"`
	TargetRevision       int    `json:"targetRevision,omitempty"`
	TargetSHA256         string `json:"targetSha256,omitempty"`
	EstimatedGenerations int    `json:"estimatedGenerations"`
	EstimatedCredits     int    `json:"estimatedCredits,omitempty"`
	CreatedAt            string `json:"createdAt"`
}

const (
	filmAICandidateReady    = "ready"
	filmAICandidateStale    = "stale"
	filmAICandidateRejected = "rejected"
	filmAICandidateApplied  = "applied"
)

type filmAICandidate struct {
	ID              string              `json:"id"`
	Revision        int                 `json:"revision"`
	Stage           string              `json:"stage"`
	Status          string              `json:"status"`
	SourceRevision  int                 `json:"sourceRevision"`
	SourceSHA256    string              `json:"sourceSha256"`
	FilmRevision    int                 `json:"filmRevision"`
	TaskID          string              `json:"taskId"`
	GenerationJobID string              `json:"generationJobId"`
	RequestHash     string              `json:"requestHash"`
	Decomposition   filmAIDecomposition `json:"decomposition"`
	CreatedAt       string              `json:"createdAt"`
	AppliedAt       string              `json:"appliedAt,omitempty"`
}

type filmAIScriptCandidate struct {
	ID              string       `json:"id"`
	Revision        int          `json:"revision"`
	Stage           string       `json:"stage"`
	Status          string       `json:"status"`
	SourceRevision  int          `json:"sourceRevision"`
	SourceSHA256    string       `json:"sourceSha256"`
	FilmRevision    int          `json:"filmRevision"`
	TargetEpisodeID string       `json:"targetEpisodeId"`
	TargetRevision  int          `json:"targetRevision"`
	TargetSHA256    string       `json:"targetSha256"`
	TaskID          string       `json:"taskId"`
	GenerationJobID string       `json:"generationJobId"`
	RequestHash     string       `json:"requestHash"`
	Script          filmAIScript `json:"script"`
	CreatedAt       string       `json:"createdAt"`
	AppliedAt       string       `json:"appliedAt,omitempty"`
}

type filmStructureVersion struct {
	ID          string         `json:"id"`
	Revision    int            `json:"revision"`
	CandidateID string         `json:"candidateId"`
	Story       filmStoryBible `json:"story"`
	Episodes    []filmEpisode  `json:"episodes"`
	Scenes      []filmScene    `json:"scenes"`
	Shots       []filmShot     `json:"shots"`
	Dialogues   []filmDialogue `json:"dialogues"`
	Assets      []filmAsset    `json:"assets"`
	CreatedAt   string         `json:"createdAt"`
}

// filmGenerationSnapshot freezes every Film-domain input used to create a
// GenerationJob. Assets remain embedded here even when their editable records
// are changed later, so an approved result can be reproduced and audited.
type filmGenerationSnapshot struct {
	ShotRevision             int                  `json:"shotRevision"`
	DialogueVersion          *filmDialogue        `json:"dialogueVersion,omitempty"`
	Prompt                   string               `json:"prompt"`
	ProviderID               string               `json:"providerId"`
	Model                    string               `json:"model"`
	CapabilityVersion        string               `json:"capabilityVersion,omitempty"`
	GenerationMode           string               `json:"generationMode,omitempty"`
	Config                   filmGenerationConfig `json:"config"`
	IdentityVersions         []filmAsset          `json:"identityVersions"`
	StyleVersion             *filmAsset           `json:"styleVersion,omitempty"`
	StoryboardDirectorSource *filmDirectorSource  `json:"storyboardDirectorSource,omitempty"`
	FirstFrameDirectorSource *filmDirectorSource  `json:"firstFrameDirectorSource,omitempty"`
	LastFrameDirectorSource  *filmDirectorSource  `json:"lastFrameDirectorSource,omitempty"`
	ReferenceStorageKeys     []string             `json:"referenceStorageKeys"`
	EstimatedGenerations     int                  `json:"estimatedGenerations"`
	EstimatedCredits         int                  `json:"estimatedCredits,omitempty"`
	CreatedAt                string               `json:"createdAt"`
}

type filmQualityIssue struct {
	ID         string `json:"id"`
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	TargetType string `json:"targetType"`
	TargetID   string `json:"targetId"`
	Message    string `json:"message"`
	MediaKind  string `json:"mediaKind,omitempty"`
}

type filmRepairProposal struct {
	ID                   string         `json:"id"`
	IssueID              string         `json:"issueId"`
	TargetType           string         `json:"targetType"`
	TargetID             string         `json:"targetId"`
	ExpectedRevision     int            `json:"expectedRevision"`
	Patch                map[string]any `json:"patch"`
	Summary              string         `json:"summary"`
	Approved             bool           `json:"approved"`
	AppliedAt            string         `json:"appliedAt,omitempty"`
	AffectedTargets      []string       `json:"affectedTargets,omitempty"`
	EstimatedGenerations int            `json:"estimatedGenerations,omitempty"`
	EstimatedCredits     int            `json:"estimatedCredits,omitempty"`
	RegenerationStage    string         `json:"regenerationStage,omitempty"`
}

type filmEntityVersion struct {
	ID         string          `json:"id"`
	EntityType string          `json:"entityType"`
	EntityID   string          `json:"entityId"`
	Revision   int             `json:"revision"`
	Snapshot   json.RawMessage `json:"snapshot"`
	Reason     string          `json:"reason"`
	CreatedAt  string          `json:"createdAt"`
}

type filmQualityReport struct {
	ID        string               `json:"id"`
	Revision  int                  `json:"revision"`
	CreatedAt string               `json:"createdAt"`
	Issues    []filmQualityIssue   `json:"issues"`
	Repairs   []filmRepairProposal `json:"repairs"`
}

type filmTimelineClip struct {
	ID         string  `json:"id"`
	Revision   int     `json:"revision"`
	Source     string  `json:"source"`
	Order      int     `json:"order"`
	Start      float64 `json:"start"`
	End        float64 `json:"end"`
	TrimIn     float64 `json:"trimIn"`
	TrimOut    float64 `json:"trimOut"`
	Volume     float64 `json:"volume"`
	Muted      bool    `json:"muted"`
	FadeIn     float64 `json:"fadeIn"`
	FadeOut    float64 `json:"fadeOut"`
	Transition string  `json:"transition"`
	Text       string  `json:"text,omitempty"`
}

type filmTimelineTrack struct {
	ID       string             `json:"id"`
	Revision int                `json:"revision"`
	Kind     string             `json:"kind"`
	Title    string             `json:"title"`
	Clips    []filmTimelineClip `json:"clips"`
}

type filmTimeline struct {
	Revision  int                 `json:"revision"`
	Width     int                 `json:"width"`
	Height    int                 `json:"height"`
	FrameRate int                 `json:"frameRate"`
	Tracks    []filmTimelineTrack `json:"tracks"`
}

type filmDeliverable struct {
	ID              string `json:"id"`
	Revision        int    `json:"revision"`
	Kind            string `json:"kind"`
	Status          string `json:"status"`
	Title           string `json:"title"`
	MIMEType        string `json:"mimeType"`
	StorageKey      string `json:"storageKey,omitempty"`
	SHA256          string `json:"sha256,omitempty"`
	ObjectVersion   string `json:"objectVersion,omitempty"`
	Content         string `json:"content,omitempty"`
	Bytes           int64  `json:"bytes,omitempty"`
	Diagnostic      string `json:"diagnostic,omitempty"`
	IdempotencyKey  string `json:"idempotencyKey,omitempty"`
	RequestHash     string `json:"requestHash,omitempty"`
	Provenance      string `json:"provenance,omitempty"`
	GenerationJobID string `json:"generationJobId,omitempty"`
	CreatedAt       string `json:"createdAt"`
}

type filmMediaAdoption struct {
	ID              string `json:"id"`
	Revision        int    `json:"revision"`
	TargetType      string `json:"targetType"`
	TargetID        string `json:"targetId"`
	TargetField     string `json:"targetField"`
	TargetRevision  int    `json:"targetRevision"`
	SourceNodeID    string `json:"sourceNodeId"`
	StorageKey      string `json:"storageKey"`
	MIMEType        string `json:"mimeType"`
	SHA256          string `json:"sha256"`
	ObjectVersion   string `json:"objectVersion"`
	GenerationJobID string `json:"generationJobId,omitempty"`
	Prompt          string `json:"prompt,omitempty"`
	ProviderID      string `json:"providerId,omitempty"`
	Model           string `json:"model,omitempty"`
	AdoptedAt       string `json:"adoptedAt"`
}

type filmDocument struct {
	SchemaVersion      int                     `json:"schemaVersion"`
	ProjectID          string                  `json:"projectId"`
	Revision           int                     `json:"revision"`
	CreatedAt          string                  `json:"createdAt"`
	UpdatedAt          string                  `json:"updatedAt"`
	AspectRatio        string                  `json:"aspectRatio"`
	Source             filmSource              `json:"source"`
	Story              filmStoryBible          `json:"story,omitempty"`
	Episodes           []filmEpisode           `json:"episodes"`
	Scenes             []filmScene             `json:"scenes"`
	Shots              []filmShot              `json:"shots"`
	Dialogues          []filmDialogue          `json:"dialogues,omitempty"`
	Assets             []filmAsset             `json:"assets"`
	Stages             []filmStage             `json:"stages"`
	Tasks              []filmTask              `json:"tasks"`
	AICandidates       []filmAICandidate       `json:"aiCandidates,omitempty"`
	ScriptCandidates   []filmAIScriptCandidate `json:"scriptCandidates,omitempty"`
	StructureVersions  []filmStructureVersion  `json:"structureVersions,omitempty"`
	QualityReports     []filmQualityReport     `json:"qualityReports"`
	Timeline           filmTimeline            `json:"timeline"`
	Deliverables       []filmDeliverable       `json:"deliverables"`
	Adoptions          []filmMediaAdoption     `json:"adoptions,omitempty"`
	Versions           []filmEntityVersion     `json:"versions,omitempty"`
	ProjectionRevision int                     `json:"projectionRevision"`
}

type filmExportRequest struct {
	Kind           string `json:"kind"`
	Revision       int    `json:"revision"`
	IdempotencyKey string `json:"idempotencyKey"`
}

type filmStatusResponse struct {
	Document     filmDocument   `json:"document"`
	Capabilities map[string]any `json:"capabilities"`
}

func decodeFilmDocument(raw json.RawMessage) (filmDocument, error) {
	var document filmDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return filmDocument{}, err
	}
	document = migrateFilmDocumentTopology(document)
	return migrateFilmRepairRegenerationStages(document), nil
}

func migrateFilmRepairRegenerationStages(document filmDocument) filmDocument {
	shots := make(map[string]filmShot, len(document.Shots))
	for _, shot := range document.Shots {
		shots[shot.ID] = shot
	}
	dialogues := make(map[string]struct{}, len(document.Dialogues))
	for _, dialogue := range document.Dialogues {
		dialogues[dialogue.ID] = struct{}{}
	}
	for reportIndex := range document.QualityReports {
		issues := make(map[string]filmQualityIssue, len(document.QualityReports[reportIndex].Issues))
		for _, issue := range document.QualityReports[reportIndex].Issues {
			issues[issue.ID] = issue
		}
		for repairIndex := range document.QualityReports[reportIndex].Repairs {
			repair := &document.QualityReports[reportIndex].Repairs[repairIndex]
			if repair.EstimatedGenerations == 0 || repair.RegenerationStage != "" {
				continue
			}
			if repair.TargetType == "dialogue" {
				if _, exists := dialogues[repair.TargetID]; exists {
					repair.RegenerationStage = "audio"
				}
			} else {
				repair.RegenerationStage = filmRepairRegenerationStage(issues[repair.IssueID], shots[repair.TargetID])
			}
			if repair.RegenerationStage == "" {
				repair.RegenerationStage = "storyboard"
			}
		}
	}
	return document
}

func migrateFilmDocumentTopology(document filmDocument) filmDocument {
	for _, stage := range document.Stages {
		if stage.ID == "first_frame" {
			return document
		}
	}
	if len(document.Stages) != 7 {
		return document
	}
	storyboardApproved := false
	for _, stage := range document.Stages {
		if stage.ID == "storyboard" && stage.Status == filmStatusApproved {
			storyboardApproved = true
		}
	}
	status := filmStatusDraft
	if storyboardApproved {
		status = filmStatusApproved
		for index := range document.Shots {
			shot := &document.Shots[index]
			if shot.FirstFrameStorageKey == "" {
				shot.FirstFrameStorageKey, shot.FirstFrameSHA256, shot.FirstFrameObjectVersion, shot.FirstFrameGenerationJobID = shot.ImageStorageKey, shot.ImageSHA256, shot.ImageObjectVersion, shot.ImageGenerationJobID
			}
		}
	}
	stage := filmStage{ID: "first_frame", Revision: 1, Status: status, UpdatedAt: document.UpdatedAt}
	next := make([]filmStage, 0, 8)
	for _, current := range document.Stages {
		next = append(next, current)
		if current.ID == "storyboard" {
			next = append(next, stage)
		}
	}
	document.Stages = next
	return document
}
