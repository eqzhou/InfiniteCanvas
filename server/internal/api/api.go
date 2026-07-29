package api

import (
	"bytes"
	"context"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/openboard/openboard/server/internal/store"
)

const (
	maxProjectBytes   = 32 << 20
	maxUploadBytes    = 64 << 20
	maxStoredFiles    = 1 << 30
	maxStoredProjects = 1 << 30
	maxProjectCount   = 1_000
)

var projectIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

type Server struct {
	dataDir                 string
	mu                      sync.Mutex
	uploads                 chan struct{}
	codex                   *codexManager
	claude                  *claudeManager
	runtime                 *runtimeHub
	runtimeOrigins          map[string]struct{}
	store                   store.Store
	blobObjects             blobObjectStore
	tenantBlobStoreMu       sync.Mutex
	tenantBlobStores        map[string]tenantBlobStoreCacheEntry
	secrets                 cipher.AEAD
	imageExecutor           imageExecutor
	videoExecutor           videoExecutor
	audioExecutor           audioExecutor
	promptCatalogFetcher    promptCatalogFetchFunc
	promptSchedulerOnce     sync.Once
	logRetentionOnce        sync.Once
	logRetentionInterval    time.Duration
	promptSchedulerWG       sync.WaitGroup
	promptSchedulerRoot     context.Context
	stopPromptScheduler     context.CancelFunc
	promptSchedulerInterval time.Duration
	generationMu            sync.Mutex
	generationCancels       map[string]context.CancelFunc
	generationWG            sync.WaitGroup
	generationWorkerWG      sync.WaitGroup
	generationWorkersOnce   sync.Once
	generationRoot          context.Context
	stopGeneration          context.CancelFunc
	generationWake          chan struct{}
	workflowWorkerWG        sync.WaitGroup
	workflowWG              sync.WaitGroup
	workflowWorkersOnce     sync.Once
	workflowWake            chan struct{}
	videoWorkerWG           sync.WaitGroup
	videoWG                 sync.WaitGroup
	videoWorkersOnce        sync.Once
	videoWake               chan struct{}
	audioWorkerWG           sync.WaitGroup
	audioWG                 sync.WaitGroup
	audioWorkersOnce        sync.Once
	audioWake               chan struct{}
	processToken            string
}

func Mount(r chi.Router, dataDir string) {
	s := NewServer(dataDir)
	r.Route("/api", func(r chi.Router) {
		r.Get("/health", s.health)
		r.Get("/version", s.version)
		r.Get("/agent/status", s.agentStatus)
		r.Post("/agent/execute", s.executeAgentTool)
		r.Post("/runtime/ticket", s.runtimeTicket)
		r.Get("/runtime/ws", s.runtimeSocket)
		r.Post("/runtime/command", s.runtimeCommand)
		r.Post("/codex/session", s.createCodexSession)
		r.Get("/codex/session", s.getCodexSession)
		r.Post("/codex/message", s.sendCodexMessage)
		r.Post("/codex/interrupt", s.interruptCodex)
		r.Post("/codex/attachments", s.uploadCodexAttachments)
		r.Delete("/codex/attachments/{id}", s.deleteCodexAttachment)
		r.Post("/codex/approval", s.respondCodexApproval)
		r.Get("/codex/events", s.codexEvents)
		r.Delete("/codex/session/{id}", s.closeCodexSession)
		r.Post("/claude/session", s.createClaudeSession)
		r.Get("/claude/session", s.getClaudeSession)
		r.Post("/claude/message", s.sendClaudeMessage)
		r.Post("/claude/interrupt", s.interruptClaude)
		r.Get("/claude/events", s.claudeEvents)
		r.Delete("/claude/session/{id}", s.closeClaudeSession)
		r.Post("/files", s.uploadFile)
		r.Get("/files/{name}", s.getFile)
		r.Get("/projects", s.listProjects)
		r.Put("/projects/{id}", s.putProject)
		r.Get("/projects/{id}", s.getProject)
		r.Delete("/projects/{id}", s.deleteProject)
		r.Get("/state/{key}", s.getState)
		r.Put("/state/{key}", s.putState)
		r.Put("/blobs/{key}", s.putBlob)
		r.Get("/blobs/{key}", s.getBlob)
		r.Delete("/blobs/{key}", s.deleteBlob)
		r.Get("/director-captures", s.listDirectorCaptures)
		r.Post("/director-captures", s.createDirectorCapture)
		r.Put("/director-captures/prune", s.pruneDirectorCaptures)
		r.Delete("/director-captures/{id}", s.deleteDirectorCapture)
		r.Get("/secrets/config", s.getSecrets)
		r.Put("/secrets/config", s.putSecrets)
		r.Get("/config", s.getConfigBundle)
		r.Put("/config", s.putConfigBundle)
		r.Post("/provider-models", s.getProviderModels)
		r.Post("/provider-text", s.generateProviderText)
		r.Get("/generation-jobs", s.listGenerationJobs)
		r.Put("/generation-jobs", s.replaceGenerationJobs)
		r.Post("/generation-jobs", s.createGenerationJob)
		r.Post("/generation-jobs/image", s.createServerImageJob)
		r.Post("/generation-jobs/video", s.createServerVideoJob)
		r.Post("/generation-jobs/audio", s.createServerAudioJob)
		r.Post("/generation-jobs/workflow", s.createServerWorkflowJob)
		r.Post("/generation-jobs/{id}/cancel", s.cancelServerGenerationJob)
		r.Get("/generation-jobs/{id}", s.getGenerationJob)
		r.Put("/generation-jobs/{id}", s.updateGenerationJob)
		r.Delete("/generation-jobs/project/{projectId}", s.deleteGenerationJobsForProject)
		r.Post("/generation-jobs/bulk-delete", s.bulkDeleteGenerationJobs)
		r.Delete("/generation-jobs/{id}", s.deleteGenerationJob)
		r.Get("/workflow-templates", s.listWorkflowTemplates)
		r.Put("/workflow-templates", s.replaceWorkflowTemplates)
		r.Put("/workflow-templates/{id}", s.putWorkflowTemplate)
		r.Delete("/workflow-templates/{id}", s.deleteWorkflowTemplate)
		r.Get("/library-assets", s.listLibraryAssets)
		r.Post("/library-assets", s.createLibraryAsset)
		r.Get("/library-assets/{id}", s.getLibraryAsset)
		r.Put("/library-assets/{id}", s.updateLibraryAsset)
		r.Delete("/library-assets/{id}", s.deleteLibraryAsset)
		r.Get("/ai-call-logs", s.listAICallLogs)
		r.Get("/ai-call-logs/{id}", s.getAICallLog)
		r.Post("/ai-call-logs/delete", s.deleteAICallLogs)
		r.Get("/ai-call-logs/retention", s.getAICallLogRetention)
		r.Put("/ai-call-logs/retention", s.putAICallLogRetention)
		r.Get("/ai-call-logs/client-report", s.getAICallLogClientReport)
		r.Put("/ai-call-logs/client-report", s.putAICallLogClientReport)
		r.Post("/ai-call-logs/report", s.reportClientAICallLog)
		r.Get("/site-policy", s.getSitePolicy)
		r.Put("/site-policy", s.putSitePolicy)
		r.Get("/auth/oauth/linuxdo/start", s.linuxDoOAuthStart)
		r.Get("/auth/oauth/linuxdo/callback", s.linuxDoOAuthCallback)
		r.Get("/billing/estimate", s.estimateCredits)
		r.Get("/admin/channels", s.getAdminChannels)
		r.Get("/shared-channels", s.getSharedChannels)
		r.Put("/admin/channels", s.putAdminChannels)
		r.Delete("/admin/channels/{id}", s.deleteAdminChannel)
		r.Put("/admin/channels/{id}/secret", s.putAdminChannelSecret)
		r.Post("/admin/channels/{id}/test", s.testAdminChannel)
		r.Post("/admin/channels/{id}/models", s.getAdminChannelModels)
		r.Get("/admin/models", s.getAdminModels)
		r.Put("/admin/models", s.putAdminModels)
		r.Get("/admin/users", s.listAdminUsers)
		r.Patch("/admin/users/{id}", s.patchAdminUser)
		r.Post("/admin/users/{id}/credit-adjustments", s.createAdminCreditAdjustment)
		r.Get("/admin/credit-logs", s.listAdminCreditLogs)
		r.Get("/admin/storage-pool", s.getAdminStoragePool)
		r.Put("/admin/storage-pool", s.putAdminStoragePool)
		r.Put("/admin/storage-pool/{id}/secret", s.putAdminStoragePoolSecret)
		r.Delete("/admin/storage-pool/{id}", s.deleteAdminStoragePoolProvider)
		r.Get("/prompt-catalog", s.getPublicPromptCatalog)
		r.Get("/admin/prompt-catalog", s.getAdminPromptCatalog)
		r.Post("/admin/prompt-categories", s.createAdminPromptCategory)
		r.Put("/admin/prompt-categories/{id}", s.putAdminPromptCategory)
		r.Delete("/admin/prompt-categories/{id}", s.deleteAdminPromptCategory)
		r.Post("/admin/prompts", s.createAdminPrompt)
		r.Put("/admin/prompts/{id}", s.putAdminPrompt)
		r.Post("/admin/prompts/bulk-delete", s.bulkDeleteAdminPrompts)
		r.Post("/admin/prompt-sources", s.createAdminPromptSource)
		r.Put("/admin/prompt-sources/{id}", s.putAdminPromptSource)
		r.Delete("/admin/prompt-sources/{id}", s.deleteAdminPromptSource)
		r.Post("/admin/prompt-sources/{id}/sync", s.syncAdminPromptSource)
		r.Post("/admin/prompt-sources/sync-all", s.syncAllAdminPromptSources)
		r.Post("/admin/prompt-sources/run-due", s.runDueAdminPromptSources)
		r.Post("/media/references", s.createMediaReferences)
		r.Get("/media/references/{token}", s.getMediaReference)
		r.Get("/migration/capabilities", s.migrationCapabilities)
		r.Post("/migration/versions", s.migrationVersions)
		r.Put("/migration/projects/{id}", s.migrationPutProject)
		r.Put("/migration/state/{key}", s.migrationPutState)
		r.Put("/migration/secrets/config", s.migrationPutSecrets)
		r.Put("/migration/generation-history", s.migrationPutGenerationHistory)
		r.Put("/migration/blobs/{key}", s.migrationPutBlob)
	})
}

func NewServer(dataDir string) *Server {
	purgeCodexAttachmentRoot(dataDir)
	generationRoot, stopGeneration := context.WithCancel(context.Background())
	promptSchedulerRoot, stopPromptScheduler := context.WithCancel(context.Background())
	return &Server{
		dataDir: dataDir,
		uploads: make(chan struct{}, 2),
		codex:   newCodexManager(),
		claude:  newClaudeManager(),
		runtime: newRuntimeHub(),
		runtimeOrigins: map[string]struct{}{
			"http://localhost:5173": {},
			"http://127.0.0.1:5173": {},
		},
		imageExecutor:       newOpenAIImageExecutor(),
		videoExecutor:       newHTTPVideoExecutor(),
		audioExecutor:       newHTTPAudioExecutor(),
		generationCancels:   make(map[string]context.CancelFunc),
		generationRoot:      generationRoot,
		stopGeneration:      stopGeneration,
		generationWake:      make(chan struct{}, 1),
		promptSchedulerRoot: promptSchedulerRoot,
		stopPromptScheduler: stopPromptScheduler,
		workflowWake:        make(chan struct{}, 1),
		videoWake:           make(chan struct{}, 1),
		audioWake:           make(chan struct{}, 1),
	}
}

func (s *Server) SetProcessToken(token string) {
	s.processToken = strings.TrimSpace(token)
}

func (s *Server) SetRuntimeOrigins(origins map[string]struct{}) {
	s.runtimeOrigins = make(map[string]struct{}, len(origins))
	for origin := range origins {
		s.runtimeOrigins[origin] = struct{}{}
	}
}

func NewServerWithStore(dataDir string, backend store.Store) *Server {
	s := NewServer(dataDir)
	s.store = backend
	return s
}

func (s *Server) setBlobObjectStore(objects blobObjectStore) {
	s.tenantBlobStoreMu.Lock()
	defer s.tenantBlobStoreMu.Unlock()
	s.blobObjects = objects
}

func (s *Server) ConfigureS3BlobStorage(config S3BlobStorageConfig) error {
	objects, err := newS3BlobObjectStore(config)
	if err != nil {
		return err
	}
	s.tenantBlobStoreMu.Lock()
	defer s.tenantBlobStoreMu.Unlock()
	if s.store != nil {
		configs := []blobStorageProviderConfig{{
			ID: "process-default", Destination: s3BlobStorageDestination(objects),
			Weight: 1, Health: blobStorageProviderHealthy, Store: objects,
		}}
		if err := persistBlobProviderRegistry(context.Background(), s.store, configs); err != nil {
			return err
		}
		if current, ok := s.blobObjects.(*blobStoragePoolStore); ok {
			return current.Update(configs)
		}
		pool, err := newBlobStoragePoolStore(configs, newTenantStateBlobPlacementStore(s.store))
		if err != nil {
			return err
		}
		s.blobObjects = pool
		return nil
	}
	s.blobObjects = objects
	return nil
}

func (s *Server) Close() {
	s.runtime.closeAll()
	s.codex.closeAll()
	s.claude.closeAll()
	s.stopPromptScheduler()
	s.stopGeneration()
	s.generationMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(s.generationCancels))
	for _, cancel := range s.generationCancels {
		cancels = append(cancels, cancel)
	}
	s.generationMu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	s.generationWorkerWG.Wait()
	s.generationWG.Wait()
	s.workflowWorkerWG.Wait()
	s.workflowWG.Wait()
	s.videoWorkerWG.Wait()
	s.videoWG.Wait()
	s.audioWorkerWG.Wait()
	s.audioWG.Wait()
	s.promptSchedulerWG.Wait()
}

func randomGenerationOwner() string {
	value := make([]byte, 12)
	if _, err := rand.Read(value); err != nil {
		return fmt.Sprintf("worker-%d", time.Now().UnixNano())
	}
	return "worker-" + hex.EncodeToString(value)
}

func MountServer(r chi.Router, s *Server) {
	s.startPromptCatalogScheduler()
	s.startAICallLogRetentionScheduler()
	r.Route("/api", func(r chi.Router) {
		r.Use(s.withSession)
		r.Use(s.requireUserWhenNeeded)
		r.Get("/health", s.health)
		r.Get("/version", s.version)
		r.Post("/auth/register", s.register)
		r.Post("/auth/login", s.login)
		r.Post("/auth/logout", s.logout)
		r.Get("/auth/me", s.me)
		r.Get("/auth/usage", s.usage)
		r.Get("/agent/status", s.agentStatus)
		r.Post("/agent/execute", s.executeAgentTool)
		r.Post("/runtime/ticket", s.runtimeTicket)
		r.Get("/runtime/ws", s.runtimeSocket)
		r.Post("/runtime/command", s.runtimeCommand)
		r.Post("/codex/session", s.createCodexSession)
		r.Get("/codex/session", s.getCodexSession)
		r.Post("/codex/message", s.sendCodexMessage)
		r.Post("/codex/interrupt", s.interruptCodex)
		r.Post("/codex/attachments", s.uploadCodexAttachments)
		r.Delete("/codex/attachments/{id}", s.deleteCodexAttachment)
		r.Post("/codex/approval", s.respondCodexApproval)
		r.Get("/codex/events", s.codexEvents)
		r.Delete("/codex/session/{id}", s.closeCodexSession)
		r.Post("/claude/session", s.createClaudeSession)
		r.Get("/claude/session", s.getClaudeSession)
		r.Post("/claude/message", s.sendClaudeMessage)
		r.Post("/claude/interrupt", s.interruptClaude)
		r.Get("/claude/events", s.claudeEvents)
		r.Delete("/claude/session/{id}", s.closeClaudeSession)
		r.Post("/files", s.uploadFile)
		r.Get("/files/{name}", s.getFile)
		r.Get("/projects", s.listProjects)
		r.Put("/projects/{id}", s.putProject)
		r.Get("/projects/{id}", s.getProject)
		r.Delete("/projects/{id}", s.deleteProject)
		r.Get("/state/{key}", s.getState)
		r.Put("/state/{key}", s.putState)
		r.Put("/blobs/{key}", s.putBlob)
		r.Get("/blobs/{key}", s.getBlob)
		r.Delete("/blobs/{key}", s.deleteBlob)
		r.Get("/director-captures", s.listDirectorCaptures)
		r.Post("/director-captures", s.createDirectorCapture)
		r.Put("/director-captures/prune", s.pruneDirectorCaptures)
		r.Delete("/director-captures/{id}", s.deleteDirectorCapture)
		r.Get("/secrets/config", s.getSecrets)
		r.Put("/secrets/config", s.putSecrets)
		r.Get("/config", s.getConfigBundle)
		r.Put("/config", s.putConfigBundle)
		r.Post("/provider-models", s.getProviderModels)
		r.Post("/provider-text", s.generateProviderText)
		r.Get("/generation-jobs", s.listGenerationJobs)
		r.Put("/generation-jobs", s.replaceGenerationJobs)
		r.Post("/generation-jobs", s.createGenerationJob)
		r.Post("/generation-jobs/image", s.createServerImageJob)
		r.Post("/generation-jobs/video", s.createServerVideoJob)
		r.Post("/generation-jobs/audio", s.createServerAudioJob)
		r.Post("/generation-jobs/workflow", s.createServerWorkflowJob)
		r.Post("/generation-jobs/{id}/cancel", s.cancelServerGenerationJob)
		r.Get("/generation-jobs/{id}", s.getGenerationJob)
		r.Put("/generation-jobs/{id}", s.updateGenerationJob)
		r.Delete("/generation-jobs/project/{projectId}", s.deleteGenerationJobsForProject)
		r.Post("/generation-jobs/bulk-delete", s.bulkDeleteGenerationJobs)
		r.Delete("/generation-jobs/{id}", s.deleteGenerationJob)
		r.Get("/workflow-templates", s.listWorkflowTemplates)
		r.Put("/workflow-templates", s.replaceWorkflowTemplates)
		r.Put("/workflow-templates/{id}", s.putWorkflowTemplate)
		r.Delete("/workflow-templates/{id}", s.deleteWorkflowTemplate)
		r.Get("/library-assets", s.listLibraryAssets)
		r.Post("/library-assets", s.createLibraryAsset)
		r.Get("/library-assets/{id}", s.getLibraryAsset)
		r.Put("/library-assets/{id}", s.updateLibraryAsset)
		r.Delete("/library-assets/{id}", s.deleteLibraryAsset)
		r.Get("/ai-call-logs", s.listAICallLogs)
		r.Get("/ai-call-logs/{id}", s.getAICallLog)
		r.Post("/ai-call-logs/delete", s.deleteAICallLogs)
		r.Get("/ai-call-logs/retention", s.getAICallLogRetention)
		r.Put("/ai-call-logs/retention", s.putAICallLogRetention)
		r.Get("/ai-call-logs/client-report", s.getAICallLogClientReport)
		r.Put("/ai-call-logs/client-report", s.putAICallLogClientReport)
		r.Post("/ai-call-logs/report", s.reportClientAICallLog)
		r.Get("/site-policy", s.getSitePolicy)
		r.Put("/site-policy", s.putSitePolicy)
		r.Get("/auth/oauth/linuxdo/start", s.linuxDoOAuthStart)
		r.Get("/auth/oauth/linuxdo/callback", s.linuxDoOAuthCallback)
		r.Get("/billing/estimate", s.estimateCredits)
		r.Get("/admin/channels", s.getAdminChannels)
		r.Get("/shared-channels", s.getSharedChannels)
		r.Put("/admin/channels", s.putAdminChannels)
		r.Delete("/admin/channels/{id}", s.deleteAdminChannel)
		r.Put("/admin/channels/{id}/secret", s.putAdminChannelSecret)
		r.Post("/admin/channels/{id}/test", s.testAdminChannel)
		r.Post("/admin/channels/{id}/models", s.getAdminChannelModels)
		r.Get("/admin/models", s.getAdminModels)
		r.Put("/admin/models", s.putAdminModels)
		r.Get("/admin/users", s.listAdminUsers)
		r.Patch("/admin/users/{id}", s.patchAdminUser)
		r.Post("/admin/users/{id}/credit-adjustments", s.createAdminCreditAdjustment)
		r.Get("/admin/credit-logs", s.listAdminCreditLogs)
		r.Get("/admin/storage-pool", s.getAdminStoragePool)
		r.Put("/admin/storage-pool", s.putAdminStoragePool)
		r.Put("/admin/storage-pool/{id}/secret", s.putAdminStoragePoolSecret)
		r.Delete("/admin/storage-pool/{id}", s.deleteAdminStoragePoolProvider)
		r.Get("/prompt-catalog", s.getPublicPromptCatalog)
		r.Get("/admin/prompt-catalog", s.getAdminPromptCatalog)
		r.Post("/admin/prompt-categories", s.createAdminPromptCategory)
		r.Put("/admin/prompt-categories/{id}", s.putAdminPromptCategory)
		r.Delete("/admin/prompt-categories/{id}", s.deleteAdminPromptCategory)
		r.Post("/admin/prompts", s.createAdminPrompt)
		r.Put("/admin/prompts/{id}", s.putAdminPrompt)
		r.Post("/admin/prompts/bulk-delete", s.bulkDeleteAdminPrompts)
		r.Post("/admin/prompt-sources", s.createAdminPromptSource)
		r.Put("/admin/prompt-sources/{id}", s.putAdminPromptSource)
		r.Delete("/admin/prompt-sources/{id}", s.deleteAdminPromptSource)
		r.Post("/admin/prompt-sources/{id}/sync", s.syncAdminPromptSource)
		r.Post("/admin/prompt-sources/sync-all", s.syncAllAdminPromptSources)
		r.Post("/admin/prompt-sources/run-due", s.runDueAdminPromptSources)
		r.Post("/media/references", s.createMediaReferences)
		r.Get("/media/references/{token}", s.getMediaReference)
		r.Get("/migration/capabilities", s.migrationCapabilities)
		r.Post("/migration/versions", s.migrationVersions)
		r.Put("/migration/projects/{id}", s.migrationPutProject)
		r.Put("/migration/state/{key}", s.migrationPutState)
		r.Put("/migration/secrets/config", s.migrationPutSecrets)
		r.Put("/migration/generation-history", s.migrationPutGenerationHistory)
		r.Put("/migration/blobs/{key}", s.migrationPutBlob)
	})
}

func SecureDataDir(dataDir string) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	return filepath.WalkDir(dataDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("data directory must not contain symbolic links")
		}
		if entry.IsDir() {
			return os.Chmod(path, 0o700)
		}
		return os.Chmod(path, 0o600)
	})
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	storage := "filesystem"
	if s.store != nil {
		storage = "postgresql+redis"
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.store.Ping(ctx); err != nil {
			http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
			return
		}
	}
	blobStorage := "filesystem"
	s.tenantBlobStoreMu.Lock()
	blobObjects := s.blobObjects
	s.tenantBlobStoreMu.Unlock()
	if blobObjects != nil {
		blobStorage = blobObjects.Kind()
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := blobObjects.Ping(ctx); err != nil {
			http.Error(w, "blob storage unavailable", http.StatusServiceUnavailable)
			return
		}
	}
	writeJSON(w, map[string]any{
		"ok":          true,
		"service":     "openboard-local",
		"time":        time.Now().UTC().Format(time.RFC3339),
		"storage":     storage,
		"blobStorage": blobStorage,
	})
}

func (s *Server) version(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{
		"name":    "OpenBoard",
		"version": "0.1.0",
		"stack":   "go+chi",
	})
}

func (s *Server) agentStatus(w http.ResponseWriter, r *http.Request) {
	hostExecution := accountAgentExecutionAllowed(requestAgentScope(r))
	bridges := []string{"http-json", "mcp-stdio", "codex-app-server"}
	if hostExecution && claudeAvailable() {
		bridges = append(bridges, "claude-code")
	}
	writeJSON(w, map[string]any{
		"connected": true,
		"runtime":   map[string]any{"connected": s.runtime.connectedFor(requestAgentScope(r))},
		"bridges":   bridges,
		"message":   "Local board tools, Codex, and optional Claude Code sessions are available.",
		"codex":     map[string]any{"available": hostExecution, "sessionEndpoint": "/api/codex/session", "eventsEndpoint": "/api/codex/events"},
		"claude":    map[string]any{"available": hostExecution && claudeAvailable(), "sessionEndpoint": "/api/claude/session", "eventsEndpoint": "/api/claude/events", "binary": claudeBinary()},
		"tools": []string{
			"board.get_state",
			"board.get_selection",
			"board.export_snapshot",
			"board.apply_ops",
			"board.create_text_node",
			"board.create_image_prompt_flow",
			"asset.search",
			"asset.insert",
			"prompt.search",
			"prompt.insert",
			"site.navigate",
			"generation_get_status",
			"board.list_nodes",
			"board.add_node",
			"board.update_node",
			"board.delete_nodes",
			"board.connect",
			"board.export_json",
		},
	})
}

func (s *Server) uploadFile(w http.ResponseWriter, r *http.Request) {
	select {
	case s.uploads <- struct{}{}:
		defer func() { <-s.uploads }()
	default:
		http.Error(w, "too many concurrent uploads", http.StatusTooManyRequests)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		http.Error(w, "invalid or oversized multipart upload", http.StatusBadRequest)
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	tenantID := tenantIDFrom(r)
	if !projectIDPattern.MatchString(tenantID) {
		http.Error(w, "invalid tenant", http.StatusBadRequest)
		return
	}
	// Scope runtime/agent file drops per tenant so a shared filename cannot
	// become a cross-tenant read once the URL leaks into logs or chat.
	dir := filepath.Join(s.dataDir, "files", tenantID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		http.Error(w, "failed to prepare file storage", http.StatusInternalServerError)
		return
	}
	storedBytes, err := directoryBytes(dir)
	if err != nil || hdr.Size < 0 || storedBytes+hdr.Size > maxStoredFiles {
		http.Error(w, "file storage quota exceeded", http.StatusInsufficientStorage)
		return
	}
	name := filepath.Base(hdr.Filename)
	if name == "." || name == "/" || name == "" {
		name = "upload.bin"
	}
	// avoid collisions; filepath.Base already strips directory components
	name = time.Now().UTC().Format("20060102T150405.000000000") + "_" + name
	dst := filepath.Join(dir, name)
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		http.Error(w, "failed to create stored file", http.StatusInternalServerError)
		return
	}
	defer out.Close()
	if _, err := io.Copy(out, file); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		http.Error(w, "failed to store file", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{
		"name": name,
		"url":  "/api/files/" + name, // resolved under the caller's tenant on GET
		"size": hdr.Size,
	})
}

func directoryBytes(dir string) (int64, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return 0, err
		}
		total += info.Size()
	}
	return total, nil
}

func (s *Server) getFile(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(chi.URLParam(r, "name"))
	if name == "." || name == "/" || name == "" || strings.Contains(name, string(filepath.Separator)) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	tenantID := tenantIDFrom(r)
	if !projectIDPattern.MatchString(tenantID) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	path := filepath.Join(s.dataDir, "files", tenantID, name)
	if info, err := os.Lstat(path); err != nil || info.Mode()&os.ModeSymlink != 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Runtime/agent drops are never meant to be navigated as documents in the
	// browser. Force download + nosniff so a leaked URL cannot execute as HTML.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "attachment")
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeFile(w, r, path)
}

func (s *Server) projectsDir() string {
	return filepath.Join(s.dataDir, "projects")
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	if s.store != nil {
		items, err := s.store.ListProjects(r.Context(), tenantIDFrom(r))
		if err != nil {
			http.Error(w, "failed to list projects", http.StatusInternalServerError)
			return
		}
		writeJSON(w, items)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := s.projectsDir()
	_ = os.MkdirAll(dir, 0o700)
	entries, err := os.ReadDir(dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]map[string]any, 0)
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(b, &obj) == nil {
			out = append(out, map[string]any{
				"id":        obj["id"],
				"title":     obj["title"],
				"updatedAt": obj["updatedAt"],
			})
		}
	}
	writeJSON(w, out)
}

func (s *Server) putProject(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	release, err := s.acquireWriteLock()
	if err != nil {
		http.Error(w, "project store is busy", http.StatusServiceUnavailable)
		return
	}
	defer release()
	id := chi.URLParam(r, "id")
	if !validProjectID(id) {
		http.Error(w, "invalid project id", http.StatusBadRequest)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxProjectBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "invalid or oversized project", http.StatusBadRequest)
		return
	}
	var project map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&project); err != nil || project == nil {
		http.Error(w, "invalid project json", http.StatusBadRequest)
		return
	}
	if err := ensureJSONEOF(decoder); err != nil {
		http.Error(w, "invalid project json", http.StatusBadRequest)
		return
	}
	if bodyID, ok := project["id"].(string); !ok || bodyID != id {
		http.Error(w, "project id does not match path", http.StatusBadRequest)
		return
	}
	if err := validateProjectDocument(project); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if s.store != nil {
		if err := s.store.PutProject(r.Context(), tenantIDFrom(r), id, body); err != nil {
			// The project was deleted while this client still held it. Say so
			// explicitly so a stale tab stops retrying a write it can never win.
			if errors.Is(err, store.ErrGone) {
				http.Error(w, "project was deleted", http.StatusGone)
				return
			}
			http.Error(w, "failed to store project", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	dir := s.projectsDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	path := filepath.Join(dir, id+".json")
	count, storedBytes, err := projectStoreUsage(dir)
	if err != nil {
		http.Error(w, "failed to inspect project storage", http.StatusInternalServerError)
		return
	}
	if info, statErr := os.Stat(path); statErr == nil {
		storedBytes -= info.Size()
	} else if errors.Is(statErr, os.ErrNotExist) {
		count++
	}
	if count > maxProjectCount || storedBytes+int64(len(body)) > maxStoredProjects {
		http.Error(w, "project storage quota exceeded", http.StatusInsufficientStorage)
		return
	}
	if err := atomicWriteFile(path, body, 0o600); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := chi.URLParam(r, "id")
	if !validProjectID(id) {
		http.Error(w, "invalid project id", http.StatusBadRequest)
		return
	}
	if s.store != nil {
		b, err := s.store.GetProject(r.Context(), tenantIDFrom(r), id)
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "failed to read project", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
		return
	}
	path := filepath.Join(s.projectsDir(), id+".json")
	b, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	release, err := s.acquireWriteLock()
	if err != nil {
		http.Error(w, "project store is busy", http.StatusServiceUnavailable)
		return
	}
	defer release()
	id := chi.URLParam(r, "id")
	if !validProjectID(id) {
		http.Error(w, "invalid project id", http.StatusBadRequest)
		return
	}
	if s.store != nil {
		tenantID := tenantIDFrom(r)
		if err := s.store.DeleteProject(r.Context(), tenantID, id); err != nil {
			http.Error(w, "failed to delete project", http.StatusInternalServerError)
			return
		}
		if _, err := s.store.DeleteGenerationJobsForProject(r.Context(), tenantID, id); err != nil {
			http.Error(w, "failed to delete project generation jobs", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	path := filepath.Join(s.projectsDir(), id+".json")
	_ = os.Remove(path)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) acquireWriteLock() (func(), error) {
	if err := os.MkdirAll(s.dataDir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(s.dataDir, ".openboard-write.lock")
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(tokenBytes)
	for attempt := 0; attempt < 200; attempt++ {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			if _, err := file.WriteString(token); err != nil {
				_ = file.Close()
				_ = os.Remove(path)
				return nil, err
			}
			_ = file.Close()
			return func() {
				if current, readErr := os.ReadFile(path); readErr == nil && string(current) == token {
					_ = os.Remove(path)
				}
			}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > 2*time.Minute {
			_ = os.Remove(path)
			continue
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil, errors.New("timed out waiting for project store")
}

func projectStoreUsage(dir string) (int, int64, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, 0, err
	}
	count := 0
	var total int64
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return 0, 0, err
		}
		count++
		total += info.Size()
	}
	return count, total, nil
}

func validProjectID(id string) bool {
	return projectIDPattern.MatchString(id)
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple json values")
		}
		return err
	}
	return nil
}

func atomicWriteFile(path string, body []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".project-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}
