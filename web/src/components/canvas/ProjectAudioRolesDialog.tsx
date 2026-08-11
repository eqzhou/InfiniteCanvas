import { X } from "lucide-react";
import { AudioRoleEditor } from "@/components/layout/AudioRoleEditor";
import { getProvider } from "@/lib/ai-config";
import { replaceProjectAudioRoles } from "@/lib/project-audio-roles";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { resolveActiveAIChannel, useSharedChannels } from "@/services/shared-channels";
import { useBoardStore } from "@/stores/use-board-store";
import { useI18n } from "@/i18n/I18nProvider";

export function ProjectAudioRolesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const project = useBoardStore((state) =>
    state.projects.find((item) => item.id === state.activeProjectId) ?? null);
  const config = useBoardStore((state) => state.config);
  const updateActive = useBoardStore((state) => state.updateActive);
  const persistNow = useBoardStore((state) => state.persistNow);
  const sharedChannels = useSharedChannels();
  const channel = resolveActiveAIChannel(
    config.channels,
    config.activeChannelId,
    sharedChannels,
    config.activeSharedChannelId,
  );
  const protocol = channel ? getProvider(channel, "audio").protocol : "openai";

  const close = () => {
    void persistNow();
    onClose();
  };
  useEscapeDismiss(open, close);

  if (!open || !project) return null;

  return (
    <div className="ob-overlay z-[120] p-3 sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-audio-roles-title"
        className="ob-dialog ob-surface-glass flex w-full max-w-2xl flex-col overflow-hidden shadow-[var(--ob-elev-2)]"
      >
        <header className="flex min-h-16 items-center gap-4 border-b border-[var(--ob-line)] px-4 sm:px-6">
          <div className="min-w-0">
            <p className="ob-page-kicker">Project cast</p>
            <h2 id="project-audio-roles-title" className="truncate text-lg font-semibold tracking-tight">
              {t("projectAudio.title")}
            </h2>
            <p className="truncate text-xs text-[var(--ob-muted)]">{project.title}</p>
          </div>
          <button
            type="button"
            aria-label={t("projectAudio.close")}
            title={t("projectAudio.closeButton")}
            className="ob-icon-btn ml-auto"
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <p className="mb-3 text-xs leading-relaxed text-[var(--ob-muted)]">
            {t("projectAudio.description")}
          </p>
          <AudioRoleEditor
            roles={project.audioRoles ?? []}
            protocol={protocol}
            onChange={(audioRoles) => updateActive(
              (current) => replaceProjectAudioRoles(current, audioRoles),
              { history: false },
            )}
          />
          <p className="mt-3 text-xs text-[var(--ob-muted)]">
            {t("projectAudio.deleteNote")}
          </p>
        </div>
      </div>
    </div>
  );
}
