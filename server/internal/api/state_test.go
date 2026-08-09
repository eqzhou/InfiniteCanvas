package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

type memoryStore struct {
	mu                     sync.RWMutex
	projects               map[string][]byte
	state                  map[string][]byte
	jobs                   map[string]store.GenerationJob
	libraryAssets          map[string]store.LibraryAsset
	aiCallLogs             map[string]store.AICallLog
	storageUsage           int64
	users                  int
	releases               map[string]struct{}
	reservations           map[string]struct{}
	compareAndSwapStateErr error
	generationJobCreateErr error
	generationJobPutErr    error
	authUsers              map[string]store.AuthUser
	credits                map[string]int64
	creditLogs             map[string]struct{}
	creditReserveAmounts   map[string]int64
	creditReserveUsers     map[string]string
	creditLogItems         []store.CreditLog
	creditAdjustments      map[string]string
	updateUserErr          error
	mediaRefs              map[string]store.MediaReference
}

func tenantKey(tenantID, key string) string {
	if tenantID == "" {
		tenantID = store.DefaultTenantID
	}
	return tenantID + "\x00" + key
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		projects:             map[string][]byte{},
		state:                map[string][]byte{},
		jobs:                 map[string]store.GenerationJob{},
		libraryAssets:        map[string]store.LibraryAsset{},
		aiCallLogs:           map[string]store.AICallLog{},
		releases:             map[string]struct{}{},
		reservations:         map[string]struct{}{},
		authUsers:            map[string]store.AuthUser{},
		credits:              map[string]int64{},
		creditLogs:           map[string]struct{}{},
		creditReserveAmounts: map[string]int64{},
		creditReserveUsers:   map[string]string{},
		creditAdjustments:    map[string]string{},
		mediaRefs:            map[string]store.MediaReference{},
	}
}

func (*memoryStore) Close()                     {}
func (*memoryStore) Ping(context.Context) error { return nil }
func (m *memoryStore) ListProjects(_ context.Context, tenantID string) ([]store.ProjectSummary, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]store.ProjectSummary, 0, len(m.projects))
	prefix := tenantKey(tenantID, "")
	for key := range m.projects {
		if len(key) < len(prefix) || key[:len(prefix)] != prefix {
			continue
		}
		id := key[len(prefix):]
		out = append(out, store.ProjectSummary{ID: id})
	}
	return out, nil
}
func (m *memoryStore) GetProject(_ context.Context, tenantID, id string) ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	value, ok := m.projects[tenantKey(tenantID, id)]
	if !ok {
		return nil, store.ErrNotFound
	}
	return append([]byte(nil), value...), nil
}
func (m *memoryStore) PutProject(_ context.Context, tenantID, id string, value []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.projects[tenantKey(tenantID, id)] = append([]byte(nil), value...)
	return nil
}
func (m *memoryStore) CompareAndSwapProject(_ context.Context, tenantID, id string, expected, value []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, id)
	current, exists := m.projects[key]
	if (!exists && expected != nil) || (exists && (expected == nil || !bytes.Equal(current, expected))) {
		return store.ErrConflict
	}
	m.projects[key] = append([]byte(nil), value...)
	return nil
}
func (m *memoryStore) DeleteProject(_ context.Context, tenantID, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.projects, tenantKey(tenantID, id))
	for key, job := range m.jobs {
		if strings.HasPrefix(key, tenantKey(tenantID, "")) && job.ProjectID == id {
			delete(m.jobs, key)
		}
	}
	return nil
}
func (m *memoryStore) GetState(_ context.Context, tenantID, key string) ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	value, ok := m.state[tenantKey(tenantID, key)]
	if !ok {
		return nil, store.ErrNotFound
	}
	return append([]byte(nil), value...), nil
}

func (m *memoryStore) GetStates(_ context.Context, tenantID string, keys []string) (map[string][]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	values := make(map[string][]byte, len(keys))
	for _, key := range keys {
		if value, ok := m.state[tenantKey(tenantID, key)]; ok {
			values[key] = append([]byte(nil), value...)
		}
	}
	return values, nil
}

func (m *memoryStore) ListStateTenants(_ context.Context, key string) ([]string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	suffix := "\x00" + key
	seen := map[string]struct{}{}
	for storageKey := range m.state {
		if strings.HasSuffix(storageKey, suffix) {
			seen[strings.TrimSuffix(storageKey, suffix)] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for tenantID := range seen {
		out = append(out, tenantID)
	}
	sort.Strings(out)
	return out, nil
}
func (m *memoryStore) PutState(_ context.Context, tenantID, key string, value []byte) error {
	if !json.Valid(value) {
		return errors.New("invalid json")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state[tenantKey(tenantID, key)] = append([]byte(nil), value...)
	return nil
}

func (m *memoryStore) CompareAndSwapState(_ context.Context, tenantID, key string, expected, value []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.compareAndSwapStateErr != nil {
		return m.compareAndSwapStateErr
	}
	storageKey := tenantKey(tenantID, key)
	current, exists := m.state[storageKey]
	if (!exists && expected != nil) || (exists && (expected == nil || !bytes.Equal(current, expected))) {
		return store.ErrConflict
	}
	m.state[storageKey] = append([]byte(nil), value...)
	return nil
}

func (m *memoryStore) CompareAndSwapStates(_ context.Context, tenantID string, mutations []store.StateMutation) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.compareAndSwapStateErr != nil {
		return m.compareAndSwapStateErr
	}
	for _, mutation := range mutations {
		current, exists := m.state[tenantKey(tenantID, mutation.Key)]
		if (!exists && mutation.Expected != nil) ||
			(exists && (mutation.Expected == nil || !bytes.Equal(current, mutation.Expected))) {
			return store.ErrConflict
		}
	}
	for _, mutation := range mutations {
		m.state[tenantKey(tenantID, mutation.Key)] = append([]byte(nil), mutation.Value...)
	}
	return nil
}

func (m *memoryStore) ListGenerationJobs(_ context.Context, tenantID string, query store.GenerationJobQuery) (store.GenerationJobPage, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	items := make([]store.GenerationJob, 0, len(m.jobs))
	prefix := tenantKey(tenantID, "")
	for key, job := range m.jobs {
		if len(key) < len(prefix) || key[:len(prefix)] != prefix {
			continue
		}
		if !query.IncludeDeleted && job.Status == "deleted" {
			continue
		}
		if query.ProjectID != "" && job.ProjectID != query.ProjectID {
			continue
		}
		if query.Kind != "" && job.Kind != query.Kind {
			continue
		}
		items = append(items, job)
	}
	return store.PaginateGenerationJobs(items, query.Page, query.PageSize), nil
}

func (m *memoryStore) GetGenerationJob(_ context.Context, tenantID, id string) (store.GenerationJob, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	job, ok := m.jobs[tenantKey(tenantID, id)]
	if !ok || job.Status == "deleted" {
		return store.GenerationJob{}, store.ErrNotFound
	}
	return job, nil
}

func (m *memoryStore) PutGenerationJob(_ context.Context, tenantID string, job store.GenerationJob) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if job.Status == "deleted" {
		return store.ErrGone
	}
	if m.generationJobPutErr != nil {
		return m.generationJobPutErr
	}
	if current, exists := m.jobs[tenantKey(tenantID, job.ID)]; exists && current.Status == "deleted" {
		return store.ErrGone
	}
	m.jobs[tenantKey(tenantID, job.ID)] = job
	return nil
}

func (m *memoryStore) CreateGenerationJob(_ context.Context, tenantID string, job store.GenerationJob) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if job.Status == "deleted" {
		return store.ErrGone
	}
	if m.generationJobCreateErr != nil {
		return m.generationJobCreateErr
	}
	key := tenantKey(tenantID, job.ID)
	if current, exists := m.jobs[key]; exists {
		if current.Status == "deleted" {
			return store.ErrGone
		}
		return store.ErrConflict
	}
	m.jobs[key] = job
	return nil
}

func (m *memoryStore) CreateServerGenerationJob(_ context.Context, tenantID, _ string, job store.GenerationJob, _ int, _ json.RawMessage) error {
	return m.CreateGenerationJob(context.Background(), tenantID, job)
}

func (m *memoryStore) ClaimServerGenerationJob(_ context.Context, claim store.GenerationClaim, owner string, now, leaseUntil time.Time) (store.TenantGenerationJob, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, job := range m.jobs {
		var parameters struct {
			Executor string `json:"executor"`
		}
		if json.Unmarshal(job.Parameters, &parameters) != nil || job.Kind != claim.Kind || parameters.Executor != claim.Executor {
			continue
		}
		leaseExpired := job.LeaseExpiresAt == ""
		if job.LeaseExpiresAt != "" {
			lease, err := time.Parse(time.RFC3339Nano, job.LeaseExpiresAt)
			leaseExpired = err == nil && lease.Before(now)
		}
		if job.Status != "queued" && !(job.Status == "running" && leaseExpired) {
			continue
		}
		job.Status = "running"
		job.LeaseOwner = owner
		job.LeaseExpiresAt = leaseUntil.UTC().Format(time.RFC3339Nano)
		job.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
		m.jobs[key] = job
		tenantID := key[:len(key)-len(job.ID)-1]
		return store.TenantGenerationJob{TenantID: tenantID, Job: job}, nil
	}
	return store.TenantGenerationJob{}, store.ErrNotFound
}

func (m *memoryStore) CheckpointServerGenerationJob(_ context.Context, tenantID, id, owner string, result json.RawMessage, now time.Time) (store.GenerationJob, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, id)
	job, ok := m.jobs[key]
	if !ok || job.Status != "running" || job.LeaseOwner != owner {
		return store.GenerationJob{}, store.ErrConflict
	}
	job.Result = append(json.RawMessage(nil), result...)
	job.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
	m.jobs[key] = job
	return job, nil
}

func (m *memoryStore) RenewServerGenerationJobLease(_ context.Context, tenantID, id, owner string, now, leaseUntil time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, id)
	job, ok := m.jobs[key]
	if !ok || job.Status != "running" || job.LeaseOwner != owner {
		return store.ErrConflict
	}
	job.LeaseExpiresAt = leaseUntil.UTC().Format(time.RFC3339Nano)
	job.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
	m.jobs[key] = job
	return nil
}

func (m *memoryStore) CompleteServerGenerationJob(_ context.Context, tenantID, id, owner, status string, result json.RawMessage, errorMessage string, now time.Time) (store.GenerationJob, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, id)
	job, ok := m.jobs[key]
	if !ok {
		return store.GenerationJob{}, store.ErrNotFound
	}
	if job.Status != "running" || job.LeaseOwner != owner {
		return store.GenerationJob{}, store.ErrConflict
	}
	job.Status = status
	job.Result = append(json.RawMessage(nil), result...)
	job.Error = errorMessage
	job.Parameters = stripGenerationChannelSecret(job.Parameters)
	job.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
	job.LeaseOwner = ""
	job.LeaseExpiresAt = ""
	m.jobs[key] = job
	return job, nil
}

func (m *memoryStore) CancelServerGenerationJob(_ context.Context, tenantID, id string, now time.Time) (store.GenerationJob, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, id)
	job, ok := m.jobs[key]
	if !ok {
		return store.GenerationJob{}, store.ErrNotFound
	}
	if !isServerGenerationJob(job) {
		return store.GenerationJob{}, store.ErrConflict
	}
	if job.Status == "queued" || job.Status == "running" {
		job.Status = "cancelled"
		job.Error = "已取消"
		job.Parameters = stripGenerationChannelSecret(job.Parameters)
		if job.Kind == "workflow" {
			var result workflowRunResult
			if json.Unmarshal(job.Result, &result) == nil {
				for id, state := range result.Steps {
					if state.Status == "pending" || state.Status == "queued" || state.Status == "running" {
						state.Status = "cancelled"
						state.Error = "已取消"
						result.Steps[id] = state
					}
				}
				job.Result, _ = json.Marshal(result)
			}
		}
		job.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
		job.LeaseOwner = ""
		job.LeaseExpiresAt = ""
		m.jobs[key] = job
	}
	return job, nil
}

func (m *memoryStore) DeleteGenerationJob(_ context.Context, tenantID, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, id)
	job, ok := m.jobs[key]
	if !ok {
		return store.ErrNotFound
	}
	if job.Status == "deleted" {
		return nil
	}
	job.Status = "deleted"
	if job.Error == "" {
		job.Error = "已删除"
	}
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	m.jobs[key] = job
	return nil
}

func (m *memoryStore) DeleteGenerationJobs(_ context.Context, tenantID string, ids []string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(ids) > 100 {
		return 0, errors.New("too many generation job ids")
	}
	var deleted int64
	for _, id := range ids {
		key := tenantKey(tenantID, id)
		job, ok := m.jobs[key]
		if !ok || job.Status == "deleted" {
			continue
		}
		job.Status = "deleted"
		if job.Error == "" {
			job.Error = "已删除"
		}
		job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		m.jobs[key] = job
		deleted++
	}
	return deleted, nil
}

func (m *memoryStore) DeleteGenerationJobsForProject(_ context.Context, tenantID, projectID string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if projectID == "" {
		return 0, errors.New("project id is required")
	}
	prefix := tenantKey(tenantID, "")
	var deleted int64
	for key, job := range m.jobs {
		if len(key) < len(prefix) || key[:len(prefix)] != prefix {
			continue
		}
		if job.ProjectID != projectID {
			continue
		}
		delete(m.jobs, key)
		deleted++
	}
	return deleted, nil
}

func (m *memoryStore) ReplaceGenerationJobs(_ context.Context, tenantID string, jobs []store.GenerationJob) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := make(map[string]store.GenerationJob, len(m.jobs)+len(jobs))
	prefix := tenantKey(tenantID, "")
	for key, job := range m.jobs {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix && isServerGenerationJob(job) &&
			(job.Status == "queued" || job.Status == "running") {
			return store.ErrConflict
		}
		if len(key) < len(prefix) || key[:len(prefix)] != prefix || job.Status == "deleted" {
			next[key] = job
		}
	}
	for _, job := range jobs {
		if job.Status == "deleted" {
			return store.ErrGone
		}
		if current, exists := m.jobs[tenantKey(tenantID, job.ID)]; exists && current.Status == "deleted" {
			return store.ErrGone
		}
		next[tenantKey(tenantID, job.ID)] = job
	}
	m.jobs = next
	return nil
}

func (m *memoryStore) CompareAndSwapGenerationJobs(_ context.Context, tenantID, expectedVersion string, jobs []store.GenerationJob) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	prefix := tenantKey(tenantID, "")
	current := make([]store.GenerationJob, 0)
	for key, job := range m.jobs {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			current = append(current, job)
		}
	}
	if store.GenerationJobsVersion(current) != expectedVersion {
		return store.ErrConflict
	}
	next := make(map[string]store.GenerationJob, len(m.jobs)+len(jobs))
	for key, job := range m.jobs {
		if len(key) < len(prefix) || key[:len(prefix)] != prefix || job.Status == "deleted" {
			next[key] = job
		}
	}
	for _, job := range jobs {
		if job.Status == "deleted" {
			return store.ErrGone
		}
		if current, exists := m.jobs[tenantKey(tenantID, job.ID)]; exists && current.Status == "deleted" {
			return store.ErrGone
		}
		next[tenantKey(tenantID, job.ID)] = job
	}
	m.jobs = next
	return nil
}

func cloneLibraryAsset(asset store.LibraryAsset) store.LibraryAsset {
	out := asset
	if asset.Tags == nil {
		out.Tags = []string{}
	} else {
		out.Tags = append([]string(nil), asset.Tags...)
	}
	return out
}

func normalizeMemoryLibraryAsset(asset store.LibraryAsset, now time.Time, create bool) (store.LibraryAsset, error) {
	asset.Title = strings.TrimSpace(asset.Title)
	asset.Kind = strings.TrimSpace(asset.Kind)
	asset.Content = strings.TrimSpace(asset.Content)
	asset.CoverURL = strings.TrimSpace(asset.CoverURL)
	asset.Source = strings.TrimSpace(asset.Source)
	asset.Notes = strings.TrimSpace(asset.Notes)
	if asset.Title == "" {
		return store.LibraryAsset{}, errors.New("title is required")
	}
	switch asset.Kind {
	case store.LibraryAssetText, store.LibraryAssetImage, store.LibraryAssetVideo, store.LibraryAssetAudio:
	default:
		return store.LibraryAsset{}, errors.New("invalid kind")
	}
	if asset.Kind == store.LibraryAssetText {
		if asset.Content == "" {
			return store.LibraryAsset{}, errors.New("content is required for text assets")
		}
	} else if asset.Content == "" && asset.CoverURL == "" {
		return store.LibraryAsset{}, errors.New("content or coverUrl is required")
	}
	tags := make([]string, 0, len(asset.Tags))
	seen := map[string]struct{}{}
	for _, tag := range asset.Tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		tags = append(tags, tag)
	}
	asset.Tags = tags
	if create {
		if asset.ID == "" {
			asset.ID = "lib_" + strconv.FormatInt(now.UnixNano(), 36)
		}
		asset.CreatedAt = now.UTC().Format(time.RFC3339Nano)
	}
	asset.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
	return asset, nil
}

func (m *memoryStore) ListLibraryAssets(_ context.Context, tenantID string, query store.LibraryAssetQuery) (store.LibraryAssetPage, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if query.Page < 1 {
		query.Page = 1
	}
	if query.PageSize < 1 {
		query.PageSize = 24
	}
	if query.PageSize > 100 {
		query.PageSize = 100
	}
	prefix := tenantKey(tenantID, "")
	q := strings.ToLower(strings.TrimSpace(query.Q))
	kind := strings.TrimSpace(query.Kind)
	tag := strings.ToLower(strings.TrimSpace(query.Tag))
	items := make([]store.LibraryAsset, 0)
	for key, asset := range m.libraryAssets {
		if len(key) < len(prefix) || key[:len(prefix)] != prefix {
			continue
		}
		if kind != "" && asset.Kind != kind {
			continue
		}
		if tag != "" {
			matched := false
			for _, item := range asset.Tags {
				if strings.ToLower(item) == tag {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		if q != "" {
			haystack := strings.ToLower(strings.Join([]string{asset.Title, asset.Content, asset.Source, asset.Notes, strings.Join(asset.Tags, " ")}, " "))
			if !strings.Contains(haystack, q) {
				continue
			}
		}
		items = append(items, cloneLibraryAsset(asset))
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].UpdatedAt == items[j].UpdatedAt {
			return items[i].ID > items[j].ID
		}
		return items[i].UpdatedAt > items[j].UpdatedAt
	})
	total := len(items)
	start := (query.Page - 1) * query.PageSize
	if start > total {
		start = total
	}
	end := start + query.PageSize
	if end > total {
		end = total
	}
	return store.LibraryAssetPage{Items: items[start:end], Page: query.Page, PageSize: query.PageSize, Total: total}, nil
}

func (m *memoryStore) GetLibraryAsset(_ context.Context, tenantID, id string) (store.LibraryAsset, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	asset, ok := m.libraryAssets[tenantKey(tenantID, id)]
	if !ok {
		return store.LibraryAsset{}, store.ErrNotFound
	}
	return cloneLibraryAsset(asset), nil
}

func (m *memoryStore) CreateLibraryAsset(_ context.Context, tenantID string, asset store.LibraryAsset) (store.LibraryAsset, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	normalized, err := normalizeMemoryLibraryAsset(asset, time.Now().UTC(), true)
	if err != nil {
		return store.LibraryAsset{}, err
	}
	key := tenantKey(tenantID, normalized.ID)
	if _, exists := m.libraryAssets[key]; exists {
		return store.LibraryAsset{}, store.ErrConflict
	}
	m.libraryAssets[key] = cloneLibraryAsset(normalized)
	return cloneLibraryAsset(normalized), nil
}

func (m *memoryStore) UpdateLibraryAsset(_ context.Context, tenantID string, asset store.LibraryAsset) (store.LibraryAsset, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, asset.ID)
	existing, ok := m.libraryAssets[key]
	if !ok {
		return store.LibraryAsset{}, store.ErrNotFound
	}
	asset.CreatedAt = existing.CreatedAt
	normalized, err := normalizeMemoryLibraryAsset(asset, time.Now().UTC(), false)
	if err != nil {
		return store.LibraryAsset{}, err
	}
	m.libraryAssets[key] = cloneLibraryAsset(normalized)
	return cloneLibraryAsset(normalized), nil
}

func (m *memoryStore) DeleteLibraryAsset(_ context.Context, tenantID, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, id)
	if _, ok := m.libraryAssets[key]; !ok {
		return store.ErrNotFound
	}
	delete(m.libraryAssets, key)
	return nil
}

func cloneAICallLog(entry store.AICallLog) store.AICallLog {
	out := entry
	if len(entry.RequestJSON) > 0 {
		out.RequestJSON = append(json.RawMessage(nil), entry.RequestJSON...)
	} else {
		out.RequestJSON = json.RawMessage(`{}`)
	}
	if len(entry.ResponseJSON) > 0 {
		out.ResponseJSON = append(json.RawMessage(nil), entry.ResponseJSON...)
	} else {
		out.ResponseJSON = json.RawMessage(`{}`)
	}
	return out
}

func normalizeMemoryAICallLog(entry store.AICallLog, now time.Time) (store.AICallLog, error) {
	entry.Kind = strings.TrimSpace(entry.Kind)
	entry.Status = strings.TrimSpace(entry.Status)
	entry.JobID = strings.TrimSpace(entry.JobID)
	entry.UserID = strings.TrimSpace(entry.UserID)
	entry.ChannelID = strings.TrimSpace(entry.ChannelID)
	entry.ChannelName = strings.TrimSpace(entry.ChannelName)
	entry.Model = strings.TrimSpace(entry.Model)
	entry.Protocol = strings.TrimSpace(entry.Protocol)
	entry.Error = strings.TrimSpace(entry.Error)
	if entry.Kind == "" {
		return store.AICallLog{}, errors.New("kind is required")
	}
	if entry.Status == "" {
		return store.AICallLog{}, errors.New("status is required")
	}
	if entry.DurationMs < 0 {
		entry.DurationMs = 0
	}
	if len(entry.RequestJSON) == 0 {
		entry.RequestJSON = json.RawMessage(`{}`)
	}
	if len(entry.ResponseJSON) == 0 {
		entry.ResponseJSON = json.RawMessage(`{}`)
	}
	if !json.Valid(entry.RequestJSON) || !json.Valid(entry.ResponseJSON) {
		return store.AICallLog{}, errors.New("invalid request/response json")
	}
	if entry.ID == "" {
		entry.ID = "ailog_" + strconv.FormatInt(now.UnixNano(), 36)
	}
	if entry.CreatedAt == "" {
		entry.CreatedAt = now.UTC().Format(time.RFC3339Nano)
	}
	return entry, nil
}

func (m *memoryStore) CreateAICallLog(_ context.Context, tenantID string, entry store.AICallLog) (store.AICallLog, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	normalized, err := normalizeMemoryAICallLog(entry, time.Now().UTC())
	if err != nil {
		return store.AICallLog{}, err
	}
	key := tenantKey(tenantID, normalized.ID)
	if _, exists := m.aiCallLogs[key]; exists {
		return store.AICallLog{}, store.ErrConflict
	}
	m.aiCallLogs[key] = cloneAICallLog(normalized)
	return cloneAICallLog(normalized), nil
}

func (m *memoryStore) ListAICallLogs(_ context.Context, tenantID string, query store.AICallLogQuery) (store.AICallLogPage, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if query.Page < 1 {
		query.Page = 1
	}
	if query.PageSize < 1 {
		query.PageSize = 24
	}
	if query.PageSize > 100 {
		query.PageSize = 100
	}
	prefix := tenantKey(tenantID, "")
	q := strings.ToLower(strings.TrimSpace(query.Q))
	kind := strings.TrimSpace(query.Kind)
	status := strings.TrimSpace(query.Status)
	channel := strings.TrimSpace(query.Channel)
	items := make([]store.AICallLog, 0)
	for key, entry := range m.aiCallLogs {
		if len(key) < len(prefix) || key[:len(prefix)] != prefix {
			continue
		}
		if kind != "" && entry.Kind != kind {
			continue
		}
		if status != "" && entry.Status != status {
			continue
		}
		if channel != "" && entry.ChannelID != channel && entry.ChannelName != channel {
			continue
		}
		if q != "" {
			haystack := strings.ToLower(strings.Join([]string{entry.ID, entry.JobID, entry.Model, entry.ChannelID, entry.ChannelName, entry.Error}, " "))
			if !strings.Contains(haystack, q) {
				continue
			}
		}
		items = append(items, cloneAICallLog(entry))
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].CreatedAt == items[j].CreatedAt {
			return items[i].ID > items[j].ID
		}
		return items[i].CreatedAt > items[j].CreatedAt
	})
	total := len(items)
	start := (query.Page - 1) * query.PageSize
	if start > total {
		start = total
	}
	end := start + query.PageSize
	if end > total {
		end = total
	}
	return store.AICallLogPage{Items: items[start:end], Page: query.Page, PageSize: query.PageSize, Total: total}, nil
}

func (m *memoryStore) GetAICallLog(_ context.Context, tenantID, id string) (store.AICallLog, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, ok := m.aiCallLogs[tenantKey(tenantID, id)]
	if !ok {
		return store.AICallLog{}, store.ErrNotFound
	}
	return cloneAICallLog(entry), nil
}

func (m *memoryStore) DeleteAICallLogsBefore(_ context.Context, tenantID string, before time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	prefix := tenantKey(tenantID, "")
	var deleted int64
	for key, entry := range m.aiCallLogs {
		if len(key) < len(prefix) || key[:len(prefix)] != prefix {
			continue
		}
		created, err := time.Parse(time.RFC3339Nano, entry.CreatedAt)
		if err != nil {
			continue
		}
		if created.Before(before) {
			delete(m.aiCallLogs, key)
			deleted++
		}
	}
	return deleted, nil
}

func (m *memoryStore) DeleteAICallLogs(_ context.Context, tenantID string, ids []string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var deleted int64
	for _, id := range ids {
		key := tenantKey(tenantID, id)
		if _, ok := m.aiCallLogs[key]; ok {
			delete(m.aiCallLogs, key)
			deleted++
		}
	}
	return deleted, nil
}

func (m *memoryStore) CountUsers(context.Context) (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.users, nil
}
func (*memoryStore) RegisterUser(context.Context, store.RegisterInput) (store.AuthUser, string, error) {
	return store.AuthUser{}, "", store.ErrUnauthorized
}
func (*memoryStore) LoginUser(context.Context, string, string) (store.AuthUser, string, error) {
	return store.AuthUser{}, "", store.ErrInvalidCredentials
}
func (*memoryStore) LogoutSession(context.Context, string) error { return nil }
func (*memoryStore) LookupSession(context.Context, string) (store.AuthUser, error) {
	return store.AuthUser{}, store.ErrUnauthorized
}
func (*memoryStore) GetTenant(context.Context, string) (store.Tenant, error) {
	return store.Tenant{ID: store.DefaultTenantID, Name: "Local", Plan: "free", StorageQuotaBytes: 1 << 30, GenerationQuotaMonthly: 1000}, nil
}
func (*memoryStore) RecordUsage(context.Context, string, string, string, int, json.RawMessage) error {
	return nil
}
func (*memoryStore) GetUsage(context.Context, string) (store.UsageSummary, error) {
	return store.UsageSummary{Plan: "free", StorageQuotaBytes: 1 << 30, GenerationQuotaMonthly: 1000}, nil
}
func (*memoryStore) CheckGenerationQuota(context.Context, string) error     { return nil }
func (*memoryStore) CheckStorageQuota(context.Context, string, int64) error { return nil }

func (m *memoryStore) ReserveStorageUsage(_ context.Context, _, _ string, bytes int64, meta json.RawMessage) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var reservation struct {
		ReservationID string `json:"reservationId"`
	}
	_ = json.Unmarshal(meta, &reservation)
	if reservation.ReservationID != "" {
		if _, exists := m.reservations[reservation.ReservationID]; exists {
			return nil
		}
		m.reservations[reservation.ReservationID] = struct{}{}
	}
	m.storageUsage += bytes
	return nil
}
func (m *memoryStore) ReleaseStorageUsage(_ context.Context, _, _ string, bytes int64, meta json.RawMessage) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var release struct {
		ReleaseOf string `json:"releaseOf"`
	}
	_ = json.Unmarshal(meta, &release)
	if release.ReleaseOf != "" {
		if _, exists := m.releases[release.ReleaseOf]; exists {
			return nil
		}
		m.releases[release.ReleaseOf] = struct{}{}
	}
	m.storageUsage -= bytes
	return nil
}

func persistentHandler(t *testing.T) http.Handler {
	t.Helper()
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	r := chi.NewRouter()
	server := NewServerWithStore(t.TempDir(), newMemoryStore())
	server.SetProcessToken("test-token")
	MountServer(r, server)
	return r
}

func (m *memoryStore) GetUser(_ context.Context, tenantID, userID string) (store.AuthUser, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	user, ok := m.authUsers[tenantKey(tenantID, userID)]
	if !ok {
		return store.AuthUser{}, store.ErrNotFound
	}
	user.Credits = m.credits[tenantKey(tenantID, userID)]
	return user, nil
}
func (m *memoryStore) ListUsers(_ context.Context, tenantID string, query store.UserQuery) (store.UserPage, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	items := make([]store.AuthUser, 0)
	prefix := tenantKey(tenantID, "")
	for key, user := range m.authUsers {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		user.Credits = m.credits[key]
		items = append(items, user)
	}
	page, pageSize := query.Page, query.PageSize
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	start := (page - 1) * pageSize
	if start > len(items) {
		start = len(items)
	}
	end := start + pageSize
	if end > len(items) {
		end = len(items)
	}
	return store.UserPage{Items: items[start:end], Page: page, PageSize: pageSize, Total: len(items)}, nil
}
func (m *memoryStore) UpdateUser(_ context.Context, tenantID, userID string, patch store.UserPatch) (store.AuthUser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.updateUserErr != nil {
		return store.AuthUser{}, m.updateUserErr
	}
	key := tenantKey(tenantID, userID)
	user, ok := m.authUsers[key]
	if !ok {
		return store.AuthUser{}, store.ErrNotFound
	}
	if !strings.EqualFold(strings.TrimSpace(patch.ActorRole), "owner") && user.Role == "owner" && (patch.Role != nil || patch.Status != nil) {
		return store.AuthUser{}, store.ErrUnauthorized
	}
	wasActiveOwner := user.Role == "owner" && user.Status == "active"
	nextRole, nextStatus := user.Role, user.Status
	if patch.Role != nil {
		nextRole = strings.ToLower(strings.TrimSpace(*patch.Role))
	}
	if patch.Status != nil {
		nextStatus = strings.ToLower(strings.TrimSpace(*patch.Status))
	}
	if wasActiveOwner && (nextRole != "owner" || nextStatus != "active") {
		activeOwners := 0
		prefix := tenantKey(tenantID, "")
		for existingKey, existing := range m.authUsers {
			if strings.HasPrefix(existingKey, prefix) && existing.Role == "owner" && existing.Status == "active" {
				activeOwners++
			}
		}
		if activeOwners <= 1 {
			return store.AuthUser{}, store.ErrLastOwner
		}
	}
	user.Role, user.Status = nextRole, nextStatus
	if patch.DisplayName != nil {
		user.DisplayName = *patch.DisplayName
	}
	if patch.CreditsDelta != nil {
		m.credits[key] += *patch.CreditsDelta
	}
	user.Credits = m.credits[key]
	m.authUsers[key] = user
	return user, nil
}
func (m *memoryStore) GetModelCreditConfig(_ context.Context, tenantID string) (store.ModelCreditConfig, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	raw, ok := m.state[tenantKey(tenantID, "adminBilling")]
	if !ok {
		return store.ModelCreditConfig{ModelCosts: []store.ModelCreditCost{}}, nil
	}
	var config store.ModelCreditConfig
	if json.Unmarshal(raw, &config) != nil {
		return store.ModelCreditConfig{}, store.ErrInvalidInput
	}
	if config.ModelCosts == nil {
		config.ModelCosts = []store.ModelCreditCost{}
	}
	return config, nil
}
func (m *memoryStore) PutModelCreditConfig(_ context.Context, tenantID string, config store.ModelCreditConfig) error {
	raw, err := json.Marshal(config)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state[tenantKey(tenantID, "adminBilling")] = raw
	return nil
}
func (m *memoryStore) GetModelCreditCost(_ context.Context, tenantID, model string) (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	raw, ok := m.state[tenantKey(tenantID, "adminBilling")]
	if !ok || len(raw) == 0 {
		return 0, nil
	}
	var cfg struct {
		ModelCosts     []store.ModelCreditCost `json:"modelCosts"`
		DefaultCredits int                     `json:"defaultCredits"`
	}
	_ = json.Unmarshal(raw, &cfg)
	for _, item := range cfg.ModelCosts {
		if strings.EqualFold(strings.TrimSpace(item.Model), strings.TrimSpace(model)) {
			return item.Credits, nil
		}
	}
	return cfg.DefaultCredits, nil
}
func (m *memoryStore) ListCreditLogs(_ context.Context, tenantID string, query store.CreditLogQuery) (store.CreditLogPage, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	items := make([]store.CreditLog, 0, len(m.creditLogItems))
	for index := len(m.creditLogItems) - 1; index >= 0; index-- {
		item := m.creditLogItems[index]
		if item.Meta == nil || string(item.Meta) == "" {
			item.Meta = json.RawMessage(`{}`)
		}
		if item.TenantID != tenantID {
			continue
		}
		if query.UserID != "" && item.UserID != query.UserID || query.Reason != "" && item.Reason != query.Reason || query.Model != "" && item.Model != query.Model {
			continue
		}
		items = append(items, item)
	}
	page, pageSize := query.Page, query.PageSize
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	start := (page - 1) * pageSize
	if start > len(items) {
		start = len(items)
	}
	end := start + pageSize
	if end > len(items) {
		end = len(items)
	}
	return store.CreditLogPage{Items: append([]store.CreditLog(nil), items[start:end]...), Page: page, PageSize: pageSize, Total: len(items)}, nil
}
func (m *memoryStore) AdjustCreditsIdempotent(_ context.Context, tenantID, userID, actorID, idempotencyKey string, delta int64, reason string, meta json.RawMessage) (store.AuthUser, store.CreditLog, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, userID)
	user, ok := m.authUsers[key]
	if !ok {
		return store.AuthUser{}, store.CreditLog{}, false, store.ErrNotFound
	}
	signature := strings.Join([]string{userID, actorID, strconv.FormatInt(delta, 10), reason}, "\x1f")
	idempotencyStorageKey := tenantKey(tenantID, idempotencyKey)
	if previous, exists := m.creditAdjustments[idempotencyStorageKey]; exists {
		if previous != signature {
			return store.AuthUser{}, store.CreditLog{}, false, store.ErrConflict
		}
		for _, item := range m.creditLogItems {
			if item.TenantID == tenantID && item.IdempotencyKey == idempotencyKey && item.UserID == userID {
				user.Credits = m.credits[key]
				return user, item, true, nil
			}
		}
	}
	next := m.credits[key] + delta
	if next < 0 {
		return store.AuthUser{}, store.CreditLog{}, false, store.ErrInsufficientCredits
	}
	m.credits[key] = next
	user.Credits = next
	m.authUsers[key] = user
	item := store.CreditLog{ID: int64(len(m.creditLogItems) + 1), TenantID: tenantID, UserID: userID, ActorID: actorID, Delta: delta, BalanceAfter: next, Reason: reason, IdempotencyKey: idempotencyKey, Meta: append(json.RawMessage(nil), meta...), CreatedAt: time.Now().UTC()}
	m.creditLogItems = append(m.creditLogItems, item)
	m.creditAdjustments[idempotencyStorageKey] = signature
	return user, item, false, nil
}
func (m *memoryStore) ReserveCredits(_ context.Context, tenantID, userID, jobID, model string, amount int, _ json.RawMessage) error {
	if amount <= 0 || userID == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, userID)
	logKey := tenantKey(tenantID, jobID+":reserve")
	if _, ok := m.creditLogs[logKey]; ok {
		return nil
	}
	if m.credits[key] < int64(amount) {
		return store.ErrInsufficientCredits
	}
	m.credits[key] -= int64(amount)
	m.creditLogs[logKey] = struct{}{}
	m.creditReserveAmounts[tenantKey(tenantID, jobID)] = int64(amount)
	m.creditReserveUsers[tenantKey(tenantID, jobID)] = userID
	m.creditLogItems = append(m.creditLogItems, store.CreditLog{
		ID: int64(len(m.creditLogItems) + 1), TenantID: tenantID, UserID: userID, JobID: jobID,
		Model: model, Delta: -int64(amount), BalanceAfter: m.credits[key], Reason: "reserve",
		Meta: json.RawMessage(`{}`), CreatedAt: time.Now().UTC(),
	})
	return nil
}
func (m *memoryStore) RefundCredits(_ context.Context, tenantID, userID, jobID, reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if reason == "" {
		reason = "refund"
	}
	refundKey := tenantKey(tenantID, jobID+":refund")
	if _, ok := m.creditLogs[refundKey]; ok {
		return nil
	}
	reserveKey := tenantKey(tenantID, jobID+":reserve")
	if _, ok := m.creditLogs[reserveKey]; !ok {
		return nil
	}
	amount := m.creditReserveAmounts[tenantKey(tenantID, jobID)]
	if userID == "" {
		userID = m.creditReserveUsers[tenantKey(tenantID, jobID)]
	}
	userKey := tenantKey(tenantID, userID)
	m.credits[userKey] += amount
	m.creditLogs[refundKey] = struct{}{}
	m.creditLogItems = append(m.creditLogItems, store.CreditLog{
		ID: int64(len(m.creditLogItems) + 1), TenantID: tenantID, UserID: userID, JobID: jobID,
		Delta: amount, BalanceAfter: m.credits[userKey], Reason: reason,
		Meta: json.RawMessage(`{}`), CreatedAt: time.Now().UTC(),
	})
	return nil
}
func (m *memoryStore) AdjustCredits(_ context.Context, tenantID, userID string, delta int, reason string, _ json.RawMessage) (store.AuthUser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := tenantKey(tenantID, userID)
	user, ok := m.authUsers[key]
	if !ok {
		return store.AuthUser{}, store.ErrNotFound
	}
	next := m.credits[key] + int64(delta)
	if next < 0 {
		return store.AuthUser{}, store.ErrInsufficientCredits
	}
	m.credits[key] = next
	user.Credits = next
	m.authUsers[key] = user
	m.creditLogItems = append(m.creditLogItems, store.CreditLog{
		ID: int64(len(m.creditLogItems) + 1), TenantID: tenantID, UserID: userID,
		Delta: int64(delta), BalanceAfter: next, Reason: reason, Meta: json.RawMessage(`{}`), CreatedAt: time.Now().UTC(),
	})
	return user, nil
}
func (*memoryStore) UpsertLinuxDoUser(context.Context, store.LinuxDoUserInput) (store.AuthUser, string, error) {
	return store.AuthUser{}, "", store.ErrUnauthorized
}
func (m *memoryStore) CreateMediaReference(_ context.Context, tenantID, storageKey string, expiresAt time.Time) (store.MediaReference, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	token := fmt.Sprintf("ref-%d", len(m.mediaRefs)+1)
	ref := store.MediaReference{Token: token, TenantID: tenantID, StorageKey: storageKey, ExpiresAt: expiresAt.UTC()}
	m.mediaRefs[token] = ref
	return ref, nil
}
func (m *memoryStore) GetMediaReference(_ context.Context, token string) (store.MediaReference, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ref, ok := m.mediaRefs[token]
	if !ok || time.Now().UTC().After(ref.ExpiresAt) {
		return store.MediaReference{}, store.ErrNotFound
	}
	return ref, nil
}
func (m *memoryStore) DeleteExpiredMediaReferences(_ context.Context, now time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for token, ref := range m.mediaRefs {
		if now.After(ref.ExpiresAt) {
			delete(m.mediaRefs, token)
			n++
		}
	}
	return n, nil
}

// The in-memory double keeps no tombstones, so there is never anything to purge.
func (m *memoryStore) PurgeExpiredTombstones(_ context.Context, _ time.Time) (int64, error) {
	return 0, nil
}

func TestPersistentProjectAndStateLifecycle(t *testing.T) {
	handler := persistentHandler(t)
	project := []byte(`{"id":"board-1","title":"First","createdAt":"2026-07-15T00:00:00Z","updatedAt":"2026-07-15T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)
	if got := request(t, handler, http.MethodPut, "/api/projects/board-1", project); got.Code != http.StatusNoContent {
		t.Fatalf("put project: %d %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodGet, "/api/projects/board-1", nil); got.Code != http.StatusOK {
		t.Fatalf("get project: %d", got.Code)
	}
	if got := request(t, handler, http.MethodPut, "/api/state/assets", []byte(`[]`)); got.Code != http.StatusNoContent {
		t.Fatalf("put state: %d", got.Code)
	}
	if got := request(t, handler, http.MethodGet, "/api/state/assets", nil); got.Code != http.StatusOK || got.Body.String() != "[]" {
		t.Fatalf("get state: %d %q", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodPut, "/api/state/unknown", []byte(`{}`)); got.Code != http.StatusNotFound {
		t.Fatalf("unknown state: %d", got.Code)
	}
}

func TestMemberConfigIsUserScopedAndCannotRebindStoredTenantKey(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	t.Setenv("OPENBOARD_TOKEN", "")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)

	member := store.AuthUser{ID: "member-1", TenantID: "tenant-a", Role: "member", Status: "active"}
	admin := store.AuthUser{ID: "admin-1", TenantID: member.TenantID, Role: "admin", Status: "active"}
	safeConfig := []byte(`{"channels":[{"id":"primary","name":"Primary","baseUrl":"https://safe.example/v1","defaultImageModel":"gpt-image-1","providers":{"image":{"baseUrl":"https://safe.example/v1","apiKey":"","model":"gpt-image-1","protocol":"openai"}}}],"systemPrompt":"safe"}`)
	if err := backend.PutState(t.Context(), member.TenantID, "config", safeConfig); err != nil {
		t.Fatal(err)
	}
	secretBody := []byte(`{"apiKeys":{"primary":{"image":"sk-tenant-private"}},"webdavPass":""}`)
	if got := putConfigSecrets(t, withActor(router, admin), secretBody); got.Code != http.StatusNoContent {
		t.Fatalf("seed secret = %d %s", got.Code, got.Body.String())
	}

	memberHandler := withActor(router, member)
	if got := request(t, memberHandler, http.MethodGet, "/api/state/config", nil); got.Code != http.StatusOK {
		t.Fatalf("member config read = %d %s", got.Code, got.Body.String())
	}
	attackerConfig := []byte(`{"channels":[{"id":"primary","name":"Primary","baseUrl":"https://attacker.example/v1","defaultImageModel":"gpt-image-1","providers":{"image":{"baseUrl":"https://attacker.example/v1","apiKey":"","model":"gpt-image-1","protocol":"openai"}}}],"systemPrompt":"stolen"}`)
	if got := requestWithHeaders(t, memberHandler, http.MethodPut, "/api/state/config", attackerConfig, map[string]string{
		"If-Match": `"` + configStateVersion(safeConfig, nil) + `"`,
	}); got.Code != http.StatusNoContent {
		t.Fatalf("member config write = %d %s", got.Code, got.Body.String())
	}
	memberConfig := request(t, memberHandler, http.MethodGet, "/api/state/config", nil)
	if memberConfig.Code != http.StatusOK || !bytes.Equal(memberConfig.Body.Bytes(), attackerConfig) {
		t.Fatalf("member-scoped config = %d %s", memberConfig.Code, memberConfig.Body.String())
	}
	if got := requestWithHeaders(t, memberHandler, http.MethodPut, "/api/migration/state/config", []byte(`{}`), nil); got.Code != http.StatusNotFound {
		t.Fatalf("removed migration endpoint = %d %s", got.Code, got.Body.String())
	}
	tenantConfig, err := backend.GetState(t.Context(), member.TenantID, "config")
	if err != nil || !bytes.Equal(tenantConfig, safeConfig) {
		t.Fatalf("tenant config was changed by member: %s, %v", tenantConfig, err)
	}

	parameters, _ := json.Marshal(persistedImageJobParameters{Executor: serverExecutorMarker, Size: "1024x1024", Count: 1})
	resolved, err := server.resolveImageGenerationRequest(t.Context(), member.TenantID, store.GenerationJob{
		ID: "job-safe-binding", Kind: "image", ProviderID: "primary", Model: "gpt-image-1", Prompt: "draw", Parameters: parameters,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.BaseURL != "https://safe.example/v1" || resolved.APIKey != "sk-tenant-private" || resolved.BaseURL == "https://attacker.example/v1" {
		t.Fatalf("stored key rebound to untrusted destination: %#v", resolved)
	}

	adminConfig := []byte(`{"channels":[{"id":"primary","name":"Primary","baseUrl":"https://safe.example/v1","defaultImageModel":"gpt-image-1","providers":{"image":{"baseUrl":"https://safe.example/v1","apiKey":"","model":"gpt-image-1","protocol":"openai"}}}],"systemPrompt":"admin update"}`)
	adminHandler := withActor(router, admin)
	adminRead := request(t, adminHandler, http.MethodGet, "/api/state/config", nil)
	adminBundle, _ := json.Marshal(map[string]json.RawMessage{"config": adminConfig, "secrets": secretBody})
	if got := requestWithHeaders(t, adminHandler, http.MethodPut, "/api/config", adminBundle, map[string]string{
		"If-Match": adminRead.Header().Get("ETag"),
	}); got.Code != http.StatusNoContent {
		t.Fatalf("admin config write = %d %s", got.Code, got.Body.String())
	}
}

func TestConfigStateRejectsStaleConditionalWriteWithoutOverwritingCurrentValue(t *testing.T) {
	handler := persistentHandler(t)
	original := []byte(`{"theme":"light","channels":[]}`)
	updated := []byte(`{"theme":"dark","channels":[]}`)
	stale := []byte(`{"theme":"system","channels":[]}`)

	if got := requestWithHeaders(t, handler, http.MethodPut, "/api/state/config", original, map[string]string{
		"If-None-Match": "*",
		"Authorization": "Bearer test-token",
	}); got.Code != http.StatusNoContent {
		t.Fatalf("create config = %d %s", got.Code, got.Body.String())
	}
	read := requestWithHeaders(t, handler, http.MethodGet, "/api/state/config", nil, map[string]string{
		"Authorization": "Bearer test-token",
	})
	etag := read.Header().Get("ETag")
	if read.Code != http.StatusOK || etag != `"`+configStateVersion(original, nil)+`"` {
		t.Fatalf("read config = %d etag=%q body=%s", read.Code, etag, read.Body.String())
	}
	updateResponse := requestWithHeaders(t, handler, http.MethodPut, "/api/state/config", updated, map[string]string{
		"If-Match":      etag,
		"Authorization": "Bearer test-token",
	})
	if updateResponse.Code != http.StatusNoContent {
		t.Fatalf("update config = %d %s", updateResponse.Code, updateResponse.Body.String())
	}
	if got := requestWithHeaders(t, handler, http.MethodPut, "/api/state/config", stale, map[string]string{
		"If-Match":      etag,
		"Authorization": "Bearer test-token",
	}); got.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale config = %d %s", got.Code, got.Body.String())
	}
	after := requestWithHeaders(t, handler, http.MethodGet, "/api/state/config", nil, map[string]string{
		"Authorization": "Bearer test-token",
	})
	if after.Code != http.StatusOK || !bytes.Equal(after.Body.Bytes(), updated) {
		t.Fatalf("stale write replaced config = %d %s", after.Code, after.Body.String())
	}
	if after.Header().Get("ETag") != updateResponse.Header().Get("ETag") {
		t.Fatalf("saved etag=%q, read etag=%q", updateResponse.Header().Get("ETag"), after.Header().Get("ETag"))
	}
	if got := requestWithHeaders(t, handler, http.MethodPut, "/api/state/config", updated, map[string]string{
		"If-Match":      updateResponse.Header().Get("ETag"),
		"Authorization": "Bearer test-token",
	}); got.Code != http.StatusNoContent {
		t.Fatalf("second config update = %d %s", got.Code, got.Body.String())
	}
}

func TestConfigStateAcceptsExplicitVersionHeaderWhenProxyDropsIfMatch(t *testing.T) {
	handler := persistentHandler(t)
	original := []byte(`{"theme":"light","channels":[]}`)
	updated := []byte(`{"theme":"dark","channels":[]}`)

	if got := requestWithHeaders(t, handler, http.MethodPut, "/api/state/config", original, map[string]string{
		"If-None-Match": "*", "Authorization": "Bearer test-token",
	}); got.Code != http.StatusNoContent {
		t.Fatalf("create config = %d %s", got.Code, got.Body.String())
	}
	read := requestWithHeaders(t, handler, http.MethodGet, "/api/state/config", nil, map[string]string{
		"Authorization": "Bearer test-token",
	})
	if got := requestWithHeaders(t, handler, http.MethodPut, "/api/state/config", updated, map[string]string{
		"X-OpenBoard-Config-Version": read.Header().Get("ETag"),
		"Authorization":              "Bearer test-token",
	}); got.Code != http.StatusNoContent {
		t.Fatalf("update config through proxy-safe version header = %d %s", got.Code, got.Body.String())
	}
}

func TestConfigStateAcceptsVersionQueryWhenProxyDropsConditionalHeaders(t *testing.T) {
	handler := persistentHandler(t)
	original := []byte(`{"theme":"light","channels":[]}`)
	updated := []byte(`{"theme":"dark","channels":[]}`)

	if got := requestWithHeaders(t, handler, http.MethodPut, "/api/state/config", original, map[string]string{
		"If-None-Match": "*", "Authorization": "Bearer test-token",
	}); got.Code != http.StatusNoContent {
		t.Fatalf("create config = %d %s", got.Code, got.Body.String())
	}
	read := requestWithHeaders(t, handler, http.MethodGet, "/api/state/config", nil, map[string]string{
		"Authorization": "Bearer test-token",
	})
	version := url.QueryEscape("W/" + read.Header().Get("ETag"))
	if got := requestWithHeaders(t, handler, http.MethodPut, "/api/state/config?configVersion="+version, updated, map[string]string{
		"Authorization": "Bearer test-token",
	}); got.Code != http.StatusNoContent {
		t.Fatalf("update config through proxy-safe query version = %d %s", got.Code, got.Body.String())
	}
}

func TestConfigStateVersionPreservesLargeIntegerPrecision(t *testing.T) {
	first := []byte(`{"pluginValue":9007199254740992}`)
	second := []byte(`{"pluginValue":9007199254740993}`)
	if configStateVersion(first, nil) == configStateVersion(second, nil) {
		t.Fatal("different large integers produced the same config version")
	}
}

func TestConfigBundleAtomicallyRejectsStaleConfigAndSecretWrites(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "off")
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	t.Cleanup(server.Close)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)

	originalConfig := []byte(`{"theme":"light","channels":[]}`)
	originalSecrets := []byte(`{"apiKeys":{"old":{"text":"sk-old"}}}`)
	if err := backend.PutState(t.Context(), store.DefaultTenantID, "config", originalConfig); err != nil {
		t.Fatal(err)
	}
	if got := putConfigSecrets(t, router, originalSecrets); got.Code != http.StatusNoContent {
		t.Fatalf("seed secrets = %d %s", got.Code, got.Body.String())
	}
	read := request(t, router, http.MethodGet, "/api/state/config", nil)
	etag := read.Header().Get("ETag")

	updatedConfig := []byte(`{"theme":"dark","channels":[]}`)
	updatedSecrets := []byte(`{"apiKeys":{"new":{"text":"sk-new"}}}`)
	updatedBundle, _ := json.Marshal(map[string]json.RawMessage{"config": updatedConfig, "secrets": updatedSecrets})
	updateResponse := requestWithHeaders(t, router, http.MethodPut, "/api/config", updatedBundle, map[string]string{
		"If-Match": etag, "Authorization": "Bearer test-token",
	})
	if updateResponse.Code != http.StatusNoContent {
		t.Fatalf("update bundle = %d %s", updateResponse.Code, updateResponse.Body.String())
	}
	loadedBundle := request(t, router, http.MethodGet, "/api/config", nil)
	if loadedBundle.Code != http.StatusOK || loadedBundle.Header().Get("ETag") != updateResponse.Header().Get("ETag") ||
		!bytes.Contains(loadedBundle.Body.Bytes(), []byte("sk-new")) {
		t.Fatalf("load bundle = %d etag=%q body=%s", loadedBundle.Code, loadedBundle.Header().Get("ETag"), loadedBundle.Body.String())
	}

	staleBundle := []byte(`{"config":{"theme":"stale","channels":[]},"secrets":{"apiKeys":{}}}`)
	if got := requestWithHeaders(t, router, http.MethodPut, "/api/config", staleBundle, map[string]string{
		"If-Match": etag, "Authorization": "Bearer test-token",
	}); got.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale bundle = %d %s", got.Code, got.Body.String())
	}
	storedConfig, _ := backend.GetState(t.Context(), store.DefaultTenantID, "config")
	storedSecrets, _ := server.decryptSecrets(t.Context(), store.DefaultTenantID)
	if !bytes.Equal(storedConfig, updatedConfig) || !bytes.Equal(storedSecrets, updatedSecrets) {
		t.Fatalf("stale bundle changed state: config=%s secrets=%s", storedConfig, storedSecrets)
	}
	reorderedBundle := []byte(`{"config":{"channels":[],"theme":"dark"},"secrets":{"apiKeys":{"new":{"text":"sk-new"}}}}`)
	if got := requestWithHeaders(t, router, http.MethodPut, "/api/config", reorderedBundle, map[string]string{
		"If-Match": updateResponse.Header().Get("ETag"), "Authorization": "Bearer test-token",
	}); got.Code != http.StatusNoContent {
		t.Fatalf("semantic second bundle save = %d %s", got.Code, got.Body.String())
	}
}

func TestPersistentBlobLifecycle(t *testing.T) {
	handler := persistentHandler(t)
	if got := request(t, handler, http.MethodPut, "/api/blobs/image%3Aone", []byte("png")); got.Code != http.StatusNoContent {
		t.Fatalf("put blob: %d %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodGet, "/api/blobs/image%3Aone", nil); got.Code != http.StatusOK || got.Body.String() != "png" {
		t.Fatalf("get blob: %d %q", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodDelete, "/api/blobs/image%3Aone", nil); got.Code != http.StatusNoContent {
		t.Fatalf("delete blob: %d", got.Code)
	}
}

func TestBlobContentTypeBoundary(t *testing.T) {
	handler := persistentHandler(t)
	unsafe := httptest.NewRequest(http.MethodPut, "/api/blobs/unsafe", bytes.NewReader([]byte("<script>alert(1)</script>")))
	unsafe.Header.Set("Content-Type", "text/html")
	unsafe.Header.Set("Authorization", "Bearer test-token")
	unsafeResult := httptest.NewRecorder()
	handler.ServeHTTP(unsafeResult, unsafe)
	if unsafeResult.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("unsafe content type status = %d", unsafeResult.Code)
	}

	safe := httptest.NewRequest(http.MethodPut, "/api/blobs/safe", bytes.NewReader([]byte("png")))
	safe.Header.Set("Content-Type", "image/png")
	safe.Header.Set("Authorization", "Bearer test-token")
	safeResult := httptest.NewRecorder()
	handler.ServeHTTP(safeResult, safe)
	if safeResult.Code != http.StatusNoContent {
		t.Fatalf("safe content type status = %d", safeResult.Code)
	}
	got := request(t, handler, http.MethodGet, "/api/blobs/safe", nil)
	if got.Header().Get("X-Content-Type-Options") != "nosniff" || got.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("blob response headers = %#v", got.Header())
	}
}

func TestEncryptedSecretLifecycle(t *testing.T) {
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	MountServer(r, server)
	if err := backend.PutState(t.Context(), store.DefaultTenantID, "config", []byte(`{"channels":[]}`)); err != nil {
		t.Fatal(err)
	}
	plain := []byte(`{"apiKeys":{"channel":{"text":"sk-secret"}},"webdavPass":"dav-secret"}`)
	if got := putConfigSecrets(t, r, plain); got.Code != http.StatusNoContent {
		t.Fatalf("put secrets: %d %s", got.Code, got.Body.String())
	}
	backend.mu.RLock()
	stored := append([]byte(nil), backend.state[tenantKey(store.DefaultTenantID, secretStateKey)]...)
	backend.mu.RUnlock()
	if bytes.Contains(stored, []byte("sk-secret")) || bytes.Contains(stored, []byte("dav-secret")) {
		t.Fatal("plaintext secret persisted")
	}
	got := request(t, r, http.MethodGet, "/api/secrets/config", nil)
	if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), plain) {
		t.Fatalf("get secrets: %d %s", got.Code, got.Body.String())
	}
	if got.Header().Get("Cache-Control") != "no-store" || got.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("secret cache headers = %#v", got.Header())
	}
}

func TestEncryptedSecretsRequireLoginAfterFirstUser(t *testing.T) {
	backend := newMemoryStore()
	backend.users = 1
	server := NewServerWithStore(t.TempDir(), backend)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		got := request(t, router, method, "/api/secrets/config", []byte(`{}`))
		if got.Code != http.StatusUnauthorized {
			t.Fatalf("%s anonymous secrets status = %d, body = %s", method, got.Code, got.Body.String())
		}
	}
}

func TestMemberPersonalSecretsAreIsolatedFromTenantBag(t *testing.T) {
	t.Setenv("OPENBOARD_AUTH_MODE", "optional")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	if err := server.SetSecretKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MountServer(router, server)

	admin := store.AuthUser{ID: "admin-1", TenantID: store.DefaultTenantID, Role: "admin", Status: "active"}
	memberA := store.AuthUser{ID: "member-a", TenantID: store.DefaultTenantID, Role: "member", Status: "active"}
	memberB := store.AuthUser{ID: "member-b", TenantID: store.DefaultTenantID, Role: "member", Status: "active"}
	if err := backend.PutState(t.Context(), store.DefaultTenantID, "config", []byte(`{"channels":[]}`)); err != nil {
		t.Fatal(err)
	}

	adminPlain := []byte(`{"apiKeys":{"tenant":{"image":"sk-tenant"}},"webdavPass":""}`)
	if got := putConfigSecrets(t, withActor(router, admin), adminPlain); got.Code != http.StatusNoContent {
		t.Fatalf("admin put: %d %s", got.Code, got.Body.String())
	}
	memberPlain := []byte(`{"apiKeys":{"personal":{"image":"sk-member-a"}},"webdavPass":"","objectStorageSecretAccessKey":"user-s3"}`)
	if got := putConfigSecrets(t, withActor(router, memberA), memberPlain); got.Code != http.StatusNoContent {
		t.Fatalf("member put: %d %s", got.Code, got.Body.String())
	}

	// Admin still reads the tenant bag, not the member bag.
	got := request(t, withActor(router, admin), http.MethodGet, "/api/secrets/config", nil)
	if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), adminPlain) {
		t.Fatalf("admin get: %d %s", got.Code, got.Body.String())
	}
	// Member A reads their personal bag.
	got = request(t, withActor(router, memberA), http.MethodGet, "/api/secrets/config", nil)
	if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), memberPlain) {
		t.Fatalf("member A get: %d %s", got.Code, got.Body.String())
	}
	// Member B has no bag yet and must not see A or the tenant bag.
	got = request(t, withActor(router, memberB), http.MethodGet, "/api/secrets/config", nil)
	if got.Code != http.StatusNotFound {
		t.Fatalf("member B get: %d %s", got.Code, got.Body.String())
	}

	backend.mu.RLock()
	tenantStored := append([]byte(nil), backend.state[tenantKey(store.DefaultTenantID, secretStateKey)]...)
	userStored := append([]byte(nil), backend.state[tenantKey(store.DefaultTenantID, userSecretStateKeyPrefix+memberA.ID)]...)
	backend.mu.RUnlock()
	if len(userStored) == 0 {
		t.Fatal("member bag missing")
	}
	if bytes.Contains(tenantStored, []byte("sk-member-a")) || bytes.Contains(userStored, []byte("sk-tenant")) {
		t.Fatal("member and tenant bags must stay isolated")
	}
	if bytes.Contains(tenantStored, []byte("sk-tenant")) {
		// plaintext must never land on disk
		t.Fatal("tenant bag stored plaintext")
	}
	if bytes.Contains(userStored, []byte("sk-member-a")) || bytes.Contains(userStored, []byte("user-s3")) {
		t.Fatal("member bag stored plaintext")
	}
}

func TestBlobDeleteReleasesStorageUsageAndKeysDecodeOnce(t *testing.T) {
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	router := chi.NewRouter()
	MountServer(router, server)

	for _, key := range []string{"percent%value", "literal%2Fvalue", "slash/value", "空 格"} {
		path := "/api/blobs/" + url.PathEscape(key)
		put := httptest.NewRequest(http.MethodPut, path, bytes.NewReader([]byte("png")))
		put.Header.Set("Content-Type", "image/png")
		put.Header.Set("Authorization", "Bearer test-token")
		putResult := httptest.NewRecorder()
		router.ServeHTTP(putResult, put)
		if putResult.Code != http.StatusNoContent {
			t.Fatalf("put %q: %d %s", key, putResult.Code, putResult.Body.String())
		}
		got := request(t, router, http.MethodGet, path, nil)
		if got.Code != http.StatusOK || got.Body.String() != "png" {
			t.Fatalf("get %q: %d %q", key, got.Code, got.Body.String())
		}
		deleted := request(t, router, http.MethodDelete, path, nil)
		if deleted.Code != http.StatusNoContent {
			t.Fatalf("delete %q: %d %s", key, deleted.Code, deleted.Body.String())
		}
	}
	overwritePath := "/api/blobs/overwrite"
	for _, value := range []string{"first", "second-value"} {
		put := httptest.NewRequest(http.MethodPut, overwritePath, bytes.NewReader([]byte(value)))
		put.Header.Set("Content-Type", "image/png")
		put.Header.Set("Authorization", "Bearer test-token")
		result := httptest.NewRecorder()
		router.ServeHTTP(result, put)
		if result.Code != http.StatusNoContent {
			t.Fatalf("overwrite put: %d %s", result.Code, result.Body.String())
		}
	}
	if deleted := request(t, router, http.MethodDelete, overwritePath, nil); deleted.Code != http.StatusNoContent {
		t.Fatalf("overwrite delete: %d %s", deleted.Code, deleted.Body.String())
	}
	backend.mu.RLock()
	usage := backend.storageUsage
	backend.mu.RUnlock()
	if usage != 0 {
		t.Fatalf("storage usage after deletes = %d", usage)
	}
}

func TestConcurrentServerBlobOverwriteKeepsOneReservation(t *testing.T) {
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	dataDir := t.TempDir()
	servers := []*Server{
		NewServerWithStore(dataDir, backend),
		NewServerWithStore(dataDir, backend),
	}
	routers := make([]http.Handler, 0, len(servers))
	for _, server := range servers {
		server.SetProcessToken("test-token")
		router := chi.NewRouter()
		MountServer(router, server)
		routers = append(routers, router)
	}

	results := make(chan int, len(routers))
	var wait sync.WaitGroup
	for index, router := range routers {
		wait.Add(1)
		go func(index int, router http.Handler) {
			defer wait.Done()
			request := httptest.NewRequest(http.MethodPut, "/api/blobs/shared", bytes.NewReader(bytes.Repeat([]byte{byte(index + 1)}, 1024)))
			request.Header.Set("Content-Type", "image/png")
			request.Header.Set("Authorization", "Bearer test-token")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			results <- response.Code
		}(index, router)
	}
	wait.Wait()
	close(results)
	for status := range results {
		if status != http.StatusNoContent {
			t.Fatalf("concurrent overwrite status = %d", status)
		}
	}
	if deleted := request(t, routers[0], http.MethodDelete, "/api/blobs/shared", nil); deleted.Code != http.StatusNoContent {
		t.Fatalf("delete shared blob: %d %s", deleted.Code, deleted.Body.String())
	}
	backend.mu.RLock()
	usage := backend.storageUsage
	backend.mu.RUnlock()
	if usage != 0 {
		t.Fatalf("storage usage after concurrent overwrite/delete = %d", usage)
	}
}

func TestGenerationJobPaginatedCRUD(t *testing.T) {
	handler := persistentHandler(t)
	created := request(t, handler, http.MethodPost, "/api/generation-jobs", []byte(`{
		"id":"job-1","projectId":"board-1","kind":"image","status":"running",
		"prompt":"a red square","providerId":"image-main","model":"mock-image",
		"parameters":{"size":"1024x1024"},"result":{}
	}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("create job: %d %s", created.Code, created.Body.String())
	}
	updated := request(t, handler, http.MethodPut, "/api/generation-jobs/job-1", []byte(`{
		"id":"job-1","projectId":"board-1","kind":"image","status":"succeeded",
		"prompt":"a red square","providerId":"image-main","model":"mock-image",
		"parameters":{"size":"1024x1024"},"result":{"storageKeys":["image:one"]}
	}`))
	if updated.Code != http.StatusOK || !bytes.Contains(updated.Body.Bytes(), []byte(`"succeeded"`)) {
		t.Fatalf("update job: %d %s", updated.Code, updated.Body.String())
	}
	listed := request(t, handler, http.MethodGet, "/api/generation-jobs?projectId=board-1&kind=image&page=1&pageSize=10", nil)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte(`"total": 1`)) {
		t.Fatalf("list jobs: %d %s", listed.Code, listed.Body.String())
	}
	if got := request(t, handler, http.MethodDelete, "/api/generation-jobs/job-1", nil); got.Code != http.StatusNoContent {
		t.Fatalf("delete job: %d", got.Code)
	}
}

func TestGenerationHistorySoftDelete(t *testing.T) {
	handler := persistentHandler(t)
	if got := request(t, handler, http.MethodPost, "/api/generation-jobs", []byte(`{"id":"job-soft","projectId":"board-soft","kind":"image","status":"succeeded","prompt":"hide me","providerId":"image-main","model":"mock","parameters":{},"result":{"items":[{"storageKey":"image:soft"}]}}`)); got.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodDelete, "/api/generation-jobs/job-soft", nil); got.Code != http.StatusNoContent {
		t.Fatalf("soft delete: %d %s", got.Code, got.Body.String())
	}
	listed := request(t, handler, http.MethodGet, "/api/generation-jobs?projectId=board-soft&page=1&pageSize=20", nil)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte(`"total": 0`)) || bytes.Contains(listed.Body.Bytes(), []byte(`"job-soft"`)) {
		t.Fatalf("deleted job still listed: %d %s", listed.Code, listed.Body.String())
	}
	got := request(t, handler, http.MethodGet, "/api/generation-jobs/job-soft", nil)
	if got.Code != http.StatusNotFound {
		t.Fatalf("tombstone should be hidden: %d %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodDelete, "/api/generation-jobs/job-soft", nil); got.Code != http.StatusNotFound {
		t.Fatalf("hidden tombstone delete: %d %s", got.Code, got.Body.String())
	}
}

func TestGenerationJobTombstoneWritesReturnGone(t *testing.T) {
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	router := chi.NewRouter()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	MountServer(router, server)
	body := []byte(`{"id":"job-gone","kind":"image","status":"succeeded","prompt":"stale","providerId":"image-main","model":"mock","parameters":{},"result":{}}`)
	deletedBody := []byte(`{"id":"job-fake-tombstone","kind":"image","status":"deleted","prompt":"stale","providerId":"image-main","model":"mock","parameters":{},"result":{}}`)
	if got := request(t, router, http.MethodPost, "/api/generation-jobs", deletedBody); got.Code != http.StatusBadRequest {
		t.Fatalf("client-created deleted status = %d, want 400: %s", got.Code, got.Body.String())
	}

	if got := request(t, router, http.MethodPost, "/api/generation-jobs", body); got.Code != http.StatusCreated {
		t.Fatalf("seed job: %d %s", got.Code, got.Body.String())
	}
	if got := request(t, router, http.MethodDelete, "/api/generation-jobs/job-gone", nil); got.Code != http.StatusNoContent {
		t.Fatalf("delete job: %d %s", got.Code, got.Body.String())
	}
	if got := request(t, router, http.MethodPost, "/api/generation-jobs", body); got.Code != http.StatusGone {
		t.Fatalf("create over tombstone status = %d, want 410: %s", got.Code, got.Body.String())
	}
	staleRestore := []byte(`[{"id":"job-gone","kind":"image","status":"succeeded","prompt":"stale restore","providerId":"image-main","model":"mock","parameters":{},"result":{},"createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z"}]`)
	if got := request(t, router, http.MethodPut, "/api/generation-jobs", staleRestore); got.Code != http.StatusGone {
		t.Fatalf("replace over tombstone status = %d, want 410: %s", got.Code, got.Body.String())
	}

	backend.mu.Lock()
	backend.jobs[tenantKey(store.DefaultTenantID, "job-update-race")] = store.GenerationJob{
		ID: "job-update-race", Kind: "image", Status: "succeeded", Prompt: "current",
		Parameters: json.RawMessage(`{}`), Result: json.RawMessage(`{}`),
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	backend.generationJobPutErr = store.ErrGone
	backend.mu.Unlock()
	update := []byte(`{"id":"job-update-race","kind":"image","status":"succeeded","prompt":"stale","providerId":"image-main","model":"mock","parameters":{},"result":{}}`)
	if got := request(t, router, http.MethodPut, "/api/generation-jobs/job-update-race", update); got.Code != http.StatusGone {
		t.Fatalf("racing update status = %d, want 410: %s", got.Code, got.Body.String())
	}
}

func TestBulkDeleteGenerationJobs(t *testing.T) {
	handler := persistentHandler(t)
	for _, body := range []string{
		`{"id":"job-bulk-1","projectId":"board-bulk","kind":"image","status":"succeeded","prompt":"one","providerId":"image-main","model":"mock","parameters":{},"result":{}}`,
		`{"id":"job-bulk-2","projectId":"board-bulk","kind":"image","status":"succeeded","prompt":"two","providerId":"image-main","model":"mock","parameters":{},"result":{}}`,
		`{"id":"job-bulk-keep","projectId":"board-bulk","kind":"video","status":"succeeded","prompt":"keep","providerId":"video-main","model":"mock","parameters":{},"result":{}}`,
	} {
		if got := request(t, handler, http.MethodPost, "/api/generation-jobs", []byte(body)); got.Code != http.StatusCreated {
			t.Fatalf("create job: %d %s", got.Code, got.Body.String())
		}
	}
	got := request(t, handler, http.MethodPost, "/api/generation-jobs/bulk-delete", []byte(`{"ids":["job-bulk-1","job-bulk-2","job-bulk-1"]}`))
	if got.Code != http.StatusOK || !bytes.Contains(got.Body.Bytes(), []byte(`"deleted": 2`)) {
		t.Fatalf("bulk delete: %d %s", got.Code, got.Body.String())
	}
	listed := request(t, handler, http.MethodGet, "/api/generation-jobs?projectId=board-bulk&page=1&pageSize=20", nil)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte(`"job-bulk-keep"`)) || bytes.Contains(listed.Body.Bytes(), []byte(`"job-bulk-1"`)) {
		t.Fatalf("bulk delete residual: %d %s", listed.Code, listed.Body.String())
	}
	if got := request(t, handler, http.MethodPost, "/api/generation-jobs/bulk-delete", []byte(`{"ids":[]}`)); got.Code != http.StatusBadRequest {
		t.Fatalf("empty bulk delete accepted: %d", got.Code)
	}
}

func TestDeleteProjectCascadesGenerationJobs(t *testing.T) {
	handler := persistentHandler(t)
	for _, body := range []string{
		`{"id":"job-keep","projectId":"board-keep","kind":"image","status":"succeeded","prompt":"keep","providerId":"image-main","model":"mock","parameters":{},"result":{}}`,
		`{"id":"job-drop-1","projectId":"board-drop","kind":"image","status":"succeeded","prompt":"drop1","providerId":"image-main","model":"mock","parameters":{},"result":{}}`,
		`{"id":"job-drop-2","projectId":"board-drop","kind":"video","status":"succeeded","prompt":"drop2","providerId":"video-main","model":"mock","parameters":{},"result":{}}`,
	} {
		if got := request(t, handler, http.MethodPost, "/api/generation-jobs", []byte(body)); got.Code != http.StatusCreated {
			t.Fatalf("create job: %d %s body=%s", got.Code, got.Body.String(), body)
		}
	}
	if got := request(t, handler, http.MethodPut, "/api/projects/board-drop", []byte(`{"id":"board-drop","title":"Drop","createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z","nodes":[],"edges":[],"chatSessions":[],"activeChatId":null,"backgroundMode":"dots","viewport":{"x":0,"y":0,"k":1}}`)); got.Code != http.StatusNoContent {
		t.Fatalf("put project: %d %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodDelete, "/api/projects/board-drop", nil); got.Code != http.StatusNoContent {
		t.Fatalf("delete project: %d %s", got.Code, got.Body.String())
	}
	listedDrop := request(t, handler, http.MethodGet, "/api/generation-jobs?projectId=board-drop&page=1&pageSize=20", nil)
	if listedDrop.Code != http.StatusOK || !bytes.Contains(listedDrop.Body.Bytes(), []byte(`"total": 0`)) {
		t.Fatalf("drop project jobs remain: %d %s", listedDrop.Code, listedDrop.Body.String())
	}
	listedKeep := request(t, handler, http.MethodGet, "/api/generation-jobs?projectId=board-keep&page=1&pageSize=20", nil)
	if listedKeep.Code != http.StatusOK || !bytes.Contains(listedKeep.Body.Bytes(), []byte(`"job-keep"`)) {
		t.Fatalf("kept project jobs missing: %d %s", listedKeep.Code, listedKeep.Body.String())
	}
	if got := request(t, handler, http.MethodPost, "/api/generation-jobs", []byte(`{"id":"job-api-drop","projectId":"board-api","kind":"image","status":"succeeded","prompt":"x","providerId":"image-main","model":"mock","parameters":{},"result":{}}`)); got.Code != http.StatusCreated {
		t.Fatalf("create api-drop job: %d %s", got.Code, got.Body.String())
	}
	if got := request(t, handler, http.MethodDelete, "/api/generation-jobs/project/board-api", nil); got.Code != http.StatusOK || !bytes.Contains(got.Body.Bytes(), []byte(`"deleted"`)) {
		t.Fatalf("delete jobs by project endpoint: %d %s", got.Code, got.Body.String())
	}
	listedAPI := request(t, handler, http.MethodGet, "/api/generation-jobs?projectId=board-api&page=1&pageSize=20", nil)
	if listedAPI.Code != http.StatusOK || !bytes.Contains(listedAPI.Body.Bytes(), []byte(`"total": 0`)) {
		t.Fatalf("api project jobs remain: %d %s", listedAPI.Code, listedAPI.Body.String())
	}
}

func TestGenerationJobRejectsInvalidInput(t *testing.T) {
	handler := persistentHandler(t)
	for _, body := range [][]byte{
		[]byte(`{"id":"../bad","kind":"image","status":"running","prompt":"x","parameters":{},"result":{}}`),
		[]byte(`{"id":"job-1","kind":"document","status":"running","prompt":"x","parameters":{},"result":{}}`),
		[]byte(`{"id":"job-1","kind":"image","status":"unknown","prompt":"x","parameters":{},"result":{}}`),
		[]byte(`{"id":"job-1","kind":"image","status":"running","prompt":"x","parameters":[],"result":{}}`),
	} {
		if got := request(t, handler, http.MethodPost, "/api/generation-jobs", body); got.Code != http.StatusBadRequest {
			t.Fatalf("invalid job accepted: %d %s", got.Code, got.Body.String())
		}
	}
	if got := request(t, handler, http.MethodGet, "/api/generation-jobs?page=0&pageSize=1000", nil); got.Code != http.StatusBadRequest {
		t.Fatalf("invalid pagination accepted: %d", got.Code)
	}
}

func TestGenerationJobBulkRestore(t *testing.T) {
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	handler := chi.NewRouter()
	MountServer(handler, server)
	body := []byte(`[{"id":"job-restored","projectId":"board-1","kind":"video","status":"succeeded","prompt":"restored","parameters":{"duration":5},"result":{"items":[]},"createdAt":"2026-07-01T01:02:03Z","updatedAt":"2026-07-02T04:05:06.123Z"}]`)
	if got := request(t, handler, http.MethodPut, "/api/generation-jobs", body); got.Code != http.StatusNoContent {
		t.Fatalf("restore jobs: %d %s", got.Code, got.Body.String())
	}
	backend.mu.RLock()
	job := backend.jobs[tenantKey(store.DefaultTenantID, "job-restored")]
	backend.mu.RUnlock()
	if job.CreatedAt != "2026-07-01T01:02:03Z" || job.UpdatedAt != "2026-07-02T04:05:06.123Z" {
		t.Fatalf("timestamps changed: %#v", job)
	}
}

func TestGenerationJobBulkRestoreRejectsEntireInvalidBatch(t *testing.T) {
	t.Setenv("OPENBOARD_TOKEN", "test-token")
	backend := newMemoryStore()
	backend.jobs[tenantKey(store.DefaultTenantID, "existing")] = store.GenerationJob{ID: "existing"}
	server := NewServerWithStore(t.TempDir(), backend)
	server.SetProcessToken("test-token")
	handler := chi.NewRouter()
	MountServer(handler, server)
	valid := `{"id":"job-1","kind":"image","status":"succeeded","prompt":"ok","parameters":{},"result":{},"createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z"}`
	for _, body := range []string{
		`null`,
		`[` + valid + `,` + valid + `]`,
		`[` + valid + `,{"id":"job-2","kind":"document","status":"running","prompt":"bad","parameters":{},"result":{},"createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:00:00Z"}]`,
	} {
		if got := request(t, handler, http.MethodPut, "/api/generation-jobs", []byte(body)); got.Code != http.StatusBadRequest {
			t.Fatalf("invalid restore accepted: %d %s", got.Code, got.Body.String())
		}
		if len(backend.jobs) != 1 || backend.jobs[tenantKey(store.DefaultTenantID, "existing")].ID != "existing" {
			t.Fatalf("invalid restore changed existing data: %#v", backend.jobs)
		}
	}
}
