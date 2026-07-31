import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useBoardStore } from "@/stores/use-board-store";
import { TopNav } from "@/components/layout/TopNav";
import { SettingsModal } from "@/components/layout/SettingsModal";
import { ShortcutsModal } from "@/components/layout/ShortcutsModal";
import { LocalAgentPanel } from "@/components/agent/LocalAgentPanel";
import { BrowserRuntime } from "@/components/agent/BrowserRuntime";
import { PromptSourceScheduler } from "@/components/prompts/PromptSourceScheduler";
import { HomePage } from "@/pages/HomePage";
import { AssetsPage } from "@/pages/AssetsPage";
import { ServerLibraryPage } from "@/pages/ServerLibraryPage";
import { AICallLogsPage } from "@/pages/AICallLogsPage";
import { PromptsPage } from "@/pages/PromptsPage";
import { PluginsPage } from "@/pages/PluginsPage";
import { ImageWorkbenchPage } from "@/pages/ImageWorkbenchPage";
import { VideoWorkbenchPage } from "@/pages/VideoWorkbenchPage";
import { AdminPage } from "@/pages/AdminPage";
import { HelpPage } from "@/pages/HelpPage";
import { applyChannelUrlCredentials, consumeUrlCredentials } from "@/lib/url-credentials";
import { initAnalytics } from "@/lib/analytics";
import { AnalyticsTracker } from "@/components/layout/AnalyticsTracker";
import { AuthGate } from "@/components/auth/AuthGate";

const WorkflowWorkbenchPage = lazy(async () => {
  const module = await import("@/pages/WorkflowWorkbenchPage");
  return { default: module.WorkflowWorkbenchPage };
});

export function App() {
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
            <span className="min-w-0 flex-1 truncate">连接参数无效：{urlCredentialError}</span>
            <button type="button" className="ob-banner-close" onClick={() => setUrlCredentialError(null)}>
              关闭
            </button>
          </div>
        ) : null}
        {promptSourceError ? (
          <div role="alert" className="ob-banner" data-tone="warning">
            <span className="min-w-0 flex-1 truncate">提示词来源自动刷新失败：{promptSourceError}</span>
            <button type="button" className="ob-banner-close" onClick={() => setPromptSourceError(null)}>关闭</button>
          </div>
        ) : null}
        {configConflict ? (
          <div role="alert" className="ob-banner" data-tone="warning">
            <span className="min-w-0 flex-1 truncate">{configConflict}，当前修改尚未保存。</span>
            <button type="button" className="ob-banner-close" onClick={() => window.location.reload()}>
              刷新并载入最新配置
            </button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <main className="min-h-0 min-w-0 flex-1">
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
              <Route path="/workbench/workflows" element={(
                <Suspense fallback={<div className="p-6 text-sm text-[var(--ob-muted)]">正在加载工作流…</div>}>
                  <WorkflowWorkbenchPage />
                </Suspense>
              )} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
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
