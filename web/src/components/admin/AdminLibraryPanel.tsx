import { useCallback, useEffect, useRef, useState } from "react";
import {
  createLibraryAsset,
  deleteLibraryAsset,
  listLibraryAssets,
  updateLibraryAsset,
  type LibraryAsset,
  type LibraryAssetKind,
} from "@/services/library-assets";

const KIND_LABELS: Record<LibraryAssetKind, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
};

const EMPTY_DRAFT = { id: "", kind: "text" as LibraryAssetKind, title: "", tags: "", content: "", source: "", notes: "" };

/**
 * Server material library management inside the admin console. The same CRUD
 * API also powers the reader-facing page; authorization stays server-side, so
 * this panel only decides what to show.
 */
export function AdminLibraryPanel() {
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | LibraryAssetKind>("all");
  const [tag, setTag] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Monotonic request id: a slow earlier response must never overwrite the
  // result of a newer filter.
  const requestIdRef = useRef(0);
  const mutationBusyRef = useRef(false);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      setError("");
      const page = await listLibraryAssets({ q, kind, tag, pageSize: 100 });
      if (requestId !== requestIdRef.current) return;
      setItems(page.items);
      setTotal(page.total);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setItems([]);
      setTotal(0);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [q, kind, tag]);

  useEffect(() => { void load(); }, [load]);

  // A filter change invalidates whatever is still in flight.
  useEffect(() => () => { requestIdRef.current += 1; }, []);

  const perform = async (action: () => Promise<unknown>) => {
    if (mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    setSaving(true);
    try {
      setError("");
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      mutationBusyRef.current = false;
      setSaving(false);
    }
  };

  const save = () => void perform(async () => {
    const input = {
      kind: draft.kind,
      title: draft.title.trim(),
      tags: draft.tags.split(",").map((value) => value.trim()).filter(Boolean),
      content: draft.content.trim() || undefined,
      source: draft.source.trim() || undefined,
      notes: draft.notes.trim() || undefined,
    };
    if (editing && draft.id) await updateLibraryAsset(draft.id, input);
    else await createLibraryAsset(input);
    setDraft(EMPTY_DRAFT);
    setEditing(false);
  });

  return (
    <div className="space-y-4" aria-busy={loading || saving}>
      {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}

      <div className="grid gap-2 md:grid-cols-3">
        <input className="ob-field" aria-label="搜索素材" placeholder="按标题或来源搜索" value={q} disabled={saving} onChange={(event) => setQ(event.target.value)} />
        <select className="ob-field" aria-label="按类型筛选素材" value={kind} disabled={saving} onChange={(event) => setKind(event.target.value as "all" | LibraryAssetKind)}>
          <option value="all">全部类型</option>
          {(Object.keys(KIND_LABELS) as LibraryAssetKind[]).map((value) => (
            <option key={value} value={value}>{KIND_LABELS[value]}</option>
          ))}
        </select>
        <input className="ob-field" aria-label="按标签筛选素材" placeholder="标签筛选" value={tag} disabled={saving} onChange={(event) => setTag(event.target.value)} />
      </div>

      <section className="space-y-2 rounded-xl border border-[var(--ob-line)] p-3">
        <h2 className="font-semibold">{editing ? "编辑素材" : "新增素材"}</h2>
        <fieldset className="contents" disabled={saving}>
        <div className="grid gap-2 md:grid-cols-2">
          <select className="ob-field" aria-label="素材类型" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as LibraryAssetKind })}>
            {(Object.keys(KIND_LABELS) as LibraryAssetKind[]).map((value) => (
              <option key={value} value={value}>{KIND_LABELS[value]}</option>
            ))}
          </select>
          <input className="ob-field" aria-label="素材标题" placeholder="标题" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          <input className="ob-field" aria-label="素材标签" placeholder="标签，逗号分隔" value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
          <input className="ob-field" aria-label="素材来源" placeholder="来源" value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} />
          <textarea className="ob-field min-h-20 md:col-span-2" aria-label="素材内容" placeholder="文本内容或媒体 URL" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
          <textarea className="ob-field min-h-16 md:col-span-2" aria-label="素材备注" placeholder="备注" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
        </div>
        <div className="flex gap-2">
          <button type="button" className="ob-btn ob-btn-primary" disabled={saving || !draft.title.trim()} onClick={save}>
            {saving ? "保存中…" : editing ? "保存素材" : "新增素材"}
          </button>
          {editing ? (
            <button type="button" className="ob-btn" disabled={saving} onClick={() => { setDraft(EMPTY_DRAFT); setEditing(false); }}>取消编辑</button>
          ) : null}
        </div>
        </fieldset>
      </section>

      <p className="text-xs text-[var(--ob-muted)]">共 {total} 条，当前显示 {items.length} 条。</p>
      <div className="space-y-1">
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-2 rounded-lg border border-[var(--ob-line)] p-2">
            <span className="min-w-0 flex-1">
              <b>{item.title}</b>
              <span className="block text-xs text-[var(--ob-muted)]">
                {KIND_LABELS[item.kind]}{item.tags.length ? ` · ${item.tags.join("、")}` : ""}{item.source ? ` · ${item.source}` : ""}
              </span>
            </span>
            <button type="button" className="ob-btn" disabled={saving} onClick={() => {
              setDraft({
                id: item.id, kind: item.kind, title: item.title, tags: item.tags.join(", "),
                content: item.content ?? "", source: item.source ?? "", notes: item.notes ?? "",
              });
              setEditing(true);
            }}>编辑</button>
            <button type="button" className="ob-btn text-[var(--ob-danger)]" disabled={saving} aria-label={`删除素材 ${item.title}`} onClick={() => {
              if (!window.confirm(`确认删除素材「${item.title}」？`)) return;
              void perform(() => deleteLibraryAsset(item.id));
            }}>删除</button>
          </div>
        ))}
        {loading
          ? <p className="text-sm text-[var(--ob-muted)]">加载中…</p>
          : items.length ? null : <p className="text-sm text-[var(--ob-muted)]">没有匹配的素材。</p>}
      </div>
    </div>
  );
}
