import { useEffect, useLayoutEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useBoardStore } from "@/stores/use-board-store";
import { TopNav } from "@/components/layout/TopNav";
import { SettingsModal } from "@/components/layout/SettingsModal";
import { ShortcutsModal } from "@/components/layout/ShortcutsModal";
import { LocalAgentPanel } from "@/components/agent/LocalAgentPanel";
import { BrowserRuntime } from "@/components/agent/BrowserRuntime";
import { PromptSourceScheduler } from "@/components/prompts/PromptSourceScheduler";
import { HomePage } from "@/pages/HomePage";
import { AssetsPage } from "@/pages/AssetsPage";
import { PromptsPage } from "@/pages/PromptsPage";
import { PluginsPage } from "@/pages/PluginsPage";
import { ImageWorkbenchPage } from "@/pages/ImageWorkbenchPage";
import { VideoWorkbenchPage } from "@/pages/VideoWorkbenchPage";
import { applyChannelUrlCredentials, consumeUrlCredentials } from "@/lib/url-credentials";
import { initAnalytics } from "@/lib/analytics";
import { AnalyticsTracker } from "@/components/layout/AnalyticsTracker";

export function App() {
  const hydrate = useBoardStore((s) => s.hydrate);
  const theme = useBoardStore((s) => s.config.theme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [urlCredentialError, setUrlCredentialError] = useState<string | null>(null);
  const [promptSourceError, setPromptSourceError] = useState<string | null>(null);
  const [urlCredentials] = useState(() =>
    consumeUrlCredentials(window.location.href));

  useLayoutEffect(() => {
    if (urlCredentials.hadSensitiveParams) {
      window.history.replaceState(
        window.history.state,
        "",
        urlCredentials.sanitizedPath,
      );
    }
  }, [urlCredentials]);

  useEffect(() => {
    void hydrate().then(() => {
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
    });
  }, [hydrate, urlCredentials]);

  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      useBoardStore.getState().setShowAssistant(false);
    }
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
        useBoardStore.getState().setShowAssistant(detail.open);
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
    <div className="flex h-full flex-col">
      <TopNav onOpenSettings={() => setSettingsOpen(true)} />
      {urlCredentialError ? (
        <div role="alert" className="flex items-center gap-2 border-b border-[var(--ob-danger)] bg-[var(--ob-panel)] px-4 py-2 text-sm text-[var(--ob-danger)]">
          <span className="min-w-0 flex-1 truncate">连接参数无效：{urlCredentialError}</span>
          <button type="button" className="shrink-0" onClick={() => setUrlCredentialError(null)}>
            关闭
          </button>
        </div>
      ) : null}
      {promptSourceError ? (
        <div role="alert" className="flex items-center gap-2 border-b border-[var(--ob-warning)] bg-[var(--ob-panel)] px-4 py-2 text-sm text-[var(--ob-warning)]">
          <span className="min-w-0 flex-1 truncate">提示词来源自动刷新失败：{promptSourceError}</span>
          <button type="button" className="shrink-0" onClick={() => setPromptSourceError(null)}>关闭</button>
        </div>
      ) : null}
      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/prompts" element={<PromptsPage />} />
          <Route path="/plugins" element={<PluginsPage />} />
          <Route path="/workbench/image" element={<ImageWorkbenchPage />} />
          <Route path="/workbench/video" element={<VideoWorkbenchPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShortcutsModal />
      <LocalAgentPanel />
      <BrowserRuntime />
      <PromptSourceScheduler />
      <AnalyticsTracker />
    </div>
  );
}
