import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { Bot, Link2, RefreshCw, Unplug } from "lucide-react";
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

const CodexPanel = lazy(async () => {
  const module = await import("@/components/agent/CodexPanel");
  return { default: module.CodexPanel };
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
  const [baseUrl, setBaseUrl] = useState(() => resolveAgentBaseUrl(
    config.localAgentUrl,
    readAgentToken(),
    window.location.origin,
  ));
  const [token, setToken] = useState(initialAgentToken);
  const connection = useMemo(() => ({ baseUrl, token }), [baseUrl, token]);
  useEscapeDismiss(show, () => setShow(false));

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
    <div className={`absolute bottom-16 left-2 right-2 z-[60] max-h-[calc(100vh-5rem)] w-auto overflow-auto rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-3 shadow-[var(--ob-shadow)] sm:left-auto sm:w-96 ${showAssistant ? "sm:right-[356px]" : "sm:right-4"}`}>
      <div className="mb-2 flex items-center gap-2">
        <Bot size={16} className="text-[var(--ob-accent)]" />
        <strong className="text-sm">本地 Agent</strong>
        <button
          type="button"
          className="ml-auto rounded p-1 hover:bg-[var(--ob-accent-soft)]"
          title="刷新"
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          className="rounded p-1 hover:bg-[var(--ob-accent-soft)]"
          title="关闭"
          onClick={() => setShow(false)}
        >
          <Unplug size={14} />
        </button>
      </div>
      <div className="mb-3 grid gap-2 border-b border-[var(--ob-line)] pb-3">
        <label className="grid gap-1 text-xs">
          <span className="text-[var(--ob-muted)]">Local URL</span>
          <input
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setStatus(null);
            }}
            className="rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5"
            placeholder={DEFAULT_AGENT_BASE_URL}
          />
        </label>
        <label className="grid gap-1 text-xs">
          <span className="text-[var(--ob-muted)]">Connect token</span>
          <input
            type="password"
            value={token}
            autoComplete="off"
            onChange={(event) => {
              setToken(event.target.value);
              setStatus(null);
            }}
            className="rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5"
          />
        </label>
        <button
          type="button"
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--ob-accent)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
          disabled={busy || !baseUrl.trim()}
          onClick={() => void connect()}
        >
          <Link2 size={14} /> 连接
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-[var(--ob-danger)]">
          无法连接 Agent：{error}
          <br />
          请运行 <code>cd server && go run ./cmd/server</code>
        </p>
      ) : (
        <div className="space-y-2 text-xs">
          {syncError ? <p role="alert" className="text-[var(--ob-danger)]">Agent 同步失败：{syncError}</p> : null}
          <div>
            状态：{" "}
            <span
              className={
                status?.connected ? "text-[var(--ob-accent)]" : "text-[var(--ob-muted)]"
              }
            >
              {status?.connected ? "已连接" : "未连接"}
            </span>
          </div>
          <p className="text-[var(--ob-muted)]">{status?.message}</p>
          {status?.bridges?.length ? (
            <div>
              Bridges：
              <div className="mt-1 flex flex-wrap gap-1">
                {status.bridges.map((b) => (
                  <span
                    key={b}
                    className="rounded bg-[var(--ob-accent-soft)] px-1.5 py-0.5"
                  >
                    {b}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {status?.tools?.length ? (
            <div>
              Tools：
              <ul className="mt-1 list-disc pl-4">
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
          <Suspense fallback={<div className="border-t border-[var(--ob-line)] pt-2 text-[var(--ob-muted)]">加载 Codex 面板…</div>}>
            <CodexPanel connection={connection} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
