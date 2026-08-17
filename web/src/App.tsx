import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Navigate, Route, Routes } from "react-router";
import { useBoardStore } from "@/stores/use-board-store";
import { TopNav } from "@/components/layout/TopNav";
import { PromptSourceScheduler } from "@/components/prompts/PromptSourceScheduler";
import { applyChannelUrlCredentials, consumeUrlCredentials } from "@/lib/url-credentials";
import { initAnalytics } from "@/lib/analytics";
import { applyTheme, setupCrossTabThemeListener, setupSystemThemeListener } from "@/lib/theme";
import { AnalyticsTracker } from "@/components/layout/AnalyticsTracker";
import { AuthGate } from "@/components/auth/AuthGate";
import { ToastContainer } from "@/components/common/ToastContainer";
import { useI18n } from "@/i18n/I18nProvider";
import { lazyRoute, preloadRouteChunk } from "@/routes/route-registry";
import { PageSkeleton } from "@/components/layout/PageSkeleton";

const HomePage = lazyRoute("home");
const AssetsPage = lazyRoute("assets");
const ServerLibraryPage = lazyRoute("library");
const AICallLogsPage = lazyRoute("aiLogs");
const PromptsPage = lazyRoute("prompts");
const PluginsPage = lazyRoute("plugins");
const ImageWorkbenchPage = lazyRoute("imageWorkbench");
const VideoWorkbenchPage = lazyRoute("videoWorkbench");
const AdminPage = lazyRoute("admin");
const HelpPage = lazyRoute("help");
const WorkflowWorkbenchPage = lazyRoute("workflowWorkbench");
const FilmWorkbenchPage = lazyRoute("filmWorkbench");
const TaskCenterPage = lazyRoute("tasks");
const SettingsModal = lazy(async () => {
  const module = await import("@/components/layout/SettingsModal");
  return { default: module.SettingsModal };
});
const ShortcutsModal = lazy(async () => {
  const module = await import("@/components/layout/ShortcutsModal");
  return { default: module.ShortcutsModal };
});
const LocalAgentPanel = lazy(async () => {
  const module = await import("@/components/agent/LocalAgentPanel");
  return { default: module.LocalAgentPanel };
});
const BrowserRuntime = lazy(async () => {
  const module = await import("@/components/agent/BrowserRuntime");
  return { default: module.BrowserRuntime };
});

export function App() {
  const { t } = useI18n();
  const hydrate = useBoardStore((s) => s.hydrate);
  const prepareWorkspaceScopeChange = useBoardStore((s) => s.prepareWorkspaceScopeChange);
  const resetWorkspaceScopeRuntime = useBoardStore((s) => s.resetWorkspaceScopeRuntime);
  const ready = useBoardStore((s) => s.ready);
  const theme = useBoardStore((s) => s.config.theme);
  const showShortcuts = useBoardStore((s) => s.showShortcuts);
  const showLocalAgent = useBoardStore((s) => s.showLocalAgent);
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
    if (ready) void preloadRouteChunk("home");
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    applyTheme(theme);
    const unsubs: (() => void)[] = [];
    if (theme === "system") {
      unsubs.push(setupSystemThemeListener(() => {
        applyTheme("system");
      }));
    }
    unsubs.push(setupCrossTabThemeListener((newTheme) => {
      if (newTheme !== theme) {
        const { config, setConfig } = useBoardStore.getState();
        setConfig({ ...config, theme: newTheme });
        applyTheme(newTheme);
      }
    }));
    return () => unsubs.forEach((unsub) => unsub());
  }, [ready, theme]);

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
            <Suspense fallback={<PageSkeleton />}>
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
          {showLocalAgent ? (
            <Suspense fallback={null}>
              <LocalAgentPanel />
            </Suspense>
          ) : null}
        </div>
        {settingsOpen ? (
          <Suspense fallback={null}>
            <SettingsModal open onClose={() => setSettingsOpen(false)} />
          </Suspense>
        ) : null}
        {showShortcuts ? (
          <Suspense fallback={null}>
            <ShortcutsModal />
          </Suspense>
        ) : null}
        <Suspense fallback={null}>
          <BrowserRuntime />
        </Suspense>
        <PromptSourceScheduler />
        <AnalyticsTracker />
        <ToastContainer />
      </div>
    </AuthGate>
  );
}
