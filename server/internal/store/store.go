package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"time"
)

var (
	ErrNotFound            = errors.New("not found")
	ErrConflict            = errors.New("conflict")
	ErrGone                = errors.New("deleted")
	ErrQuotaExceeded       = errors.New("quota exceeded")
	ErrInvalidCredentials  = errors.New("invalid credentials")
	ErrUnauthorized        = errors.New("unauthorized")
	ErrInsufficientCredits = errors.New("insufficient credits")
	ErrBanned              = errors.New("user banned")
	ErrLastOwner           = errors.New("last active owner must be preserved")
	ErrInvalidInput        = errors.New("invalid input")
	ErrInvitationInvalid   = errors.New("invalid invitation")
)

const DefaultTenantID = "local"

type ProjectSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updatedAt"`
}

type GenerationJob struct {
	ID             string          `json:"id"`
	ProjectID      string          `json:"projectId,omitempty"`
	Kind           string          `json:"kind"`
	Status         string          `json:"status"`
	Prompt         string          `json:"prompt"`
	ProviderID     string          `json:"providerId,omitempty"`
	Model          string          `json:"model,omitempty"`
	Parameters     json.RawMessage `json:"parameters"`
	Result         json.RawMessage `json:"result"`
	Error          string          `json:"error,omitempty"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
	LeaseOwner     string          `json:"-"`
	LeaseExpiresAt string          `json:"-"`
}

type TenantGenerationJob struct {
	TenantID string
	Job      GenerationJob
}

type GenerationJobQuery struct {
	ProjectID      string
	Kind           string
	Page           int
	PageSize       int
	IncludeDeleted bool
}

type GenerationJobPage struct {
	Items    []GenerationJob `json:"items"`
	Page     int             `json:"page"`
	PageSize int             `json:"pageSize"`
	Total    int             `json:"total"`
}

type GenerationClaim struct {
	Kind     string
	Executor string
}

type AuthUser struct {
	ID            string `json:"id"`
	TenantID      string `json:"tenantId"`
	Email         string `json:"email"`
	DisplayName   string `json:"displayName"`
	Role          string `json:"role"`
	Credits       int64  `json:"credits"`
	Status        string `json:"status,omitempty"`
	LinuxDoID     string `json:"linuxDoId,omitempty"`
	PlatformAdmin bool   `json:"platformAdmin,omitempty"`
}

type Tenant struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Plan                   string `json:"plan"`
	StorageQuotaBytes      int64  `json:"storageQuotaBytes"`
	GenerationQuotaMonthly int64  `json:"generationQuotaMonthly"`
	CreatedAt              string `json:"createdAt"`
	UserCount              int    `json:"userCount,omitempty"`
}

type UsageSummary struct {
	StorageBytes           int64  `json:"storageBytes"`
	GenerationThisMonth    int64  `json:"generationThisMonth"`
	StorageQuotaBytes      int64  `json:"storageQuotaBytes"`
	GenerationQuotaMonthly int64  `json:"generationQuotaMonthly"`
	Plan                   string `json:"plan"`
	Credits                int64  `json:"credits"`
}

type RegisterInput struct {
	Email       string
	Password    string
	DisplayName string
	InviteToken string
}

func PaginateGenerationJobs(items []GenerationJob, page, pageSize int) GenerationJobPage {
	sorted := append([]GenerationJob(nil), items...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].CreatedAt == sorted[j].CreatedAt {
			return sorted[i].ID > sorted[j].ID
		}
		return sorted[i].CreatedAt > sorted[j].CreatedAt
	})
	start := (page - 1) * pageSize
	if start > len(sorted) {
		start = len(sorted)
	}
	end := start + pageSize
	if end > len(sorted) {
		end = len(sorted)
	}
	return GenerationJobPage{Items: sorted[start:end], Page: page, PageSize: pageSize, Total: len(sorted)}
}

type LibraryAssetKind = string

const (
	LibraryAssetText  LibraryAssetKind = "text"
	LibraryAssetImage LibraryAssetKind = "image"
	LibraryAssetVideo LibraryAssetKind = "video"
	LibraryAssetAudio LibraryAssetKind = "audio"
)

// LibraryAsset is a tenant-scoped server material-library entry (URL/text only).
type LibraryAsset struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Title     string   `json:"title"`
	Tags      []string `json:"tags"`
	Content   string   `json:"content,omitempty"`
	CoverURL  string   `json:"coverUrl,omitempty"`
	Source    string   `json:"source,omitempty"`
	Notes     string   `json:"notes,omitempty"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
}

type LibraryAssetQuery struct {
	Q        string
	Kind     string
	Tag      string
	Page     int
	PageSize int
}

type LibraryAssetPage struct {
	Items    []LibraryAsset `json:"items"`
	Page     int            `json:"page"`
	PageSize int            `json:"pageSize"`
	Total    int            `json:"total"`
}

// AICallLog captures one backend AI proxy invocation for admin audit.
type AICallLog struct {
	ID           string          `json:"id"`
	JobID        string          `json:"jobId,omitempty"`
	UserID       string          `json:"userId,omitempty"`
	Kind         string          `json:"kind"`
	ChannelID    string          `json:"channelId,omitempty"`
	ChannelName  string          `json:"channelName,omitempty"`
	Model        string          `json:"model,omitempty"`
	Protocol     string          `json:"protocol,omitempty"`
	Status       string          `json:"status"`
	DurationMs   int64           `json:"durationMs"`
	Error        string          `json:"error,omitempty"`
	RequestJSON  json.RawMessage `json:"request,omitempty"`
	ResponseJSON json.RawMessage `json:"response,omitempty"`
	CreatedAt    string          `json:"createdAt"`
}

type AICallLogQuery struct {
	Q        string
	Kind     string
	Status   string
	Channel  string
	Page     int
	PageSize int
}

type AICallLogPage struct {
	Items    []AICallLog `json:"items"`
	Page     int         `json:"page"`
	PageSize int         `json:"pageSize"`
	Total    int         `json:"total"`
}

type UserQuery struct {
	Q        string
	Page     int
	PageSize int
}

type UserPage struct {
	Items    []AuthUser `json:"items"`
	Page     int        `json:"page"`
	PageSize int        `json:"pageSize"`
	Total    int        `json:"total"`
}

type TenantQuery struct {
	Q        string
	Page     int
	PageSize int
}

type TenantPage struct {
	Items    []Tenant `json:"items"`
	Page     int      `json:"page"`
	PageSize int      `json:"pageSize"`
	Total    int      `json:"total"`
}

type PlatformUserQuery struct {
	TenantID string
	Q        string
	Page     int
	PageSize int
}

type TenantInvitation struct {
	ID             string     `json:"id"`
	TenantID       string     `json:"tenantId"`
	Email          string     `json:"email"`
	Role           string     `json:"role"`
	ExpiresAt      time.Time  `json:"expiresAt"`
	AcceptedAt     *time.Time `json:"acceptedAt,omitempty"`
	AcceptedUserID string     `json:"acceptedUserId,omitempty"`
	RevokedAt      *time.Time `json:"revokedAt,omitempty"`
	CreatedBy      string     `json:"createdBy"`
	CreatedAt      time.Time  `json:"createdAt"`
}

type TenantInvitationInput struct {
	TenantID  string
	CreatedBy string
	Email     string
	Role      string
	ExpiresAt time.Time
}

type CreatedTenantInvitation struct {
	TenantInvitation
	Token string `json:"token"`
}

type UserPatch struct {
	Role         *string `json:"role,omitempty"`
	Status       *string `json:"status,omitempty"`
	DisplayName  *string `json:"displayName,omitempty"`
	CreditsDelta *int64  `json:"creditsDelta,omitempty"`
	ActorRole    string  `json:"-"`
}

type LinuxDoUserInput struct {
	LinuxDoID   string
	Email       string
	DisplayName string
	Username    string
}

type MediaReference struct {
	Token      string    `json:"token"`
	TenantID   string    `json:"tenantId"`
	StorageKey string    `json:"storageKey"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

type ModelCreditCost struct {
	Model   string `json:"model"`
	Credits int    `json:"credits"`
}

type ModelCreditConfig struct {
	ModelCosts     []ModelCreditCost `json:"modelCosts"`
	DefaultCredits int               `json:"defaultCredits"`
}

type CreditLog struct {
	ID             int64           `json:"id"`
	TenantID       string          `json:"-"`
	UserID         string          `json:"userId"`
	ActorID        string          `json:"actorId,omitempty"`
	JobID          string          `json:"jobId,omitempty"`
	Model          string          `json:"model,omitempty"`
	Delta          int64           `json:"delta"`
	BalanceAfter   int64           `json:"balanceAfter"`
	Reason         string          `json:"reason"`
	IdempotencyKey string          `json:"idempotencyKey,omitempty"`
	Meta           json.RawMessage `json:"meta,omitempty"`
	CreatedAt      time.Time       `json:"createdAt"`
}

type CreditLogQuery struct {
	UserID   string
	Reason   string
	Model    string
	Page     int
	PageSize int
}

type CreditLogPage struct {
	Items    []CreditLog `json:"items"`
	Page     int         `json:"page"`
	PageSize int         `json:"pageSize"`
	Total    int         `json:"total"`
}

type StateMutation struct {
	Key      string
	Expected []byte
	Value    []byte
}

// FilmRecord stores the authoritative, revisioned film workbench document for
// one tenant-owned board project. Entity revisions live inside Document; this
// row revision protects atomic multi-entity updates.
type FilmRecord struct {
	ProjectID string          `json:"projectId"`
	Revision  int             `json:"revision"`
	Document  json.RawMessage `json:"document"`
	UpdatedAt string          `json:"updatedAt"`
}

// FilmStore is an optional capability implemented by PostgreSQL-backed stores.
// Keeping it separate preserves the lightweight filesystem-only companion.
type FilmStore interface {
	GetFilmProject(ctx context.Context, tenantID, projectID string) (FilmRecord, error)
	CreateFilmProject(ctx context.Context, tenantID, projectID string, document []byte) (FilmRecord, error)
	CompareAndSwapFilmProject(ctx context.Context, tenantID, projectID string, expectedRevision int, document []byte) (FilmRecord, error)
}

// VoiceIdentity is the mutable display record for a project voice. Generated
// voice material lives in immutable VoiceIdentityVersion snapshots below.
type VoiceIdentity struct {
	ID               string `json:"id"`
	ProjectID        string `json:"projectId"`
	Revision         int    `json:"revision"`
	Title            string `json:"title"`
	Description      string `json:"description,omitempty"`
	CurrentVersionID string `json:"currentVersionId,omitempty"`
	CreatedAt        string `json:"createdAt"`
	UpdatedAt        string `json:"updatedAt"`
}

// VoiceSample references tenant-owned media without duplicating its bytes in
// PostgreSQL. The digest and object version freeze the exact consented input.
type VoiceSample struct {
	ID                 string `json:"id"`
	ProjectID          string `json:"projectId"`
	VoiceIdentityID    string `json:"voiceIdentityId"`
	Label              string `json:"label,omitempty"`
	StorageKey         string `json:"storageKey"`
	MIMEType           string `json:"mimeType"`
	SHA256             string `json:"sha256"`
	MediaObjectVersion string `json:"mediaObjectVersion,omitempty"`
	CreatedAt          string `json:"createdAt"`
}

// VoiceConsent is append-only audit evidence. Accepted=false is intentionally
// not persisted: absence of affirmative consent can never authorize cloning.
type VoiceConsent struct {
	ID                    string `json:"id"`
	ProjectID             string `json:"projectId"`
	VoiceIdentityID       string `json:"voiceIdentityId"`
	Accepted              bool   `json:"accepted"`
	RightsBasis           string `json:"rightsBasis"`
	SubjectDisplayName    string `json:"subjectDisplayName"`
	TermsVersion          string `json:"termsVersion"`
	EvidenceStorageKey    string `json:"evidenceStorageKey"`
	EvidenceMIMEType      string `json:"evidenceMimeType"`
	EvidenceSHA256        string `json:"evidenceSHA256"`
	EvidenceObjectVersion string `json:"evidenceObjectVersion"`
	ActorID               string `json:"actorId"`
	AcceptedAt            string `json:"acceptedAt"`
}

// VoiceIdentityVersion freezes all clone inputs. Lifecycle fields may move
// from queued/running to one terminal state, but snapshot fields never change.
type VoiceIdentityVersion struct {
	ID                 string   `json:"id"`
	ProjectID          string   `json:"projectId"`
	VoiceIdentityID    string   `json:"voiceIdentityId"`
	Revision           int      `json:"revision"`
	Status             string   `json:"status"`
	SampleIDs          []string `json:"sampleIds"`
	ConsentID          string   `json:"consentId"`
	ProviderID         string   `json:"providerId"`
	Model              string   `json:"model"`
	ProviderVoiceID    string   `json:"providerVoiceId,omitempty"`
	GenerationJobID    string   `json:"generationJobId"`
	IdempotencyKeyHash string   `json:"-"`
	Error              string   `json:"error,omitempty"`
	CreatedAt          string   `json:"createdAt"`
	UpdatedAt          string   `json:"updatedAt"`
}

// VoiceIdentityStore is an optional PostgreSQL capability. Every operation is
// tenant and project scoped; samples, consents and versions are append-only.
type VoiceIdentityStore interface {
	CreateVoiceIdentity(ctx context.Context, tenantID, projectID string, value VoiceIdentity) (VoiceIdentity, error)
	GetVoiceIdentity(ctx context.Context, tenantID, projectID, id string) (VoiceIdentity, error)
	ListVoiceIdentities(ctx context.Context, tenantID, projectID string) ([]VoiceIdentity, error)
	AddVoiceSample(ctx context.Context, tenantID, projectID string, value VoiceSample) (VoiceSample, error)
	GetVoiceSample(ctx context.Context, tenantID, projectID, id string) (VoiceSample, error)
	ListVoiceSamples(ctx context.Context, tenantID, projectID, voiceIdentityID string) ([]VoiceSample, error)
	CreateVoiceConsent(ctx context.Context, tenantID, projectID string, value VoiceConsent) (VoiceConsent, error)
	GetVoiceConsent(ctx context.Context, tenantID, projectID, id string) (VoiceConsent, error)
	ListVoiceConsents(ctx context.Context, tenantID, projectID, voiceIdentityID string) ([]VoiceConsent, error)
	ListVoiceIdentityVersions(ctx context.Context, tenantID, projectID, voiceIdentityID string) ([]VoiceIdentityVersion, error)
	CompleteVoiceIdentityVersion(ctx context.Context, tenantID, projectID, versionID, jobID, status, providerVoiceID, message, updatedAt string) (VoiceIdentityVersion, error)
}

// VoiceCloneBatchStore is the production transaction boundary for voice
// cloning. A queued job must never become claimable before its immutable voice
// version and sample links exist, and the model quote must match the amount
// reserved in the same transaction.
type VoiceCloneBatchStore interface {
	CreateVoiceCloneBatch(
		ctx context.Context,
		tenantID, userID, projectID, idempotencyKeyHash string,
		value VoiceIdentityVersion,
		job GenerationJob,
		units int,
		usageMeta json.RawMessage,
		expectedCredits int,
	) (VoiceIdentityVersion, bool, error)
}

type FilmGenerationReservation struct {
	Job       GenerationJob
	Units     int
	UsageMeta json.RawMessage
	// ExpectedCredits binds a user-confirmed quote to the transactional model price.
	// Nil is accepted for legacy/non-interactive generation; repair confirmations set it.
	ExpectedCredits *int
}

// FilmGenerationBatchStore commits the aggregate revision, queued jobs and
// their quota/credit reservations as one serializable transaction.
type FilmGenerationBatchStore interface {
	CreateFilmGenerationBatch(
		ctx context.Context,
		tenantID, userID, projectID string,
		expectedRevision int,
		document []byte,
		reservations []FilmGenerationReservation,
	) (FilmRecord, error)
}

// FilmRestoreStore makes the film aggregate update and its rollback point one
// durable operation. Tokens are stored as digests and are tenant/project bound.
type FilmRestoreStore interface {
	RestoreFilmProject(ctx context.Context, tenantID, projectID string, expectedRevision int, document []byte, tokenDigest string, expiresAt time.Time, createdMedia []WorkspaceMedia) (FilmRecord, error)
	RollbackFilmProject(ctx context.Context, tenantID, projectID string, expectedRevision int, tokenDigest string, now time.Time) (FilmRecord, bool, error)
}

type WorkspaceProject struct {
	ID       string          `json:"id"`
	Document json.RawMessage `json:"document"`
}

type WorkspaceFilm struct {
	ProjectID string          `json:"projectId"`
	Revision  int             `json:"revision,omitempty"`
	Document  json.RawMessage `json:"document"`
}

type WorkspaceGenerationJob struct {
	Job       GenerationJob `json:"job"`
	DeletedAt string        `json:"deletedAt,omitempty"`
}

type WorkspaceState struct {
	Key    string          `json:"key"`
	Exists bool            `json:"exists"`
	Value  json.RawMessage `json:"value,omitempty"`
}

type WorkspaceMedia struct {
	ProjectID  string `json:"projectId"`
	StorageKey string `json:"storageKey"`
}

type FilmCleanupGeneration struct {
	GenerationID string            `json:"generationId"`
	ProjectID    string            `json:"projectId"`
	Documents    []json.RawMessage `json:"documents"`
	Media        []WorkspaceMedia  `json:"media"`
}

type FilmCleanupStore interface {
	DeleteProjectWithFilmCleanup(ctx context.Context, tenantID, projectID, generationID string) error
	ListFilmCleanupGenerations(ctx context.Context, tenantID, projectID string) ([]FilmCleanupGeneration, error)
	CompleteFilmCleanupGeneration(ctx context.Context, tenantID, projectID, generationID string) error
}

type WorkspaceSnapshot struct {
	Projects       []WorkspaceProject       `json:"projects"`
	Films          []WorkspaceFilm          `json:"films"`
	GenerationJobs []WorkspaceGenerationJob `json:"generationJobs"`
	States         []WorkspaceState         `json:"states"`
}

type WorkspaceReplaceResult struct {
	Version           string
	CleanupProjectIDs []string
}

// WorkspaceStore atomically replaces board projects and their Film aggregates.
// Its rollback token is opaque, tenant-bound, single-use, and CAS-protected by
// the workspace version produced by the replacement.
type WorkspaceStore interface {
	WorkspaceVersion(ctx context.Context, tenantID string) (string, error)
	ReplaceWorkspace(ctx context.Context, tenantID, expectedVersion, tokenDigest string, expiresAt time.Time, snapshot WorkspaceSnapshot, createdMedia []WorkspaceMedia) (WorkspaceReplaceResult, error)
	ReplaceWorkspaceProject(ctx context.Context, tenantID, projectID, expectedVersion, tokenDigest string, expiresAt time.Time, project WorkspaceProject, film *WorkspaceFilm, createdMedia []WorkspaceMedia) (WorkspaceReplaceResult, error)
	RollbackWorkspace(ctx context.Context, tenantID, expectedVersion, tokenDigest string, now time.Time) (WorkspaceReplaceResult, error)
}

func ComputeWorkspaceVersion(snapshot WorkspaceSnapshot) (string, error) {
	projects := append([]WorkspaceProject(nil), snapshot.Projects...)
	films := append([]WorkspaceFilm(nil), snapshot.Films...)
	jobs := append([]WorkspaceGenerationJob(nil), snapshot.GenerationJobs...)
	states := append([]WorkspaceState(nil), snapshot.States...)
	sort.Slice(projects, func(i, j int) bool { return projects[i].ID < projects[j].ID })
	sort.Slice(films, func(i, j int) bool { return films[i].ProjectID < films[j].ProjectID })
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].Job.ID < jobs[j].Job.ID })
	sort.Slice(states, func(i, j int) bool { return states[i].Key < states[j].Key })
	hash := sha256.New()
	for _, project := range projects {
		var value any
		if json.Unmarshal(project.Document, &value) != nil {
			return "", ErrInvalidInput
		}
		canonical, _ := json.Marshal(value)
		_, _ = hash.Write([]byte("project\x00" + project.ID + "\x00"))
		_, _ = hash.Write(canonical)
	}
	for _, film := range films {
		var value any
		if json.Unmarshal(film.Document, &value) != nil {
			return "", ErrInvalidInput
		}
		canonical, _ := json.Marshal(value)
		_, _ = hash.Write([]byte("film\x00" + film.ProjectID + "\x00"))
		_, _ = hash.Write(canonical)
	}
	for _, item := range jobs {
		canonical, err := json.Marshal(item)
		if err != nil || !json.Valid(item.Job.Parameters) || !json.Valid(item.Job.Result) {
			return "", ErrInvalidInput
		}
		_, _ = hash.Write([]byte("job\x00" + item.Job.ID + "\x00"))
		_, _ = hash.Write(canonical)
	}
	for _, state := range states {
		if state.Exists && !json.Valid(state.Value) {
			return "", ErrInvalidInput
		}
		_, _ = hash.Write([]byte("state\x00" + state.Key + "\x00"))
		if state.Exists {
			var value any
			_ = json.Unmarshal(state.Value, &value)
			canonical, _ := json.Marshal(value)
			_, _ = hash.Write(canonical)
		} else {
			_, _ = hash.Write([]byte("absent"))
		}
	}
	return "w1-" + hex.EncodeToString(hash.Sum(nil)), nil
}

type Store interface {
	Close()
	Ping(context.Context) error
	ListProjects(ctx context.Context, tenantID string) ([]ProjectSummary, error)
	GetProject(ctx context.Context, tenantID, id string) ([]byte, error)
	PutProject(ctx context.Context, tenantID, id string, document []byte) error
	CompareAndSwapProject(ctx context.Context, tenantID, id string, expected, document []byte) error
	DeleteProject(ctx context.Context, tenantID, id string) error
	GetState(ctx context.Context, tenantID, key string) ([]byte, error)
	GetStates(ctx context.Context, tenantID string, keys []string) (map[string][]byte, error)
	PutState(ctx context.Context, tenantID, key string, value []byte) error
	CompareAndSwapState(ctx context.Context, tenantID, key string, expected, value []byte) error
	CompareAndSwapStates(ctx context.Context, tenantID string, mutations []StateMutation) error
	ListGenerationJobs(ctx context.Context, tenantID string, query GenerationJobQuery) (GenerationJobPage, error)
	GetGenerationJob(ctx context.Context, tenantID, id string) (GenerationJob, error)
	CreateGenerationJob(ctx context.Context, tenantID string, job GenerationJob) error
	CreateServerGenerationJob(ctx context.Context, tenantID, userID string, job GenerationJob, units int, usageMeta json.RawMessage) error
	PutGenerationJob(ctx context.Context, tenantID string, job GenerationJob) error
	ClaimServerGenerationJob(ctx context.Context, claim GenerationClaim, owner string, now, leaseUntil time.Time) (TenantGenerationJob, error)
	RenewServerGenerationJobLease(ctx context.Context, tenantID, id, owner string, now, leaseUntil time.Time) error
	CheckpointServerGenerationJob(ctx context.Context, tenantID, id, owner string, result json.RawMessage, now time.Time) (GenerationJob, error)
	CompleteServerGenerationJob(ctx context.Context, tenantID, id, owner, status string, result json.RawMessage, errorMessage string, now time.Time) (GenerationJob, error)
	CancelServerGenerationJob(ctx context.Context, tenantID, id string, now time.Time) (GenerationJob, error)
	DeleteGenerationJob(ctx context.Context, tenantID, id string) error
	DeleteGenerationJobs(ctx context.Context, tenantID string, ids []string) (int64, error)
	DeleteGenerationJobsForProject(ctx context.Context, tenantID, projectID string) (int64, error)
	ReplaceGenerationJobs(ctx context.Context, tenantID string, jobs []GenerationJob) error
	CompareAndSwapGenerationJobs(ctx context.Context, tenantID, expectedVersion string, jobs []GenerationJob) error

	// Server material library (tenant-scoped URL/text catalog).
	ListLibraryAssets(ctx context.Context, tenantID string, query LibraryAssetQuery) (LibraryAssetPage, error)
	GetLibraryAsset(ctx context.Context, tenantID, id string) (LibraryAsset, error)
	CreateLibraryAsset(ctx context.Context, tenantID string, asset LibraryAsset) (LibraryAsset, error)
	UpdateLibraryAsset(ctx context.Context, tenantID string, asset LibraryAsset) (LibraryAsset, error)
	DeleteLibraryAsset(ctx context.Context, tenantID, id string) error
	// AI call logs (backend proxy audit trail).
	CreateAICallLog(ctx context.Context, tenantID string, entry AICallLog) (AICallLog, error)
	ListAICallLogs(ctx context.Context, tenantID string, query AICallLogQuery) (AICallLogPage, error)
	GetAICallLog(ctx context.Context, tenantID, id string) (AICallLog, error)
	DeleteAICallLogsBefore(ctx context.Context, tenantID string, before time.Time) (int64, error)
	DeleteAICallLogs(ctx context.Context, tenantID string, ids []string) (int64, error)
	// Auth and usage (no-op or limited on non-postgres backends).
	CountUsers(ctx context.Context) (int, error)
	RegisterUser(ctx context.Context, input RegisterInput) (AuthUser, string, error) // user, sessionToken, err
	LoginUser(ctx context.Context, email, password string) (AuthUser, string, error)
	LogoutSession(ctx context.Context, sessionToken string) error
	LookupSession(ctx context.Context, sessionToken string) (AuthUser, error)
	GetTenant(ctx context.Context, tenantID string) (Tenant, error)
	UpdateTenantGenerationQuota(ctx context.Context, tenantID string, quota int64) (Tenant, error)
	RecordUsage(ctx context.Context, tenantID, userID, kind string, units int, meta json.RawMessage) error
	GetUsage(ctx context.Context, tenantID string) (UsageSummary, error)
	CheckGenerationQuota(ctx context.Context, tenantID string) error
	CheckStorageQuota(ctx context.Context, tenantID string, additionalBytes int64) error
	ReserveStorageUsage(ctx context.Context, tenantID, userID string, additionalBytes int64, meta json.RawMessage) error
	ReleaseStorageUsage(ctx context.Context, tenantID, userID string, bytes int64, meta json.RawMessage) error
	// Credits, users, media references, and admin billing.
	GetUser(ctx context.Context, tenantID, userID string) (AuthUser, error)
	ListUsers(ctx context.Context, tenantID string, query UserQuery) (UserPage, error)
	UpdateUser(ctx context.Context, tenantID string, userID string, patch UserPatch) (AuthUser, error)
	GetModelCreditConfig(ctx context.Context, tenantID string) (ModelCreditConfig, error)
	PutModelCreditConfig(ctx context.Context, tenantID string, config ModelCreditConfig) error
	GetModelCreditCost(ctx context.Context, tenantID, model string) (int, error)
	ListCreditLogs(ctx context.Context, tenantID string, query CreditLogQuery) (CreditLogPage, error)
	AdjustCreditsIdempotent(ctx context.Context, tenantID, userID, actorID, idempotencyKey string, delta int64, reason string, meta json.RawMessage) (AuthUser, CreditLog, bool, error)
	ReserveCredits(ctx context.Context, tenantID, userID, jobID, model string, amount int, meta json.RawMessage) error
	RefundCredits(ctx context.Context, tenantID, userID, jobID, reason string) error
	AdjustCredits(ctx context.Context, tenantID, userID string, delta int, reason string, meta json.RawMessage) (AuthUser, error)
	UpsertLinuxDoUser(ctx context.Context, input LinuxDoUserInput) (AuthUser, string, error)
	CreateMediaReference(ctx context.Context, tenantID, storageKey string, expiresAt time.Time) (MediaReference, error)
	GetMediaReference(ctx context.Context, token string) (MediaReference, error)
	DeleteExpiredMediaReferences(ctx context.Context, now time.Time) (int64, error)
	PurgeExpiredTombstones(ctx context.Context, now time.Time) (int64, error)
}

// PlatformAdminStore is an optional capability implemented by persistent
// stores that can serve server-level administration without weakening the
// tenant-scoped Store contract.
type PlatformAdminStore interface {
	ListTenants(ctx context.Context, query TenantQuery) (TenantPage, error)
	ListPlatformUsers(ctx context.Context, query PlatformUserQuery) (UserPage, error)
	GetUserAnyTenant(ctx context.Context, userID string) (AuthUser, error)
}

// InvitationStore contains the tenant invitation operations used by the
// registration flow. Invitation tokens are returned only at creation time;
// persistent stores must retain only a hash.
type InvitationStore interface {
	CreateTenantInvitation(ctx context.Context, input TenantInvitationInput) (CreatedTenantInvitation, error)
	ListTenantInvitations(ctx context.Context, tenantID string) ([]TenantInvitation, error)
	RevokeTenantInvitation(ctx context.Context, tenantID, invitationID string) error
}

func GenerationJobsVersion(jobs []GenerationJob) string {
	ordered := append([]GenerationJob(nil), jobs...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	value, _ := json.Marshal(ordered)
	sum := sha256.Sum256(value)
	return "m1-" + hex.EncodeToString(sum[:])
}
