import { Minus, Plus } from "lucide-react";
import type { KlingShotType, KlingVideoElement, KlingVideoMode, KlingVideoShot } from "@/lib/kling-video";
import { useI18n } from "@/i18n/I18nProvider";

export type KlingWorkbenchOptions = {
  negativePrompt: string;
  mode: KlingVideoMode;
  multiShot: boolean;
  shotType: KlingShotType;
  shots: KlingVideoShot[];
  elements: KlingVideoElement[];
};

export function KlingVideoControls({
  model,
  value,
  onChange,
}: {
  model: string;
  value: KlingWorkbenchOptions;
  onChange: (value: KlingWorkbenchOptions) => void;
}) {
  const { t } = useI18n();
  const isV3 = model.trim().toLowerCase() === "kling-v3";
  const update = (patch: Partial<KlingWorkbenchOptions>) => onChange({ ...value, ...patch });
  const updateShot = (index: number, patch: Partial<KlingVideoShot>) => update({
    shots: value.shots.map((shot, offset) => offset === index ? { ...shot, ...patch } : shot),
  });
  const updateElement = (index: number, patch: Partial<KlingVideoElement>) => update({
    elements: value.elements.map((element, offset) => offset === index ? { ...element, ...patch } : element),
  });
  return (
    <fieldset className="col-span-2 space-y-3 rounded-xl border border-[var(--ob-line)] p-3">
      <legend className="px-1 text-xs font-semibold text-[var(--ob-muted)]">{t("kling.panelTitle")}</legend>
      <label className="block"><span className="ob-label">{t("kling.negativePrompt")}</span><textarea className="ob-field min-h-20 resize-y" maxLength={2500} value={value.negativePrompt} onChange={(e) => update({ negativePrompt: e.target.value })} /></label>
      <label className="block"><span className="ob-label">{t("kling.mode")}</span><select className="ob-field" value={value.mode} onChange={(e) => update({ mode: e.target.value as KlingVideoMode })}><option value="std">std · 720p</option><option value="pro">pro · 1080p</option>{isV3 ? <option value="4k">4K</option> : null}</select></label>
      {isV3 ? <>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.multiShot} onChange={(e) => update({ multiShot: e.target.checked })} />{t("kling.multiShot")}</label>
        {value.multiShot ? <>
          <select className="ob-field" aria-label={t("kling.shotType")} value={value.shotType} onChange={(e) => update({ shotType: e.target.value as KlingShotType })}><option value="intelligence">{t("kling.intelligence")}</option><option value="customize">{t("kling.customize")}</option></select>
          {value.shotType === "customize" ? <div className="space-y-2">{value.shots.map((shot, index) => <div key={index} className="grid grid-cols-[1fr_5rem_2rem] gap-2"><input className="ob-field" maxLength={512} placeholder={t("kling.shotPrompt", { index: index + 1 })} value={shot.prompt} onChange={(e) => updateShot(index, { prompt: e.target.value })} /><input className="ob-field" type="number" min={1} max={15} aria-label={t("kling.shotSeconds", { index: index + 1 })} value={shot.duration} onChange={(e) => updateShot(index, { duration: Number(e.target.value) })} /><button type="button" className="ob-icon-btn" aria-label={t("kling.deleteShot", { index: index + 1 })} onClick={() => update({ shots: value.shots.filter((_, offset) => offset !== index).map((item, offset) => ({ ...item, index: offset + 1 })) })}><Minus size={13} /></button></div>)}<button type="button" className="ob-btn" disabled={value.shots.length >= 6} onClick={() => update({ shots: [...value.shots, { index: value.shots.length + 1, prompt: "", duration: 1 }] })}><Plus size={13} />{t("kling.addShot")}</button></div> : null}
        </> : null}
        <div className="space-y-2"><div className="ob-label">{t("kling.elements")}</div>{value.elements.map((element, index) => <div key={index} className="space-y-1 rounded-lg border border-[var(--ob-line)] p-2"><div className="grid grid-cols-[1fr_2rem] gap-2"><input className="ob-field" maxLength={64} placeholder={t("kling.elementName")} value={element.name} onChange={(e) => updateElement(index, { name: e.target.value })} /><button type="button" className="ob-icon-btn" aria-label={t("kling.deleteElement", { index: index + 1 })} onClick={() => update({ elements: value.elements.filter((_, offset) => offset !== index) })}><Minus size={13} /></button></div><input className="ob-field" maxLength={1000} placeholder={t("kling.elementDescription")} value={element.description} onChange={(e) => updateElement(index, { description: e.target.value })} /><textarea className="ob-field min-h-16" placeholder={t("kling.elementUrls")} value={element.imageUrls.join("\n")} onChange={(e) => updateElement(index, { imageUrls: e.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) })} /></div>)}<button type="button" className="ob-btn" disabled={value.elements.length >= 3} onClick={() => update({ elements: [...value.elements, { name: "", description: "", imageUrls: [] }] })}><Plus size={13} />{t("kling.addElement")}</button></div>
      </> : null}
    </fieldset>
  );
}
