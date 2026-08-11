import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Send, Square, Unplug } from "lucide-react";
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
import { AgentDiagnosticLog } from "@/components/agent/AgentDiagnosticLog";
import { AgentJumpToLatest } from "@/components/agent/AgentJumpToLatest";
import { AgentMarkdownMessage } from "@/components/agent/agent-markdown";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator } from "@/i18n/messages/agent-help";

type Message = { id?: string; role: "user" | "assistant"; text: string };
type TurnStatus = "idle" | "running" | "completed" | "failed";
const CLAUDE_PROFILE = "claude-default";

function eventText(event: ClaudeEvent): string | undefined {
  const params = event.params as { text?: string } | undefined;
  if (params && typeof params.text === "string") return params.text;
  const data = event.data as { message?: string; text?: string } | undefined;
  if (data?.text) return data.text;
  if (data?.message) return data.message;
  return undefined;
}

export function ClaudePanel({ connection }: { connection: AgentConnection }) {
  const { locale, t: baseT } = useI18n();
  const t = useMemo(() => createAgentHelpTranslator(baseT, locale), [baseT, locale]);
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
          const message = eventText(event) ?? t("agent.claudeRunError");
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
          willRetry ? t("agent.streamReconnecting", { message: cause.message }) : cause.message,
        ]);
      },
    });
  }, [connection, session?.id, t]);

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
    if (!session || !text.trim() || busy || turnStatus === "running") return;
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
      setLogs((current) => [...current.slice(-99), t("agent.stopRequested")]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="border-t border-[var(--ob-line)] pt-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0">
          <strong className="text-sm font-semibold tracking-tight">Claude</strong>
          {session?.claudeSessionId ? (
            <p className="truncate text-[10px] text-[var(--ob-muted)]" title={session.claudeSessionId}>
              {session.claudeSessionId}
            </p>
          ) : null}
        </div>
        {session ? (
          <>
            <button
              type="button"
              className="ob-icon-btn ml-auto h-7 w-7"
              title={t("agent.newSession")}
              aria-label={t("agent.newSession")}
              onClick={() => void start(true)}
              disabled={busy || turnStatus === "running"}
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              className="ob-icon-btn h-7 w-7"
              title={t("agent.closeSession", { agent: "Claude" })}
              aria-label={t("agent.closeSession", { agent: "Claude" })}
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
      <p className="mb-2 text-[11px] leading-relaxed text-[var(--ob-muted)]">
        {t("agent.claudeDescription")}
      </p>
      {!session ? (
        <button
          type="button"
          className="ob-btn-primary gap-1.5 text-xs"
          onClick={() => void start(false)}
          disabled={busy}
        >
          {t("agent.startClaude")}
        </button>
      ) : (
        <>
          <div className="relative mb-2">
            <div
              ref={transcriptRef}
              className="max-h-56 space-y-2 overflow-auto rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_50%,transparent)] p-2.5 text-xs"
              onScroll={updateStickToBottom}
            >
              {messages.length ? (
                messages.map((message, index) => (
                  <div
                    key={message.id ?? `${index}-${message.role}`}
                    className="ob-msg"
                    data-role={message.role}
                  >
                    <div className="ob-msg-meta">
                      {message.role === "user" ? t("agent.you") : "Claude"}
                    </div>
                    {message.role === "assistant" ? (
                      <AgentMarkdownMessage text={message.text} />
                    ) : (
                      <div className="whitespace-pre-wrap text-[var(--ob-ink)]">{message.text}</div>
                    )}
                  </div>
                ))
              ) : (
                <div className="grid place-items-center gap-1 py-8 text-center text-[var(--ob-muted)]">
                  <span className="text-xs font-medium text-[var(--ob-ink)]">{t("agent.waitingMessage")}</span>
                  <span className="text-[11px]">{t("agent.claudeWaitingHint")}</span>
                </div>
              )}
            </div>
            {showJumpBottom ? (
              <AgentJumpToLatest onClick={() => scrollTranscriptToBottom("smooth")} />
            ) : null}
          </div>
          <AgentDiagnosticLog logs={logs} title={t("agent.runtimeLog")} />
          {error ? (
            <p className="mb-2 rounded-lg border border-[color-mix(in_srgb,var(--ob-danger)_28%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-danger)_8%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--ob-danger)]">
              {error}
            </p>
          ) : null}
          <div className="ob-composer flex items-end gap-1.5 p-1.5">
            <textarea
              disabled={busy || turnStatus === "running"}
              className="min-h-[56px] flex-1 resize-none border-0 bg-transparent px-1.5 py-1 text-xs outline-none placeholder:text-[var(--ob-muted)] disabled:opacity-50"
              placeholder={t("agent.claudePlaceholder")}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {turnStatus === "running" ? (
              <button type="button" className="ob-btn-danger rounded-lg p-2" title={t("agent.stop")} aria-label={t("agent.stop")} onClick={() => void stop()}>
                <Square size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="ob-btn-primary rounded-lg p-2 disabled:opacity-50"
                title={t("agent.send")}
                aria-label={t("agent.send")}
                disabled={!canSend}
                onClick={() => void send()}
              >
                <Send size={14} />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-[var(--ob-muted)]">
            <span
              className="ob-status-dot"
              data-status={
                turnStatus === "running" ? "running"
                  : turnStatus === "failed" ? "failed"
                    : turnStatus === "completed" ? "succeeded"
                      : "idle"
              }
              aria-hidden
            />
            {turnStatus === "running" ? t("agent.running") : turnStatus === "failed" ? t("agent.failed") : turnStatus === "completed" ? t("agent.completed") : t("agent.idle")}
          </div>
        </>
      )}
    </div>
  );
}
