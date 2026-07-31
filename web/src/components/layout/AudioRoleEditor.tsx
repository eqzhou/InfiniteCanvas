import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { uid } from "@/lib/id";
import { audioVoiceLabel, audioVoiceOptions, defaultAudioVoice } from "@/lib/audio-provider";
import type { AiProtocol, AudioRolePreset } from "@/types/board";

export function applyAudioRoleNameDraft(
  roles: readonly AudioRolePreset[],
  id: string,
  draft: string,
): AudioRolePreset[] | null {
  const name = draft.trim().slice(0, 80);
  if (!name) return null;
  return roles.map((role) => role.id === id
    ? { ...role, name, voices: { ...role.voices } }
    : { ...role, voices: { ...role.voices } });
}

export function AudioRoleEditor({
  roles,
  protocol,
  disabled = false,
  onChange,
}: {
  roles: readonly AudioRolePreset[];
  protocol: AiProtocol;
  disabled?: boolean;
  onChange: (roles: AudioRolePreset[]) => void;
}) {
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const voices = audioVoiceOptions(protocol);
  const update = (id: string, patch: Partial<AudioRolePreset>) => {
    onChange(roles.map((role) => role.id === id ? { ...role, ...patch } : { ...role, voices: { ...role.voices } }));
  };
  const updateVoice = (role: AudioRolePreset, voice: string) => {
    update(role.id, { voices: { ...role.voices, [protocol]: voice } });
  };
  const updateNameDraft = (id: string, draft: string) => {
    setNameDrafts((current) => ({ ...current, [id]: draft }));
    const next = applyAudioRoleNameDraft(roles, id, draft);
    if (next) onChange(next);
  };
  const finishNameDraft = (id: string) => {
    setNameDrafts((current) => Object.fromEntries(
      Object.entries(current).filter(([roleID]) => roleID !== id),
    ));
  };
  return (
    <div className="space-y-2 rounded-xl border border-[var(--ob-line)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--ob-ink)]">多角色配音</p>
          <p className="text-xs text-[var(--ob-muted)]">角色只属于当前画布项目；每个音频服务可映射到不同声线。</p>
        </div>
        <button
          type="button"
          className="ob-btn"
          disabled={disabled || roles.length >= 32}
          onClick={() => onChange([...roles.map((role) => ({ ...role, voices: { ...role.voices } })), {
            id: uid("role"), name: `角色 ${roles.length + 1}`, voices: { [protocol]: defaultAudioVoice(protocol) },
          }])}
        ><Plus size={14} />添加角色</button>
      </div>
      {roles.length === 0 ? <p className="text-xs text-[var(--ob-muted)]">尚未添加角色；音频节点将使用默认声音。</p> : null}
      {roles.map((role) => {
        const current = role.voices[protocol] ?? defaultAudioVoice(protocol);
        const options = voices.includes(current as never) ? voices : [current, ...voices];
        const name = nameDrafts[role.id] ?? role.name;
        const nameEmpty = !name.trim();
        return (
          <div key={role.id} className="grid gap-2 sm:grid-cols-[minmax(120px,0.8fr)_minmax(220px,1.4fr)_40px]">
            <input
              className={`ob-field ${nameEmpty ? "!border-[var(--ob-danger)]" : ""}`}
              aria-label={`${role.name}角色名称`}
              aria-invalid={nameEmpty}
              title={nameEmpty ? "角色名称不能为空；继续输入即可保存" : undefined}
              maxLength={80}
              disabled={disabled}
              value={name}
              onChange={(event) => updateNameDraft(role.id, event.target.value)}
              onBlur={() => finishNameDraft(role.id)}
            />
            <select
              className="ob-field"
              aria-label={`${role.name}声线`}
              disabled={disabled}
              value={current}
              onChange={(event) => updateVoice(role, event.target.value)}
            >
              {options.map((voice) => <option key={voice} value={voice}>{audioVoiceLabel(voice)}</option>)}
            </select>
            <button
              type="button"
              className="ob-icon-btn"
              aria-label={`删除角色 ${role.name}`}
              disabled={disabled}
              onClick={() => onChange(roles.filter((item) => item.id !== role.id).map((item) => ({ ...item, voices: { ...item.voices } })))}
            ><Trash2 size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}
