package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
)

var (
	ErrNotFound       = errors.New("not found")
	ErrConflict       = errors.New("conflict")
	ErrQuotaExceeded  = errors.New("quota exceeded")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrUnauthorized   = errors.New("unauthorized")
)

const DefaultTenantID = "local"

type ProjectSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updatedAt"`
}

type GenerationJob struct {
	ID         string          `json:"id"`
	ProjectID  string          `json:"projectId,omitempty"`
	Kind       string          `json:"kind"`
	Status     string          `json:"status"`
	Prompt     string          `json:"prompt"`
	ProviderID string          `json:"providerId,omitempty"`
	Model      string          `json:"model,omitempty"`
	Parameters json.RawMessage `json:"parameters"`
	Result     json.RawMessage `json:"result"`
	Error      string          `json:"error,omitempty"`
	CreatedAt  string          `json:"createdAt"`
	UpdatedAt  string          `json:"updatedAt"`
}

type GenerationJobQuery struct {
	ProjectID string
	Kind      string
	Page      int
	PageSize  int
}

type GenerationJobPage struct {
	Items    []GenerationJob `json:"items"`
	Page     int             `json:"page"`
	PageSize int             `json:"pageSize"`
	Total    int             `json:"total"`
}

type AuthUser struct {
	ID          string `json:"id"`
	TenantID    string `json:"tenantId"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
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
	StorageBytes         int64  `json:"storageBytes"`
	GenerationThisMonth  int64  `json:"generationThisMonth"`
	StorageQuotaBytes    int64  `json:"storageQuotaBytes"`
	GenerationQuotaMonthly int64 `json:"generationQuotaMonthly"`
	Plan                 string `json:"plan"`
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

type Store interface {
	Close()
	Ping(context.Context) error
	ListProjects(ctx context.Context, tenantID string) ([]ProjectSummary, error)
	GetProject(ctx context.Context, tenantID, id string) ([]byte, error)
	PutProject(ctx context.Context, tenantID, id string, document []byte) error
	DeleteProject(ctx context.Context, tenantID, id string) error
	GetState(ctx context.Context, tenantID, key string) ([]byte, error)
	PutState(ctx context.Context, tenantID, key string, value []byte) error
	ListGenerationJobs(ctx context.Context, tenantID string, query GenerationJobQuery) (GenerationJobPage, error)
	GetGenerationJob(ctx context.Context, tenantID, id string) (GenerationJob, error)
	PutGenerationJob(ctx context.Context, tenantID string, job GenerationJob) error
	DeleteGenerationJob(ctx context.Context, tenantID, id string) error
	ReplaceGenerationJobs(ctx context.Context, tenantID string, jobs []GenerationJob) error

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
}
