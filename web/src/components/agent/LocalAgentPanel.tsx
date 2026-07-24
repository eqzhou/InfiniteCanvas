import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { Bot, Link2, LoaderCircle, RefreshCw, Unplug } from "lucide-react";
import {
  DEFAULT_AGENT_BASE_URL,
  AGENT_TOKEN_KEY,
  fetchAgentStatus,
  normalizeAgentBaseUrl,
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
  const show = useBoardStore((s) => s.showLocalAgent);
  const showAssistant = useBoardStore((s) => s.showAssistant);
  const setShow = useBoardStore((s) => s.setShowLocalAgent);
  const config = useBoardStore((s) => s.config);
  const setConfig = useBoardStore((s) => s.setConfig);
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
  const connection = useMemo(() => ({ baseUrl, token }), [baseUrl, token]);
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
    try {
      if (token) sessionStorage.setItem(AGENT_TOKEN_KEY, token);
      else sessionStorage.removeItem(AGENT_TOKEN_KEY);
    } catch {
      // Private browsing may deny session storage; the in-memory token still works.
    }
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
    <div className={`ob-surface absolute bottom-16 left-2 right-2 z-[60] max-h-[calc(100vh-5rem)] w-auto overflow-auto p-3 shadow-[var(--ob-elev-2)] sm:left-auto sm:w-96 ${showAssistant ? "sm:right-[356px]" : "sm:right-4"}`}>
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]">
          <Bot size={16} />
        </span>
        <div className="min-w-0">
          <p className="ob-page-kicker !mb-0">Runtime</p>
          <strong className="text-sm font-semibold tracking-tight">本地 Agent</strong>
        </div>
        <button
          type="button"
          className="ob-icon-btn ml-auto h-8 w-8"
          title="刷新"
          aria-label="刷新 Agent 状态"
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          className="ob-icon-btn h-8 w-8"
          aria-label="关闭本地 Agent"
          title="关闭本地 Agent"
          onClick={() => setShow(false)}
        >
          <Unplug size={14} />
        </button>
      </div>
      <div className="mb-3 grid gap-2 rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_55%,transparent)] p-2.5">
        <label className="grid gap-1 text-xs">
          <span className="ob-label !mb-0">本地地址</span>
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
          <span className="ob-label !mb-0">连接令牌</span>
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
          <Link2 size={14} /> 连接
        </button>
      </div>
      {error ? (
        <p role="alert" className="rounded-lg border border-[color-mix(in_srgb,var(--ob-danger)_28%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-danger)_8%,transparent)] px-2.5 py-2 text-xs text-[var(--ob-danger)]">
          无法连接 Agent：{error}
          <br />
          请运行 <code className="rounded bg-[color-mix(in_srgb,var(--ob-canvas)_70%,transparent)] px-1">cd server && go run ./cmd/server</code>
        </p>
      ) : (
        <div className="space-y-2.5 text-xs">
          {syncError ? (
            <p role="alert" className="rounded-lg border border-[color-mix(in_srgb,var(--ob-danger)_28%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-danger)_8%,transparent)] px-2.5 py-2 text-[var(--ob-danger)]">
              Agent 同步失败：{syncError}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <span
              className="ob-status-dot"
              data-status={status?.connected ? "succeeded" : "idle"}
              aria-hidden
            />
            <span className={status?.connected ? "font-medium text-[var(--ob-accent)]" : "text-[var(--ob-muted)]"}>
              {status?.connected ? "已连接" : "未连接"}
            </span>
          </div>
          {status?.message ? <p className="text-[var(--ob-muted)]">{status.message}</p> : null}
          {status?.bridges?.length ? (
            <div>
              <span className="text-[var(--ob-muted)]">桥接</span>
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
              <span className="text-[var(--ob-muted)]">工具</span>
              <ul className="mt-1 list-disc pl-4 text-[var(--ob-ink)]">
                {status.tools.map((tool) => (
                  <li key={tool}>{tool}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[var(--ob-muted)]">
              当前服务未公布可用工具。
            </p>
          )}
          {runningGenerationTasks.length ? (
            <section className="rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_45%,transparent)] p-2" aria-label="正在运行的生成任务">
              <div className="mb-1.5 flex items-center gap-1.5 font-medium text-[var(--ob-ink)]">
                <LoaderCircle size={13} className="animate-spin text-[var(--ob-accent)]" />
                生成任务 · {runningGenerationTasks.length}
              </div>
              <ul className="space-y-1 text-[11px] text-[var(--ob-muted)]">
                {runningGenerationTasks.slice(0, 4).map((task) => (
                  <li key={task.id} className="flex min-w-0 items-center gap-2">
                    <span className="ob-chip shrink-0 !px-1.5 !py-0 text-[10px]">
                      {task.kind === "image" ? "图片" : task.kind === "video" ? "视频" : task.kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={task.prompt}>{task.prompt || "无提示词"}</span>
                    <span className="shrink-0">{task.surface === "image-workbench" ? "图片工作台" : task.surface === "video-workbench" ? "视频工作台" : "画布"}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="ob-segment mt-1 w-full" role="tablist" aria-label="Agent 会话">
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
              <span className="ml-auto self-center px-1 text-[10px] text-[var(--ob-muted)]">未检测到 claude CLI</span>
            ) : null}
          </div>
          <Suspense fallback={<div className="border-t border-[var(--ob-line)] pt-2 text-[var(--ob-muted)]">加载会话面板…</div>}>
            {agentTab === "claude" ? (
              <ClaudePanel connection={connection} />
            ) : (
              <CodexPanel connection={connection} />
            )}
          </Suspense>
        </div>
      )}
    </div>
  );
}
