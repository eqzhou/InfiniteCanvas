import { useMemo, useRef, useState } from "react";
import { FileUp, Plus, Save, Send } from "lucide-react";

import { preflightFilmImport } from "@/lib/film-import";
import { filmEditorKey } from "@/lib/film-drafts";
import type { FilmCapabilities, FilmStatus } from "@/services/film-client";
import type { FilmAsset, FilmAssetKind, FilmDocument } from "@/types/film";
import { WorkbenchSection } from "./WorkbenchSection";

export function ManuscriptPanel({ document, capabilities, manuscript, busy, onDraft, onImportText, onImportFile }: {
  document: FilmDocument; capabilities: FilmCapabilities; manuscript: string; busy: boolean;
  onDraft: (text: string) => void;
  onImportText: (text: string, format: "text" | "txt" | "markdown", originalName?: string) => Promise<boolean>;
  onImportFile: (file: File, format: "docx" | "pdf") => Promise<boolean>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parseState, setParseState] = useState<"idle" | "parsing" | "error">("idle");
  const [fileError, setFileError] = useState("");
  const formats = [
    ["txt", "TXT", capabilities.plainTextImport], ["md", "MD", capabilities.markdownImport],
    ["docx", "DOCX", capabilities.docxImport], ["pdf", "PDF", capabilities.pdfImport],
  ] as const;
  const accept = useMemo(() => formats.filter(([, , enabled]) => enabled).map(([extension]) => `.${extension}`).join(","), [capabilities]);
  const chooseFile = async (file: File) => {
    setFileError("");
    setParseState("parsing");
    try {
      const result = preflightFilmImport(file, capabilities);
      let ok = false;
      if (result.format === "txt" || result.format === "markdown") {
        const text = await file.text();
        if (!text.trim()) throw new Error("剧本文件没有可导入的文本");
        onDraft(text);
        ok = await onImportText(text, result.format, file.name);
      } else {
        ok = await onImportFile(file, result.format);
      }
      setParseState(ok ? "idle" : "error");
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : String(cause));
      setParseState("error");
    }
  };
  return <WorkbenchSection id="manuscript" title="原稿导入 / Manuscript">
    <label className="block text-sm font-medium" htmlFor="film-manuscript">粘贴剧本原稿</label>
    <textarea id="film-manuscript" className="ob-input mt-2 min-h-52 w-full resize-y font-mono text-sm" value={manuscript} onChange={(event) => onDraft(event.target.value)} placeholder="EPISODE 1&#10;INT. STUDIO - DAY&#10;A slate snaps shut." />
    <div className="mt-2 flex flex-wrap gap-1" aria-label="可用导入格式">
      {formats.map(([id, label, enabled]) => <span key={id} data-testid={`film-format-${id}`} aria-disabled={!enabled} className={`rounded-full border px-2 py-1 text-xs ${enabled ? "border-[var(--ob-line)]" : "opacity-40"}`}>{label}</span>)}
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="ob-btn ob-btn-primary" disabled={busy || !manuscript.trim()} onClick={() => void onImportText(manuscript, "text")}><Send size={14} /> 导入并拆解</button>
      <button type="button" className="ob-btn" disabled={busy || !accept} onClick={() => fileRef.current?.click()}><FileUp size={14} /> 选择 TXT / MD / DOCX / PDF</button>
      <input data-testid="film-manuscript-file" ref={fileRef} type="file" className="hidden" accept={accept} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void chooseFile(file); event.currentTarget.value = ""; }} />
    </div>
    {parseState === "parsing" ? <p role="status" className="mt-2 text-sm text-[var(--ob-muted)]">文件上传中，正在解析…</p> : null}
    {fileError ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{fileError}</p> : null}
    <p className="mt-2 text-xs text-[var(--ob-muted)]">客户端预检上限 50 MiB；扫描型 PDF 若无文本，请先 OCR 后再导入。当前源修订 r{document.source.revision}</p>
  </WorkbenchSection>;
}

function AssetEditor({ asset, characters, busy, onSave }: { asset: FilmAsset; characters: FilmAsset[]; busy: boolean; onSave: (asset: FilmAsset, patch: Partial<FilmAsset>) => void }) {
  const [title, setTitle] = useState(asset.title);
  const [description, setDescription] = useState(asset.description);
  const [detail, setDetail] = useState(asset.stylePrompt ?? asset.voice ?? "");
  const [parentAssetId, setParent] = useState(asset.parentAssetId ?? "");
  const [ageStage, setAgeStage] = useState(asset.ageStage ?? "");
  const [costume, setCostume] = useState(asset.costume ?? "");
  const [storyPeriod, setStoryPeriod] = useState(asset.storyPeriod ?? "");
  const [isDefault, setIsDefault] = useState(asset.isDefault ?? false);
  return <li data-testid={`film-asset-${asset.id}`} data-revision={asset.revision} className="rounded-lg border border-[var(--ob-line)] p-3">
    <div className="mb-2 flex items-center justify-between"><strong className="text-xs uppercase tracking-wide">{asset.kind}</strong><span className="text-xs text-[var(--ob-muted)]">r{asset.revision}</span></div>
    <input aria-label="资产名称编辑" className="ob-input w-full" value={title} onChange={(event) => setTitle(event.target.value)} />
    <textarea aria-label="资产描述" className="ob-input mt-2 min-h-20 w-full" value={description} onChange={(event) => setDescription(event.target.value)} />
    {asset.kind === "style" || asset.kind === "voice" ? <input aria-label={asset.kind === "style" ? "风格提示" : "声音身份"} className="ob-input mt-2 w-full" value={detail} onChange={(event) => setDetail(event.target.value)} /> : null}
    {asset.kind === "identity" ? <div className="mt-2 grid gap-2 sm:grid-cols-2"><select aria-label="所属角色" className="ob-input" value={parentAssetId} onChange={(event) => setParent(event.target.value)}><option value="">未绑定角色</option>{characters.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><input aria-label="年龄阶段" className="ob-input" value={ageStage} onChange={(event) => setAgeStage(event.target.value)} placeholder="年龄阶段" /><input aria-label="长期造型" className="ob-input" value={costume} onChange={(event) => setCostume(event.target.value)} placeholder="服装 / 长期造型" /><input aria-label="剧情时期" className="ob-input" value={storyPeriod} onChange={(event) => setStoryPeriod(event.target.value)} placeholder="剧情时期" /><label className="text-xs"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} /> 默认身份</label></div> : null}
    <button type="button" className="ob-btn mt-2" disabled={busy || !title.trim()} onClick={() => onSave(asset, { title, description, parentAssetId, ...(asset.kind === "style" ? { stylePrompt: detail } : {}), ...(asset.kind === "voice" ? { voice: detail } : {}), ...(asset.kind === "identity" ? { ageStage, costume, storyPeriod, isDefault } : {}) })}><Save size={14} /> 保存资产</button>
  </li>;
}

export function AssetsPanel({ status, busy, onCreate, onSave }: { status: FilmStatus; busy: boolean; onCreate: (input: { kind: FilmAssetKind; title: string; parentAssetId?: string }) => void; onSave: (asset: FilmAsset, patch: Partial<FilmAsset>) => void }) {
  const [kind, setKind] = useState<FilmAssetKind>("character");
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState("");
  const characters = status.document.assets.filter((asset) => asset.kind === "character");
  return <WorkbenchSection id="assets" title="资产、风格与身份版本 / Assets">
    <form className="grid gap-2 sm:grid-cols-[130px_1fr_auto]" onSubmit={(event) => { event.preventDefault(); if (!title.trim()) return; onCreate({ kind, title: title.trim(), ...(kind === "identity" && parent ? { parentAssetId: parent } : {}) }); setTitle(""); }}>
      <select aria-label="资产类型" className="ob-input" value={kind} onChange={(event) => setKind(event.target.value as FilmAssetKind)}>{["character", "identity", "location", "prop", "style", "voice"].map((item) => <option key={item} value={item}>{item}</option>)}</select>
      <input aria-label="资产名称" className="ob-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="角色、身份版本或风格名称" />
      <button className="ob-btn" disabled={busy || !title.trim()}><Plus size={14} /> 添加资产</button>
      {kind === "identity" ? <select aria-label="新身份所属角色" className="ob-input sm:col-span-2" value={parent} onChange={(event) => setParent(event.target.value)}><option value="">选择角色</option>{characters.map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select> : null}
    </form>
    <ul className="mt-4 grid gap-2 sm:grid-cols-2">{status.document.assets.map((asset) => <AssetEditor key={filmEditorKey(asset.id, asset.revision)} asset={asset} characters={characters} busy={busy} onSave={onSave} />)}</ul>
  </WorkbenchSection>;
}
