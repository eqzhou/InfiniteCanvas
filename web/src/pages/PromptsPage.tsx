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
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  FilePlus2,
  Library,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SendToBack,
  SlidersHorizontal,
  Trash2,
  UserRound,
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
  const [sourcesOpen, setSourcesOpen] = useState(true);

  // Keep a fresh deployment empty. Built-in examples are opt-in via the
  // explicit restore action below, so demo content never appears silently.
  const all = prompts;
  const minePrompts = useMemo(
    () => all.filter((p) => p.source === "local" || p.sourceId === "personal"),
    [all],
  );
  const libraryPrompts = useMemo(
    () => all,
    [all],
  );
  const scoped = activeTab === "mine" ? minePrompts : libraryPrompts;
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
    const existing = current.find((item) => item.id === sourceConfig.id);
    // Built-in registry sources keep their URL/mapping; only enablement/schedule/status update.
    if (existing?.builtIn || sourceConfig.builtIn) {
      setConfig({
        ...latest,
        promptSources: current.map((item) =>
          item.id === sourceConfig.id
            ? {
              ...item,
              enabled: sourceConfig.enabled,
              refreshMinutes: sourceConfig.refreshMinutes,
              lastFetchedAt: sourceConfig.lastFetchedAt ?? item.lastFetchedAt,
              lastSuccessAt: sourceConfig.lastSuccessAt ?? item.lastSuccessAt,
              lastError: sourceConfig.lastError,
              itemCount: sourceConfig.itemCount ?? item.itemCount,
            }
            : item),
      });
      await flushConfig();
      return;
    }
    if (!existing && current.length >= PROMPT_SOURCE_LIMITS.maxSources) {
      throw new Error(`提示词来源最多保存 ${PROMPT_SOURCE_LIMITS.maxSources} 个`);
    }
    setConfig({
      ...latest,
      promptSources: existing
        ? current.map((item) => item.id === sourceConfig.id ? { ...sourceConfig, builtIn: false } : item)
        : [...current, { ...sourceConfig, builtIn: false }],
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

  const restoreBuiltinPrompts = () => {
    setBusy(true);
    setActiveTab("library");
    const current = useBoardStore.getState().prompts.filter((prompt) => prompt.source !== "builtin");
    setPrompts([
      ...BUILTIN.map((prompt) => ({ ...prompt, tags: [...prompt.tags] })),
      ...current,
    ]);
    void flushPrompts()
      .catch((cause) => setErr(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const failedSources = savedSources.filter((item) => Boolean(item.lastError)).length;
  const enabledSources = savedSources.filter((item) => item.enabled).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ob-canvas)]">
      <div className="shrink-0 border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-4 py-3 backdrop-blur-md sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0">
              <h1
                aria-label="提示词库"
                className="text-lg font-semibold tracking-tight text-[var(--ob-ink)]"
              >
                提示词中心
              </h1>
              <p className="text-xs text-[var(--ob-muted)]">
                浏览、筛选并插入画布 · 库 {libraryPrompts.length} · 我的 {minePrompts.length}
              </p>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {activeTab === "library" ? (
                <button
                  type="button"
                  className="ob-btn"
                  onClick={() => setSourcesOpen((open) => !open)}
                  aria-expanded={sourcesOpen}
                >
                  {sourcesOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  来源
                  <span className="ob-chip">{enabledSources}/{savedSources.length || 0}</span>
                  {failedSources ? (
                    <span className="rounded-full bg-[color-mix(in_srgb,var(--ob-danger)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ob-danger)]">
                      {failedSources} 失败
                    </span>
                  ) : null}
                </button>
              ) : null}
              <button
                type="button"
                className="ob-btn"
                disabled={busy}
                onClick={restoreBuiltinPrompts}
              >
                恢复内置
              </button>
              <button
                type="button"
                aria-label="新建提示词"
                className="ob-btn-primary rounded-lg px-3.5 py-2 text-sm font-medium"
                onClick={() => {
                  setActiveTab("mine");
                  setEditingPrompt(null);
                  setCreatingPromptId(uid("prompt"));
                  setEditorMode("create");
                }}
              >
                <Plus size={15} /> 新建
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              className="inline-flex rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-0.5 shadow-sm"
              role="tablist"
              aria-label="提示词中心分类"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "library"}
                className={`inline-flex items-center gap-1.5 rounded-[0.65rem] px-3 py-1.5 text-sm transition-colors ${
                  activeTab === "library"
                    ? "bg-[var(--ob-accent-soft)] font-semibold text-[var(--ob-accent)]"
                    : "font-medium text-[var(--ob-muted)] hover:text-[var(--ob-ink)]"
                }`}
                onClick={() => setActiveTab("library")}
              >
                <Library size={14} />
                提示词库
                <span className="tabular-nums opacity-80">{libraryPrompts.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "mine"}
                className={`inline-flex items-center gap-1.5 rounded-[0.65rem] px-3 py-1.5 text-sm transition-colors ${
                  activeTab === "mine"
                    ? "bg-[var(--ob-accent-soft)] font-semibold text-[var(--ob-accent)]"
                    : "font-medium text-[var(--ob-muted)] hover:text-[var(--ob-ink)]"
                }`}
                onClick={() => setActiveTab("mine")}
              >
                <UserRound size={14} />
                我的
                <span className="tabular-nums opacity-80">{minePrompts.length}</span>
              </button>
            </div>

            <label className="relative min-w-[12rem] flex-1 sm:max-w-sm">
              <span className="sr-only">搜索提示词</span>
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ob-muted)]"
                aria-hidden
              />
              <input
                className="ob-field w-full !pl-9"
                placeholder="搜索标题 / 内容 / 标签 / 来源"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>

            {activeTab === "library" ? (
              <>
                <select
                  aria-label="提示词来源"
                  className="ob-field w-auto max-w-[10rem] cursor-pointer"
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
                  className="ob-field w-auto max-w-[9rem] cursor-pointer"
                  value={tag}
                  onChange={(event) => setTag(event.target.value)}
                >
                  {tags.map((value) => (
                    <option key={value} value={value}>
                      {value === "all" ? "全部标签" : value}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            <span className="ml-auto hidden text-xs text-[var(--ob-muted)] sm:inline">
              显示 {filtered.length}
              {(q || source !== "all" || tag !== "all") ? " · 已筛选" : ""}
            </span>
          </div>

          {err ? (
            <p role="alert" className="rounded-lg border border-[color-mix(in_srgb,var(--ob-danger)_30%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-danger)_8%,transparent)] px-3 py-2 text-sm text-[var(--ob-danger)]">
              {err}
            </p>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
          {activeTab === "library" && sourcesOpen ? (
            <section className="ob-card overflow-hidden p-0">
              <header className="flex flex-wrap items-center gap-2 border-b border-[var(--ob-line)] px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-[var(--ob-ink)]">提示词源</h2>
                  <p className="text-[11px] text-[var(--ob-muted)]">社区目录 · 远程 JSON/Markdown · 同步状态</p>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-label="管理来源"
                    className="ob-btn"
                    onClick={() => setSourceManagerOpen(true)}
                  >
                    <SlidersHorizontal size={14} /> 管理
                  </button>
                  {enabledSources ? (
                    <button
                      type="button"
                      className="ob-btn"
                      disabled={busy}
                      onClick={() => void refreshAllRemote()}
                    >
                      <RefreshCw size={14} className={busy ? "animate-spin" : undefined} /> 刷新全部
                    </button>
                  ) : null}
                </div>
              </header>

              <div className="grid gap-0 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="border-b border-[var(--ob-line)] p-4 lg:border-b-0 lg:border-r">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--ob-muted)]">
                    社区一键接入
                  </div>
                  <ul className="grid gap-2 sm:grid-cols-2" aria-label="社区提示词源">
                    {COMMUNITY_PROMPT_SOURCE_PRESETS.map((preset) => {
                      const installed = savedSources.some((item) =>
                        item.id === preset.source.id || item.url === preset.source.url);
                      return (
                        <li
                          key={preset.id}
                          className="flex min-w-0 items-start gap-2 rounded-xl border border-[var(--ob-line)] bg-[var(--ob-canvas)]/60 px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-[var(--ob-ink)]">{preset.name}</div>
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--ob-muted)]">
                              {preset.description}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="ob-btn shrink-0 px-2.5 py-1 text-xs"
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

                <div className="p-4">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--ob-muted)]">
                    自定义远程源
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      className="ob-field min-w-0 flex-1"
                      placeholder="远程源 URL（raw JSON / Markdown）"
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label="拉取远程提示词"
                      className="ob-btn-primary shrink-0 rounded-lg px-3 py-2 text-sm font-medium"
                      disabled={busy}
                      onClick={() => void pullRemote()}
                    >
                      {busy ? "拉取中…" : "拉取"}
                    </button>
                  </div>

                  {savedSources.length ? (
                    <ul className="mt-3 divide-y divide-[var(--ob-line)] rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)]">
                      {savedSources.map((sourceConfig) => (
                        <li key={sourceConfig.id} className="flex min-w-0 items-center gap-2 px-3 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <span className="truncate text-sm font-medium" title={sourceConfig.url}>
                                {sourceConfig.name}
                              </span>
                              <span className="ob-chip uppercase">{sourceConfig.format}</span>
                              {sourceConfig.builtIn ? <span className="ob-chip">内置</span> : null}
                              {!sourceConfig.enabled ? <span className="ob-chip">已停用</span> : null}
                              {sourceConfig.lastError ? (
                                <span
                                  className="rounded-full bg-[color-mix(in_srgb,var(--ob-danger)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ob-danger)]"
                                  title={sourceConfig.lastError}
                                >
                                  失败
                                </span>
                              ) : sourceConfig.lastSuccessAt ? (
                                <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                                  正常
                                </span>
                              ) : (
                                <span className="ob-chip">未同步</span>
                              )}
                            </div>
                            <p className="mt-0.5 truncate text-[11px] text-[var(--ob-muted)]">
                              {sourceConfig.homepage || sourceConfig.url}
                              {typeof sourceConfig.itemCount === "number" ? ` · ${sourceConfig.itemCount} 条` : ""}
                              {sourceConfig.lastSuccessAt
                                ? ` · ${new Date(sourceConfig.lastSuccessAt).toLocaleString()}`
                                : " · 尚未成功拉取"}
                            </p>
                          </div>
                          <button
                            type="button"
                            title="刷新提示词源"
                            className="ob-icon-btn h-8 w-8"
                            disabled={busy || !sourceConfig.enabled}
                            onClick={() => void refreshRemote(sourceConfig).catch(() => undefined)}
                          >
                            <RefreshCw size={14} />
                          </button>
                          {!sourceConfig.builtIn ? (
                            <button
                              type="button"
                              title="移除提示词源"
                              className="ob-btn-danger rounded-lg p-1.5"
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
                  ) : (
                    <p className="mt-3 rounded-xl border border-dashed border-[var(--ob-line)] px-3 py-4 text-center text-xs text-[var(--ob-muted)]">
                      尚未接入来源。可一键接入社区目录，或粘贴远程 URL。
                    </p>
                  )}
                </div>
              </div>
            </section>
          ) : null}

          {filtered.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((p) => {
                const isLocal = p.source === "local" || p.sourceId === "personal";
                return (
                  <article
                    key={p.id}
                    className="ob-card group flex min-h-[13.5rem] flex-col overflow-hidden p-0"
                  >
                    {p.coverUrl ? (
                      <div className="relative h-28 overflow-hidden border-b border-[var(--ob-line)] bg-[var(--ob-canvas)]">
                        <img
                          src={p.coverUrl}
                          alt=""
                          crossOrigin="anonymous"
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                        />
                      </div>
                    ) : null}
                    <div className="flex min-h-0 flex-1 flex-col p-3.5">
                      <div className="mb-1.5 flex items-start gap-2">
                        <h3 className="min-w-0 flex-1 truncate text-[0.95rem] font-semibold leading-snug text-[var(--ob-ink)]">
                          {p.title}
                        </h3>
                        <span className="ob-chip shrink-0 max-w-[7rem] truncate" title={p.source}>
                          {p.source}
                        </span>
                      </div>
                      <p className="line-clamp-3 flex-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ob-muted)]">
                        {p.body}
                      </p>
                      {p.tags.length ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {p.tags.slice(0, 4).map((t) => (
                            <span
                              key={t}
                              className="rounded-md bg-[var(--ob-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ob-accent)]"
                            >
                              {t}
                            </span>
                          ))}
                          {p.tags.length > 4 ? (
                            <span className="ob-chip">+{p.tags.length - 4}</span>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="mt-3 flex items-center gap-1.5 border-t border-[var(--ob-line)] pt-2.5">
                        <button
                          type="button"
                          aria-label="插入画布"
                          className="ob-btn-primary rounded-lg px-2.5 py-1.5 text-xs font-medium"
                          onClick={() => usePrompt(p)}
                        >
                          <SendToBack size={13} /> 插入
                        </button>
                        <button
                          type="button"
                          className="ob-btn px-2.5 py-1.5 text-xs"
                          onClick={() => setSelectedPrompt(p)}
                        >
                          <Eye size={13} /> 详情
                        </button>
                        <button
                          type="button"
                          title="复制提示词"
                          aria-label="复制提示词"
                          className="ob-icon-btn h-8 w-8"
                          onClick={() => void navigator.clipboard.writeText(p.body)}
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          type="button"
                          title="加入素材"
                          aria-label="加入素材"
                          className="ob-icon-btn h-8 w-8"
                          onClick={() => void addPromptAsset(p).catch((cause) =>
                            setErr(cause instanceof Error ? cause.message : String(cause)))}
                        >
                          <FilePlus2 size={14} />
                        </button>
                        <div className="ml-auto flex items-center gap-1">
                          {isLocal ? (
                            <>
                              <button
                                type="button"
                                className="ob-icon-btn h-8 w-8"
                                title="编辑"
                                aria-label="编辑"
                                onClick={() => {
                                  setEditingPrompt(p);
                                  setEditorMode("edit");
                                }}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                type="button"
                                className="ob-btn-danger rounded-lg p-1.5"
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
                              className="ob-btn px-2.5 py-1.5 text-xs"
                              onClick={() => void saveToMine(p).catch((cause) =>
                                setErr(cause instanceof Error ? cause.message : String(cause)))}
                            >
                              保存到我的
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="ob-card flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]">
                {activeTab === "mine" ? <UserRound size={22} /> : <Library size={22} />}
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--ob-ink)]">
                  {activeTab === "mine" ? "还没有我的提示词" : "当前没有可显示的提示词"}
                </p>
                <p className="mt-1 max-w-md text-xs leading-relaxed text-[var(--ob-muted)]">
                  {activeTab === "mine"
                    ? "从公共库保存，或点击右上角新建。"
                    : "展开「来源」接入社区 / 远程目录，或恢复内置示例。"}
                </p>
              </div>
              {activeTab === "library" ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {!sourcesOpen ? (
                    <button type="button" className="ob-btn" onClick={() => setSourcesOpen(true)}>
                      查看来源
                    </button>
                  ) : null}
                </div>
              ) : (
                <button
                  type="button"
                  className="ob-btn-primary rounded-lg px-3 py-2 text-sm font-medium"
                  onClick={() => {
                    setEditingPrompt(null);
                    setCreatingPromptId(uid("prompt"));
                    setEditorMode("create");
                  }}
                >
                  <Plus size={15} /> 新建提示词
                </button>
              )}
            </div>
          )}
        </div>
      </div>
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
