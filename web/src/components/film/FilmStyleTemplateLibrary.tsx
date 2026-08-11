import { Copy, Palette, Plus } from "lucide-react";

import { FILM_STYLE_TEMPLATES } from "@/services/film-style-templates";
import type { FilmStyleTemplate } from "@/types/film";
import { WorkbenchSection } from "./WorkbenchSection";

export function FilmStyleTemplateLibrary({ busy, onApply, onCopy }: {
  busy: boolean;
  onApply: (template: FilmStyleTemplate) => void;
  onCopy: (template: FilmStyleTemplate) => void;
}) {
  return <WorkbenchSection id="style-templates" title="原创影视风格参考库" wide>
    <div aria-label="原创影视风格参考模板">
      <p className="mb-4 text-sm text-[var(--ob-muted)]">模板由 OpenBoard 独立设计。应用后会创建项目内的风格资产，后续镜头继续使用现有资产绑定、版本和任务链路。</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {FILM_STYLE_TEMPLATES.map((template) => <article key={template.id} data-testid={`film-style-template-${template.id}`} className="flex min-w-0 flex-col rounded-xl border border-[var(--ob-line)] bg-[var(--ob-canvas)] p-4">
          <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]"><Palette aria-hidden="true" size={18} /></span><div className="min-w-0"><h3 className="font-medium">{template.title}</h3><p className="mt-1 text-xs text-[var(--ob-muted)]">{template.aspectRatio} · {template.cameraLanguage}</p></div></div>
          <p className="mt-3 flex-1 text-sm leading-6">{template.description}</p>
          <div className="mt-3 flex gap-1" aria-label={`${template.title} 色板`}>{template.palette.map((color) => <span key={color} className="h-5 flex-1 rounded-sm border border-black/10" style={{ backgroundColor: color }}><span className="sr-only">{color}</span></span>)}</div>
          <p className="mt-3 line-clamp-3 text-xs text-[var(--ob-muted)]">{template.stylePrompt}</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button type="button" className="ob-btn min-h-10 focus-visible:outline-2 focus-visible:outline-offset-2" disabled={busy} aria-label={`应用${template.title}到当前项目`} onClick={() => onApply(template)}><Plus aria-hidden="true" size={14} />应用到当前项目</button>
            <button type="button" className="ob-btn min-h-10 focus-visible:outline-2 focus-visible:outline-offset-2" disabled={busy} aria-label={`复制${template.title}为影视项目`} onClick={() => onCopy(template)}><Copy aria-hidden="true" size={14} />复制为影视项目</button>
          </div>
        </article>)}
      </div>
    </div>
  </WorkbenchSection>;
}
