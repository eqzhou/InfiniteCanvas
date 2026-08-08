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
	ID          string `json:"id"`
	TenantID    string `json:"tenantId"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	Credits     int64  `json:"credits"`
	Status      string `json:"status,omitempty"`
	LinuxDoID   string `json:"linuxDoId,omitempty"`
}

type Tenant struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Plan                   string `json:"plan"`
	StorageQuotaBytes      int64  `json:"storageQuotaBytes"`
	GenerationQuotaMonthly int64  `json:"generationQuotaMonthly"`
	CreatedAt              string `json:"createdAt"`
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

func GenerationJobsVersion(jobs []GenerationJob) string {
	ordered := append([]GenerationJob(nil), jobs...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	value, _ := json.Marshal(ordered)
	sum := sha256.Sum256(value)
	return "m1-" + hex.EncodeToString(sum[:])
}
