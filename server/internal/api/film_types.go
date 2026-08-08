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
	ID        string `json:"id"`
	Revision  int    `json:"revision"`
	EpisodeID string `json:"episodeId"`
	Order     int    `json:"order"`
	Heading   string `json:"heading"`
	Synopsis  string `json:"synopsis"`
	Status    string `json:"status"`
}

type filmShot struct {
	ID                 string   `json:"id"`
	Revision           int      `json:"revision"`
	SceneID            string   `json:"sceneId"`
	Order              int      `json:"order"`
	Title              string   `json:"title"`
	Description        string   `json:"description"`
	Status             string   `json:"status"`
	DurationSeconds    float64  `json:"durationSeconds"`
	AspectRatio        string   `json:"aspectRatio"`
	IdentityVersionIDs []string `json:"identityVersionIds"`
	StyleAssetID       string   `json:"styleAssetId,omitempty"`
	ImageStorageKey    string   `json:"imageStorageKey,omitempty"`
	VideoStorageKey    string   `json:"videoStorageKey,omitempty"`
	AudioStorageKey    string   `json:"audioStorageKey,omitempty"`
	Subtitle           string   `json:"subtitle,omitempty"`
	MediaMIMEType      string   `json:"mediaMimeType,omitempty"`
}

type filmAsset struct {
	ID              string `json:"id"`
	Revision        int    `json:"revision"`
	Kind            string `json:"kind"`
	Title           string `json:"title"`
	Status          string `json:"status"`
	ParentAssetID   string `json:"parentAssetId,omitempty"`
	Description     string `json:"description"`
	MediaStorageKey string `json:"mediaStorageKey,omitempty"`
	Voice           string `json:"voice,omitempty"`
	StylePrompt     string `json:"stylePrompt,omitempty"`
	AspectRatio     string `json:"aspectRatio,omitempty"`
}

type filmStage struct {
	ID        string `json:"id"`
	Revision  int    `json:"revision"`
	Status    string `json:"status"`
	UpdatedAt string `json:"updatedAt"`
	Error     string `json:"error,omitempty"`
}

type filmTask struct {
	ID              string  `json:"id"`
	Revision        int     `json:"revision"`
	Stage           string  `json:"stage"`
	Title           string  `json:"title"`
	Status          string  `json:"status"`
	Progress        float64 `json:"progress"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
	GenerationJobID string  `json:"generationJobId,omitempty"`
	Error           string  `json:"error,omitempty"`
}

type filmQualityIssue struct {
	ID         string `json:"id"`
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	TargetType string `json:"targetType"`
	TargetID   string `json:"targetId"`
	Message    string `json:"message"`
}

type filmRepairProposal struct {
	ID               string         `json:"id"`
	IssueID          string         `json:"issueId"`
	TargetType       string         `json:"targetType"`
	TargetID         string         `json:"targetId"`
	ExpectedRevision int            `json:"expectedRevision"`
	Patch            map[string]any `json:"patch"`
	Summary          string         `json:"summary"`
	Approved         bool           `json:"approved"`
	AppliedAt        string         `json:"appliedAt,omitempty"`
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
	ID         string `json:"id"`
	Revision   int    `json:"revision"`
	Kind       string `json:"kind"`
	Status     string `json:"status"`
	Title      string `json:"title"`
	MIMEType   string `json:"mimeType"`
	StorageKey string `json:"storageKey,omitempty"`
	Content    string `json:"content,omitempty"`
	Bytes      int64  `json:"bytes,omitempty"`
	Diagnostic string `json:"diagnostic,omitempty"`
	CreatedAt  string `json:"createdAt"`
}

type filmDocument struct {
	SchemaVersion      int                 `json:"schemaVersion"`
	ProjectID          string              `json:"projectId"`
	Revision           int                 `json:"revision"`
	CreatedAt          string              `json:"createdAt"`
	UpdatedAt          string              `json:"updatedAt"`
	AspectRatio        string              `json:"aspectRatio"`
	Source             filmSource          `json:"source"`
	Episodes           []filmEpisode       `json:"episodes"`
	Scenes             []filmScene         `json:"scenes"`
	Shots              []filmShot          `json:"shots"`
	Assets             []filmAsset         `json:"assets"`
	Stages             []filmStage         `json:"stages"`
	Tasks              []filmTask          `json:"tasks"`
	QualityReports     []filmQualityReport `json:"qualityReports"`
	Timeline           filmTimeline        `json:"timeline"`
	Deliverables       []filmDeliverable   `json:"deliverables"`
	ProjectionRevision int                 `json:"projectionRevision"`
}

type filmExportRequest struct {
	Kind     string `json:"kind"`
	Revision int    `json:"revision"`
}

type filmStatusResponse struct {
	Document     filmDocument   `json:"document"`
	Capabilities map[string]any `json:"capabilities"`
}

func decodeFilmDocument(raw json.RawMessage) (filmDocument, error) {
	var document filmDocument
	err := json.Unmarshal(raw, &document)
	return document, err
}
