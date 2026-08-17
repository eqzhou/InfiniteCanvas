import { useState } from "react";
import {
  CloudDownload,
  CloudUpload,
  FolderCog,
  HardDrive,
  RotateCcw,
} from "lucide-react";
import { useBoardStore } from "@/stores/use-board-store";
import { createDefaultObjectStorage, normalizeObjectStorage, validateObjectStorageConfig } from "@/lib/object-storage";
import {
  exportConfigFile,
  hasSameChannelConfiguration,
  importConfigFile,
} from "@/lib/config-file";
import { webdavGetBlob, webdavPutBlob } from "@/services/webdav";
import {
  exportCompleteProjectBundle,
  exportCompleteWorkspaceBundle,
  importCompleteProjectBundle,
  importCompleteWorkspaceBundle,
} from "@/services/film-bundle";
import { listAllGenerationJobs } from "@/services/generation-jobs";
import { loadPersonalWorkflowTemplates } from "@/services/workflow-templates";
import {
  settingsChannelImportLockedFor,
  settingsImportEnabledFor,
  settingsWorkspacePermissions,
  type SettingsPolicyLoad,
} from "@/lib/settings-navigation";
import type { TenantPolicy } from "@/services/auth-session";
import { useI18n } from "@/i18n/I18nProvider";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { SettingsField } from "./SettingsField";
import type { SettingsNoticeHandlers } from "./settings-notices";

export function SettingsDataSection({
  tenantOwner,
  policyLoad,
  tenantPolicy,
  notices,
}: {
  tenantOwner: boolean;
  policyLoad: SettingsPolicyLoad;
  tenantPolicy: TenantPolicy;
  notices: SettingsNoticeHandlers;
}) {
  const { t } = useI18n();
  const objectStorage = useBoardStore((state) => state.config.objectStorage);
  const webdavUrl = useBoardStore((state) => state.config.webdavUrl);
  const webdavUser = useBoardStore((state) => state.config.webdavUser);
  const webdavPass = useBoardStore((state) => state.config.webdavPass);
  const setConfig = useBoardStore((state) => state.setConfig);
  const workspacePermissions = settingsWorkspacePermissions(tenantOwner);
  const [restoreWorkspacePending, setRestoreWorkspacePending] = useState(false);
  const importEnabled = settingsImportEnabledFor(tenantOwner, policyLoad);
  const storage = normalizeObjectStorage(objectStorage);
  const storageValidation = validateObjectStorageConfig(storage);

  const restoreWorkspace = () => {
    setRestoreWorkspacePending(false);
    notices.setFeedback(null);
    if (!workspacePermissions.restoreCompleteWorkspace) {
      notices.setFeedback({ tone: "danger", message: t("admin.permissionRequired") });
      return;
    }
    void (async () => {
      try {
        const state = useBoardStore.getState();
        const blob = await webdavGetBlob(state.config, "openboard-workspace.obundle");
        await importCompleteWorkspaceBundle(blob, state.config);
        notices.setFeedback({ tone: "success", message: t("settings.restoreWorkspaceSuccess") });
      } catch (cause) {
        notices.setFeedback({ tone: "danger", message: cause instanceof Error ? cause.message : String(cause) });
      }
    })();
  };

  return (
    <section className="ob-settings-section mb-5" data-section-id="data">
      <div className="ob-settings-section-header">
        <span className="ob-settings-section-icon"><HardDrive size={14} /></span>
        <div>
          <div className="ob-settings-section-title">{t("settings.dataAndBackup")}</div>
          <div className="ob-settings-section-desc">{t("settings.dataAndBackupDescription")}</div>
        </div>
      </div>

      <div className="mb-6">
        <h3 className="mb-1 text-sm font-medium">{t("settings.objectStorageTitle")}</h3>
        <p className="mb-3 text-xs text-[var(--ob-muted)]">{t("settings.objectStorageHint")}</p>
        <label className="ob-toggle-field mb-3">
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(objectStorage?.enabled)}
            aria-label={t("settings.enableObjectStorage")}
            className="ob-switch"
            data-checked={objectStorage?.enabled ? "true" : "false"}
            onClick={() => {
              const current = normalizeObjectStorage(useBoardStore.getState().config.objectStorage);
              setConfig({
                ...useBoardStore.getState().config,
                objectStorage: { ...current, enabled: !current.enabled },
              });
            }}
          />
          <span>{t("settings.enableObjectStorage")}</span>
        </label>
        <div className="grid gap-3 lg:grid-cols-2">
          <SettingsField label={t("settings.endpoint")}>
            <input
              className="ob-field"
              value={objectStorage?.endpoint ?? ""}
              placeholder="https://&lt;account&gt;.r2.cloudflarestorage.com"
              onChange={(event) => setConfig({
                ...useBoardStore.getState().config,
                objectStorage: { ...(useBoardStore.getState().config.objectStorage ?? createDefaultObjectStorage()), endpoint: event.target.value },
              })}
            />
          </SettingsField>
          <SettingsField label={t("settings.bucket")}>
            <input
              className="ob-field"
              value={objectStorage?.bucket ?? ""}
              onChange={(event) => setConfig({
                ...useBoardStore.getState().config,
                objectStorage: { ...(useBoardStore.getState().config.objectStorage ?? createDefaultObjectStorage()), bucket: event.target.value },
              })}
            />
          </SettingsField>
          <SettingsField label={t("settings.region")}>
            <input
              className="ob-field"
              value={objectStorage?.region ?? "auto"}
              onChange={(event) => setConfig({
                ...useBoardStore.getState().config,
                objectStorage: { ...(useBoardStore.getState().config.objectStorage ?? createDefaultObjectStorage()), region: event.target.value },
              })}
            />
          </SettingsField>
          <SettingsField label={t("settings.prefix")}>
            <input
              className="ob-field"
              value={objectStorage?.prefix ?? "openboard"}
              onChange={(event) => setConfig({
                ...useBoardStore.getState().config,
                objectStorage: { ...(useBoardStore.getState().config.objectStorage ?? createDefaultObjectStorage()), prefix: event.target.value },
              })}
            />
          </SettingsField>
          <SettingsField label={t("settings.accessKeyId")}>
            <input
              className="ob-field"
              name="openboard-object-storage-access-key-id"
              autoComplete="off"
              value={objectStorage?.accessKeyId ?? ""}
              onChange={(event) => setConfig({
                ...useBoardStore.getState().config,
                objectStorage: { ...(useBoardStore.getState().config.objectStorage ?? createDefaultObjectStorage()), accessKeyId: event.target.value },
              })}
            />
          </SettingsField>
          <SettingsField label={t("settings.secretAccessKey")}>
            <input
              className="ob-field"
              type="password"
              name="openboard-object-storage-secret-access-key"
              autoComplete="new-password"
              value={objectStorage?.secretAccessKey ?? ""}
              onChange={(event) => setConfig({
                ...useBoardStore.getState().config,
                objectStorage: { ...(useBoardStore.getState().config.objectStorage ?? createDefaultObjectStorage()), secretAccessKey: event.target.value },
              })}
            />
          </SettingsField>
          <SettingsField label={t("settings.sessionToken")}>
            <input
              className="ob-field"
              type="password"
              name="openboard-object-storage-session-token"
              autoComplete="new-password"
              value={objectStorage?.sessionToken ?? ""}
              onChange={(event) => setConfig({
                ...useBoardStore.getState().config,
                objectStorage: { ...(useBoardStore.getState().config.objectStorage ?? createDefaultObjectStorage()), sessionToken: event.target.value },
              })}
            />
          </SettingsField>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-[var(--ob-muted)]">
            <input
              type="checkbox"
              checked={Boolean(objectStorage?.allowInsecureLoopback)}
              onChange={(event) => setConfig({
                ...useBoardStore.getState().config,
                objectStorage: { ...(useBoardStore.getState().config.objectStorage ?? createDefaultObjectStorage()), allowInsecureLoopback: event.target.checked },
              })}
            />
            {t("settings.allowLoopback")}
          </label>
        </div>
        {storageValidation ? <p className="mt-2 text-xs text-[var(--ob-danger)]">{storageValidation}</p> : null}
      </div>

      <div className="mb-6 border-t border-[var(--ob-line)] pt-5">
        <div className="mb-1 flex items-center gap-2">
          <FolderCog size={14} className="text-[var(--ob-muted)]" />
          <h3 className="text-sm font-medium">{t("settings.configTitle")}</h3>
        </div>
        <p className="mb-3 text-xs text-[var(--ob-muted)]">{t("settings.configHint")}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="ob-btn"
            onClick={() => {
              const payload = JSON.stringify(exportConfigFile(useBoardStore.getState().config), null, 2);
              const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = "openboard-config.json";
              anchor.click();
              URL.revokeObjectURL(url);
            }}
          >
            <CloudDownload size={15} /> {t("settings.exportConfig")}
          </button>
          <label className="ob-btn cursor-pointer">
            <CloudUpload size={15} /> {t("settings.importConfig")}
            <input
              type="file"
              aria-label={t("settings.importConfigLabel")}
              accept="application/json,.json"
              className="hidden"
              disabled={!importEnabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                notices.setFeedback(null);
                void file.text().then(async (raw) => {
                  const state = useBoardStore.getState();
                  const previous = structuredClone(state.config);
                  const next = importConfigFile(raw, state.config);
                  if (settingsChannelImportLockedFor(tenantOwner, policyLoad, tenantPolicy.allowCustomChannel)
                    && !hasSameChannelConfiguration(state.config, next)) {
                    throw new Error(t("settings.channelImportLocked"));
                  }
                  state.setConfig(next);
                  const applied = useBoardStore.getState().config;
                  try {
                    await state.flushConfig();
                  } catch (cause) {
                    if (useBoardStore.getState().config === applied) {
                      useBoardStore.getState().setConfig(previous);
                      await useBoardStore.getState().flushConfig().catch(() => undefined);
                    }
                    throw cause;
                  }
                  notices.setFeedback({ tone: "success", message: t("settings.importSuccess") });
                }).catch((cause) => {
                  notices.setFeedback({ tone: "danger", message: cause instanceof Error ? cause.message : String(cause) });
                });
              }}
            />
          </label>
        </div>
      </div>

      <div className="border-t border-[var(--ob-line)] pt-5">
        <h3 className="mb-1 text-sm font-medium">{t("settings.webdavTitle")}</h3>
        <p className="mb-3 text-xs text-[var(--ob-muted)]">{t("settings.webdavDescription")}</p>
        <div className="grid gap-3 lg:grid-cols-[1.4fr_0.7fr_0.7fr]">
          <SettingsField label={t("settings.webdavUrl")}>
            <input className="ob-field" value={webdavUrl ?? ""} onChange={(event) => setConfig({ ...useBoardStore.getState().config, webdavUrl: event.target.value })} placeholder="https://example.com/dav/openboard" />
          </SettingsField>
          <SettingsField label={t("settings.username")}>
            <input className="ob-field" name="openboard-webdav-user" autoComplete="off" value={webdavUser ?? ""} onChange={(event) => setConfig({ ...useBoardStore.getState().config, webdavUser: event.target.value })} />
          </SettingsField>
          <SettingsField label={t("settings.password")}>
            <input className="ob-field" name="openboard-webdav-password" autoComplete="new-password" type="password" value={webdavPass ?? ""} onChange={(event) => setConfig({ ...useBoardStore.getState().config, webdavPass: event.target.value })} />
          </SettingsField>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="ob-btn"
            onClick={() => {
              notices.setFeedback(null);
              void (async () => {
                try {
                  const state = useBoardStore.getState();
                  const project = state.getActive();
                  if (!project) throw new Error(t("settings.canvasBackupMissing"));
                  const bundle = await exportCompleteProjectBundle(project);
                  await webdavPutBlob(state.config, "openboard-current.openboard", bundle);
                  notices.setFeedback({ tone: "success", message: t("settings.uploadCanvasSuccess") });
                } catch (cause) {
                  notices.setFeedback({ tone: "danger", message: cause instanceof Error ? cause.message : String(cause) });
                }
              })();
            }}
          >
            <CloudUpload size={15} /> {t("settings.uploadCanvas")}
          </button>
          {workspacePermissions.exportCompleteWorkspace ? <button
            type="button"
            className="ob-btn"
            onClick={() => {
              notices.setFeedback(null);
              void (async () => {
                try {
                  const store = useBoardStore.getState();
                  await Promise.all([
                    store.loadProjectsOnDemand(),
                    store.loadAssetsOnDemand(),
                    store.loadPromptsOnDemand(),
                  ]);
                  const state = useBoardStore.getState();
                  if (state.projectsState !== "loaded" || state.assetsState !== "loaded" || state.promptsState !== "loaded") {
                    throw new Error(t("workspace.loadFailed", { message: state.projectsError ?? state.assetsError ?? state.promptsError ?? "" }));
                  }
                  const bundle = await exportCompleteWorkspaceBundle({
                    projects: state.projects,
                    assets: state.assets,
                    prompts: state.prompts,
                    config: state.config,
                    generationJobs: await listAllGenerationJobs(),
                    workflowTemplates: await loadPersonalWorkflowTemplates(),
                  });
                  await webdavPutBlob(state.config, "openboard-workspace.obundle", bundle);
                  notices.setFeedback({ tone: "success", message: t("settings.uploadWorkspaceSuccess") });
                } catch (cause) {
                  notices.setFeedback({ tone: "danger", message: cause instanceof Error ? cause.message : String(cause) });
                }
              })();
            }}
          >
            <CloudUpload size={15} /> {t("settings.uploadWorkspace")}
          </button> : null}
          {workspacePermissions.importCompleteProject ? <button
            type="button"
            className="ob-btn"
            onClick={() => {
              notices.setFeedback(null);
              void (async () => {
                try {
                  const state = useBoardStore.getState();
                  const blob = await webdavGetBlob(state.config, "openboard-current.openboard");
                  await importCompleteProjectBundle(blob);
                  notices.setFeedback({ tone: "success", message: t("settings.importCanvasSuccess") });
                } catch (cause) {
                  notices.setFeedback({ tone: "danger", message: cause instanceof Error ? cause.message : String(cause) });
                }
              })();
            }}
          >
            <CloudDownload size={15} /> {t("settings.importCloudCanvas")}
          </button> : null}
          {workspacePermissions.restoreCompleteWorkspace ? <button
            type="button"
            className="ob-btn"
            onClick={() => setRestoreWorkspacePending(true)}
          >
            <RotateCcw size={15} /> {t("settings.restoreWorkspace")}
          </button> : null}
        </div>
      </div>

      {workspacePermissions.restoreCompleteWorkspace && restoreWorkspacePending ? (
        <ConfirmDialog
          title={t("settings.restoreWorkspace")}
          message={t("settings.confirmRestoreWorkspace")}
          confirmLabel={t("settings.restoreWorkspace")}
          onCancel={() => setRestoreWorkspacePending(false)}
          onConfirm={restoreWorkspace}
        />
      ) : null}
    </section>
  );
}
