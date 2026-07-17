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
    <aside className="absolute inset-0 z-50 flex h-full w-full shrink-0 flex-col border-l border-[var(--ob-line)] bg-[var(--ob-panel)] md:static md:w-[340px]">
      <div className="flex items-center gap-2 border-b border-[var(--ob-line)] px-3 py-2">
        <strong className="text-sm">画布助手</strong>
        <button
          type="button"
          className="ml-auto rounded p-1 hover:bg-[var(--ob-accent-soft)] md:hidden"
          title="关闭助手"
          onClick={() => setShowAssistant(false)}
        >
          <X size={16} />
        </button>
        <button
          type="button"
          className="rounded p-1 hover:bg-[var(--ob-accent-soft)]"
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
          className={`rounded p-1 hover:bg-[var(--ob-accent-soft)] ${
            managingSessions ? "bg-[var(--ob-accent-soft)]" : ""
          }`}
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
          className="rounded p-1 hover:bg-[var(--ob-accent-soft)]"
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
              className="flex w-full items-center justify-center gap-1 rounded bg-[var(--ob-danger)] px-2 py-1.5 text-xs text-white disabled:opacity-50"
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
            className="w-full rounded border border-[var(--ob-line)] bg-transparent px-2 py-1 text-sm"
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
        {session.messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-lg border border-[var(--ob-line)] p-2 text-sm ${
              m.role === "user" ? "bg-[var(--ob-accent-soft)]" : "bg-transparent"
            }`}
          >
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--ob-muted)]">
              {m.role} · {m.mode}
            </div>
            <div className="whitespace-pre-wrap">{m.isLoading ? "思考中…" : m.text}</div>
            {m.images?.map((img) => (
              <img
                key={img.id}
                src={img.url}
                alt=""
                className="mt-2 max-h-40 rounded object-contain"
              />
            ))}
            <div className="mt-2 flex flex-wrap gap-2">
              {!m.isLoading && (m.role === "assistant" || m.images?.length) ? (
                <button
                  type="button"
                  className="text-xs text-[var(--ob-accent)]"
                  onClick={() => insertMessage(m)}
                >
                  插入画布
                </button>
              ) : null}
              {m.role === "assistant" && !m.isLoading ? (
                <>
                  <button
                    type="button"
                    className="text-xs text-[var(--ob-muted)]"
                    onClick={() => void retryMessage(m)}
                  >
                    重试
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="text-xs text-[var(--ob-danger)]"
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
                className="rounded bg-[var(--ob-accent-soft)] px-1.5 py-0.5 text-[11px]"
              >
                {r.kind}:{r.label}
              </span>
            ))}
          </div>
        ) : (
          <p className="mb-2 text-xs text-[var(--ob-muted)]">选中节点可作为引用</p>
        )}
        <div className="mb-2 flex gap-2 text-xs">
          <button
            type="button"
            className={`rounded px-2 py-1 ${mode === "ask" ? "bg-[var(--ob-accent-soft)]" : ""}`}
            onClick={() => setMode("ask")}
          >
            问答
          </button>
          <button
            type="button"
            className={`rounded px-2 py-1 ${mode === "image" ? "bg-[var(--ob-accent-soft)]" : ""}`}
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
        <div className="flex gap-2">
          <textarea
            className="min-h-[72px] flex-1 resize-none rounded-md border border-[var(--ob-line)] bg-transparent p-2 text-sm"
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
            className="self-end rounded-md bg-[var(--ob-accent)] p-2 text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void send()}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
