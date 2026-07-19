import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ImagePlus, Plus, Send, Square, Unplug, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  closeCodexSession,
  createCodexSession,
  deleteCodexAttachment,
  getCodexSession,
  interruptCodexTurn,
  respondCodexApproval,
  sendCodexMessage,
  subscribeCodexEvents,
  uploadCodexAttachments,
  type AgentConnection,
  type CodexEvent,
  type CodexSession,
} from "@/services/local-agent";
import {
  classifyCodexEvent,
  codexApprovalKey,
  codexApprovalResolutionKey,
  codexEventThreadId,
} from "@/services/codex-events";
import {
  createCodexSessionSync,
  shouldResetCodexTranscript,
  statusForCodexSnapshot,
  type SharedTurnStatus,
} from "@/services/codex-session-sync";
import { getRuntimeClientId } from "@/services/runtime-identity";

type Message = { id?: string; role: "user" | "assistant"; text: string };
type TurnStatus = SharedTurnStatus;
const CODEX_PROFILE = "default";

function MarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="underline">{children}</a>,
        img: () => <span>[图片]</span>,
        pre: ({ children }) => <pre className="max-w-full overflow-auto whitespace-pre-wrap rounded bg-[var(--ob-accent-soft)] p-1">{children}</pre>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export function CodexPanel({ connection }: { connection: AgentConnection }) {
  const [session, setSession] = useState<CodexSession | null>(null);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [turnStatus, setTurnStatus] = useState<TurnStatus>("idle");
  const [approvals, setApprovals] = useState<CodexEvent[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const syncRef = useRef<ReturnType<typeof createCodexSessionSync> | null>(null);
  const turnStatusRef = useRef<TurnStatus>("idle");
  const sharedRevisionRef = useRef(0);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const previews = useMemo(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })), [files]);
  const sessionId = session?.id;

  useEffect(() => {
    turnStatusRef.current = turnStatus;
  }, [turnStatus]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)), [previews]);

  useEffect(() => {
    let active = true;
    const applyShared = (shared: { session: CodexSession | null; turnStatus: TurnStatus }) => {
      if (!active) return;
      sharedRevisionRef.current += 1;
      const nextSessionId = shared.session?.id;
      if (shouldResetCodexTranscript(sessionIdRef.current, nextSessionId)) {
        setMessages([]);
        setLogs([]);
        setFiles([]);
        setApprovals([]);
      }
      sessionIdRef.current = nextSessionId;
      setSession(shared.session);
      setTurnStatus(shared.turnStatus);
      turnStatusRef.current = shared.turnStatus;
      if (!shared.session) {
        setApprovals([]);
      }
    };
    const sync = createCodexSessionSync(CODEX_PROFILE, applyShared);
    syncRef.current = sync;
    const requestRevision = sharedRevisionRef.current;
    void getCodexSession(connection, CODEX_PROFILE)
      .then((current) => {
        if (!active || sharedRevisionRef.current !== requestRevision) return;
        const status: TurnStatus = current?.running ? "running" : "idle";
        if (shouldResetCodexTranscript(sessionIdRef.current, current?.id)) {
          setMessages([]);
          setLogs([]);
          setFiles([]);
          setApprovals([]);
        }
        sessionIdRef.current = current?.id;
        setSession(current);
        setTurnStatus(status);
        turnStatusRef.current = status;
        sync.publish(current, status);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
      sync.close();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [connection]);

  useEffect(() => {
    if (!sessionId) return;
    const source = subscribeCodexEvents(connection, sessionId, (event) => {
      if (sessionIdRef.current !== sessionId) return;
      setReconnecting(false);
      setError((current) => current?.startsWith("Codex 事件流正在重连：") ? null : current);
      if (event.method === "openboard/session_state") {
        const snapshot = event.data as CodexSession | undefined;
        if (!snapshot || snapshot.id !== sessionId || typeof snapshot.running !== "boolean") return;
        const status = statusForCodexSnapshot(turnStatusRef.current, snapshot.running);
        setSession(snapshot);
        setTurnStatus(status);
        turnStatusRef.current = status;
        syncRef.current?.publish(snapshot, status);
        return;
      }
      const resolvedApproval = codexApprovalResolutionKey(event);
      if (resolvedApproval) {
        setApprovals((current) => current.filter((item) => codexApprovalKey(item) !== resolvedApproval));
        return;
      }
      if (event.method === "openboard/user_message") {
        const data = event.data as { id?: unknown; text?: unknown } | undefined;
        if (typeof data?.id !== "string" || typeof data.text !== "string") return;
        const id = data.id;
        const messageText = data.text;
        const message: Message = { id, role: "user", text: messageText };
        setMessages((current) => current.some((message) => message.id === id)
          ? current
          : [...current, message].slice(-120));
        return;
      }
      const eventThreadId = codexEventThreadId(event);
      if (eventThreadId && session?.threadId && eventThreadId !== session.threadId) return;
      const effect = classifyCodexEvent(event);
      if (effect.kind === "approval") {
        setApprovals((current) => current.some((item) => codexApprovalKey(item) === codexApprovalKey(effect.event))
          ? current
          : [...current, effect.event].slice(-32));
      }
      if (effect.kind === "assistant-delta") {
        setMessages((current) => {
          const last = current[current.length - 1];
          if (last?.role === "assistant") return [...current.slice(0, -1), { ...last, text: last.text + effect.text }];
          return [...current, { role: "assistant", text: effect.text }];
        });
      }
      if (effect.kind === "item") {
        setLogs((current) => [...current.slice(-99), [effect.text, effect.status, effect.detail].filter(Boolean).join(" · ")]);
      }
      if (effect.kind === "turn") {
        setTurnStatus(effect.status);
        turnStatusRef.current = effect.status;
        setSession((current) => {
          if (!current || current.id !== sessionId) return current;
          const next = { ...current, running: effect.status === "running" };
          syncRef.current?.publish(next, effect.status);
          return next;
        });
        if (effect.error) setLogs((current) => [...current.slice(-99), `Codex: ${effect.error}`]);
      }
    }, (streamError, recoverable) => {
      setReconnecting(recoverable);
      setError(recoverable
        ? `Codex 事件流正在重连：${streamError.message}`
        : `Codex 会话已结束：${streamError.message}`);
      if (recoverable) return;
      setTurnStatus("failed");
      turnStatusRef.current = "failed";
      setSession((current) => {
        if (!current || current.id !== sessionId) return current;
        const next = { ...current, running: false };
        syncRef.current?.publish(next, "failed");
        return next;
      });
    });
    return () => source.close();
  }, [connection, sessionId, session?.threadId]);

  const start = async (fresh: boolean) => {
    sharedRevisionRef.current += 1;
    setBusy(true);
    setError(null);
    setReconnecting(false);
    try {
      const previousSessionId = sessionIdRef.current;
      const next = await createCodexSession(connection, { profile: "default", fresh });
      sessionIdRef.current = next.id;
      setSession(next);
      const status: TurnStatus = next.running ? "running" : "idle";
      setTurnStatus(status);
      turnStatusRef.current = status;
      syncRef.current?.publish(next, status);
      setApprovals([]);
      if (fresh || shouldResetCodexTranscript(previousSessionId, next.id)) {
        setMessages([]);
        setLogs([]);
        setFiles([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!session || !text.trim() || busy || turnStatusRef.current === "running") return;
    const prompt = text.trim();
    sharedRevisionRef.current += 1;
    setBusy(true);
    setError(null);
    setReconnecting(false);
    let attachments: Awaited<ReturnType<typeof uploadCodexAttachments>> = [];
    try {
      attachments = files.length
        ? await uploadCodexAttachments(connection, session.id, files)
        : [];
      setText("");
      setFiles([]);
      setTurnStatus("running");
      const next = { ...session, running: true };
      setSession(next);
      syncRef.current?.publish(next, "running");
      await sendCodexMessage(
        connection,
        session.id,
        prompt,
        fetch,
        attachments.map((item) => item.id),
        getRuntimeClientId(),
      );
    } catch (cause) {
      await Promise.allSettled(attachments.map((attachment) =>
        deleteCodexAttachment(connection, session.id, attachment.id)));
      setTurnStatus("failed");
      turnStatusRef.current = "failed";
      setSession((current) => {
        if (!current) return current;
        const next = { ...current, running: false };
        syncRef.current?.publish(next, "failed");
        return next;
      });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!session) return;
    sharedRevisionRef.current += 1;
    try {
      await interruptCodexTurn(connection, session.id);
      setLogs((current) => [...current.slice(-99), "已请求停止当前 turn"]);
      const current = await getCodexSession(connection, CODEX_PROFILE);
      if (current && !current.running) {
        setSession(current);
        setTurnStatus("completed");
        turnStatusRef.current = "completed";
        syncRef.current?.publish(current, "completed");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="border-t border-[var(--ob-line)] pt-2">
      <div className="mb-1 flex items-center gap-1">
        <strong>Codex</strong>
        {session?.threadId ? <span className="min-w-0 truncate text-[10px] text-[var(--ob-muted)]">{session.threadId}</span> : null}
        {session ? (
          <>
            <button type="button" className="ml-auto" title="新会话" onClick={() => void start(true)} disabled={busy || turnStatus === "running"}><Plus size={13} /></button>
            <button type="button" title="关闭 Codex 会话" disabled={turnStatus === "running"} onClick={() => {
              sharedRevisionRef.current += 1;
              void closeCodexSession(connection, session.id).then(() => {
                sessionIdRef.current = undefined;
                setSession(null);
                setReconnecting(false);
                setTurnStatus("idle");
                turnStatusRef.current = "idle";
                syncRef.current?.publish(null, "idle");
              }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
            }}><Unplug size={13} /></button>
          </>
        ) : null}
      </div>
      {!session ? (
        <button type="button" className="rounded bg-[var(--ob-accent)] px-2 py-1 text-white disabled:opacity-50" onClick={() => void start(false)} disabled={busy}>
          {busy ? "连接中" : "继续会话"}
        </button>
      ) : (
        <>
          <div className="mb-1 max-h-48 space-y-2 overflow-auto rounded border border-[var(--ob-line)] p-2">
            {messages.length ? messages.slice(-120).map((message, index) => (
              <div key={message.id ?? `${index}-${message.role}`} className={message.role === "user" ? "text-[var(--ob-muted)]" : "prose-openboard"}>
                <strong>{message.role === "user" ? "你" : "Codex"}：</strong>
                {message.role === "assistant" ? <MarkdownMessage text={message.text} /> : message.text}
              </div>
            )) : <span className="text-[var(--ob-muted)]">等待消息</span>}
          </div>
          {logs.length ? (
            <details className="mb-1 rounded border border-[var(--ob-line)] px-2 py-1">
              <summary className="cursor-pointer">运行日志 · {logs.length}</summary>
              <ol className="mt-1 max-h-24 list-decimal overflow-auto pl-4 text-[10px] text-[var(--ob-muted)]">
                {logs.map((log, index) => <li key={`${index}-${log}`}>{log}</li>)}
              </ol>
            </details>
          ) : null}
          {previews.length ? (
            <div className="mb-1 flex gap-1 overflow-x-auto">
              {previews.map((preview) => (
                <div key={`${preview.file.name}-${preview.file.lastModified}`} className="relative h-14 w-14 shrink-0 overflow-hidden rounded border border-[var(--ob-line)]">
                  <img src={preview.url} alt={preview.file.name} className="h-full w-full object-cover" />
                  <button type="button" title="移除附件" className="absolute right-0 top-0 bg-black/60 p-0.5 text-white" onClick={() => setFiles((current) => current.filter((file) => file !== preview.file))}><X size={11} /></button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mb-1 text-[10px] text-[var(--ob-muted)]">
            状态：{turnStatus === "running" ? "处理中" : turnStatus === "completed" ? "已完成" : turnStatus === "failed" ? "失败" : "空闲"}
            {reconnecting ? " · 事件流重连中" : ""}
            {session.reused ? " · 连续 thread" : ""}
          </div>
          <div className="flex items-end gap-1">
            <textarea disabled={turnStatus === "running"} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} className="min-h-16 min-w-0 flex-1 resize-y rounded border border-[var(--ob-line)] bg-transparent px-2 py-1 disabled:opacity-50" placeholder="发送消息" />
            <label className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center" title="添加图片">
              <ImagePlus size={14} />
              <input disabled={turnStatus === "running"} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="hidden" onChange={(event) => { setFiles(Array.from(event.target.files ?? []).slice(0, 10)); event.currentTarget.value = ""; }} />
            </label>
            {turnStatus === "running" ? <button type="button" onClick={() => void stop()} title="停止"><Square size={14} /></button> : <button type="button" onClick={() => void send()} title="发送" disabled={busy || !text.trim()}><Send size={14} /></button>}
          </div>
        </>
      )}
      {error ? <p role="alert" className="mt-1 text-[var(--ob-danger)]">{error}</p> : null}
      {approvals.map((pending, index) => {
        const params = pending.params as { command?: unknown; path?: unknown; tool?: unknown } | undefined;
        const detail = typeof params?.command === "string" ? params.command : typeof params?.path === "string" ? params.path : typeof params?.tool === "string" ? params.tool : "需要确认的操作";
        const resolve = async (approve: boolean) => {
          if (!session || pending.id === undefined) return;
          try {
            await respondCodexApproval(connection, session.id, pending.id, approve);
            setApprovals((current) => current.filter((_, itemIndex) => itemIndex !== index));
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        };
        return (
          <div key={codexApprovalKey(pending)} className="mt-2 rounded border border-[var(--ob-warning)] p-2">
            <div className="mb-1">Codex 请求审批</div>
            <div className="mb-1 break-words text-[var(--ob-muted)]">{detail}</div>
            <details><summary className="cursor-pointer text-[10px]">查看请求详情</summary><pre className="max-h-20 overflow-auto text-[10px]">{JSON.stringify(pending.params, null, 2)}</pre></details>
            <div className="mt-1 flex gap-1"><button type="button" title="允许" onClick={() => void resolve(true)}><Check size={14} /></button><button type="button" title="拒绝" onClick={() => void resolve(false)}><X size={14} /></button></div>
          </div>
        );
      })}
    </div>
  );
}
