import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { Bot, Link2, LoaderCircle, RefreshCw, Unplug } from "lucide-react";
import {
  DEFAULT_AGENT_BASE_URL,
  fetchAgentStatus,
  normalizeAgentBaseUrl,
  saveAgentToken,
  syncProjectWithAgent,
  type AgentStatus,
  readAgentToken,
  resolveAgentBaseUrl,
} from "@/services/local-agent";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import {
  getGenerationActivities,
  subscribeGenerationActivities,
} from "@/services/generation-activity";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { getSessionToken } from "@/services/auth-session";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator } from "@/i18n/messages/agent-help";

const CodexPanel = lazy(async () => {
  const module = await import("@/components/agent/CodexPanel");
  return { default: module.CodexPanel };
});

const ClaudePanel = lazy(async () => {
  const module = await import("@/components/agent/ClaudePanel");
  return { default: module.ClaudePanel };
});

function initialAgentToken(): string {
  return readAgentToken();
}

export function LocalAgentPanel() {
  const { locale, t: baseT } = useI18n();
  const t = createAgentHelpTranslator(baseT, locale);
  const show = useBoardStore((s) => s.showLocalAgent);
  const setShow = useBoardStore((s) => s.setShowLocalAgent);
  const config = useBoardStore((s) => s.config);
  const setConfig = useBoardStore((s) => s.setConfig);
  const auth = useOptionalAuth();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [generationTasks, setGenerationTasks] = useState(getGenerationActivities);
  const [agentTab, setAgentTab] = useState<"codex" | "claude">("codex");
  const [baseUrl, setBaseUrl] = useState(() => resolveAgentBaseUrl(
    config.localAgentUrl,
    readAgentToken(),
    window.location.origin,
  ));
  const [token, setToken] = useState(initialAgentToken);
  const sessionToken = getSessionToken();
  const connection = useMemo(
    () => ({ baseUrl, token, sessionToken }),
    [auth?.user?.id, auth?.user?.tenantId, baseUrl, sessionToken, token],
  );
  useEscapeDismiss(show, () => setShow(false));
  const runningGenerationTasks = generationTasks.filter((task) => task.status === "running");

  useEffect(() => subscribeGenerationActivities(() => {
    setGenerationTasks(getGenerationActivities());
  }), []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSyncError(null);
    try {
      setStatus(await fetchAgentStatus(connection));
      return true;
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [connection]);

  const connect = async () => {
    let normalized: string;
    try {
      normalized = normalizeAgentBaseUrl(baseUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (!(await refresh())) return;
    setBaseUrl(normalized);
    const current = useBoardStore.getState().config;
    setConfig({ ...current, localAgentUrl: normalized });
    saveAgentToken(token);
  };

  useEffect(() => {
    if (show) void refresh();
  }, [show, refresh]);

  useEffect(() => {
    if (!show || !status?.connected) return;
    let active = true;
    let running = false;
    const sync = async () => {
      if (running) return;
      running = true;
      const state = useBoardStore.getState();
      try {
        for (const project of state.projects) {
          const result = await syncProjectWithAgent(project, () =>
            useBoardStore.getState().projects.find((current) => current.id === project.id),
            connection,
          );
          if (active && result.direction === "pull" && result.project) {
            const current = useBoardStore
              .getState()
              .projects.find((candidate) => candidate.id === project.id);
            if (current?.updatedAt === project.updatedAt) {
              useBoardStore.getState().replaceProjectFromAgent(result.project);
            }
          }
        }
        if (active) setSyncError(null);
      } catch (cause) {
        if (active) setSyncError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        running = false;
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connection, show, status?.connected]);


  if (!show) return null;

  return (
    <aside
      id="canvas-agent"
      aria-label={t("agent.canvasAgent")}
      className="ob-drawer fixed bottom-0 right-0 top-14 z-[60] flex w-full flex-col overflow-auto p-3 shadow-[var(--ob-elev-2)] sm:w-[420px] xl:static xl:h-full xl:w-[380px] xl:shrink-0"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]">
          <Bot size={16} />
        </span>
        <div className="min-w-0">
          <p className="ob-page-kicker !mb-0">Canvas runtime</p>
          <strong className="text-sm font-semibold tracking-tight">{t("agent.canvasAgent")}</strong>
        </div>
        <button
          type="button"
          className="ob-icon-btn ml-auto h-8 w-8"
          title={t("agent.refresh")}
          aria-label={t("agent.refreshStatus")}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          className="ob-icon-btn h-8 w-8"
          aria-label={t("agent.closeCanvasAgent")}
          title={t("agent.closeCanvasAgent")}
          onClick={() => setShow(false)}
        >
          <Unplug size={14} />
        </button>
      </div>
      <div className="mb-3 grid gap-2 rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_55%,transparent)] p-2.5">
        <label className="grid gap-1 text-xs">
          <span className="ob-label !mb-0">{t("agent.localAddress")}</span>
          <input
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setStatus(null);
            }}
            className="ob-field"
            placeholder={DEFAULT_AGENT_BASE_URL}
          />
        </label>
        <label className="grid gap-1 text-xs">
          <span className="ob-label !mb-0">{t("agent.connectionToken")}</span>
          <input
            type="password"
            value={token}
            autoComplete="off"
            onChange={(event) => {
              setToken(event.target.value);
              setStatus(null);
            }}
            className="ob-field"
          />
        </label>
        <button
          type="button"
          className="ob-btn-primary gap-1.5 text-xs"
          disabled={busy || !baseUrl.trim()}
          onClick={() => void connect()}
        >
          <Link2 size={14} /> {t("agent.connect")}
        </button>
      </div>
      {error ? (
        <p role="alert" className="rounded-lg border border-[color-mix(in_srgb,var(--ob-danger)_28%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-danger)_8%,transparent)] px-2.5 py-2 text-xs text-[var(--ob-danger)]">
          {t("agent.connectionFailed", { message: error })}
          <br />
          {t("agent.runServerHint")} <code className="rounded bg-[color-mix(in_srgb,var(--ob-canvas)_70%,transparent)] px-1">cd server && go run ./cmd/server</code>
        </p>
      ) : (
        <div className="space-y-2.5 text-xs">
          {syncError ? (
            <p role="alert" className="rounded-lg border border-[color-mix(in_srgb,var(--ob-danger)_28%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-danger)_8%,transparent)] px-2.5 py-2 text-[var(--ob-danger)]">
              {t("agent.syncFailed", { message: syncError })}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <span
              className="ob-status-dot"
              data-status={status?.connected ? "succeeded" : "idle"}
              aria-hidden
            />
            <span className={status?.connected ? "font-medium text-[var(--ob-accent)]" : "text-[var(--ob-muted)]"}>
              {status?.connected ? t("agent.connected") : t("agent.disconnected")}
            </span>
          </div>
          {status?.message ? <p className="text-[var(--ob-muted)]">{status.message}</p> : null}
          {status?.bridges?.length ? (
            <div>
              <span className="text-[var(--ob-muted)]">{t("agent.bridge")}</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {status.bridges.map((b) => (
                  <span key={b} className="ob-chip">
                    {b}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {status?.tools?.length ? (
            <div>
              <span className="text-[var(--ob-muted)]">{t("agent.tools")}</span>
              <ul className="mt-1 list-disc pl-4 text-[var(--ob-ink)]">
                {status.tools.map((tool) => (
                  <li key={tool}>{tool}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[var(--ob-muted)]">
              {t("agent.noTools")}
            </p>
          )}
          {runningGenerationTasks.length ? (
            <section className="rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_45%,transparent)] p-2" aria-label={t("agent.runningTasks")}>
              <div className="mb-1.5 flex items-center gap-1.5 font-medium text-[var(--ob-ink)]">
                <LoaderCircle size={13} className="animate-spin text-[var(--ob-accent)]" />
                {t("agent.generationTasks", { count: runningGenerationTasks.length })}
              </div>
              <ul className="space-y-1 text-[11px] text-[var(--ob-muted)]">
                {runningGenerationTasks.slice(0, 4).map((task) => (
                  <li key={task.id} className="flex min-w-0 items-center gap-2">
                    <span className="ob-chip shrink-0 !px-1.5 !py-0 text-[10px]">
                      {task.kind === "image" ? t("agent.image") : task.kind === "video" ? t("agent.video") : task.kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={task.prompt}>{task.prompt || t("agent.noPrompt")}</span>
                    <span className="shrink-0">{task.surface === "image-workbench" ? t("agent.imageWorkbench") : task.surface === "video-workbench" ? t("agent.videoWorkbench") : t("agent.canvas")}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="ob-segment mt-1 w-full" role="tablist" aria-label={t("agent.sessions")}>
            <button
              type="button"
              role="tab"
              aria-selected={agentTab === "codex"}
              className="ob-segment-item flex-1"
              onClick={() => setAgentTab("codex")}
            >
              Codex
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={agentTab === "claude"}
              className="ob-segment-item flex-1"
              onClick={() => setAgentTab("claude")}
            >
              Claude
            </button>
            {status?.claude?.available === false ? (
              <span className="ml-auto self-center px-1 text-[10px] text-[var(--ob-muted)]">{t("agent.claudeMissing")}</span>
            ) : null}
          </div>
          <Suspense fallback={<div className="border-t border-[var(--ob-line)] pt-2 text-[var(--ob-muted)]">{t("agent.loadingPanel")}</div>}>
            {agentTab === "claude" ? (
              <ClaudePanel connection={connection} />
            ) : (
              <CodexPanel connection={connection} />
            )}
          </Suspense>
        </div>
      )}
    </aside>
  );
}
