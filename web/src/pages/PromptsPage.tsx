import { useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import type { PromptItem, PromptSourceConfig } from "@/types/board";
import { nowIso, uid } from "@/lib/id";
import {
  fetchPromptSource,
  mergePromptSourceItems,
  parsePromptSourceConfig,
  PROMPT_SOURCE_LIMITS,
} from "@/services/prompt-sources";
import {
  clearPromptSourceCache,
  promptSourceSignature,
  readPromptSourceCache,
  writePromptSourceCache,
} from "@/services/prompt-source-cache";
import {
  clonePresetSource,
  COMMUNITY_PROMPT_SOURCE_PRESETS,
} from "@/services/prompt-source-presets";
import { PromptDetailDialog } from "@/components/prompts/PromptDetailDialog";
import {
  Copy,
  Eye,
  FilePlus2,
  Pencil,
  Plus,
  RefreshCw,
  SendToBack,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  PromptEditorDialog,
  type PromptEditorValues,
} from "@/components/prompts/PromptEditorDialog";
import { PromptSourceManagerDialog } from "@/components/prompts/PromptSourceManagerDialog";

const BUILTIN: PromptItem[] = [
  {
    id: "p1",
    title: "产品棚拍",
    body: "Studio product photo, softbox lighting, seamless backdrop, high detail, commercial catalog style",
    tags: ["product", "studio"],
    source: "builtin",
  },
  {
    id: "p2",
    title: "电影静帧",
    body: "Cinematic still, anamorphic lens flare, volumetric light, 35mm film grain, dramatic composition",
    tags: ["cinematic"],
    source: "builtin",
  },
  {
    id: "p3",
    title: "角色设定三视图",
    body: "Character design sheet, front side back views, clean line art, consistent proportions, white background",
    tags: ["character"],
    source: "builtin",
  },
  {
    id: "p4",
    title: "赛博夜景",
    body: "Rainy cyberpunk street, neon reflections, dense atmosphere, ultra detailed night city",
    tags: ["scifi", "city"],
    source: "builtin",
  },
];

export function PromptsPage() {
  const navigate = useNavigate();
  const prompts = useBoardStore((s) => s.prompts);
  const setPrompts = useBoardStore((s) => s.setPrompts);
  const flushPrompts = useBoardStore((s) => s.flushPrompts);
  const setAssets = useBoardStore((s) => s.setAssets);
  const flushAssets = useBoardStore((s) => s.flushAssets);
  const config = useBoardStore((s) => s.config);
  const setConfig = useBoardStore((s) => s.setConfig);
  const flushConfig = useBoardStore((s) => s.flushConfig);
  const [q, setQ] = useState("");
  const [source, setSource] = useState("all");
  const [tag, setTag] = useState("all");
  const [remoteUrl, setRemoteUrl] = useState(
    config.promptSources?.[0]?.url ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptItem | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<PromptItem | null>(null);
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [creatingPromptId, setCreatingPromptId] = useState("");
  const [sourceManagerOpen, setSourceManagerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"library" | "mine">("library");

  // Keep a fresh deployment empty. Built-in examples are opt-in via the
  // explicit restore action below, so demo content never appears silently.
  const all = prompts;
  const minePrompts = useMemo(
    () => all.filter((p) => p.source === "local" || p.sourceId === "personal"),
    [all],
  );
  const libraryPrompts = useMemo(
    () => all.filter((p) => p.source !== "local" && p.sourceId !== "personal"),
    [all],
  );
  const scoped = activeTab === "mine" ? minePrompts : all;
  const filtered = useMemo(() => {
    return scoped.filter((p) => {
      if (activeTab === "library" && source !== "all" && p.source !== source) return false;
      if (activeTab === "library" && tag !== "all" && !p.tags.includes(tag)) return false;
      if (!q.trim()) return true;
      const s = q.toLowerCase();
      return (
        p.title.toLowerCase().includes(s) ||
        p.body.toLowerCase().includes(s) ||
        p.tags.some((t) => t.toLowerCase().includes(s)) ||
        p.source.toLowerCase().includes(s)
      );
    });
  }, [scoped, q, source, tag, activeTab]);

  const sources = useMemo(
    () => ["all", ...Array.from(new Set(libraryPrompts.map((p) => p.source)))],
    [libraryPrompts],
  );
  const tags = useMemo(
    () => ["all", ...Array.from(new Set(
      (activeTab === "mine" ? minePrompts : libraryPrompts).flatMap((prompt) => prompt.tags),
    )).sort()],
    [activeTab, libraryPrompts, minePrompts],
  );
  const savedSources = config.promptSources ?? [];

  const mergeRemoteSource = async (sourceConfig: PromptSourceConfig) => {
    const items = await fetchPromptSource(sourceConfig);
    const latest = useBoardStore.getState();
    setPrompts(mergePromptSourceItems(latest.prompts, items, sourceConfig.id));
    await flushPrompts();
    const successAt = nowIso();
    await writePromptSourceCache({
      sourceId: sourceConfig.id,
      items,
      count: items.length,
      fetchedAt: Date.now(),
      lastSuccessAt: successAt,
      lastError: "",
      signature: promptSourceSignature(sourceConfig),
    });
    return { items, successAt };
  };

  const saveSourceConfig = async (sourceConfig: PromptSourceConfig) => {
    const latest = useBoardStore.getState().config;
    const current = latest.promptSources ?? [];
    const exists = current.some((item) => item.id === sourceConfig.id);
    if (!exists && current.length >= PROMPT_SOURCE_LIMITS.maxSources) {
      throw new Error(`提示词来源最多保存 ${PROMPT_SOURCE_LIMITS.maxSources} 个`);
    }
    setConfig({
      ...latest,
      promptSources: exists
        ? current.map((item) => item.id === sourceConfig.id ? { ...sourceConfig } : item)
        : [...current, { ...sourceConfig }],
    });
    await flushConfig();
  };

  const pullRemote = async () => {
    if (!remoteUrl.trim()) {
      alert("请填写远程提示词源 URL（JSON 数组或 Markdown）");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const url = remoteUrl.trim();
      const duplicate = (useBoardStore.getState().config.promptSources ?? [])
        .find((sourceConfig) => sourceConfig.url === url);
      const sourceConfig = duplicate ?? parsePromptSourceConfig({
        id: uid("prompt-source"),
        name: new URL(url).hostname,
        url,
        format: "auto",
        enabled: true,
        refreshMinutes: 0,
      });
      const { successAt, items } = await mergeRemoteSource(sourceConfig);
      await saveSourceConfig({
        ...sourceConfig,
        lastFetchedAt: successAt,
        lastSuccessAt: successAt,
        lastError: undefined,
        itemCount: items.length,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshRemote = async (sourceConfig: PromptSourceConfig) => {
    setBusy(true);
    setErr(null);
    try {
      const { successAt, items } = await mergeRemoteSource(sourceConfig);
      await saveSourceConfig({
        ...sourceConfig,
        lastFetchedAt: successAt,
        lastSuccessAt: successAt,
        lastError: undefined,
        itemCount: items.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErr(message);
      // Keep last successful prompts/cache; only record the failure on the source card.
      const cached = await readPromptSourceCache(sourceConfig.id);
      await saveSourceConfig({
        ...sourceConfig,
        lastFetchedAt: nowIso(),
        lastSuccessAt: sourceConfig.lastSuccessAt ?? cached?.lastSuccessAt,
        lastError: message,
        itemCount: sourceConfig.itemCount ?? cached?.count,
      });
      if (cached?.items?.length) {
        const latest = useBoardStore.getState();
        setPrompts(mergePromptSourceItems(latest.prompts, cached.items, sourceConfig.id));
        await flushPrompts();
      }
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const refreshAllRemote = async () => {
    setBusy(true);
    setErr(null);
    const failures: string[] = [];
    try {
      for (const sourceConfig of savedSources.filter((item) => item.enabled)) {
        try {
          const { successAt, items } = await mergeRemoteSource(sourceConfig);
          await saveSourceConfig({
            ...sourceConfig,
            lastFetchedAt: successAt,
            lastSuccessAt: successAt,
            lastError: undefined,
            itemCount: items.length,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${sourceConfig.name}: ${message}`);
          const cached = await readPromptSourceCache(sourceConfig.id);
          await saveSourceConfig({
            ...sourceConfig,
            lastFetchedAt: nowIso(),
            lastSuccessAt: sourceConfig.lastSuccessAt ?? cached?.lastSuccessAt,
            lastError: message,
            itemCount: sourceConfig.itemCount ?? cached?.count,
          });
          if (cached?.items?.length) {
            const latest = useBoardStore.getState();
            setPrompts(mergePromptSourceItems(latest.prompts, cached.items, sourceConfig.id));
            await flushPrompts();
          }
        }
      }
      if (failures.length) {
        setErr(`部分来源更新失败（已保留上次成功内容）：${failures.join("；")}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const removeRemote = async (sourceConfig: PromptSourceConfig) => {
    if (sourceConfig.builtIn) {
      throw new Error("内置提示词来源不能删除，可停用或刷新");
    }
    setBusy(true);
    const latest = useBoardStore.getState().config;
    setConfig({
      ...latest,
      promptSources: (latest.promptSources ?? []).filter((item) => item.id !== sourceConfig.id),
    });
    setPrompts(useBoardStore.getState().prompts.filter((item) => item.sourceId !== sourceConfig.id));
    try {
      await Promise.all([flushConfig(), flushPrompts(), clearPromptSourceCache(sourceConfig.id)]);
      if (remoteUrl === sourceConfig.url) setRemoteUrl("");
    } finally {
      setBusy(false);
    }
  };

  const addCommunityPreset = async (presetId: string) => {
    const preset = COMMUNITY_PROMPT_SOURCE_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setBusy(true);
    setErr(null);
    try {
      const existing = (useBoardStore.getState().config.promptSources ?? [])
        .find((item) => item.id === preset.source.id || item.url === preset.source.url);
      // Community actions always re-enable the source so a disabled catalog can be
      // refreshed from the one-click entry without opening the manager.
      const sourceConfig = {
        ...(existing ?? clonePresetSource(preset)),
        enabled: true,
      };
      const { successAt, items } = await mergeRemoteSource(sourceConfig);
      await saveSourceConfig({
        ...sourceConfig,
        lastFetchedAt: successAt,
        lastSuccessAt: successAt,
        lastError: undefined,
        itemCount: items.length,
      });
      setRemoteUrl(sourceConfig.url);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const report = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown }>).detail;
      if (typeof detail?.message === "string") setErr(`提示词来源自动刷新失败：${detail.message}`);
    };
    window.addEventListener("openboard:prompt-source-error", report);
    return () => window.removeEventListener("openboard:prompt-source-error", report);
  }, []);

  const addPromptAsset = async (prompt: PromptItem) => {
    const t = nowIso();
    const latestAssets = useBoardStore.getState().assets;
    setAssets([
      {
        id: uid("asset"),
        kind: "text",
        title: prompt.title,
        content: prompt.body,
        tags: [...prompt.tags],
        source: prompt.source,
        createdAt: t,
        updatedAt: t,
      },
      ...latestAssets,
    ]);
    await flushAssets();
  };

  const insertPrompt = (prompt: PromptItem) => {
    const state = useBoardStore.getState();
    const active = state.getActive();
    if (!active) return;
    state.addNode("text", {
      x: (window.innerWidth / 2 - active.viewport.x) / active.viewport.k - 140,
      y: (window.innerHeight / 2 - active.viewport.y) / active.viewport.k - 90,
    }, {
      title: prompt.title,
      metadata: { content: prompt.body, status: "idle" },
    });
  };

  const savePrompt = async (values: PromptEditorValues) => {
    const latest = useBoardStore.getState().prompts;
    if (editorMode === "edit" && editingPrompt) {
      setPrompts(latest.map((prompt) =>
        prompt.id === editingPrompt.id
          ? { ...prompt, title: values.title, body: values.body, tags: [...values.tags] }
          : prompt,
      ));
    } else {
      setPrompts([
        {
          id: creatingPromptId || uid("prompt"),
          title: values.title,
          body: values.body,
          tags: [...values.tags],
          source: "local",
        },
        ...latest,
      ]);
    }
    await flushPrompts();
    setEditingPrompt(null);
    setEditorMode(null);
    setCreatingPromptId("");
  };

  const saveToMine = async (prompt: PromptItem) => {
    const latest = useBoardStore.getState().prompts;
    const next: PromptItem = {
      id: uid("prompt"),
      title: prompt.title,
      body: prompt.body,
      tags: [...prompt.tags],
      source: "local",
      ...(prompt.coverUrl ? { coverUrl: prompt.coverUrl } : {}),
      ...(prompt.resultUrls?.length ? { resultUrls: [...prompt.resultUrls] } : {}),
    };
    setPrompts([next, ...latest]);
    await flushPrompts();
    setActiveTab("mine");
  };

  const usePrompt = (prompt: PromptItem) => {
    insertPrompt(prompt);
    navigate("/");
  };

  return (
    <div className="mx-auto h-full max-w-6xl overflow-auto p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">提示词中心</h1>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--ob-accent)] px-3 py-1.5 text-sm text-white"
          onClick={() => {
            setActiveTab("mine");
            setEditingPrompt(null);
            setCreatingPromptId(uid("prompt"));
            setEditorMode("create");
          }}
        >
          <Plus size={15} /> 新建提示词
        </button>
        <input
          className="w-full rounded-md border border-[var(--ob-line)] bg-transparent px-3 py-1.5 text-sm sm:ml-auto sm:w-auto"
          placeholder="搜索标题/内容/标签/来源…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {activeTab === "library" ? (
          <>
            <select
              aria-label="提示词来源"
              className="rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5 text-sm"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "全部来源" : s}
                </option>
              ))}
            </select>
            <select
              aria-label="提示词标签"
              className="rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5 text-sm"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            >
              {tags.map((value) => (
                <option key={value} value={value}>{value === "all" ? "全部标签" : value}</option>
              ))}
            </select>
          </>
        ) : null}
        <button
          type="button"
          className="rounded-md border border-[var(--ob-line)] px-3 py-1.5 text-sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setActiveTab("library");
            const current = useBoardStore.getState().prompts.filter((prompt) => prompt.source !== "builtin");
            setPrompts([...BUILTIN.map((prompt) => ({ ...prompt, tags: [...prompt.tags] })), ...current]);
            void flushPrompts().catch((cause) =>
              setErr(cause instanceof Error ? cause.message : String(cause)))
              .finally(() => setBusy(false));
          }}
        >
          恢复内置
        </button>
      </div>
      <div className="mb-4 flex gap-1 border-b border-[var(--ob-line)]" role="tablist" aria-label="提示词中心分类">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "library"}
          className={`px-3 py-2 text-sm ${activeTab === "library" ? "border-b-2 border-[var(--ob-accent)] font-medium text-[var(--ob-accent)]" : "text-[var(--ob-muted)]"}`}
          onClick={() => setActiveTab("library")}
        >
          提示词库 ({libraryPrompts.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "mine"}
          className={`px-3 py-2 text-sm ${activeTab === "mine" ? "border-b-2 border-[var(--ob-accent)] font-medium text-[var(--ob-accent)]" : "text-[var(--ob-muted)]"}`}
          onClick={() => setActiveTab("mine")}
        >
          我的提示词 ({minePrompts.length})
        </button>
      </div>

      {activeTab === "library" ? <div className="mb-4 space-y-3 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-3">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">社区提示词源</h2>
            <span className="text-[11px] text-[var(--ob-muted)]">一键接入 Image Prompts 统一 JSON 目录</span>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2" aria-label="社区提示词源">
            {COMMUNITY_PROMPT_SOURCE_PRESETS.map((preset) => {
              const installed = savedSources.some((item) =>
                item.id === preset.source.id || item.url === preset.source.url);
              return (
                <li
                  key={preset.id}
                  className="flex min-w-0 items-start gap-2 rounded-md border border-[var(--ob-line)] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{preset.name}</div>
                    <p className="line-clamp-2 text-[11px] text-[var(--ob-muted)]">{preset.description}</p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-[var(--ob-line)] px-2 py-1 text-xs disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void addCommunityPreset(preset.id)}
                  >
                    {installed ? "刷新" : "接入"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-[var(--ob-line)] pt-3">
        <input
          className="min-w-0 flex-1 basis-full rounded-md border border-[var(--ob-line)] bg-transparent px-3 py-1.5 text-sm sm:basis-auto"
          placeholder="远程源 URL（raw JSON / Markdown）"
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
        />
        <button
          type="button"
          className="rounded-md bg-[var(--ob-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={busy}
          onClick={() => void pullRemote()}
        >
          {busy ? "拉取中…" : "拉取远程提示词"}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--ob-line)] px-3 py-1.5 text-sm"
          onClick={() => setSourceManagerOpen(true)}
        >
          <SlidersHorizontal size={14} /> 管理来源
        </button>
        {savedSources.some((item) => item.enabled) ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--ob-line)] px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={busy}
            onClick={() => void refreshAllRemote()}
          >
            <RefreshCw size={14} /> 刷新全部
          </button>
        ) : null}
        {err ? <p className="w-full text-sm text-[var(--ob-danger)]">{err}</p> : null}
        {savedSources.length ? (
          <ul className="w-full divide-y divide-[var(--ob-line)] text-xs">
            {savedSources.map((sourceConfig) => (
              <li key={sourceConfig.id} className="flex min-w-0 items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium" title={sourceConfig.url}>{sourceConfig.name}</span>
                    <span className="shrink-0 rounded-sm bg-[var(--ob-accent-soft)] px-1.5 py-0.5 uppercase text-[10px] text-[var(--ob-accent)]">{sourceConfig.format}</span>
                    {sourceConfig.builtIn ? <span className="shrink-0 text-[10px] text-[var(--ob-muted)]">内置</span> : null}
                    {!sourceConfig.enabled ? <span className="shrink-0 text-[var(--ob-muted)]">已停用</span> : null}
                    {sourceConfig.lastError
                      ? <span className="shrink-0 rounded-sm bg-red-500/15 px-1.5 py-0.5 text-[10px] text-[var(--ob-danger)]" title={sourceConfig.lastError}>失败</span>
                      : sourceConfig.lastSuccessAt
                        ? <span className="shrink-0 rounded-sm bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600">正常</span>
                        : <span className="shrink-0 text-[10px] text-[var(--ob-muted)]">未同步</span>}
                  </div>
                  <p className="truncate text-[11px] text-[var(--ob-muted)]">
                    {(sourceConfig.homepage || sourceConfig.url)}
                    {typeof sourceConfig.itemCount === "number" ? ` · ${sourceConfig.itemCount} 条` : ""}
                    {sourceConfig.lastSuccessAt
                      ? ` · 上次成功 ${new Date(sourceConfig.lastSuccessAt).toLocaleString()}`
                      : " · 尚未成功拉取"}
                  </p>
                </div>
                <button
                  type="button"
                  title="刷新提示词源"
                  className="rounded p-1 text-[var(--ob-muted)]"
                  disabled={busy || !sourceConfig.enabled}
                  onClick={() => void refreshRemote(sourceConfig).catch(() => undefined)}
                >
                  <RefreshCw size={14} />
                </button>
                {!sourceConfig.builtIn ? (
                  <button
                    type="button"
                    title="移除提示词源"
                    className="rounded p-1 text-[var(--ob-danger)]"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`移除提示词来源“${sourceConfig.name}”？`)) {
                        void removeRemote(sourceConfig).catch((cause) =>
                          setErr(cause instanceof Error ? cause.message : String(cause)));
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        </div>
      </div> : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {filtered.map((p) => (
          <article
            key={p.id}
            className="flex min-h-52 flex-col rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-4 transition-colors hover:border-[var(--ob-accent)]"
          >
            <div className="mb-1 flex items-center gap-2">
              <h3 className="min-w-0 flex-1 truncate font-medium">{p.title}</h3>
              <span className="shrink-0 text-xs text-[var(--ob-muted)]">{p.source}</span>
            </div>
            {p.coverUrl ? (
              <img
                src={p.coverUrl}
                alt=""
                crossOrigin="anonymous"
                referrerPolicy="no-referrer"
                className="mb-2 h-28 w-full rounded-md bg-[var(--ob-canvas)] object-cover"
              />
            ) : null}
            <p className="line-clamp-4 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-[var(--ob-muted)]">{p.body}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {p.tags.map((t) => (
                <span
                  key={t}
                  className="rounded bg-[var(--ob-accent-soft)] px-1.5 py-0.5 text-[11px]"
                >
                  {t}
                </span>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-sm">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md bg-[var(--ob-accent)] px-2 py-1 text-white"
                onClick={() => usePrompt(p)}
              >
                <SendToBack size={14} /> 插入画布
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-[var(--ob-line)] px-2 py-1"
                onClick={() => setSelectedPrompt(p)}
              >
                <Eye size={14} /> 详情
              </button>
              <button
                type="button"
                title="复制提示词"
                aria-label="复制提示词"
                className="grid h-8 w-8 place-items-center rounded-md border border-[var(--ob-line)]"
                onClick={() => void navigator.clipboard.writeText(p.body)}
              >
                <Copy size={14} />
              </button>
              <button
                type="button"
                title="加入素材"
                aria-label="加入素材"
                className="grid h-8 w-8 place-items-center rounded-md border border-[var(--ob-line)]"
                onClick={() => void addPromptAsset(p).catch((cause) =>
                  setErr(cause instanceof Error ? cause.message : String(cause)))}
              >
                <FilePlus2 size={14} />
              </button>
              {p.source === "local" ? (
                <>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--ob-line)] px-2 py-1"
                    onClick={() => {
                      setEditingPrompt(p);
                      setEditorMode("edit");
                    }}
                  >
                    <Pencil size={14} /> 编辑
                  </button>
                  <button
                    type="button"
                    className="grid h-8 w-8 place-items-center rounded-md text-[var(--ob-danger)] hover:bg-[var(--ob-accent-soft)]"
                    title="删除"
                    aria-label="删除"
                    onClick={() => {
                      if (!window.confirm(`删除提示词“${p.title}”？`)) return;
                      setPrompts(useBoardStore.getState().prompts.filter((prompt) => prompt.id !== p.id));
                      void flushPrompts().catch((cause) =>
                        setErr(cause instanceof Error ? cause.message : String(cause)));
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--ob-line)] px-2 py-1"
                  onClick={() => void saveToMine(p).catch((cause) =>
                    setErr(cause instanceof Error ? cause.message : String(cause)))}
                >
                  <FilePlus2 size={14} /> 保存到我的
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!filtered.length ? (
        <p className="py-10 text-center text-sm text-[var(--ob-muted)]">
          {activeTab === "mine"
            ? "还没有我的提示词。可从公共库保存，或点击新建。"
            : "暂无提示词。可以恢复内置示例，或接入社区 / 远程提示词源。"}
        </p>
      ) : null}
      <PromptDetailDialog
        prompt={selectedPrompt}
        open={selectedPrompt !== null}
        onClose={() => setSelectedPrompt(null)}
        onCopy={() => {
          if (selectedPrompt) void navigator.clipboard.writeText(selectedPrompt.body);
        }}
        onAddAsset={() => {
          if (selectedPrompt) void addPromptAsset(selectedPrompt).catch((cause) =>
            setErr(cause instanceof Error ? cause.message : String(cause)));
        }}
        onInsert={() => {
          if (!selectedPrompt) return;
          insertPrompt(selectedPrompt);
          setSelectedPrompt(null);
          navigate("/");
        }}
      />
      <PromptEditorDialog
        open={editorMode !== null}
        mode={editorMode === "edit" ? "edit" : "create"}
        prompt={editingPrompt}
        onClose={() => {
          setEditingPrompt(null);
          setEditorMode(null);
          setCreatingPromptId("");
        }}
        onSave={savePrompt}
      />
      {sourceManagerOpen ? <PromptSourceManagerDialog
        open={sourceManagerOpen}
        sources={savedSources}
        busy={busy}
        onClose={() => setSourceManagerOpen(false)}
        onSave={saveSourceConfig}
        onPreview={fetchPromptSource}
        onRefresh={refreshRemote}
        onRemove={async (sourceConfig) => {
          if (!window.confirm(`移除提示词来源“${sourceConfig.name}”？`)) return false;
          await removeRemote(sourceConfig);
          return true;
        }}
      /> : null}
    </div>
  );
}
