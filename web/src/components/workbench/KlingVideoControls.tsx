import { Minus, Plus } from "lucide-react";
import type { KlingShotType, KlingVideoElement, KlingVideoMode, KlingVideoShot } from "@/lib/kling-video";

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
      <legend className="px-1 text-xs font-semibold text-[var(--ob-muted)]">Kling 专属参数</legend>
      <label className="block"><span className="ob-label">负面提示词</span><textarea className="ob-field min-h-20 resize-y" maxLength={2500} value={value.negativePrompt} onChange={(e) => update({ negativePrompt: e.target.value })} /></label>
      <label className="block"><span className="ob-label">生成模式</span><select className="ob-field" value={value.mode} onChange={(e) => update({ mode: e.target.value as KlingVideoMode })}><option value="std">std · 720p</option><option value="pro">pro · 1080p</option>{isV3 ? <option value="4k">4K</option> : null}</select></label>
      {isV3 ? <>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.multiShot} onChange={(e) => update({ multiShot: e.target.checked })} />多镜头</label>
        {value.multiShot ? <>
          <select className="ob-field" aria-label="镜头拆分方式" value={value.shotType} onChange={(e) => update({ shotType: e.target.value as KlingShotType })}><option value="intelligence">智能拆分</option><option value="customize">自定义镜头</option></select>
          {value.shotType === "customize" ? <div className="space-y-2">{value.shots.map((shot, index) => <div key={index} className="grid grid-cols-[1fr_5rem_2rem] gap-2"><input className="ob-field" maxLength={512} placeholder={`镜头 ${index + 1} 提示词`} value={shot.prompt} onChange={(e) => updateShot(index, { prompt: e.target.value })} /><input className="ob-field" type="number" min={1} max={15} aria-label={`镜头 ${index + 1} 秒数`} value={shot.duration} onChange={(e) => updateShot(index, { duration: Number(e.target.value) })} /><button type="button" className="ob-icon-btn" aria-label={`删除镜头 ${index + 1}`} onClick={() => update({ shots: value.shots.filter((_, offset) => offset !== index).map((item, offset) => ({ ...item, index: offset + 1 })) })}><Minus size={13} /></button></div>)}<button type="button" className="ob-btn" disabled={value.shots.length >= 6} onClick={() => update({ shots: [...value.shots, { index: value.shots.length + 1, prompt: "", duration: 1 }] })}><Plus size={13} />添加镜头</button></div> : null}
        </> : null}
        <div className="space-y-2"><div className="ob-label">参考元素（2-4 个公开 HTTPS 图片 URL）</div>{value.elements.map((element, index) => <div key={index} className="space-y-1 rounded-lg border border-[var(--ob-line)] p-2"><div className="grid grid-cols-[1fr_2rem] gap-2"><input className="ob-field" maxLength={64} placeholder="元素名称，如 CharacterA" value={element.name} onChange={(e) => updateElement(index, { name: e.target.value })} /><button type="button" className="ob-icon-btn" aria-label={`删除元素 ${index + 1}`} onClick={() => update({ elements: value.elements.filter((_, offset) => offset !== index) })}><Minus size={13} /></button></div><input className="ob-field" maxLength={1000} placeholder="元素描述" value={element.description} onChange={(e) => updateElement(index, { description: e.target.value })} /><textarea className="ob-field min-h-16" placeholder="每行一个图片 URL" value={element.imageUrls.join("\n")} onChange={(e) => updateElement(index, { imageUrls: e.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) })} /></div>)}<button type="button" className="ob-btn" disabled={value.elements.length >= 3} onClick={() => update({ elements: [...value.elements, { name: "", description: "", imageUrls: [] }] })}><Plus size={13} />添加元素</button></div>
      </> : null}
    </fieldset>
  );
}
