import { useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { generateImages, generateText, resolveNodeImageDataUrls } from "@/services/ai-client";
import { uploadMedia } from "@/services/storage";
import { createEmptySession, createNode } from "@/lib/defaults";
import { deleteAssistantSessions } from "@/lib/assistant-sessions";
import { nowIso, uid } from "@/lib/id";
import { isSubmitShortcut } from "@/lib/keyboard";
import type { AssistantImage, AssistantMessage, AssistantRef } from "@/types/board";
import { ListChecks, Plus, Send, Trash2, X } from "lucide-react";
import { getProvider } from "@/lib/ai-config";

export function AssistantPanel() {
  const project = useBoardStore((s) => s.getActive());
  const selectedIds = useBoardStore((s) => s.selectedIds);
  const config = useBoardStore((s) => s.config);
  const updateActive = useBoardStore((s) => s.updateActive);
  const showAssistant = useBoardStore((s) => s.showAssistant);
  const setShowAssistant = useBoardStore((s) => s.setShowAssistant);
  const [mode, setMode] = useState<"ask" | "image">("ask");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pastedImages, setPastedImages] = useState<AssistantImage[]>([]);
  const [managingSessions, setManagingSessions] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);

  const session = useMemo(() => {
    if (!project) return null;
    return (
      project.chatSessions.find((s) => s.id === project.activeChatId) ??
      project.chatSessions[0] ??
      null
    );
  }, [project]);

  const references: AssistantRef[] = useMemo(() => {
    if (!project || !selectedIds.length) return [];
    const selected = new Set(selectedIds);
    const upstream = new Set<string>();
    for (const id of selectedIds) {
      for (const e of project.edges) {
        if (e.to === id) upstream.add(e.from);
      }
    }
    const ids = new Set([...selected, ...upstream]);
    return project.nodes
      .filter((n) => ids.has(n.id))
      .map((n) => ({
        nodeId: n.id,
        kind: n.type,
        label: n.title,
        preview: n.metadata.content?.slice(0, 80),
        storageKey: n.metadata.storageKey,
      }));
  }, [project, selectedIds]);

  if (!showAssistant || !project || !session) return null;

  const channel =
    config.channels.find((c) => c.id === config.activeChannelId) ?? config.channels[0];

  const patchSession = (messages: AssistantMessage[], title?: string) => {
    updateActive((p) => ({
      ...p,
      chatSessions: p.chatSessions.map((s) =>
        s.id === session.id
          ? {
              ...s,
              messages,
              title: title ?? s.title,
              updatedAt: nowIso(),
            }
          : s,
      ),
    }), { history: true });
  };

  const send = async () => {
    if (!text.trim() || busy) return;
    if (!channel || !getProvider(channel, mode === "image" ? "image" : "text").apiKey) {
      alert("请先配置 API Key");
      return;
    }
    setBusy(true);
    const userMsg: AssistantMessage = {
      id: uid("msg"),
      role: "user",
      mode,
      text: text.trim(),
      references,
      images: pastedImages.length ? pastedImages : undefined,
    };
    const assistantMsg: AssistantMessage = {
      id: uid("msg"),
      role: "assistant",
      mode,
      text: "",
      isLoading: true,
    };
    const next = [...session.messages, userMsg, assistantMsg];
    patchSession(next, session.messages.length ? session.title : text.slice(0, 24));
    setText("");
    setPastedImages([]);
    try {
      const imageKeys = [
        ...references.map((r) => r.storageKey).filter((x): x is string => Boolean(x)),
        ...pastedImages.map((img) => img.storageKey).filter((x): x is string => Boolean(x)),
      ];
      const textCtx = references
        .filter((r) => r.kind === "text" && r.preview)
        .map((r) => r.preview)
        .join("\n");
      const prompt = textCtx ? `${text.trim()}\n\n引用：\n${textCtx}` : text.trim();

      if (mode === "ask") {
        const out = await generateText({
          channel,
          model: getProvider(channel, "text").model,
          prompt,
          images: await resolveNodeImageDataUrls(imageKeys),
          systemPrompt: config.systemPrompt,
        });
        patchSession(
          next.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, text: out, isLoading: false }
              : m,
          ),
        );
      } else {
        const urls = await generateImages({
          channel,
          model: getProvider(channel, "image").model,
          prompt,
          size: config.imageSize,
          quality: config.imageQuality,
          n: 1,
          referenceDataUrls: await resolveNodeImageDataUrls(imageKeys),
          systemPrompt: config.systemPrompt,
        });
        const images: AssistantImage[] = [];
        for (const url of urls) {
          const uploaded = await uploadMedia(url, "image");
          images.push({
            id: uid("img"),
            url: uploaded.url,
            storageKey: uploaded.storageKey,
          });
        }
        patchSession(
          next.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  text: "已生成图片",
                  images,
                  isLoading: false,
                }
              : m,
          ),
        );
      }
    } catch (err) {
      patchSession(
        next.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                text: err instanceof Error ? err.message : String(err),
                isLoading: false,
              }
            : m,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const insertMessage = (msg: AssistantMessage) => {
    const baseX =
      (project.nodes.at(-1)?.position.x ?? 0) +
      (project.nodes.at(-1)?.width ?? 0) +
      40;
    const baseY = project.nodes.at(-1)?.position.y ?? 0;
    if (msg.images?.length) {
      updateActive((p) => {
        const nodes = msg.images!.map((img, i) =>
          createNode(
            "image",
            { x: baseX, y: baseY + i * 40 },
            {
              metadata: {
                content: img.url,
                storageKey: img.storageKey,
                status: "success",
              },
            },
          ),
        );
        return { ...p, nodes: [...p.nodes, ...nodes] };
      });
    } else if (msg.text) {
      updateActive((p) => ({
        ...p,
        nodes: [
          ...p.nodes,
          createNode("text", { x: baseX, y: baseY }, {
            metadata: { content: msg.text, status: "success" },
          }),
        ],
      }));
    }
  };


  const retryMessage = async (msg: AssistantMessage) => {
    if (busy || msg.role !== "assistant") return;
    // find previous user message
    const idx = session.messages.findIndex((m) => m.id === msg.id);
    if (idx <= 0) return;
    let userIdx = idx - 1;
    while (userIdx >= 0 && session.messages[userIdx].role !== "user") userIdx -= 1;
    if (userIdx < 0) return;
    const user = session.messages[userIdx];
    if (!channel || !getProvider(channel, msg.mode === "image" ? "image" : "text").apiKey) {
      alert("请先配置 API Key");
      return;
    }
    setBusy(true);
    const loading: AssistantMessage = {
      ...msg,
      text: "",
      isLoading: true,
      images: undefined,
    };
    const base = session.messages.map((m) => (m.id === msg.id ? loading : m));
    patchSession(base);
    try {
      const imageKeys = [
        ...(user.references ?? []).map((r) => r.storageKey).filter((x): x is string => Boolean(x)),
        ...(user.images ?? []).map((i) => i.storageKey).filter((x): x is string => Boolean(x)),
      ];
      if (user.mode === "ask" || msg.mode === "ask") {
        const out = await generateText({
          channel,
          model: getProvider(channel, "text").model,
          prompt: user.text,
          images: await resolveNodeImageDataUrls(imageKeys),
          systemPrompt: config.systemPrompt,
        });
        patchSession(
          base.map((m) =>
            m.id === msg.id ? { ...m, text: out, isLoading: false } : m,
          ),
        );
      } else {
        const urls = await generateImages({
          channel,
          model: getProvider(channel, "image").model,
          prompt: user.text,
          size: config.imageSize,
          quality: config.imageQuality,
          n: 1,
          referenceDataUrls: await resolveNodeImageDataUrls(imageKeys),
          systemPrompt: config.systemPrompt,
        });
        const images: AssistantImage[] = [];
        for (const url of urls) {
          const uploaded = await uploadMedia(url, "image");
          images.push({ id: uid("img"), url: uploaded.url, storageKey: uploaded.storageKey });
        }
        patchSession(
          base.map((m) =>
            m.id === msg.id
              ? { ...m, text: "已生成图片", images, isLoading: false }
              : m,
          ),
        );
      }
    } catch (err) {
      patchSession(
        base.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                text: err instanceof Error ? err.message : String(err),
                isLoading: false,
              }
            : m,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      id="canvas-assistant"
      aria-label="画布助手"
      className="ob-drawer absolute inset-y-0 right-0 z-50 flex h-full w-full shrink-0 flex-col sm:w-[360px] xl:static xl:w-[340px] xl:shadow-[var(--ob-elev-1)]"
    >
      <div className="flex min-h-12 items-center gap-1.5 border-b border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_40%,transparent)] px-3 py-2">
        <strong className="mr-auto text-sm font-semibold tracking-tight">画布助手</strong>
        <button
          type="button"
          className="ob-icon-btn h-8 w-8 xl:hidden"
          title="关闭助手"
          onClick={() => setShowAssistant(false)}
        >
          <X size={16} />
        </button>
        <button
          type="button"
          className="ob-icon-btn h-8 w-8"
          title="新会话"
          onClick={() => {
            const s = createEmptySession();
            updateActive((p) => ({
              ...p,
              chatSessions: [s, ...p.chatSessions],
              activeChatId: s.id,
            }));
          }}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          className="ob-icon-btn h-8 w-8"
          title={managingSessions ? "退出会话管理" : "管理会话"}
          aria-pressed={managingSessions}
          onClick={() => {
            setManagingSessions((value) => !value);
            setSelectedSessionIds([]);
          }}
        >
          {managingSessions ? <X size={16} /> : <ListChecks size={16} />}
        </button>
        <button
          type="button"
          className="ob-icon-btn h-8 w-8"
          title="删除会话"
          onClick={() => {
            updateActive((p) => {
              const result = deleteAssistantSessions(
                p.chatSessions,
                p.activeChatId,
                new Set([session.id]),
                createEmptySession,
              );
              return {
                ...p,
                chatSessions: result.sessions,
                activeChatId: result.activeId,
              };
            });
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>

      <div className="border-b border-[var(--ob-line)] px-3 py-2">
        {managingSessions ? (
          <div className="space-y-2">
            <div className="max-h-36 space-y-1 overflow-auto">
              {project.chatSessions.map((item) => (
                <label
                  key={item.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-[var(--ob-accent-soft)]"
                >
                  <input
                    type="checkbox"
                    checked={selectedSessionIds.includes(item.id)}
                    onChange={(event) =>
                      setSelectedSessionIds((ids) =>
                        event.target.checked
                          ? [...ids, item.id]
                          : ids.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="ob-btn-danger w-full justify-center text-xs"
              disabled={!selectedSessionIds.length}
              onClick={() => {
                const selected = new Set(selectedSessionIds);
                updateActive((p) => {
                  const result = deleteAssistantSessions(
                    p.chatSessions,
                    p.activeChatId,
                    selected,
                    createEmptySession,
                  );
                  return {
                    ...p,
                    chatSessions: result.sessions,
                    activeChatId: result.activeId,
                  };
                });
                setSelectedSessionIds([]);
                setManagingSessions(false);
              }}
            >
              <Trash2 size={13} />
              删除 {selectedSessionIds.length} 个会话
            </button>
          </div>
        ) : (
          <select
            className="ob-field text-sm"
            value={session.id}
            onChange={(e) =>
              updateActive((p) => ({ ...p, activeChatId: e.target.value }), {
                history: false,
              })
            }
          >
            {project.chatSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {!session.messages.length ? (
          <div className="ob-empty border-0 bg-transparent px-2 py-8">
            <span className="ob-empty-icon" aria-hidden>
              <Send size={16} />
            </span>
            <p className="ob-empty-title">开始对话</p>
            <p className="ob-empty-desc">选中画布节点可作为引用，支持问答或直接生图。</p>
          </div>
        ) : null}
        {session.messages.map((m) => (
          <div
            key={m.id}
            data-testid={`assistant-message-${m.role}`}
            className="ob-msg"
            data-role={m.role}
          >
            <div className="ob-msg-meta">
              <span>{m.role === "user" ? "你" : "助手"}</span>
              <span aria-hidden>·</span>
              <span>{m.mode === "image" ? "生图" : "问答"}</span>
            </div>
            <div className="whitespace-pre-wrap text-[var(--ob-ink)]">
              {m.isLoading ? "思考中…" : m.text}
            </div>
            {m.images?.map((img) => (
              <img
                key={img.id}
                src={img.url}
                alt=""
                className="mt-2 min-h-16 min-w-16 max-h-40 max-w-full rounded-lg object-contain shadow-[var(--ob-elev-1)]"
              />
            ))}
            <div className="ob-msg-actions">
              {!m.isLoading && (m.role === "assistant" || m.images?.length) ? (
                <button
                  type="button"
                  className="ob-msg-action"
                  onClick={() => insertMessage(m)}
                >
                  插入画布
                </button>
              ) : null}
              {m.role === "assistant" && !m.isLoading ? (
                <button
                  type="button"
                  className="ob-msg-action"
                  onClick={() => void retryMessage(m)}
                >
                  重试
                </button>
              ) : null}
              <button
                type="button"
                className="ob-msg-action"
                data-tone="danger"
                onClick={() =>
                  patchSession(session.messages.filter((x) => x.id !== m.id))
                }
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-[var(--ob-line)] p-3">
        {references.length ? (
          <div className="mb-2 flex flex-wrap gap-1">
            {references.map((r) => (
              <span
                key={r.nodeId}
                className="ob-chip"
              >
                {({
                  text: "文本",
                  image: "图片",
                  config: "配置",
                  video: "视频",
                  audio: "音频",
                  group: "分组",
                  plugin: "插件",
                } as Record<string, string>)[r.kind] ?? r.kind}
                · {r.label}
              </span>
            ))}
          </div>
        ) : (
          <p className="mb-2 text-xs text-[var(--ob-muted)]">选中节点可作为引用</p>
        )}
        <div className="ob-segment mb-2" role="tablist" aria-label="助手模式">
          <button
            type="button"
            role="tab"
            aria-label="问答"
            aria-selected={mode === "ask"}
            className="ob-segment-item"
            onClick={() => setMode("ask")}
          >
            问答
          </button>
          <button
            type="button"
            role="tab"
            aria-label="生图"
            aria-selected={mode === "image"}
            className="ob-segment-item"
            onClick={() => setMode("image")}
          >
            生图
          </button>
        </div>
        {pastedImages.length ? (
          <div className="mb-2 rounded-md border border-[var(--ob-line)] p-2">
            <div className="flex flex-wrap gap-2">
              {pastedImages.map((image) => (
                <div key={image.id} className="relative h-16 w-16">
                  <img src={image.url} alt="待发送图片" className="h-full w-full rounded object-cover" />
                  <button
                    type="button"
                    title="移除附件"
                    className="absolute right-0 top-0 grid h-5 w-5 place-items-center rounded-bl bg-black/70 text-white"
                    onClick={() => setPastedImages((current) =>
                      current.filter((item) => item.id !== image.id))}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-2 text-xs text-[var(--ob-accent)]"
              onClick={() => {
                insertMessage({
                  id: uid("msg"),
                  role: "user",
                  mode,
                  text: "",
                  images: pastedImages,
                });
                setPastedImages([]);
              }}
            >
              插入画布
            </button>
          </div>
        ) : null}
        <div className="ob-composer flex gap-2 p-2">
          <textarea
            className="min-h-[72px] flex-1 resize-none border-0 bg-transparent p-1.5 text-sm text-[var(--ob-ink)] outline-none placeholder:text-[var(--ob-muted)]"
            placeholder={mode === "ask" ? "问点什么…（可粘贴图片）" : "描述想生成的图片…（可粘贴图片）"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                isSubmitShortcut({
                  key: e.key,
                  ctrlKey: e.ctrlKey,
                  metaKey: e.metaKey,
                  isComposing: e.nativeEvent.isComposing,
                })
              ) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData?.items ?? []);
              const files = items
                .filter((it) => it.type.startsWith("image/"))
                .map((it) => it.getAsFile())
                .filter((f): f is File => Boolean(f));
              if (!files.length) return;
              e.preventDefault();
              void (async () => {
                const next: AssistantImage[] = [...pastedImages];
                for (const file of files) {
                  const uploaded = await uploadMedia(file, "image");
                  next.push({
                    id: uid("img"),
                    url: uploaded.url,
                    storageKey: uploaded.storageKey,
                  });
                }
                setPastedImages(next);
              })();
            }}
          />
          <button
            type="button"
            className="ob-btn-primary self-end rounded-xl p-3 disabled:opacity-50"
            disabled={busy || !text.trim()}
            aria-label="发送"
            title="发送"
            onClick={() => void send()}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
