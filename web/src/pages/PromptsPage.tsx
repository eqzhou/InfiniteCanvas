import { useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import type { PromptItem } from "@/types/board";
import { nowIso, uid } from "@/lib/id";
import { fetchPromptSource } from "@/services/prompt-sources";
import { PromptDetailDialog } from "@/components/prompts/PromptDetailDialog";
import { Eye } from "lucide-react";
import { useNavigate } from "react-router-dom";

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
  const setAssets = useBoardStore((s) => s.setAssets);
  const config = useBoardStore((s) => s.config);
  const setConfig = useBoardStore((s) => s.setConfig);
  const [q, setQ] = useState("");
  const [source, setSource] = useState("all");
  const [remoteUrl, setRemoteUrl] = useState(
    config.promptSources?.[0] ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptItem | null>(null);

  // Keep a fresh deployment empty. Built-in examples are opt-in via the
  // explicit restore action below, so demo content never appears silently.
  const all = prompts;
  const filtered = useMemo(() => {
    return all.filter((p) => {
      if (source !== "all" && p.source !== source) return false;
      if (!q.trim()) return true;
      const s = q.toLowerCase();
      return (
        p.title.toLowerCase().includes(s) ||
        p.body.toLowerCase().includes(s) ||
        p.tags.some((t) => t.toLowerCase().includes(s))
      );
    });
  }, [all, q, source]);

  const sources = useMemo(
    () => ["all", ...Array.from(new Set(all.map((p) => p.source)))],
    [all],
  );

  const pullRemote = async () => {
    if (!remoteUrl.trim()) {
      alert("请填写远程提示词源 URL（JSON 数组或 Markdown）");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const items = await fetchPromptSource(remoteUrl.trim());
      if (!items.length) throw new Error("未解析到提示词");
      const latest = useBoardStore.getState();
      // merge by title+body
      const key = (p: PromptItem) => `${p.title}::${p.body}`;
      const map = new Map<string, PromptItem>();
      for (const p of [...items, ...latest.prompts]) map.set(key(p), p);
      setPrompts([...map.values()]);
      const sources = Array.from(
        new Set([...(latest.config.promptSources ?? []), remoteUrl.trim()]),
      );
      setConfig({ ...latest.config, promptSources: sources });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addPromptAsset = (prompt: PromptItem) => {
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

  return (
    <div className="mx-auto h-full max-w-6xl overflow-auto p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">提示词库</h1>
        <input
          className="w-full rounded-md border border-[var(--ob-line)] bg-transparent px-3 py-1.5 text-sm sm:ml-auto sm:w-auto"
          placeholder="搜索标题/标签…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5 text-sm"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded-md border border-[var(--ob-line)] px-3 py-1.5 text-sm"
          onClick={() => setPrompts(BUILTIN)}
        >
          恢复内置
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-3">
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
        {err ? <p className="w-full text-sm text-[var(--ob-danger)]">{err}</p> : null}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {filtered.map((p) => (
          <article
            key={p.id}
            className="rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-4"
          >
            <div className="mb-1 flex items-center gap-2">
              <h3 className="font-medium">{p.title}</h3>
              <span className="text-xs text-[var(--ob-muted)]">{p.source}</span>
            </div>
            <p className="text-sm text-[var(--ob-muted)]">{p.body}</p>
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
            <div className="mt-3 flex gap-2 text-sm">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-[var(--ob-line)] px-2 py-1"
                onClick={() => setSelectedPrompt(p)}
              >
                <Eye size={14} /> 详情
              </button>
              <button
                type="button"
                className="rounded border border-[var(--ob-line)] px-2 py-1"
                onClick={() => void navigator.clipboard.writeText(p.body)}
              >
                复制
              </button>
              <button
                type="button"
                className="rounded border border-[var(--ob-line)] px-2 py-1"
                onClick={() => addPromptAsset(p)}
              >
                加入素材
              </button>
            </div>
          </article>
        ))}
      </div>
      {!filtered.length ? (
        <p className="py-10 text-center text-sm text-[var(--ob-muted)]">
          暂无提示词。可以恢复内置示例，或拉取远程提示词源。
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
          if (selectedPrompt) addPromptAsset(selectedPrompt);
        }}
        onInsert={() => {
          if (!selectedPrompt) return;
          insertPrompt(selectedPrompt);
          setSelectedPrompt(null);
          navigate("/");
        }}
      />
    </div>
  );
}
