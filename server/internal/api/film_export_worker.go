package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const filmExportExecutorMarker = "film-export"

type filmExportJobParameters struct {
	Executor       string          `json:"executor"`
	ProjectID      string          `json:"projectId"`
	Kind           string          `json:"kind"`
	IdempotencyKey string          `json:"idempotencyKey"`
	RequestHash    string          `json:"requestHash"`
	UserID         string          `json:"userId,omitempty"`
	Snapshot       json.RawMessage `json:"snapshot"`
}

type filmExportJobResult struct {
	DeliverableID string `json:"deliverableId,omitempty"`
}

func withFilmExportMaintenanceContext(operation func(context.Context)) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	operation(ctx)
}

func decodeFilmExportJob(job store.GenerationJob) (filmExportJobParameters, filmDocument, error) {
	var parameters filmExportJobParameters
	if job.Kind != "export" || json.Unmarshal(job.Parameters, &parameters) != nil ||
		parameters.Executor != filmExportExecutorMarker || parameters.ProjectID != job.ProjectID ||
		!validProjectID(parameters.ProjectID) || !validFilmIdempotencyKey(parameters.IdempotencyKey) ||
		!validFilmRequestHash(parameters.RequestHash) {
		return filmExportJobParameters{}, filmDocument{}, errors.New("invalid film export job")
	}
	if _, _, _, valid := filmDeliverableSpec(parameters.Kind); !valid {
		return filmExportJobParameters{}, filmDocument{}, errors.New("invalid film export kind")
	}
	document, err := decodeFilmDocument(parameters.Snapshot)
	if err != nil || validateFilmAggregate(document, parameters.ProjectID) != nil {
		return filmExportJobParameters{}, filmDocument{}, errors.New("invalid film export snapshot")
	}
	return parameters, document, nil
}

func validPersistedFilmExportJob(job store.GenerationJob) bool {
	_, _, err := decodeFilmExportJob(job)
	return err == nil
}

func (s *Server) startFilmExportWorkers(count int) {
	if s.store == nil || count < 1 {
		return
	}
	s.filmExportWorkersOnce.Do(func() {
		for range count {
			s.filmExportWorkerWG.Add(1)
			go s.filmExportWorkerLoop()
		}
	})
}

func (s *Server) notifyFilmExportWorkers() {
	select {
	case s.filmExportWake <- struct{}{}:
	default:
	}
}

func (s *Server) filmExportWorkerLoop() {
	defer s.filmExportWorkerWG.Done()
	for {
		now := time.Now().UTC()
		claimed, err := s.store.ClaimServerGenerationJob(s.generationRoot,
			store.GenerationClaim{Kind: "export", Executor: filmExportExecutorMarker},
			randomGenerationOwner(), now, now.Add(generationLeaseDuration))
		if err == nil {
			s.filmExportWG.Add(1)
			s.executeClaimedFilmExportJob(claimed)
			s.filmExportWG.Done()
			continue
		}
		select {
		case <-s.generationRoot.Done():
			return
		case <-s.filmExportWake:
		case <-time.After(time.Second):
		}
	}
}

func (s *Server) executeClaimedFilmExportJob(claimed store.TenantGenerationJob) {
	tenantID, job := claimed.TenantID, claimed.Job
	parameters, snapshot, err := decodeFilmExportJob(job)
	if err != nil {
		s.finishFilmExportJob(tenantID, job, "failed", filmExportJobResult{}, "导出任务快照无效")
		return
	}
	ctx, cancel := context.WithCancel(s.generationRoot)
	key := tenantID + "\x00" + job.ID
	s.generationMu.Lock()
	s.generationCancels[key] = cancel
	s.generationMu.Unlock()
	watchDone := make(chan struct{})
	go s.watchGenerationCancellation(ctx, cancel, watchDone, tenantID, job.ID, job.LeaseOwner)
	defer func() {
		close(watchDone)
		s.generationMu.Lock()
		delete(s.generationCancels, key)
		s.generationMu.Unlock()
		cancel()
	}()

	deliverableID := stableFilmID("deliverable", parameters.ProjectID, parameters.IdempotencyKey)
	data, err := s.exportFilmBytes(ctx, tenantID, snapshot, parameters.Kind)
	if err != nil {
		status := filmStatusFailed
		message := "导出失败"
		if ctx.Err() != nil {
			status, message = filmStatusCanceled, "已取消"
		}
		withFilmExportMaintenanceContext(func(maintenanceContext context.Context) {
			s.updateFilmExportDeliverable(maintenanceContext, tenantID, parameters.ProjectID, deliverableID, job.ID, func(item filmDeliverable) filmDeliverable {
				item.Status, item.Diagnostic, item.Revision = status, message, item.Revision+1
				return item
			})
		})
		s.finishFilmExportJob(tenantID, job, mapFilmExportJobStatus(status), filmExportJobResult{}, message)
		return
	}
	_, mimeType, _, _ := filmDeliverableSpec(parameters.Kind)
	storageKey := "film:deliverable:" + parameters.ProjectID + ":" + deliverableID
	storeErr := s.storeTenantBlobConditional(ctx, tenantID, parameters.UserID, storageKey, mimeType, data, blobVersionAbsent)
	if errors.Is(storeErr, errBlobObjectConflict) {
		existing, readErr := s.readTenantBlob(ctx, tenantID, storageKey, maxFilmRenderBytes)
		if readErr != nil || existing.Metadata.ContentType != mimeType || !bytes.Equal(existing.Data, data) {
			storeErr = errors.New("export storage conflict")
		} else {
			storeErr = nil
		}
	}
	stored, readErr := s.readTenantBlob(ctx, tenantID, storageKey, maxFilmRenderBytes)
	if storeErr != nil || readErr != nil || stored.Metadata.ContentType != mimeType || !bytes.Equal(stored.Data, data) {
		withFilmExportMaintenanceContext(func(maintenanceContext context.Context) {
			s.cleanupUnreferencedFilmBlob(maintenanceContext, tenantID, parameters.UserID, parameters.ProjectID, storageKey)
		})
		withFilmExportMaintenanceContext(func(maintenanceContext context.Context) {
			s.updateFilmExportDeliverable(maintenanceContext, tenantID, parameters.ProjectID, deliverableID, job.ID, func(item filmDeliverable) filmDeliverable {
				item.Status, item.Diagnostic, item.Revision = filmStatusFailed, "导出存储失败", item.Revision+1
				return item
			})
		})
		s.finishFilmExportJob(tenantID, job, "failed", filmExportJobResult{}, "导出存储失败")
		return
	}
	updated := s.updateFilmExportDeliverable(ctx, tenantID, parameters.ProjectID, deliverableID, job.ID, func(item filmDeliverable) filmDeliverable {
		item.Status = filmStatusApproved
		item.StorageKey = storageKey
		item.SHA256 = sha256Hex(data)
		item.ObjectVersion = blobIdentityVersion(stored)
		item.Bytes = int64(len(data))
		item.Diagnostic = ""
		item.Revision++
		return item
	})
	if !updated {
		withFilmExportMaintenanceContext(func(maintenanceContext context.Context) {
			s.cleanupUnreferencedFilmBlob(maintenanceContext, tenantID, parameters.UserID, parameters.ProjectID, storageKey)
		})
		s.finishFilmExportJob(tenantID, job, "failed", filmExportJobResult{}, "导出结果合并冲突")
		return
	}
	s.finishFilmExportJob(tenantID, job, "succeeded", filmExportJobResult{DeliverableID: deliverableID}, "")
}

func mapFilmExportJobStatus(status string) string {
	if status == filmStatusCanceled {
		return "cancelled"
	}
	return "failed"
}

func (s *Server) updateFilmExportDeliverable(ctx context.Context, tenantID, projectID, deliverableID, jobID string, update func(filmDeliverable) filmDeliverable) bool {
	backend, ok := s.store.(store.FilmStore)
	if !ok {
		return false
	}
	for range 5 {
		record, err := backend.GetFilmProject(ctx, tenantID, projectID)
		if err != nil {
			return false
		}
		document, err := decodeFilmDocument(record.Document)
		if err != nil {
			return false
		}
		found := false
		for index, item := range document.Deliverables {
			if item.ID == deliverableID && item.GenerationJobID == jobID {
				if item.Status == filmStatusApproved {
					return true
				}
				if item.Status == filmStatusCanceled {
					return false
				}
				document.Deliverables[index] = update(item)
				found = true
				break
			}
		}
		if !found {
			return false
		}
		document.Revision++
		document.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		raw, _ := json.Marshal(document)
		if _, err := backend.CompareAndSwapFilmProject(ctx, tenantID, projectID, record.Revision, raw); err == nil {
			return true
		} else if !errors.Is(err, store.ErrConflict) {
			return false
		}
	}
	return false
}

func (s *Server) cancelFilmExportDeliverable(ctx context.Context, tenantID, projectID, deliverableID, jobID string) bool {
	backend, ok := s.store.(store.FilmStore)
	if !ok {
		return false
	}
	for range 5 {
		record, err := backend.GetFilmProject(ctx, tenantID, projectID)
		if err != nil {
			return false
		}
		document, err := decodeFilmDocument(record.Document)
		if err != nil {
			return false
		}
		found := false
		for index, item := range document.Deliverables {
			if item.ID != deliverableID || item.GenerationJobID != jobID {
				continue
			}
			if item.Status == filmStatusCanceled {
				return true
			}
			item.Status, item.Diagnostic, item.Revision = filmStatusCanceled, "已取消", item.Revision+1
			document.Deliverables[index], found = item, true
			break
		}
		if !found {
			return false
		}
		document.Revision++
		document.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		raw, _ := json.Marshal(document)
		if _, err := backend.CompareAndSwapFilmProject(ctx, tenantID, projectID, record.Revision, raw); err == nil {
			return true
		} else if !errors.Is(err, store.ErrConflict) {
			return false
		}
	}
	return false
}

func (s *Server) reconcileMissingFilmExportJobs(ctx context.Context, tenantID string, document filmDocument) bool {
	changed := false
	for _, item := range document.Deliverables {
		if item.Status != filmStatusRunning || item.GenerationJobID == "" {
			continue
		}
		if _, err := s.store.GetGenerationJob(ctx, tenantID, item.GenerationJobID); !errors.Is(err, store.ErrNotFound) {
			continue
		}
		if s.updateFilmExportDeliverable(ctx, tenantID, document.ProjectID, item.ID, item.GenerationJobID, func(current filmDeliverable) filmDeliverable {
			current.Status, current.Diagnostic, current.Revision = filmStatusFailed, "导出任务记录缺失，请重试", current.Revision+1
			return current
		}) {
			changed = true
		}
	}
	return changed
}

func (s *Server) finishFilmExportJob(tenantID string, job store.GenerationJob, status string, result filmExportJobResult, message string) {
	value, _ := json.Marshal(result)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _ = s.store.CompleteServerGenerationJob(ctx, tenantID, job.ID, job.LeaseOwner, status, value, message, time.Now().UTC())
}
