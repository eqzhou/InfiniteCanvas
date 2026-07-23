import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Plus, Send, Square, Unplug } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  closeClaudeSession,
  createClaudeSession,
  getClaudeSession,
  interruptClaudeTurn,
  sendClaudeMessage,
  subscribeClaudeEvents,
  type AgentConnection,
  type ClaudeEvent,
  type ClaudeSession,
} from "@/services/local-agent";
import { getRuntimeClientId } from "@/services/runtime-identity";

type Message = { id?: string; role: "user" | "assistant"; text: string };
type TurnStatus = "idle" | "running" | "completed" | "failed";
const CLAUDE_PROFILE = "claude-default";

function MarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer" className="underline">
            {children}
          </a>
        ),
        img: () => <span>[图片]</span>,
        pre: ({ children }) => (
          <pre className="max-w-full overflow-auto whitespace-pre-wrap rounded bg-[var(--ob-accent-soft)] p-1">
            {children}
          </pre>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function eventText(event: ClaudeEvent): string | undefined {
  const params = event.params as { text?: string } | undefined;
  if (params && typeof params.text === "string") return params.text;
  const data = event.data as { message?: string; text?: string } | undefined;
  if (data?.text) return data.text;
  if (data?.message) return data.message;
  return undefined;
}

export function ClaudePanel({ connection }: { connection: AgentConnection }) {
  const [session, setSession] = useState<ClaudeSession | null>(null);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [turnStatus, setTurnStatus] = useState<TurnStatus>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const turnStatusRef = useRef<TurnStatus>("idle");
  const streamingAssistantRef = useRef("");

  const canSend = useMemo(
    () => Boolean(session && text.trim() && turnStatus !== "running" && !busy),
    [busy, session, text, turnStatus],
  );

  const scrollTranscriptToBottom = (behavior: ScrollBehavior = "auto") => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    setShowJumpBottom(false);
  };

  const updateStickToBottom = () => {
    const node = transcriptRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setShowJumpBottom(distance > 48);
  };

  useEffect(() => {
    if (!showJumpBottom) scrollTranscriptToBottom();
  }, [messages, showJumpBottom]);

  useEffect(() => {
    if (!session?.id) return;
    sessionIdRef.current = session.id;
    return subscribeClaudeEvents(connection, session.id, {
      onEvent: (event) => {
        if (event.method === "openboard/user_message") {
          const body = eventText(event);
          if (body) {
            setMessages((current) => [...current, { role: "user", text: body }]);
          }
          return;
        }
        if (event.method === "agent/message_delta") {
          const delta = eventText(event) ?? "";
          streamingAssistantRef.current += delta;
          const snapshot = streamingAssistantRef.current;
          setMessages((current) => {
            const last = current[current.length - 1];
            if (last?.role === "assistant" && last.id === "streaming") {
              return [...current.slice(0, -1), { id: "streaming", role: "assistant", text: snapshot }];
            }
            return [...current, { id: "streaming", role: "assistant", text: snapshot }];
          });
          return;
        }
        if (event.method === "agent/message") {
          const body = eventText(event) ?? "";
          streamingAssistantRef.current = "";
          setMessages((current) => {
            const withoutStreaming = current.filter((item) => item.id !== "streaming");
            if (!body) return withoutStreaming;
            return [...withoutStreaming, { role: "assistant", text: body }];
          });
          return;
        }
        if (event.method === "openboard/turn_started") {
          setTurnStatus("running");
          turnStatusRef.current = "running";
          streamingAssistantRef.current = "";
          return;
        }
        if (event.method === "openboard/turn_completed" || event.method === "openboard/turn_interrupted") {
          setTurnStatus(event.method === "openboard/turn_interrupted" ? "failed" : "completed");
          turnStatusRef.current = event.method === "openboard/turn_interrupted" ? "failed" : "completed";
          setSession((current) => (current ? { ...current, running: false } : current));
          // finalize streaming bubble
          if (streamingAssistantRef.current) {
            const finalText = streamingAssistantRef.current;
            streamingAssistantRef.current = "";
            setMessages((current) => {
              const withoutStreaming = current.filter((item) => item.id !== "streaming");
              const last = withoutStreaming[withoutStreaming.length - 1];
              if (last?.role === "assistant" && last.text === finalText) return withoutStreaming;
              return [...withoutStreaming, { role: "assistant", text: finalText }];
            });
          }
          return;
        }
        if (event.method === "openboard/session_bound") {
          const data = event.data as { claudeSessionId?: string } | undefined;
          if (data?.claudeSessionId) {
            setSession((current) =>
              current ? { ...current, claudeSessionId: data.claudeSessionId } : current);
          }
          return;
        }
        if (event.type === "error") {
          const message = eventText(event) ?? "Claude 运行出错";
          setError(message);
          setTurnStatus("failed");
          turnStatusRef.current = "failed";
          setLogs((current) => [...current.slice(-99), message]);
          return;
        }
        if (event.method === "openboard/log" || event.method?.startsWith("claude/")) {
          const message = eventText(event) ?? event.method ?? event.type;
          setLogs((current) => [...current.slice(-99), String(message)]);
        }
      },
      onError: (cause, willRetry) => {
        setLogs((current) => [
          ...current.slice(-99),
          willRetry ? `事件流中断，重连中：${cause.message}` : cause.message,
        ]);
      },
    });
  }, [connection, session?.id]);

  const start = async (fresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await createClaudeSession(connection, {
        profile: CLAUDE_PROFILE,
        fresh,
      });
      setSession(next);
      if (fresh) {
        setMessages([]);
        setLogs([]);
        setTurnStatus("idle");
        turnStatusRef.current = "idle";
        streamingAssistantRef.current = "";
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void getClaudeSession(connection, CLAUDE_PROFILE)
      .then((existing) => {
        if (existing) setSession(existing);
      })
      .catch(() => undefined);
  }, [connection]);

  const send = async () => {
    if (!session || !text.trim() || turnStatus === "running") return;
    const prompt = text.trim();
    setText("");
    setBusy(true);
    setError(null);
    setTurnStatus("running");
    turnStatusRef.current = "running";
    try {
      setSession((current) => (current ? { ...current, running: true } : current));
      await sendClaudeMessage(connection, session.id, prompt, fetch, getRuntimeClientId());
    } catch (cause) {
      setTurnStatus("failed");
      turnStatusRef.current = "failed";
      setSession((current) => (current ? { ...current, running: false } : current));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!session) return;
    try {
      await interruptClaudeTurn(connection, session.id);
      setLogs((current) => [...current.slice(-99), "已请求停止当前 turn"]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="border-t border-[var(--ob-line)] pt-2">
      <div className="mb-1 flex items-center gap-1">
        <strong>Claude</strong>
        {session?.claudeSessionId ? (
          <span className="min-w-0 truncate text-[10px] text-[var(--ob-muted)]" title={session.claudeSessionId}>
            {session.claudeSessionId}
          </span>
        ) : null}
        {session ? (
          <>
            <button
              type="button"
              className="ml-auto"
              title="新会话"
              onClick={() => void start(true)}
              disabled={busy || turnStatus === "running"}
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              title="关闭 Claude 会话"
              disabled={turnStatus === "running"}
              onClick={() => {
                void closeClaudeSession(connection, session.id)
                  .then(() => {
                    sessionIdRef.current = undefined;
                    setSession(null);
                    setTurnStatus("idle");
                    turnStatusRef.current = "idle";
                  })
                  .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
              }}
            >
              <Unplug size={13} />
            </button>
          </>
        ) : null}
      </div>
      <p className="mb-1 text-[10px] text-[var(--ob-muted)]">
        通过本机 Claude Code CLI（stream-json）会话；需已登录 `claude`，可选 MCP 驱动画布。
      </p>
      {!session ? (
        <button
          type="button"
          className="rounded bg-[var(--ob-accent)] px-2 py-1 text-white disabled:opacity-50"
          onClick={() => void start(false)}
          disabled={busy}
        >
          {busy ? "连接中" : "开始 Claude 会话"}
        </button>
      ) : (
        <>
          <div className="relative mb-1">
            <div
              ref={transcriptRef}
              onScroll={updateStickToBottom}
              className="max-h-48 space-y-2 overflow-auto rounded border border-[var(--ob-line)] p-2"
            >
              {messages.length ? (
                messages.slice(-120).map((message, index) => (
                  <div
                    key={message.id ?? `${index}-${message.role}`}
                    className={
                      message.role === "user"
                        ? "ml-8 rounded-lg bg-[var(--ob-accent-soft)] px-2 py-1 text-[var(--ob-ink)]"
                        : "mr-4"
                    }
                  >
                    {message.role === "assistant" ? (
                      <MarkdownMessage text={message.text} />
                    ) : (
                      message.text
                    )}
                  </div>
                ))
              ) : (
                <span className="text-[var(--ob-muted)]">等待消息</span>
              )}
            </div>
            {showJumpBottom ? (
              <button
                type="button"
                title="回到底部"
                className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full border border-[var(--ob-line)] bg-[var(--ob-bg)] px-2 py-1 text-[10px] shadow-sm"
                onClick={() => scrollTranscriptToBottom("smooth")}
              >
                <ArrowDown size={12} />
                回到底部
              </button>
            ) : null}
          </div>
          {logs.length ? (
            <details className="mb-1 rounded border border-[var(--ob-line)] px-2 py-1">
              <summary className="cursor-pointer">运行日志 · {logs.length}</summary>
              <ol className="mt-1 max-h-24 list-decimal overflow-auto pl-4 text-[10px] text-[var(--ob-muted)]">
                {logs.map((log, index) => (
                  <li key={`${index}-${log}`}>{log}</li>
                ))}
              </ol>
            </details>
          ) : null}
          {error ? <p className="mb-1 text-[10px] text-[var(--ob-danger)]">{error}</p> : null}
          <div className="flex items-end gap-1">
            <textarea
              className="ob-field min-h-[56px] flex-1 resize-none text-xs"
              placeholder="向 Claude Code 提问…（可驱动画布 MCP）"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {turnStatus === "running" ? (
              <button type="button" className="ob-btn-danger rounded-lg p-2" title="停止" onClick={() => void stop()}>
                <Square size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="ob-btn-primary rounded-lg p-2 disabled:opacity-50"
                title="发送"
                disabled={!canSend}
                onClick={() => void send()}
              >
                <Send size={14} />
              </button>
            )}
          </div>
          <div className="mt-1 text-[10px] text-[var(--ob-muted)]">
            状态：{turnStatus === "running" ? "生成中" : turnStatus === "failed" ? "已中断/失败" : turnStatus === "completed" ? "完成" : "空闲"}
          </div>
        </>
      )}
    </div>
  );
}
