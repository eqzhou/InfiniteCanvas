import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { Navigate, Route, Routes } from "react-router";
import { useBoardStore } from "@/stores/use-board-store";
import { TopNav } from "@/components/layout/TopNav";
import { SettingsModal } from "@/components/layout/SettingsModal";
import { ShortcutsModal } from "@/components/layout/ShortcutsModal";
import { LocalAgentPanel } from "@/components/agent/LocalAgentPanel";
import { BrowserRuntime } from "@/components/agent/BrowserRuntime";
import { PromptSourceScheduler } from "@/components/prompts/PromptSourceScheduler";
import { HomePage } from "@/pages/HomePage";
import { applyChannelUrlCredentials, consumeUrlCredentials } from "@/lib/url-credentials";
import { initAnalytics } from "@/lib/analytics";
import { AnalyticsTracker } from "@/components/layout/AnalyticsTracker";
import { AuthGate } from "@/components/auth/AuthGate";
import { useI18n } from "@/i18n/I18nProvider";

// Landing route (HomePage) stays eager so the most common entry avoids a
// Suspense flash. Every other route is code-split out of the initial bundle.
function lazyNamed<M extends Record<string, unknown>, K extends keyof M>(
  loader: () => Promise<M>,
  name: K,
) {
  return lazy(async () => {
    const module = await loader();
    return { default: module[name] as ComponentType };
  });
}

const AssetsPage = lazyNamed(() => import("@/pages/AssetsPage"), "AssetsPage");
const ServerLibraryPage = lazyNamed(() => import("@/pages/ServerLibraryPage"), "ServerLibraryPage");
const AICallLogsPage = lazyNamed(() => import("@/pages/AICallLogsPage"), "AICallLogsPage");
const PromptsPage = lazyNamed(() => import("@/pages/PromptsPage"), "PromptsPage");
const PluginsPage = lazyNamed(() => import("@/pages/PluginsPage"), "PluginsPage");
const ImageWorkbenchPage = lazyNamed(() => import("@/pages/ImageWorkbenchPage"), "ImageWorkbenchPage");
const VideoWorkbenchPage = lazyNamed(() => import("@/pages/VideoWorkbenchPage"), "VideoWorkbenchPage");
const AdminPage = lazyNamed(() => import("@/pages/AdminPage"), "AdminPage");
const HelpPage = lazyNamed(() => import("@/pages/HelpPage"), "HelpPage");
const WorkflowWorkbenchPage = lazyNamed(
  () => import("@/pages/WorkflowWorkbenchPage"),
  "WorkflowWorkbenchPage",
);
const FilmWorkbenchPage = lazyNamed(() => import("@/pages/FilmWorkbenchPage"), "FilmWorkbenchPage");
const TaskCenterPage = lazyNamed(() => import("@/pages/TaskCenterPage"), "TaskCenterPage");

export function App() {
  const { t } = useI18n();
  const hydrate = useBoardStore((s) => s.hydrate);
  const prepareWorkspaceScopeChange = useBoardStore((s) => s.prepareWorkspaceScopeChange);
  const resetWorkspaceScopeRuntime = useBoardStore((s) => s.resetWorkspaceScopeRuntime);
  const theme = useBoardStore((s) => s.config.theme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [urlCredentialError, setUrlCredentialError] = useState<string | null>(null);
  const [promptSourceError, setPromptSourceError] = useState<string | null>(null);
  const [configConflict, setConfigConflict] = useState<string | null>(null);
  const [urlCredentials] = useState(() =>
    consumeUrlCredentials(window.location.href));
  const urlCredentialsAppliedRef = useRef(false);

  useLayoutEffect(() => {
    if (urlCredentials.hadSensitiveParams) {
      window.history.replaceState(
        window.history.state,
        "",
        urlCredentials.sanitizedPath,
      );
    }
  }, [urlCredentials]);

  const onAuthReady = useCallback(async (scope: string) => {
    await hydrate(scope);
    if (urlCredentialsAppliedRef.current) return;
    urlCredentialsAppliedRef.current = true;
    const { apiKey, baseUrl, provider } = urlCredentials.credentials;
    if (apiKey === undefined && baseUrl === undefined) return;

    const { config, setConfig } = useBoardStore.getState();
    const channel =
      config.channels.find((c) => c.id === config.activeChannelId) ??
      config.channels[0];
    if (!channel) return;

    try {
      setConfig({
        ...config,
        channels: config.channels.map((c) =>
          c.id === channel.id
            ? applyChannelUrlCredentials(c, { apiKey, baseUrl, provider })
            : c,
        ),
      });
    } catch (cause) {
      setUrlCredentialError(cause instanceof Error ? cause.message : String(cause));
    }
    setSettingsOpen(true);
  }, [hydrate, urlCredentials]);

  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      useBoardStore.getState().setShowLocalAgent(false);
    }
  }, []);

  useEffect(() => {
    const report = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown }>).detail;
      if (typeof detail?.message === "string") setConfigConflict(detail.message);
    };
    window.addEventListener("openboard:config-conflict", report);
    return () => window.removeEventListener("openboard:config-conflict", report);
  }, []);

  useEffect(() => {
    const report = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown }>).detail;
      if (typeof detail?.message === "string") setPromptSourceError(detail.message);
    };
    window.addEventListener("openboard:prompt-source-error", report);
    return () => window.removeEventListener("openboard:prompt-source-error", report);
  }, []);

  useEffect(() => {
    const controlPluginPanel = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: unknown }>).detail;
      if (typeof detail?.open === "boolean") {
        useBoardStore.getState().setShowLocalAgent(detail.open);
      }
    };
    window.addEventListener("openboard:plugin-panel", controlPluginPanel);
    return () => window.removeEventListener("openboard:plugin-panel", controlPluginPanel);
  }, []);

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    const dark =
      theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }, [theme]);

  return (
    <AuthGate
      onReady={onAuthReady}
      onBeforeScopeChange={prepareWorkspaceScopeChange}
      onScopeCredentialsChanged={resetWorkspaceScopeRuntime}
    >
      <div className="flex h-full flex-col">
        <TopNav onOpenSettings={() => setSettingsOpen(true)} />
        {urlCredentialError ? (
          <div role="alert" className="ob-banner" data-tone="danger">
            <span className="min-w-0 flex-1 truncate">{t("app.connectionParamsInvalid", { message: urlCredentialError })}</span>
            <button type="button" className="ob-banner-close" onClick={() => setUrlCredentialError(null)}>
              {t("common.close")}
            </button>
          </div>
        ) : null}
        {promptSourceError ? (
          <div role="alert" className="ob-banner" data-tone="warning">
            <span className="min-w-0 flex-1 truncate">{t("app.promptSourceRefreshFailed", { message: promptSourceError })}</span>
            <button type="button" className="ob-banner-close" onClick={() => setPromptSourceError(null)}>{t("common.close")}</button>
          </div>
        ) : null}
        {configConflict ? (
          <div role="alert" className="ob-banner" data-tone="warning">
            <span className="min-w-0 flex-1 truncate">{t("app.configConflictUnsaved", { message: configConflict })}</span>
            <button type="button" className="ob-banner-close" onClick={() => window.location.reload()}>
              {t("app.reloadLatestConfig")}
            </button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <main className="min-h-0 min-w-0 flex-1">
            <Suspense fallback={<div className="p-6 text-sm text-[var(--ob-muted)]">{t("common.loading")}</div>}>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/assets" element={<AssetsPage />} />
                <Route path="/library" element={<ServerLibraryPage />} />
                <Route path="/ai-logs" element={<AICallLogsPage />} />
                <Route path="/prompts" element={<PromptsPage />} />
                <Route path="/plugins" element={<PluginsPage />} />
                <Route path="/workbench/image" element={<ImageWorkbenchPage />} />
                <Route path="/workbench/video" element={<VideoWorkbenchPage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="/help" element={<HelpPage />} />
                <Route path="/workbench/workflows" element={<WorkflowWorkbenchPage />} />
                <Route path="/film/:projectId" element={<FilmWorkbenchPage />} />
                <Route path="/tasks" element={<TaskCenterPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </main>
          <LocalAgentPanel />
        </div>
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <ShortcutsModal />
        <BrowserRuntime />
        <PromptSourceScheduler />
        <AnalyticsTracker />
      </div>
    </AuthGate>
  );
}
