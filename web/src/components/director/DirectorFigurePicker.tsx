import { useRef, useState, type KeyboardEvent } from "react";
import type { DirectorCharacterPreset, DirectorPosePreset } from "@/types/board";
import {
  DIRECTOR_CHARACTER_PRESETS,
  DIRECTOR_POSE_PRESETS,
} from "@/lib/director-cast";
import { buildDirectorFigurePreview } from "@/lib/director-figure-preview";

function DirectorFigureThumbnail({
  preset,
  pose,
}: {
  preset: DirectorCharacterPreset;
  pose: DirectorPosePreset;
}) {
  const preview = buildDirectorFigurePreview(preset, pose);
  return (
    <svg aria-hidden="true" viewBox="0 0 80 96" className="h-20 w-full overflow-visible">
      <ellipse cx="40" cy="91" rx="19" ry="3" fill="currentColor" opacity="0.12" />
      {preview.limbs.map((limb) => (
        <line
          key={limb.id}
          x1={limb.start.x}
          y1={limb.start.y}
          x2={limb.end.x}
          y2={limb.end.y}
          stroke={preview.color}
          strokeWidth={limb.width}
          strokeLinecap="round"
        />
      ))}
      <rect
        x={preview.torso.x - preview.torso.width / 2}
        y={preview.torso.y - preview.torso.height / 2}
        width={preview.torso.width}
        height={preview.torso.height}
        rx="4"
        fill={preview.color}
        transform={`rotate(${preview.torso.rotation} ${preview.torso.x} ${preview.torso.y})`}
      />
      {preview.accessory === "jacket" ? (
        <path d={`M ${preview.torso.x - 5} ${preview.torso.y - 8} L ${preview.torso.x} ${preview.torso.y + 7} L ${preview.torso.x + 5} ${preview.torso.y - 8}`} fill="none" stroke="white" strokeOpacity=".6" strokeWidth="1.2" />
      ) : null}
      {preview.accessory === "belt" ? (
        <line x1={preview.torso.x - preview.torso.width / 2} x2={preview.torso.x + preview.torso.width / 2} y1={preview.torso.y + 7} y2={preview.torso.y + 7} stroke="white" strokeOpacity=".7" strokeWidth="2" />
      ) : null}
      <circle cx={preview.head.x} cy={preview.head.y} r={preview.head.radius} fill={preview.skinColor} />
      {preview.accessory === "visor" ? (
        <path d={`M ${preview.head.x - preview.head.radius * .8} ${preview.head.y - 1} Q ${preview.head.x} ${preview.head.y + 2} ${preview.head.x + preview.head.radius * .8} ${preview.head.y - 1}`} fill="none" stroke="#67e8f9" strokeWidth="2" />
      ) : null}
    </svg>
  );
}

type PickerOption = {
  id: DirectorCharacterPreset | DirectorPosePreset;
  label: string;
  preset: DirectorCharacterPreset;
  pose: DirectorPosePreset;
};

export function DirectorFigurePicker({
  kind,
  preset,
  pose,
  onPresetChange,
  onPoseChange,
}: {
  kind: "character" | "pose";
  preset: DirectorCharacterPreset;
  pose: DirectorPosePreset;
  onPresetChange: (preset: DirectorCharacterPreset) => void;
  onPoseChange: (pose: DirectorPosePreset) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const options: PickerOption[] = kind === "character"
    ? DIRECTOR_CHARACTER_PRESETS.map((option) => ({ id: option.id, label: option.label, preset: option.id, pose }))
    : DIRECTOR_POSE_PRESETS.map((option) => ({ id: option.id, label: option.label, preset, pose: option.id }));
  const selectedId = kind === "character" ? preset : pose;
  const selected = options.find((option) => option.id === selectedId) ?? options[0]!;
  const title = kind === "character" ? "人物外观" : "动作姿态";

  const select = (option: PickerOption) => {
    if (kind === "character") onPresetChange(option.preset);
    else onPoseChange(option.pose);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const columns = kind === "character" ? 2 : 3;
    const delta = event.key === "ArrowRight" ? 1
      : event.key === "ArrowLeft" ? -1
        : event.key === "ArrowDown" ? columns
          : event.key === "ArrowUp" ? -columns
            : 0;
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
        : Math.max(0, Math.min(options.length - 1, index + delta));
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    itemRefs.current[nextIndex]?.focus();
  };

  return (
    <section aria-label={`${title}选择器`} className="rounded border border-white/10 bg-black/15 p-2">
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded border border-white/10 bg-[#222] p-2 text-left hover:border-lime-200/50 hover:bg-white/10"
        aria-expanded={expanded}
        aria-controls={`director-${kind}-catalog`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="w-16 shrink-0 rounded bg-gradient-to-b from-white/10 to-black/20 px-1 text-slate-300">
          <DirectorFigureThumbnail preset={selected.preset} pose={selected.pose} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] uppercase tracking-wider text-slate-500">{title}</span>
          <span className="mt-1 block truncate font-medium text-slate-100">{selected.label}</span>
          <span className="mt-1 block text-[10px] text-lime-200">{expanded ? "收起目录" : `浏览全部 ${options.length} 项`}</span>
        </span>
      </button>
      {expanded ? (
        <div
          id={`director-${kind}-catalog`}
          role="listbox"
          aria-label={`${title}视觉目录`}
          className={`mt-2 grid max-h-80 gap-1.5 overflow-y-auto pr-1 ${kind === "character" ? "grid-cols-2" : "grid-cols-3"}`}
        >
          {options.map((option, index) => (
            <button
              key={option.id}
              ref={(element) => { itemRefs.current[index] = element; }}
              type="button"
              role="option"
              aria-selected={option.id === selectedId}
              aria-label={`选择${title} ${option.label}`}
              tabIndex={option.id === selectedId ? 0 : -1}
              className="group rounded border border-white/10 bg-[#202020] p-1 text-center text-[10px] text-slate-300 hover:border-lime-200/60 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-200 aria-selected:border-lime-200 aria-selected:bg-lime-200/10 aria-selected:text-lime-100"
              onClick={() => select(option)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <DirectorFigureThumbnail preset={option.preset} pose={option.pose} />
              <span className="block truncate px-1 pb-1">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
