package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
)

var ErrNotFound = errors.New("not found")

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
	ListProjects(context.Context) ([]ProjectSummary, error)
	GetProject(context.Context, string) ([]byte, error)
	PutProject(context.Context, string, []byte) error
	DeleteProject(context.Context, string) error
	GetState(context.Context, string) ([]byte, error)
	PutState(context.Context, string, []byte) error
	ListGenerationJobs(context.Context, GenerationJobQuery) (GenerationJobPage, error)
	GetGenerationJob(context.Context, string) (GenerationJob, error)
	PutGenerationJob(context.Context, GenerationJob) error
	DeleteGenerationJob(context.Context, string) error
}
