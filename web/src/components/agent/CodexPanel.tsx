import { useEffect, useMemo, useRef, useState } from "react";
import { Check, History, ImagePlus, Plus, Send, Square, Trash2, Unplug, X } from "lucide-react";
import {
  closeCodexSession,
  bulkDeleteCodexHistory,
  createCodexSession,
  deleteCodexAttachment,
  deleteCodexHistory,
  getCodexHistory,
  getCodexConnectionScope,
  getCodexSession,
  listCodexHistory,
  listCodexModels,
  listCodexSkills,
  interruptCodexTurn,
  prewarmCodexSession,
  revealCodexFile,
  respondCodexApproval,
  restoreCodexHistory,
  sendCodexMessage,
  subscribeCodexEvents,
  uploadCodexAttachments,
  updateCodexPreferences,
  type AgentConnection,
  type CodexEvent,
  type CodexHistoryRecord,
  type CodexHistorySummary,
  type CodexModel,
  type CodexPermissionMode,
  type CodexContextReference,
  type CodexSkill,
  type CodexSession,
} from "@/services/local-agent";
import {
  normalizeCodexHistorySelection,
  sortCodexHistory,
  toggleCodexHistorySelection,
} from "@/services/codex-history";
import {
  classifyCodexEvent,
  codexApprovalKey,
  codexApprovalResolutionKey,
  codexEventThreadId,
} from "@/services/codex-events";
import {
  formatCodexElapsed,
  mergeCodexLogs,
  mergeCodexProgress,
  reduceCodexProgress,
  type CodexProgressItem,
} from "@/services/codex-progress";
import { groupCodexProgress } from "@/services/codex-progress-groups";
import {
  createCodexSessionSync,
  shouldResetCodexTranscript,
  statusForCodexSnapshot,
  type SharedTurnStatus,
} from "@/services/codex-session-sync";
import { getRuntimeClientId } from "@/services/runtime-identity";
import { createNode } from "@/lib/defaults";
import { uid } from "@/lib/id";
import { attachUploadedImage, useBoardStore } from "@/stores/use-board-store";
import { AgentDiagnosticLog } from "@/components/agent/AgentDiagnosticLog";
import { CodexProgressList } from "@/components/agent/CodexProgressList";
import { AgentJumpToLatest } from "@/components/agent/AgentJumpToLatest";
import { CodexModelControls, resolveCodexReasoningEffort } from "@/components/agent/CodexModelControls";
import { CodexSkillsPanel } from "@/components/agent/CodexSkillsPanel";
import { AgentMarkdownMessage } from "@/components/agent/agent-markdown";
import {
  addCodexUserMessage,
  applyCodexTranscriptEvent,
  hydrateCodexTranscript,
  mergeCodexTranscript,
  type CodexTranscriptState,
} from "@/services/codex-transcript";
import { applyAgentComposerSuggestion, detectAgentComposerTrigger } from "@/lib/agent-composer";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator } from "@/i18n/messages/agent-help";

type Message = { id?: string; role: "user" | "assistant"; text: string };
type TurnStatus = SharedTurnStatus;
const CODEX_PROFILE = "default";

function historyTurnStatus(status: string, running: boolean): TurnStatus {
  if (running || status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "idle";
}

function replayHistoryProgress(record: CodexHistoryRecord): {
  progress: CodexProgressItem[];
  logs: string[];
} {
  let progress: CodexProgressItem[] = [];
  const logs: string[] = [];
  for (const rawEvent of record.events) {
    const effect = classifyCodexEvent(rawEvent as CodexEvent);
    if (effect.kind !== "item") continue;
    logs.push([effect.text, effect.status, effect.detail].filter(Boolean).join(" · "));
    progress = reduceCodexProgress(progress, {
      itemId: effect.itemId,
      itemType: effect.itemType,
      label: effect.label,
      path: effect.path,
      detail: effect.appendDetail
        ? effect.detail ?? effect.text
        : effect.command ?? effect.path ?? effect.detail ?? effect.text,
      appendDetail: effect.appendDetail,
      status: effect.status,
      error: effect.error,
    });
  }
  return { progress, logs: logs.slice(-100) };
}

function formatHistoryDate(value: string, locale?: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString(locale) : value;
}


async function insertAttachmentImageNodes(files: File[], title: string): Promise<void> {
  if (!files.length) return;
  const state = useBoardStore.getState();
  const project = state.getActive();
  if (!project) return;
  const viewport = project.viewport ?? { x: 0, y: 0, k: 1 };
  const center = {
    x: (window.innerWidth / 2 - viewport.x) / viewport.k,
    y: (window.innerHeight / 2 - viewport.y) / viewport.k,
  };
  const imageIds: string[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const id = await attachUploadedImage(file, {
        x: center.x - 180 + index * 36,
        y: center.y - 120 + index * 28,
      }, { mode: "image" });
      imageIds.push(id);
    }
    if (!imageIds.length) return;
    const config = createNode(
      "config",
      { x: center.x + 220, y: center.y - 40 },
      {
        title,
        metadata: {
          generationMode: "image",
          prompt: "",
          status: "idle",
        },
      },
    );
    state.updateActive((current) => ({
      ...current,
      nodes: [...current.nodes, config],
      edges: [
        ...current.edges,
        ...imageIds.map((from) => ({ id: uid("edge"), from, to: config.id })),
      ],
    }));
    state.setSelected([config.id, ...imageIds]);
    await state.persistNow();
  } catch (cause) {
    if (imageIds.length) {
      const orphaned = new Set(imageIds);
      useBoardStore.getState().updateActive((current) => ({
        ...current,
        nodes: current.nodes.filter((node) => !orphaned.has(node.id)),
        edges: current.edges.filter((edge) => !orphaned.has(edge.from) && !orphaned.has(edge.to)),
      }));
      useBoardStore.getState().setSelected([]);
    }
    throw cause;
  }
}

export function CodexPanel({ connection }: { connection: AgentConnection }) {
  const { locale, t: baseT } = useI18n();
  const t = useMemo(() => createAgentHelpTranslator(baseT, locale), [baseT, locale]);
  const [session, setSession] = useState<CodexSession | null>(null);
  const [text, setText] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const [composerReferences, setComposerReferences] = useState<CodexContextReference[]>([]);
  const [composerSkills, setComposerSkills] = useState<CodexSkill[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<CodexProgressItem[]>([]);
  const [progressOpen, setProgressOpen] = useState(true);
  const [turnStatus, setTurnStatus] = useState<TurnStatus>("idle");
  const [permissionMode, setPermissionMode] = useState<CodexPermissionMode>("workspace-auto");
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  const [approvals, setApprovals] = useState<CodexEvent[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fullAccessConfirmOpen, setFullAccessConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<CodexHistorySummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySelected, setHistorySelected] = useState<string[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [modelCatalogError, setModelCatalogError] = useState<string | undefined>();
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const syncRef = useRef<ReturnType<typeof createCodexSessionSync> | null>(null);
  const turnStatusRef = useRef<TurnStatus>("idle");
  const sharedRevisionRef = useRef(0);
  const preferenceWriteRef = useRef<Promise<void>>(Promise.resolve());
  const preferenceRevisionRef = useRef(0);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeProject = useBoardStore((state) => state.projects.find((project) => project.id === state.activeProjectId));
  const composerTrigger = detectAgentComposerTrigger(text, composerCursor);
  const composerSuggestions: CodexContextReference[] = composerTrigger?.kind === "skill"
    ? composerSkills.filter((skill) => skill.enabled && `${skill.name} ${skill.id}`.toLowerCase().includes(composerTrigger.query.toLowerCase())).slice(0, 8).map((skill) => ({ kind: "skill", id: skill.id, label: skill.name }))
    : composerTrigger?.kind === "node"
      ? (activeProject?.nodes ?? []).filter((node) => `${node.title} ${node.id}`.toLowerCase().includes(composerTrigger.query.toLowerCase())).slice(0, 8).map((node) => ({ kind: "node", id: node.id, label: node.title }))
      : [];
  const sessionInitializationRef = useRef<{
    key: string;
    promise: Promise<CodexSession | null>;
  } | null>(null);
  const transcriptStateRef = useRef<CodexTranscriptState>(hydrateCodexTranscript([], []));
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const previews = useMemo(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })), [files]);
  const progressGroups = useMemo(() => groupCodexProgress(progress), [progress]);
  const sessionId = session?.id;

  const resetTranscript = () => {
    transcriptStateRef.current = hydrateCodexTranscript([], []);
    setMessages([]);
  };

  const hydrateTranscript = (record: CodexHistoryRecord) => {
    const next = hydrateCodexTranscript(record.messages, record.events);
    transcriptStateRef.current = next;
    setMessages(next.messages);
  };

  const mergeTranscript = (record: CodexHistoryRecord) => {
    const next = mergeCodexTranscript(transcriptStateRef.current, record.messages, record.events);
    transcriptStateRef.current = next;
    setMessages(next.messages);
  };

  const applyTranscriptEvent = (event: CodexEvent) => {
    const previous = transcriptStateRef.current;
    const next = applyCodexTranscriptEvent(previous, event);
    transcriptStateRef.current = next;
    if (next.messages !== previous.messages) setMessages(next.messages);
  };

  useEffect(() => {
    return () => {
      for (const preview of previews) URL.revokeObjectURL(preview.url);
    };
  }, [previews]);

  useEffect(() => {
    turnStatusRef.current = turnStatus;
  }, [turnStatus]);

  useEffect(() => {
    let active = true;
    void listCodexSkills(connection).then((skills) => { if (active) setComposerSkills(skills); }).catch(() => { if (active) setComposerSkills([]); });
    return () => { active = false; };
  }, [connection.baseUrl, connection.token, connection.sessionToken]);

  useEffect(() => {
    if (turnStatus !== "running") return;
    setElapsedNow(Date.now());
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [turnStatus]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    preferenceRevisionRef.current += 1;
  }, [sessionId]);

  const queueCodexPreference = (
    model: string,
    effort: string,
    previous: { model: string; effort: string },
  ) => {
    if (!sessionId) return;
    const targetSessionId = sessionId;
    const revision = preferenceRevisionRef.current + 1;
    preferenceRevisionRef.current = revision;
    const write = preferenceWriteRef.current
      .catch(() => undefined)
      .then(() => updateCodexPreferences(connection, targetSessionId, model, effort));
    preferenceWriteRef.current = write;
    void write.catch((cause) => {
      if (preferenceRevisionRef.current !== revision || sessionIdRef.current !== targetSessionId) return;
      setSelectedModel(previous.model);
      setSelectedEffort(previous.effort);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  useEffect(() => {
    if (!sessionId) {
      setModels([]);
      setSelectedModel("");
      setSelectedEffort("");
      setModelCatalogError(undefined);
      setModelCatalogLoading(false);
      return;
    }
    let active = true;
    setModels([]);
    setSelectedModel("");
    setSelectedEffort("");
    setModelCatalogError(undefined);
    setModelCatalogLoading(true);
    void listCodexModels(connection, sessionId)
      .then((catalog) => {
        if (!active) return;
        setModelCatalogLoading(false);
        setModels(catalog);
        const preferredModel = session?.model || "";
        const selected = catalog.find((item) => item.model === preferredModel)
          ?? catalog.find((item) => item.isDefault)
          ?? catalog[0];
        if (!selected) {
          setSelectedModel("");
          setSelectedEffort("");
          return;
        }
        const preferredEffort = session?.effort || "";
        const effort = resolveCodexReasoningEffort(selected, preferredEffort);
        setSelectedModel(selected.model);
        setSelectedEffort(effort);
      })
      .catch((cause) => {
        if (!active) return;
        setModelCatalogLoading(false);
        setModels([]);
        setModelCatalogError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [connection, sessionId]);

  useEffect(() => {
    if (!session?.model || !models.length) return;
    const selected = models.find((item) => item.model === session.model);
    if (!selected) return;
    const effort = resolveCodexReasoningEffort(selected, session.effort);
    setSelectedModel(selected.model);
    setSelectedEffort(effort);
  }, [models, session?.effort, session?.model]);

  useEffect(() => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)), [previews]);

  const updateStickToBottom = () => {
    const node = transcriptRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const nearBottom = distance <= 48;
    stickToBottomRef.current = nearBottom;
    setShowJumpBottom(!nearBottom && node.scrollHeight > node.clientHeight + 8);
  };

  const scrollTranscriptToBottom = (behavior: ScrollBehavior = "auto") => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    stickToBottomRef.current = true;
    setShowJumpBottom(false);
  };

  useEffect(() => {
    if (!sessionId) return;
    if (stickToBottomRef.current) scrollTranscriptToBottom("auto");
    else updateStickToBottom();
  }, [messages, sessionId]);


  useEffect(() => {
    let active = true;
    let sync: ReturnType<typeof createCodexSessionSync> | null = null;
    let initialization: Promise<CodexSession | null> | undefined;
    const initializationKey = `${connection.baseUrl}\u0000${connection.token ?? ""}\u0000${connection.sessionToken ?? ""}`;
    const hydrateSharedHistory = (current: CodexSession | null) => {
      if (!current?.historyId) return;
      const expectedSessionId = current.id;
      void getCodexHistory(connection, current.historyId, CODEX_PROFILE)
        .then((record) => {
          if (!active || sessionIdRef.current !== expectedSessionId) return;
          mergeTranscript(record);
          const replay = replayHistoryProgress(record);
          setLogs((current) => mergeCodexLogs(replay.logs, current));
          setProgress((current) => mergeCodexProgress(replay.progress, current));
          setProgressOpen(replay.progress.length > 0);
        })
        .catch(() => undefined);
    };
    const applyShared = (shared: { session: CodexSession | null; turnStatus: TurnStatus }) => {
      if (!active) return;
      sharedRevisionRef.current += 1;
      const nextSessionId = shared.session?.id;
      if (shouldResetCodexTranscript(sessionIdRef.current, nextSessionId)) {
        resetTranscript();
        setLogs([]);
        setProgress([]);
        setFiles([]);
        setApprovals([]);
        hydrateSharedHistory(shared.session);
      }
      sessionIdRef.current = nextSessionId;
      setSession(shared.session);
      setTurnStatus(shared.turnStatus);
      turnStatusRef.current = shared.turnStatus;
      if (!shared.session) {
        setApprovals([]);
      }
    };
    setBusy(true);
    const initialize = async () => {
      const scopeKey = await getCodexConnectionScope(connection);
      if (!active) return;
      sync = createCodexSessionSync(CODEX_PROFILE, applyShared, scopeKey);
      syncRef.current = sync;
      const requestRevision = sharedRevisionRef.current;
      initialization = sessionInitializationRef.current?.key === initializationKey
        ? sessionInitializationRef.current.promise
        : getCodexSession(connection, CODEX_PROFILE)
          .then((existing) => {
            if (sessionInitializationRef.current?.key !== initializationKey) return null;
            return existing ?? prewarmCodexSession(connection, CODEX_PROFILE);
          });
      sessionInitializationRef.current = { key: initializationKey, promise: initialization };
      const current = await initialization;
      if (!active || sharedRevisionRef.current !== requestRevision) return;
      const status: TurnStatus = current?.running ? "running" : "idle";
      if (shouldResetCodexTranscript(sessionIdRef.current, current?.id)) {
        resetTranscript();
        setLogs([]);
        setProgress([]);
        setFiles([]);
        setApprovals([]);
      }
      sessionIdRef.current = current?.id;
      setSession(current);
      setTurnStatus(status);
      turnStatusRef.current = status;
      sync?.publish(current, status);
      hydrateSharedHistory(current);
    };
    void initialize()
      .catch((cause) => {
        if (sessionInitializationRef.current?.key === initializationKey &&
            sessionInitializationRef.current.promise === initialization) {
          sessionInitializationRef.current = null;
        }
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      sync?.close();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [connection]);

  useEffect(() => {
    if (!sessionId) return;
    const source = subscribeCodexEvents(connection, sessionId, (event) => {
      if (sessionIdRef.current !== sessionId) return;
      setReconnecting(false);
      const reconnectPrefix = t("agent.codexStreamReconnecting", { message: "" });
      setError((current) => current?.startsWith(reconnectPrefix) ? null : current);
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
        applyTranscriptEvent(event);
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
        applyTranscriptEvent(event);
      }
      if (effect.kind === "item") {
        setLogs((current) => [...current.slice(-99), [effect.text, effect.status, effect.detail].filter(Boolean).join(" · ")]);
        setProgress((current) => reduceCodexProgress(current, {
          itemId: effect.itemId,
          itemType: effect.itemType,
          label: effect.label,
          path: effect.path,
          detail: effect.appendDetail
            ? effect.detail ?? effect.text
            : effect.command ?? effect.path ?? effect.detail ?? effect.text,
          appendDetail: effect.appendDetail,
          status: effect.status,
          error: effect.error,
        }));
      }
      if (effect.kind === "turn") {
        if (effect.status === "running") {
          setTurnStartedAt((current) => current ?? Date.now());
          setProgressOpen(true);
        }
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
        ? t("agent.codexStreamReconnecting", { message: streamError.message })
        : t("agent.codexSessionEnded", { message: streamError.message }));
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
  }, [connection, sessionId, session?.threadId, t]);

  const loadHistory = async () => {
    setHistoryBusy(true);
    try {
      const records = sortCodexHistory(await listCodexHistory(connection, CODEX_PROFILE));
      setHistory(records);
      setHistorySelected((current) => normalizeCodexHistorySelection(records, current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHistoryBusy(false);
    }
  };

  const restoreHistory = async (summary: CodexHistorySummary) => {
    if (historyBusy || turnStatusRef.current === "running") return;
    setHistoryBusy(true);
    setBusy(true);
    setError(null);
    sharedRevisionRef.current += 1;
    try {
      const restored = await restoreCodexHistory(connection, summary.id);
      const nextStatus = historyTurnStatus(restored.history.status, restored.session.running === true);
      const replay = replayHistoryProgress(restored.history);
      sessionIdRef.current = restored.session.id;
      setSession(restored.session);
      hydrateTranscript(restored.history);
      setLogs(replay.logs);
      setProgress(replay.progress);
      setProgressOpen(replay.progress.length > 0);
      setApprovals([]);
      setFiles([]);
      setTurnStartedAt(nextStatus === "running" ? Date.now() : null);
      setElapsedNow(Date.now());
      setTurnStatus(nextStatus);
      turnStatusRef.current = nextStatus;
      syncRef.current?.publish(restored.session, nextStatus);
      setHistorySelected([]);
      setHistoryOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setHistoryBusy(false);
    }
  };

  const removeHistory = async (id: string) => {
    if (historyBusy) return;
    setHistoryBusy(true);
    setError(null);
    try {
      await deleteCodexHistory(connection, id);
      setHistory((current) => current.filter((record) => record.id !== id));
      setHistorySelected((current) => current.filter((value) => value !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHistoryBusy(false);
    }
  };

  const removeSelectedHistory = async () => {
    const selected = normalizeCodexHistorySelection(history, historySelected);
    if (!selected.length || historyBusy) return;
    setHistoryBusy(true);
    setError(null);
    try {
      await bulkDeleteCodexHistory(connection, selected);
      const selectedSet = new Set(selected);
      setHistory((current) => current.filter((record) => !selectedSet.has(record.id)));
      setHistorySelected([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHistoryBusy(false);
    }
  };

  const revealFile = async (path: string) => {
    if (!session) return;
    try {
      await revealCodexFile(connection, session.id, path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const start = async (fresh: boolean) => {
    sharedRevisionRef.current += 1;
    setBusy(true);
    setError(null);
    setReconnecting(false);
    if (fresh) {
      resetTranscript();
      setLogs([]);
      setProgress([]);
      setFiles([]);
      setApprovals([]);
      setTurnStartedAt(null);
    }
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
        resetTranscript();
        setLogs([]);
        setProgress([]);
        setFiles([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const send = async (requestedText?: string) => {
    const prompt = (requestedText ?? text).trim();
    if (!session || !prompt || busy || turnStatusRef.current === "running") return;
    const pendingFiles = requestedText === undefined ? files.slice() : [];
    const pendingContextReferences = requestedText === undefined ? composerReferences.slice() : [];
    const clientMessageId = uid("message");
    sharedRevisionRef.current += 1;
    setBusy(true);
    setError(null);
    setReconnecting(false);
    setText("");
    setComposerReferences([]);
    setFiles([]);
    const optimisticState = addCodexUserMessage(transcriptStateRef.current, {
      id: clientMessageId,
      text: prompt,
    });
    transcriptStateRef.current = optimisticState;
    setMessages(optimisticState.messages);
    setProgress([]);
    setProgressOpen(true);
    setTurnStartedAt(Date.now());
    setElapsedNow(Date.now());
    setTurnStatus("running");
    turnStatusRef.current = "running";
    const runningSession = { ...session, running: true };
    setSession(runningSession);
    syncRef.current?.publish(runningSession, "running");
    let attachments: Awaited<ReturnType<typeof uploadCodexAttachments>> = [];
    try {
      if (pendingFiles.length) {
        try {
          await insertAttachmentImageNodes(pendingFiles, t("agent.imageGeneration"));
        } catch (cause) {
          setLogs((current) => [
            ...current.slice(-99),
            t("agent.attachmentNodeFailed", { message: cause instanceof Error ? cause.message : String(cause) }),
          ]);
        }
      }
      attachments = pendingFiles.length
        ? await uploadCodexAttachments(connection, session.id, pendingFiles)
        : [];
      await sendCodexMessage(
        connection,
        session.id,
        prompt,
        fetch,
        {
          attachmentIds: attachments.map((item) => item.id),
          clientId: getRuntimeClientId(),
          clientMessageId,
          permissionMode,
          contextReferences: pendingContextReferences,
          ...(models.some((item) => item.model === selectedModel) ? { model: selectedModel } : {}),
          ...(models.find((item) => item.model === selectedModel)?.supportedReasoningEfforts
            .some((item) => item.reasoningEffort === selectedEffort) ? { effort: selectedEffort } : {}),
        },
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
      setLogs((current) => [
        ...current.slice(-99),
        `Codex: ${cause instanceof Error ? cause.message : String(cause)}`,
      ]);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!session) return;
    sharedRevisionRef.current += 1;
    try {
      await interruptCodexTurn(connection, session.id);
      setLogs((current) => [...current.slice(-99), t("agent.stopRequested")]);
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
    <div className="border-t border-[var(--ob-line)] pt-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0">
          <strong className="text-sm font-semibold tracking-tight">Codex</strong>
          {session?.threadId ? (
            <p className="truncate text-[10px] text-[var(--ob-muted)]" title={session.threadId}>{session.threadId}</p>
          ) : null}
        </div>
        <button
          type="button"
          className="ob-icon-btn ml-auto h-7 w-7"
          title={t("agent.history")}
          aria-label={t("agent.history")}
          disabled={historyBusy}
          onClick={() => {
            const next = !historyOpen;
            setHistoryOpen(next);
            if (next) void loadHistory();
          }}
        >
          <History size={13} />
        </button>
        {session ? (
          <>
            <button
              type="button"
              className="ob-icon-btn h-7 w-7"
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
              title={t("agent.closeSession", { agent: "Codex" })}
              aria-label={t("agent.closeSession", { agent: "Codex" })}
              disabled={busy || turnStatus === "running"}
              onClick={() => {
                sharedRevisionRef.current += 1;
                void closeCodexSession(connection, session.id).then(() => {
                  sessionIdRef.current = undefined;
                  setSession(null);
                  setReconnecting(false);
                  setTurnStatus("idle");
                  turnStatusRef.current = "idle";
                  syncRef.current?.publish(null, "idle");
                }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
              }}
            >
              <Unplug size={13} />
            </button>
          </>
        ) : null}
      </div>
      {historyOpen ? (
        <section
          role="region"
          aria-label={t("agent.codexHistory")}
          className="mb-2 rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_50%,transparent)] p-2.5"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <strong className="text-xs font-semibold">{t("agent.history")}</strong>
            <span className="text-[10px] text-[var(--ob-muted)]">{t("agent.sessionCount", { count: history.length })}</span>
          </div>
          {history.length ? (
            <div className="max-h-56 space-y-1.5 overflow-auto">
              {history.map((record) => (
                <div key={record.id} className="flex min-w-0 items-start gap-1.5 rounded-lg border border-[var(--ob-line)] px-2 py-1.5">
                  <input
                    type="checkbox"
                    aria-label={t("agent.selectSession", { title: record.title })}
                    checked={historySelected.includes(record.id)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setHistorySelected((current) => toggleCodexHistorySelection(current, record.id, checked));
                    }}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="block max-w-full truncate text-left text-[11px] font-medium text-[var(--ob-ink)] hover:underline"
                      aria-label={t("agent.restoreSession", { title: record.title })}
                      title={t("agent.restoreSession", { title: record.title })}
                      disabled={historyBusy || turnStatus === "running"}
                      onClick={() => void restoreHistory(record)}
                    >
                      {record.title}
                    </button>
                    <div className="truncate text-[10px] text-[var(--ob-muted)]">
                      {record.preview || t("agent.noReply")} · {formatHistoryDate(record.updatedAt, locale)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ob-icon-btn h-6 w-6 shrink-0"
                    title={t("agent.deleteSession")}
                    aria-label={t("agent.deleteSessionNamed", { title: record.title })}
                    disabled={historyBusy || turnStatus === "running"}
                    onClick={() => void removeHistory(record.id)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-[11px] text-[var(--ob-muted)]">{t("agent.noHistory")}</p>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[10px] text-[var(--ob-muted)]">{t("agent.selectedCount", { count: historySelected.length })}</span>
            <button
              type="button"
              className="ob-btn-danger px-2 py-1 text-[10px]"
              aria-label={t("agent.deleteSelectedSessions", { count: historySelected.length })}
              disabled={historyBusy || !historySelected.length || turnStatus === "running"}
              onClick={() => void removeSelectedHistory()}
            >
              {t("agent.deleteSelected")}
            </button>
          </div>
        </section>
      ) : null}
      <CodexSkillsPanel
        connection={connection}
        canInvoke={Boolean(session) && !busy && turnStatus !== "running"}
        onInvoke={(prompt) => send(prompt)}
      />
      {!session ? (
        <button
          type="button"
          className="ob-btn-primary gap-1.5 text-xs"
          onClick={() => void start(false)}
          disabled={busy}
        >
          {busy ? t("agent.connecting") : t("agent.startCodex")}
        </button>
      ) : (
        <>
          <div className="relative mb-2">
            <div
              ref={transcriptRef}
              role="log"
              aria-label={t("agent.codexTranscript")}
              aria-live="polite"
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
                      {message.role === "user" ? t("agent.you") : "Codex"}
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
                  <span className="text-[11px]">{t("agent.codexWaitingHint")}</span>
                </div>
              )}
            </div>
            {showJumpBottom ? (
              <AgentJumpToLatest onClick={() => scrollTranscriptToBottom("smooth")} />
            ) : null}
          </div>
          <CodexProgressList
            groups={progressGroups}
            completedCount={progress.filter((item) => item.status === "completed").length}
            totalCount={progress.length}
            open={progressOpen}
            onToggle={setProgressOpen}
            onRevealFile={(path) => void revealFile(path)}
          />
          <AgentDiagnosticLog logs={logs} />
          {previews.length ? (
            <div className="mb-2 flex gap-1.5 overflow-x-auto">
              {previews.map((preview) => (
                <div key={`${preview.file.name}-${preview.file.lastModified}`} className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-[var(--ob-line)] shadow-[var(--ob-elev-1)]">
                  <img src={preview.url} alt={preview.file.name} className="h-full w-full object-cover" />
                  <button type="button" title={t("agent.removeAttachment")} className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white" onClick={() => setFiles((current) => current.filter((file) => file !== preview.file))}><X size={11} /></button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--ob-muted)]">
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
            {turnStatus === "running"
              ? t("agent.processing", { elapsed: formatCodexElapsed(elapsedNow - (turnStartedAt ?? elapsedNow)) })
              : turnStatus === "completed" ? t("agent.completed") : turnStatus === "failed" ? t("agent.errors") : t("agent.idle")}
            {reconnecting ? t("agent.reconnectingSuffix") : ""}
            {session.reused ? t("agent.reusedThreadSuffix") : ""}
          </div>
          <div className="ob-composer p-1.5">
            <CodexModelControls
              models={models}
              model={selectedModel}
              effort={selectedEffort}
              error={modelCatalogError}
              loading={modelCatalogLoading}
              disabled={busy || turnStatus === "running"}
              onModelChange={(model) => {
                const selected = models.find((item) => item.model === model);
                if (!selected) return;
                const effort = resolveCodexReasoningEffort(selected);
                const previous = { model: selectedModel, effort: selectedEffort };
                setSelectedModel(model);
                setSelectedEffort(effort);
                queueCodexPreference(model, effort, previous);
              }}
              onEffortChange={(effort) => {
                const selected = models.find((item) => item.model === selectedModel);
                if (!selected?.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) return;
                const previous = { model: selectedModel, effort: selectedEffort };
                setSelectedEffort(effort);
                queueCodexPreference(selectedModel, effort, previous);
              }}
            />
            <div className="mb-1 flex items-center gap-1.5 px-1">
              <label htmlFor="codex-permission-mode" className="text-[10px] text-[var(--ob-muted)]">{t("agent.permission")}</label>
              <select
                id="codex-permission-mode"
                disabled={busy || turnStatus === "running"}
                value={permissionMode}
                onChange={(event) => {
                  const next = event.target.value as CodexPermissionMode;
                  if (next === "full-access") {
                    setFullAccessConfirmOpen(true);
                    return;
                  }
                  setPermissionMode(next);
                }}
                className="min-w-0 flex-1 border-0 bg-transparent text-[10px] text-[var(--ob-ink)] outline-none disabled:opacity-50"
              >
                <option value="read-only">{t("agent.permissionReadOnly")}</option>
                <option value="workspace-auto">{t("agent.permissionWorkspace")}</option>
                <option value="full-access">{t("agent.permissionFull")}</option>
              </select>
            </div>
            {composerReferences.length ? <div className="mb-1 flex flex-wrap gap-1 px-1">{composerReferences.map((reference) => <button key={`${reference.kind}:${reference.id}`} type="button" className="ob-chip text-[10px]" title={t("agent.removeContext")} onClick={() => setComposerReferences((current) => current.filter((item) => item.kind !== reference.kind || item.id !== reference.id))}>{reference.kind === "skill" ? "/" : "@"}{reference.label} ×</button>)}</div> : null}
            {composerTrigger && composerSuggestions.length ? <div role="listbox" aria-label={composerTrigger.kind === "skill" ? t("agent.skillSuggestions") : t("agent.canvasSuggestions")} className="mb-1 max-h-40 overflow-y-auto rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-1 shadow-[var(--ob-shadow)]">{composerSuggestions.map((suggestion) => <button key={`${suggestion.kind}:${suggestion.id}`} role="option" type="button" className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--ob-accent-soft)]" onMouseDown={(event) => event.preventDefault()} onClick={() => { const trigger = detectAgentComposerTrigger(text, composerCursor); if (!trigger) return; const next = applyAgentComposerSuggestion(text, trigger, suggestion, composerReferences); setText(next.text); setComposerReferences(next.references); setComposerCursor(next.cursor); requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(next.cursor, next.cursor); }); }}>{suggestion.kind === "skill" ? "/" : "@"}{suggestion.label}<span className="ml-2 text-[10px] text-[var(--ob-muted)]">{suggestion.id}</span></button>)}</div> : null}
            <div className="flex items-end gap-1.5">
              <textarea
                ref={composerRef}
                disabled={busy || turnStatus === "running"}
                value={text}
                onChange={(event) => { setText(event.target.value); setComposerCursor(event.target.selectionStart); }}
                onSelect={(event) => setComposerCursor(event.currentTarget.selectionStart)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                className="min-h-16 min-w-0 flex-1 resize-y border-0 bg-transparent px-1.5 py-1 text-xs outline-none placeholder:text-[var(--ob-muted)] disabled:opacity-50"
                placeholder={t("agent.codexPlaceholder")}
              />
              <label className="ob-icon-btn h-8 w-8 shrink-0 cursor-pointer" title={t("agent.addImage")} aria-label={t("agent.addImage")}>
                <ImagePlus size={14} />
                <input
                  disabled={busy || turnStatus === "running"}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    setFiles(Array.from(event.target.files ?? []).slice(0, 10));
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              {turnStatus === "running" ? (
                <button type="button" className="ob-btn-danger rounded-lg p-2" onClick={() => void stop()} title={t("agent.stop")} aria-label={t("agent.stop")}>
                  <Square size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="ob-btn-primary rounded-lg p-2 disabled:opacity-50"
                  onClick={() => void send()}
                  title={t("agent.send")}
                  aria-label={t("agent.send")}
                  disabled={busy || !text.trim()}
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className="mt-2 rounded-lg border border-[color-mix(in_srgb,var(--ob-danger)_28%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-danger)_8%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--ob-danger)]">
          {error}
        </p>
      ) : null}
      {approvals.map((pending, index) => {
        const params = pending.params as { command?: unknown; path?: unknown; tool?: unknown } | undefined;
        const detail = typeof params?.command === "string" ? params.command : typeof params?.path === "string" ? params.path : typeof params?.tool === "string" ? params.tool : t("agent.approvalFallback");
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
          <div key={codexApprovalKey(pending)} className="mt-2 rounded-xl border border-[color-mix(in_srgb,var(--ob-warning)_55%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-warning)_8%,transparent)] p-2.5">
            <div className="mb-1 text-xs font-semibold">{t("agent.approvalTitle")}</div>
            <div className="mb-1 break-words text-[var(--ob-muted)]">{detail}</div>
            <details><summary className="cursor-pointer text-[10px]">{t("agent.approvalDetails")}</summary><pre className="max-h-20 overflow-auto text-[10px]">{JSON.stringify(pending.params, null, 2)}</pre></details>
            <div className="mt-2 flex gap-1.5"><button type="button" className="ob-btn-primary gap-1 rounded-lg px-2.5 py-1 text-xs" title={t("agent.allow")} onClick={() => void resolve(true)}><Check size={14} /> {t("agent.allow")}</button><button type="button" className="ob-btn gap-1 text-xs" title={t("agent.deny")} onClick={() => void resolve(false)}><X size={14} /> {t("agent.deny")}</button></div>
          </div>
        );
      })}
      {fullAccessConfirmOpen ? (
        <ConfirmDialog
          title={t("agent.permissionFull")}
          message={t("agent.confirmFullAccess")}
          confirmLabel={t("agent.allow")}
          tone="danger"
          onCancel={() => setFullAccessConfirmOpen(false)}
          onConfirm={() => {
            setPermissionMode("full-access");
            setFullAccessConfirmOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
