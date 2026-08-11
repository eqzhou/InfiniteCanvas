import { useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import type { PromptItem, PromptSourceConfig } from "@/types/board";
import { nowIso, uid } from "@/lib/id";
import { writeTextWithFallback } from "@/lib/clipboard";
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
import { ImagePreviewDialog } from "@/components/canvas/ImagePreviewDialog";
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
import { useNavigate } from "react-router";
import {
  PromptEditorDialog,
  type PromptEditorValues,
} from "@/components/prompts/PromptEditorDialog";
import { PromptSourceManagerDialog } from "@/components/prompts/PromptSourceManagerDialog";
import { useI18n } from "@/i18n/I18nProvider";

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
  const { locale, t } = useI18n();
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
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
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
      throw new Error(t("prompts.maxSources", { count: PROMPT_SOURCE_LIMITS.maxSources }));
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
      alert(t("prompts.remoteUrlRequired"));
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
        setErr(t("prompts.someSourcesFailed", { failures: failures.join("; ") }));
      }
    } finally {
      setBusy(false);
    }
  };

  const removeRemote = async (sourceConfig: PromptSourceConfig) => {
    if (sourceConfig.builtIn) {
      throw new Error(t("prompts.builtinCannotDelete"));
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
      if (typeof detail?.message === "string") setErr(t("prompts.autoRefreshFailed", { message: detail.message }));
    };
    window.addEventListener("openboard:prompt-source-error", report);
    return () => window.removeEventListener("openboard:prompt-source-error", report);
  }, [t]);

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
    setSource("all");
    setTag("all");
    setQ("");
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
      <div className="shrink-0 relative overflow-hidden px-4 py-5 sm:px-6 shadow-sm border-b border-[var(--ob-line)]/50 z-10 bg-[var(--ob-panel-glass)] backdrop-blur-xl">
        <div className="absolute inset-0 bg-gradient-to-r from-[var(--ob-accent)]/5 via-transparent to-transparent opacity-80 pointer-events-none" />
        <div className="absolute top-0 right-0 h-64 w-64 rounded-full bg-[var(--ob-accent)]/10 blur-[80px] -translate-y-1/2 translate-x-1/3 pointer-events-none" />
        <div className="relative mx-auto flex max-w-7xl flex-col gap-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="ob-page-kicker">Library</p>
              <h1
                aria-label={t("prompts.library")}
                className="text-2xl font-bold tracking-tight text-[var(--ob-ink)]"
              >
                {t("prompts.title")}
              </h1>
              <p className="mt-1.5 text-sm font-medium text-[var(--ob-muted)]">
                {t("prompts.description", { library: libraryPrompts.length, mine: minePrompts.length })}
              </p>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2.5">
              {activeTab === "library" ? (
                <button
                  type="button"
                  className="ob-btn ob-btn-sm rounded-lg bg-[var(--ob-canvas)]"
                  onClick={() => setSourcesOpen((open) => !open)}
                  aria-expanded={sourcesOpen}
                >
                  {sourcesOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  {t("prompts.sources")}
                  <span className="ob-chip">{enabledSources}/{savedSources.length || 0}</span>
                  {failedSources ? (
                    <span className="rounded-full bg-[color-mix(in_srgb,var(--ob-danger)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--ob-danger)]">
                      {t("prompts.failedCount", { count: failedSources })}
                    </span>
                  ) : null}
                </button>
              ) : null}
              <button
                type="button"
                className="ob-btn ob-btn-sm rounded-lg bg-[var(--ob-canvas)]"
                disabled={busy}
                onClick={restoreBuiltinPrompts}
              >
                {t("prompts.restoreBuiltin")}
              </button>
              <button
                type="button"
                aria-label={t("prompts.newPrompt")}
                className="ob-btn-primary ob-btn-sm rounded-lg shadow-sm shadow-[var(--ob-accent)]/20"
                onClick={() => {
                  setActiveTab("mine");
                  setEditingPrompt(null);
                  setCreatingPromptId(uid("prompt"));
                  setEditorMode("create");
                }}
              >
                <Plus size={15} /> {t("prompts.new")}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-[var(--ob-panel)]/60 p-1.5 shadow-sm backdrop-blur-md border border-[var(--ob-line)]/50">
            <div
              className="inline-flex rounded-xl bg-[var(--ob-canvas)]/80 p-0.5 shadow-inner border border-[var(--ob-line)]/40"
              role="tablist"
              aria-label={t("prompts.categories")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "library"}
                className={`ob-tab rounded-lg px-4 py-1.5 text-sm font-medium border-b-0 transition-all ${
                  activeTab === "library"
                    ? "bg-[var(--ob-accent-soft)] !text-[var(--ob-accent)] shadow-sm"
                    : "bg-transparent hover:text-[var(--ob-ink)]"
                }`}
                onClick={() => setActiveTab("library")}
              >
                <Library size={14} className="mr-1" />
                {t("prompts.library")}
                <span className="tabular-nums opacity-80 ml-1">{libraryPrompts.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "mine"}
                className={`ob-tab rounded-lg px-4 py-1.5 text-sm font-medium border-b-0 transition-all ${
                  activeTab === "mine"
                    ? "bg-[var(--ob-accent-soft)] !text-[var(--ob-accent)] shadow-sm"
                    : "bg-transparent hover:text-[var(--ob-ink)]"
                }`}
                onClick={() => setActiveTab("mine")}
              >
                <UserRound size={14} className="mr-1" />
                {t("prompts.mine")}
                <span className="tabular-nums opacity-80 ml-1">{minePrompts.length}</span>
              </button>
            </div>

            <label className="relative min-w-[12rem] flex-1 sm:max-w-sm">
              <span className="sr-only">{t("prompts.search")}</span>
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ob-muted)]"
                aria-hidden
              />
              <input
                className="w-full bg-transparent px-3 py-1.5 pl-9 text-sm text-[var(--ob-ink)] placeholder-[var(--ob-muted)] outline-none transition-all focus:ring-2 focus:ring-[var(--ob-accent)]/30 rounded-xl"
                placeholder={t("prompts.searchPlaceholder")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>

            {activeTab === "library" ? (
              <>
                <div className="h-4 w-px bg-[var(--ob-line)]/80 hidden sm:block mx-1" />
                <select
                  aria-label={t("prompts.sourceFilter")}
                  className="bg-transparent text-sm font-medium text-[var(--ob-ink)] cursor-pointer outline-none hover:text-[var(--ob-accent)] transition-colors pr-1"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  {sources.map((s) => (
                    <option key={s} value={s} className="bg-[var(--ob-panel)]">
                      {s === "all" ? t("prompts.allSources") : s}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t("prompts.tagFilter")}
                  className="bg-transparent text-sm font-medium text-[var(--ob-ink)] cursor-pointer outline-none hover:text-[var(--ob-accent)] transition-colors pr-2"
                  value={tag}
                  onChange={(event) => setTag(event.target.value)}
                >
                  {tags.map((value) => (
                    <option key={value} value={value} className="bg-[var(--ob-panel)]">
                      {value === "all" ? t("prompts.allTags") : value}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            <span className="ml-auto hidden text-xs font-medium text-[var(--ob-muted)] sm:inline pr-2">
              {t("prompts.showing", { count: filtered.length })}
              {(q || source !== "all" || tag !== "all") ? t("prompts.filtered") : ""}
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
                  <h2 className="text-sm font-semibold text-[var(--ob-ink)]">{t("prompts.sourceTitle")}</h2>
                  <p className="text-[11px] text-[var(--ob-muted)]">{t("prompts.sourceDescription")}</p>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-label={t("prompts.manageSources")}
                    className="ob-btn ob-btn-sm"
                    onClick={() => setSourceManagerOpen(true)}
                  >
                    <SlidersHorizontal size={14} /> {t("prompts.manage")}
                  </button>
                  {enabledSources ? (
                    <button
                      type="button"
                      className="ob-btn ob-btn-sm"
                      disabled={busy}
                      onClick={() => void refreshAllRemote()}
                    >
                      <RefreshCw size={14} className={busy ? "animate-spin" : undefined} /> {t("prompts.refreshAll")}
                    </button>
                  ) : null}
                </div>
              </header>

              <div className="grid gap-0 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="border-b border-[var(--ob-line)] p-4 lg:border-b-0 lg:border-r">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--ob-muted)] pl-1">
                    {t("prompts.communityConnect")}
                  </div>
                  <ul className="grid gap-3 sm:grid-cols-2" aria-label={t("prompts.communitySources")}>
                    {COMMUNITY_PROMPT_SOURCE_PRESETS.map((preset) => {
                      const installed = savedSources.some((item) =>
                        item.id === preset.source.id || item.url === preset.source.url);
                      return (
                        <li
                          key={preset.id}
                          className="group/preset flex min-w-0 items-start gap-2.5 rounded-2xl border border-[var(--ob-line)]/60 bg-[var(--ob-canvas)]/30 px-3.5 py-3 transition-all hover:bg-[var(--ob-panel)] hover:shadow-sm"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-bold text-[var(--ob-ink)] group-hover/preset:text-[var(--ob-accent)] transition-colors">{preset.name}</div>
                            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--ob-muted)]">
                              {preset.description}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="ob-btn ob-btn-sm shrink-0 rounded-lg"
                            disabled={busy}
                            onClick={() => void addCommunityPreset(preset.id)}
                          >
                            {installed ? t("common.refresh") : t("prompts.connect")}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <div className="p-4">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--ob-muted)]">
                    {t("prompts.customRemoteSource")}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      className="ob-field min-w-0 flex-1"
                      placeholder={t("prompts.remoteUrlPlaceholder")}
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={t("prompts.fetchRemote")}
                      className="ob-btn-primary ob-btn-sm shrink-0"
                      disabled={busy}
                      onClick={() => void pullRemote()}
                    >
                      {busy ? t("prompts.fetching") : t("prompts.fetch")}
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
                              {sourceConfig.builtIn ? <span className="ob-chip">{t("prompts.builtin")}</span> : null}
                              {!sourceConfig.enabled ? <span className="ob-chip">{t("prompts.disabled")}</span> : null}
                              {sourceConfig.lastError ? (
                                <span
                                  className="rounded-full bg-[color-mix(in_srgb,var(--ob-danger)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ob-danger)]"
                                  title={sourceConfig.lastError}
                                >
                                  {t("prompts.failed")}
                                </span>
                              ) : sourceConfig.lastSuccessAt ? (
                                <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                                  {t("prompts.healthy")}
                                </span>
                              ) : (
                                <span className="ob-chip">{t("prompts.notSynced")}</span>
                              )}
                            </div>
                            <p className="mt-0.5 truncate text-[11px] text-[var(--ob-muted)]">
                              {sourceConfig.homepage || sourceConfig.url}
                              {typeof sourceConfig.itemCount === "number" ? ` · ${t("prompts.items", { count: sourceConfig.itemCount })}` : ""}
                              {sourceConfig.lastSuccessAt
                                ? ` · ${new Date(sourceConfig.lastSuccessAt).toLocaleString(locale)}`
                                : ` · ${t("prompts.neverFetched")}`}
                            </p>
                          </div>
                          <button
                            type="button"
                            title={t("prompts.refreshSource")}
                            className="ob-icon-btn ob-icon-btn-sm"
                            disabled={busy || !sourceConfig.enabled}
                            onClick={() => void refreshRemote(sourceConfig).catch(() => undefined)}
                          >
                            <RefreshCw size={14} />
                          </button>
                          {!sourceConfig.builtIn ? (
                            <button
                              type="button"
                              title={t("prompts.removeSource")}
                              className="ob-btn-danger ob-btn-sm p-1.5"
                              disabled={busy}
                              onClick={() => {
                                if (window.confirm(t("prompts.confirmRemoveSource", { name: sourceConfig.name }))) {
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
                      {t("prompts.noSources")}
                    </p>
                  )}
                </div>
              </div>
            </section>
          ) : null}

          {filtered.length ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((p) => {
                const isLocal = p.source === "local" || p.sourceId === "personal";
                return (
                  <article
                    key={p.id}
                    className="ob-card group flex min-h-[14.5rem] flex-col overflow-hidden p-0 rounded-2xl shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-[var(--ob-accent)]/5 hover:border-[var(--ob-accent-soft)]"
                  >
                    {p.coverUrl ? (
                      <button
                        type="button"
                        className="relative h-32 w-full overflow-hidden border-b border-[var(--ob-line)]/50 bg-[var(--ob-canvas)] text-left"
                        title={t("prompts.viewCover")}
                        aria-label={t("prompts.viewCoverLabel", { title: p.title })}
                        onClick={() => setPreviewImage({ src: p.coverUrl!, alt: p.title })}
                      >
                        <div className="absolute inset-0 z-10 bg-black/5 transition-colors pointer-events-none group-hover:bg-transparent" />
                        <img
                          src={p.coverUrl}
                          alt=""
                          crossOrigin="anonymous"
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                        />
                        <span className="pointer-events-none absolute bottom-2 right-2 z-20 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                          {t("prompts.clickToView")}
                        </span>
                      </button>
                    ) : null}
                    <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-5 relative">
                      <div className="mb-2 flex items-start gap-2">
                        <h3 className="min-w-0 flex-1 truncate text-base font-bold leading-snug text-[var(--ob-ink)] group-hover:text-[var(--ob-accent)] transition-colors">
                          {p.title}
                        </h3>
                        <span className="ob-chip shrink-0 max-w-[7rem] truncate bg-[var(--ob-canvas)] border-[var(--ob-line)]/40 font-medium" title={p.source}>
                          {p.source}
                        </span>
                      </div>
                      <p className="line-clamp-3 flex-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ob-muted)] group-hover:text-[var(--ob-ink)] transition-colors">
                        {p.body}
                      </p>
                      {p.tags.length ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {p.tags.slice(0, 4).map((t) => (
                            <span
                              key={t}
                              className="rounded-full bg-[var(--ob-accent-soft)]/50 border border-[var(--ob-accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ob-accent)] transition-colors group-hover:bg-[var(--ob-accent-soft)]"
                            >
                              {t}
                            </span>
                          ))}
                          {p.tags.length > 4 ? (
                            <span className="ob-chip rounded-full border-none bg-[var(--ob-canvas)]">+{p.tags.length - 4}</span>
                          ) : null}
                        </div>
                      ) : null}
                      
                      {/* Action Bar */}
                      <div className="mt-4 flex items-center gap-1.5 pt-3 border-t border-[var(--ob-line)]/40 transition-all duration-200">
                        <button
                          type="button"
                          aria-label={t("prompts.insertCanvas")}
                          className="ob-btn-primary ob-btn-sm flex-1 rounded-lg h-7"
                          onClick={() => usePrompt(p)}
                        >
                          <SendToBack size={13} /> {t("prompts.insert")}
                        </button>
                        <button
                          type="button"
                          className="ob-btn ob-btn-sm rounded-lg h-7"
                          aria-label={t("prompts.details")}
                          title={t("prompts.details")}
                          onClick={() => setSelectedPrompt(p)}
                        >
                          <Eye size={13} aria-hidden />
                        </button>
                        <button
                          type="button"
                          title={t("prompts.copy")}
                          aria-label={t("prompts.copy")}
                          className="ob-icon-btn ob-icon-btn-sm bg-[var(--ob-canvas)] h-7 w-7"
                          onClick={() => void writeTextWithFallback(p.body).catch(() => undefined)}
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          type="button"
                          title={t("prompts.addAsset")}
                          aria-label={t("prompts.addAsset")}
                          className="ob-icon-btn ob-icon-btn-sm bg-[var(--ob-canvas)] h-7 w-7"
                          onClick={() => void addPromptAsset(p).catch((cause) =>
                            setErr(cause instanceof Error ? cause.message : String(cause)))}
                        >
                          <FilePlus2 size={13} />
                        </button>
                        {isLocal ? (
                          <>
                            <button
                              type="button"
                              className="ob-icon-btn ob-icon-btn-sm bg-[var(--ob-canvas)] h-7 w-7"
                              title={t("prompts.edit")}
                              aria-label={t("prompts.edit")}
                              onClick={() => {
                                setEditingPrompt(p);
                                setEditorMode("edit");
                              }}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              className="ob-btn-danger ob-btn-sm p-1 ml-auto rounded-lg h-7 w-7 flex items-center justify-center"
                              title={t("prompts.delete")}
                              aria-label={t("prompts.delete")}
                              onClick={() => {
                                if (!window.confirm(t("prompts.confirmDelete", { title: p.title }))) return;
                                void (async () => {
                                  try {
                                    const next = structuredClone(
                                      useBoardStore.getState().prompts.filter((prompt) => prompt.id !== p.id),
                                    );
                                    setPrompts(next);
                                    await flushPrompts();
                                  } catch (cause) {
                                    setErr(cause instanceof Error ? cause.message : String(cause));
                                  }
                                })();
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="ob-btn ob-btn-sm ml-auto rounded-lg h-7"
                            onClick={() => void saveToMine(p).catch((cause) =>
                              setErr(cause instanceof Error ? cause.message : String(cause)))}
                          >
                            {t("prompts.saveToMine")}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-5 px-6 py-28 text-center bg-gradient-to-b from-transparent to-[var(--ob-panel)]/30 rounded-3xl border border-dashed border-[var(--ob-line)]/50 mt-8 mx-4">
              <div className="relative grid h-20 w-20 place-items-center rounded-3xl bg-gradient-to-br from-[var(--ob-accent-soft)] to-[var(--ob-canvas)] text-[var(--ob-accent)] shadow-xl shadow-[var(--ob-accent)]/10 ring-1 ring-[var(--ob-line)]/50">
                <div className="absolute inset-0 rounded-3xl bg-[var(--ob-accent)]/20 blur-2xl -z-10" />
                {activeTab === "mine" ? <UserRound size={32} strokeWidth={1.5} /> : <Library size={32} strokeWidth={1.5} />}
              </div>
              <div className="relative z-10">
                <p className="text-xl font-bold text-[var(--ob-ink)] tracking-tight">
                  {activeTab === "mine" ? t("prompts.emptyMine") : t("prompts.emptyLibrary")}
                </p>
                <p className="mt-3 max-w-md text-[15px] leading-relaxed text-[var(--ob-muted)] font-medium">
                  {activeTab === "mine"
                    ? t("prompts.emptyMineDescription")
                    : t("prompts.emptyLibraryDescription")}
                </p>
              </div>
              <div className="mt-2 relative z-10 flex gap-3">
                {activeTab === "library" ? (
                  <>
                    {!sourcesOpen ? (
                      <button type="button" className="ob-btn-primary rounded-xl px-5 py-2.5 font-bold shadow-md shadow-[var(--ob-accent)]/20 transition-transform hover:-translate-y-0.5" onClick={() => setSourcesOpen(true)}>
                        <RefreshCw size={15} className="mr-2" /> {t("prompts.connect")}
                      </button>
                    ) : null}
                    <button type="button" className="ob-btn rounded-xl px-5 py-2.5 font-bold transition-transform hover:-translate-y-0.5" onClick={restoreBuiltinPrompts}>
                      {t("prompts.loadBuiltin")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ob-btn-primary rounded-xl px-5 py-2.5 font-bold shadow-md shadow-[var(--ob-accent)]/20 transition-transform hover:-translate-y-0.5"
                    onClick={() => {
                      setEditingPrompt(null);
                      setCreatingPromptId(uid("prompt"));
                      setEditorMode("create");
                    }}
                  >
                    <Plus size={16} className="-ml-0.5 mr-1" /> {t("prompts.newPrompt")}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <PromptDetailDialog
        prompt={selectedPrompt}
        open={selectedPrompt !== null}
        onClose={() => setSelectedPrompt(null)}
        onPreviewImage={(src, alt) => setPreviewImage({ src, alt })}
        onCopy={() => {
          if (selectedPrompt) void writeTextWithFallback(selectedPrompt.body).catch(() => undefined);
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
      <ImagePreviewDialog
        open={previewImage !== null}
        src={previewImage?.src ?? ""}
        alt={previewImage?.alt ?? t("prompts.imagePreview")}
        onClose={() => setPreviewImage(null)}
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
          if (!window.confirm(t("prompts.confirmRemoveSource", { name: sourceConfig.name }))) return false;
          await removeRemote(sourceConfig);
          return true;
        }}
      /> : null}
    </div>
  );
}
