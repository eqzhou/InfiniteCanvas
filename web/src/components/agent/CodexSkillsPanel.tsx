import { useCallback, useEffect, useMemo, useState } from "react";
import { Play, RefreshCw, Save, Sparkles, Trash2, X } from "lucide-react";
import {
  createCodexSkill,
  deleteCodexSkill,
  getCodexSkill,
  invokeCodexSkill,
  listCodexSkills,
  toggleCodexSkill,
  updateCodexSkill,
  type AgentConnection,
  type CodexSkill,
} from "@/services/local-agent";
import {
  boardContextForCodexSkill,
  buildCodexSkillDraft,
  buildCodexSkillInvocationPrompt,
} from "@/services/codex-skills";
import { useBoardStore } from "@/stores/use-board-store";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator } from "@/i18n/messages/agent-help";

const SKILLS_CHANNEL = "openboard.codex.skills.v1";

type CodexSkillsPanelProps = Readonly<{
  connection: AgentConnection;
  canInvoke: boolean;
  onInvoke: (prompt: string) => Promise<void> | void;
}>;

function replaceSkill(skills: readonly CodexSkill[], next: CodexSkill): CodexSkill[] {
  return skills.map((skill) => skill.id === next.id ? next : skill);
}

export function CodexSkillsPanel({ connection, canInvoke, onInvoke }: CodexSkillsPanelProps) {
  const { locale, t: baseT } = useI18n();
  const t = useMemo(() => createAgentHelpTranslator(baseT, locale), [baseT, locale]);
  const project = useBoardStore((state) => state.getActive());
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<CodexSkill[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [skillId, setSkillId] = useState("");
  const [content, setContent] = useState("");
  const [version, setVersion] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selected = useMemo(() => skills.find((skill) => skill.id === selectedId), [selectedId, skills]);

  const broadcastChanged = useCallback(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(SKILLS_CHANNEL);
    channel.postMessage({ type: "changed" });
    channel.close();
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const next = await listCodexSkills(connection);
      setSkills(next);
      setSelectedId((current) => next.some((skill) => skill.id === current) ? current : next[0]?.id ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [connection]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return undefined;
    const channel = new BroadcastChannel(SKILLS_CHANNEL);
    channel.onmessage = (event) => {
      if (event.data?.type === "changed") void refresh();
    };
    return () => channel.close();
  }, [refresh]);

  const selectSkill = useCallback(async (skill: CodexSkill) => {
    setSelectedId(skill.id);
    setCreating(false);
    setEditing(true);
    setBusy(true);
    setError("");
    try {
      const detail = await getCodexSkill(connection, skill.id);
      setSkillId(detail.id);
      setContent(detail.content ?? "");
      setVersion(detail.version);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [connection]);

  const beginCreate = useCallback(() => {
    setOpen(true);
    setSelectedId("");
    setCreating(true);
    setEditing(true);
    setSkillId("");
    setContent("");
    setVersion("");
    setNotice("");
    setError("");
  }, []);

  const generateDraft = useCallback(() => {
    setOpen(true);
    const draft = buildCodexSkillDraft(boardContextForCodexSkill(project, goal));
    setCreating(true);
    setEditing(true);
    setSkillId(draft.id);
    setContent(draft.content);
    setVersion("");
    setNotice(t("agent.draftReady"));
    setError("");
  }, [goal, project, t]);

  const save = useCallback(async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = creating
        ? await createCodexSkill(connection, { id: skillId.trim(), content })
        : await updateCodexSkill(connection, skillId, content, version);
      setSkills((current) => creating ? [...current, next].sort((a, b) => a.id.localeCompare(b.id)) : replaceSkill(current, next));
      setSelectedId(next.id);
      setCreating(false);
      setVersion(next.version);
      setNotice(t("agent.saved"));
      broadcastChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [broadcastChanged, connection, content, creating, skillId, t, version]);

  const toggle = useCallback(async (skill: CodexSkill) => {
    setBusy(true);
    setError("");
    try {
      const next = await toggleCodexSkill(connection, skill.id, !skill.enabled, skill.version);
      setSkills((current) => replaceSkill(current, next));
      if (selectedId === skill.id) setVersion(next.version);
      broadcastChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [broadcastChanged, connection, refresh, selectedId, t]);

  const remove = useCallback(async (skill: CodexSkill) => {
    if (!window.confirm(t("agent.confirmDeleteSkill", { name: skill.name }))) return;
    setBusy(true);
    setError("");
    try {
      await deleteCodexSkill(connection, skill.id, skill.version);
      setSkills((current) => current.filter((item) => item.id !== skill.id));
      if (selectedId === skill.id) {
        setSelectedId("");
        setEditing(false);
      }
      broadcastChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [broadcastChanged, connection, refresh, selectedId]);

  const invoke = useCallback(async (skill: CodexSkill) => {
    if (!canInvoke || busy) return;
    setBusy(true);
    setError("");
    try {
      const detail = await invokeCodexSkill(connection, skill.id);
      const prompt = buildCodexSkillInvocationPrompt(detail, goal);
      await onInvoke(prompt);
      setNotice(t("agent.invokedSkill", { name: skill.name }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, canInvoke, connection, goal, onInvoke, t]);

  return (
    <section className="mb-2 rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_50%,transparent)] p-2.5" aria-label="Codex Agent Skills">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="min-w-0 flex-1 text-left text-xs font-semibold"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-controls="codex-skills-content"
        >
          Agent Skills <span className="text-[10px] font-normal text-[var(--ob-muted)]">{t("agent.skillCount", { count: skills.length })}</span>
        </button>
        <button type="button" className="ob-icon-btn h-6 w-6" title={t("agent.refreshSkills")} aria-label={t("agent.refreshSkills")} onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={12} />
        </button>
        <button type="button" className="ob-btn px-2 py-1 text-[10px]" onClick={beginCreate} disabled={busy}>
          {t("agent.new")}
        </button>
      </div>
      {open ? (
        <div id="codex-skills-content" className="mt-2 space-y-2">
          <div className="flex gap-1.5">
            <input
              className="ob-field min-w-0 flex-1 text-[11px]"
              aria-label={t("agent.draftGoal")}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder={t("agent.draftGoalPlaceholder")}
            />
            <button type="button" className="ob-btn gap-1 px-2 py-1 text-[10px]" title={t("agent.generateSkillDraft")} onClick={generateDraft} disabled={busy}>
              <Sparkles size={12} /> {t("agent.draft")}
            </button>
          </div>
          {skills.length ? (
            <div className="space-y-1">
              {skills.map((skill) => (
                <div key={skill.id} className="flex items-center gap-1.5 rounded-lg border border-[var(--ob-line)] px-2 py-1.5">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void selectSkill(skill)}>
                    <div className="truncate text-[11px] font-medium">{skill.name}</div>
                    <div className="truncate text-[10px] text-[var(--ob-muted)]">{skill.id} · {skill.enabled ? t("agent.enabled") : t("agent.disabled")}</div>
                  </button>
                  <button type="button" className="ob-icon-btn h-6 w-6" title={skill.enabled ? t("agent.disableSkill") : t("agent.enableSkill")} aria-label={skill.enabled ? t("agent.disableNamed", { name: skill.name }) : t("agent.enableNamed", { name: skill.name })} onClick={() => void toggle(skill)} disabled={busy}>
                    <span className={`text-[10px] ${skill.enabled ? "text-[var(--ob-success)]" : "text-[var(--ob-muted)]"}`}>{skill.enabled ? t("agent.on") : t("agent.off")}</span>
                  </button>
                  <button type="button" className="ob-icon-btn h-6 w-6" title={t("agent.invokeSkill")} aria-label={t("agent.invokeNamed", { name: skill.name })} onClick={() => void invoke(skill)} disabled={busy || !canInvoke || !skill.enabled}>
                    <Play size={11} />
                  </button>
                  <button type="button" className="ob-icon-btn h-6 w-6 text-[var(--ob-danger)]" title={t("agent.deleteSkill")} aria-label={t("agent.deleteNamed", { name: skill.name })} onClick={() => void remove(skill)} disabled={busy}>
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-2 text-center text-[10px] text-[var(--ob-muted)]">{t("agent.noSkills")}</p>
          )}
          {editing ? (
            <div className="rounded-lg border border-[var(--ob-line)] p-2">
              <div className="mb-1.5 flex items-center gap-1.5">
                <input
                  className="ob-field min-w-0 flex-1 text-[11px]"
                  aria-label="Skill id"
                  value={skillId}
                  disabled={!creating || busy}
                  onChange={(event) => setSkillId(event.target.value)}
                  placeholder={t("agent.skillIdPlaceholder")}
                />
                <button type="button" className="ob-icon-btn h-6 w-6" title={t("agent.closeEditor")} aria-label={t("agent.closeEditor")} onClick={() => setEditing(false)} disabled={busy}>
                  <X size={12} />
                </button>
              </div>
              <textarea
                className="ob-field min-h-40 w-full resize-y font-mono text-[10px]"
                aria-label={t("agent.skillContent")}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                disabled={busy}
                placeholder={t("agent.skillContentPlaceholder")}
              />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[10px] text-[var(--ob-muted)]">{t("agent.reviewBeforeSave")}</span>
                <button type="button" className="ob-btn-primary gap-1 px-2 py-1 text-[10px]" onClick={() => void save()} disabled={busy || !skillId.trim() || !content.trim()}>
                  <Save size={11} /> {t("agent.save")}
                </button>
              </div>
            </div>
          ) : null}
          {selected ? <p className="text-[10px] text-[var(--ob-muted)]">{t("agent.currentSkill", { name: selected.name })}</p> : null}
          {notice ? <p className="text-[10px] text-[var(--ob-success)]">{notice}</p> : null}
          {error ? <p role="alert" className="text-[10px] text-[var(--ob-danger)]">{error}</p> : null}
          {!canInvoke ? <p className="text-[10px] text-[var(--ob-muted)]">{t("agent.startBeforeInvoke")}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
