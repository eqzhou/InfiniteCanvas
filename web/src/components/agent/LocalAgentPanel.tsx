import { useCallback, useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { Bot, Link2, RefreshCw, Send, Unplug, Check, X } from "lucide-react";
import {
  DEFAULT_AGENT_BASE_URL,
  fetchAgentStatus,
  normalizeAgentBaseUrl,
  syncProjectWithAgent,
  type AgentStatus,
  type CodexEvent,
  type CodexSession,
  closeCodexSession,
  createCodexSession,
  respondCodexApproval,
  sendCodexMessage,
  subscribeCodexEvents,
} from "@/services/local-agent";
import { classifyCodexEvent, codexApprovalKey } from "@/services/codex-events";

const AGENT_TOKEN_KEY = "openboard:agent-token";

function initialAgentToken(): string {
  try {
    return sessionStorage.getItem(AGENT_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
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
  const [baseUrl, setBaseUrl] = useState(config.localAgentUrl ?? DEFAULT_AGENT_BASE_URL);
  const [token, setToken] = useState(initialAgentToken);
  const connection = useMemo(() => ({ baseUrl, token }), [baseUrl, token]);
  const [codex, setCodex] = useState<CodexSession | null>(null);
  const [codexText, setCodexText] = useState("");
  const [codexMessages, setCodexMessages] = useState<Array<{ role: "user" | "assistant" | "system"; text: string }>>([]);
  const [codexTurnStatus, setCodexTurnStatus] = useState<"idle" | "running" | "completed" | "failed">("idle");
  const [approvals, setApprovals] = useState<CodexEvent[]>([]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
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
      } catch (syncError) {
        if (active) setError(syncError instanceof Error ? syncError.message : String(syncError));
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

  useEffect(() => {
    if (!codex) return;
    const source = subscribeCodexEvents(connection, codex.id, (event) => {
      const effect = classifyCodexEvent(event);
      if (effect.kind === "approval") {
        setApprovals((current) => current.some((item) => codexApprovalKey(item) === codexApprovalKey(effect.event))
          ? current
          : [...current, effect.event].slice(-32));
      }
      if (effect.kind === "assistant-delta") {
        setCodexMessages((current) => {
          const last = current[current.length - 1];
          if (last?.role === "assistant") return [...current.slice(0, -1), { ...last, text: last.text + effect.text }];
          return [...current, { role: "assistant", text: effect.text }];
        });
      }
      if (effect.kind === "item") {
        setCodexMessages((current) => [
          ...current,
          { role: "system", text: [effect.text, effect.status, effect.detail].filter(Boolean).join(" · ") },
        ]);
      }
      if (effect.kind === "turn") {
        setCodexTurnStatus(effect.status);
        if (effect.error) {
          setCodexMessages((current) => [
            ...current.slice(-119),
            { role: "system", text: `Codex：${effect.error}` },
          ]);
        }
      }
    }, (streamError) => {
      setCodexTurnStatus("failed");
      setError(`Codex 事件流已断开：${streamError.message}`);
      setCodexMessages((current) => [
        ...current.slice(-119),
        { role: "system", text: "Codex 事件流已断开，请重新建立会话。" },
      ]);
    });
    return () => source.close();
  }, [codex, connection]);

  const startCodex = async () => {
    setError(null);
    try {
      setCodexMessages([]);
      setCodexTurnStatus("idle");
      setApprovals([]);
      setCodex(await createCodexSession(connection));
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const sendCodex = async () => {
    if (!codex || !codexText.trim()) return;
    const text = codexText.trim(); setCodexText("");
    setCodexTurnStatus("running");
    setCodexMessages((current) => [...current, { role: "user", text }]);
    try { await sendCodexMessage(connection, codex.id, text); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

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
        <p className="text-xs text-[var(--ob-danger)]">
          无法连接 Agent：{error}
          <br />
          请运行 <code>cd server && go run ./cmd/server</code>
        </p>
      ) : (
        <div className="space-y-2 text-xs">
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
          <div className="border-t border-[var(--ob-line)] pt-2">
            <div className="mb-1 flex items-center justify-between"><strong>Codex</strong>{codex ? <button type="button" className="text-[var(--ob-muted)]" onClick={() => { void closeCodexSession(connection, codex.id); setCodex(null); }} title="关闭 Codex 会话"><Unplug size={13} /></button> : null}</div>
            {!codex ? <button type="button" className="inline-flex items-center gap-1 rounded bg-[var(--ob-accent)] px-2 py-1 text-white" onClick={() => void startCodex()}><Bot size={13} /> 开始会话</button> : <>
              <div className="mb-1 max-h-40 space-y-1 overflow-auto rounded border border-[var(--ob-line)] p-1 whitespace-pre-wrap">
                {codexMessages.length ? codexMessages.slice(-120).map((message, index) => <div key={`${index}-${message.role}`} className={message.role === "user" ? "text-[var(--ob-muted)]" : ""}><strong>{message.role === "user" ? "你" : message.role === "assistant" ? "Codex" : "系统"}：</strong>{message.text}</div>) : "等待 Codex 回复..."}
              </div>
              <div className="mb-1 text-[10px] text-[var(--ob-muted)]">状态：{codexTurnStatus === "running" ? "处理中" : codexTurnStatus === "completed" ? "已完成" : codexTurnStatus === "failed" ? "失败" : "空闲"}</div>
              <div className="flex gap-1"><input value={codexText} onChange={(e) => setCodexText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendCodex(); }} className="min-w-0 flex-1 rounded border border-[var(--ob-line)] bg-transparent px-2 py-1" placeholder="发送消息" /><button type="button" onClick={() => void sendCodex()} title="发送"><Send size={14} /></button></div>
            </>}
            {approvals.map((pending, index) => {
              const params = pending.params as { command?: unknown; path?: unknown; tool?: unknown } | undefined;
              const detail = typeof params?.command === "string"
                ? params.command
                : typeof params?.path === "string"
                  ? params.path
                  : typeof params?.tool === "string" ? params.tool : "需要确认的操作";
              const resolve = async (approve: boolean) => {
                if (!codex || pending.id === undefined) return;
                try {
                  await respondCodexApproval(connection, codex.id, pending.id, approve);
                  setApprovals((current) => current.filter((_, itemIndex) => itemIndex !== index));
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                }
              };
              return <div key={codexApprovalKey(pending)} className="mt-2 rounded border border-[var(--ob-warning)] p-2"><div className="mb-1">Codex 请求审批</div><div className="mb-1 break-words text-[var(--ob-muted)]">{detail}</div><details><summary className="cursor-pointer text-[10px]">查看请求详情</summary><pre className="max-h-20 overflow-auto text-[10px]">{JSON.stringify(pending.params, null, 2)}</pre></details><div className="mt-1 flex gap-1"><button type="button" title="允许" onClick={() => void resolve(true)}><Check size={14} /></button><button type="button" title="拒绝" onClick={() => void resolve(false)}><X size={14} /></button></div></div>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}
