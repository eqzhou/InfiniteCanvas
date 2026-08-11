import { ArrowDown } from "lucide-react";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator } from "@/i18n/messages/agent-help";

export function AgentJumpToLatest({ onClick }: { onClick: () => void }) {
  const { locale, t: baseT } = useI18n();
  const t = createAgentHelpTranslator(baseT, locale);
  return (
    <button
      type="button"
      title={t("agent.jumpBottom")}
      className="absolute bottom-2 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--ob-line)] bg-[var(--ob-panel)] px-2 py-1 text-[10px] shadow-[var(--ob-elev-1)]"
      onClick={onClick}
    >
      <ArrowDown size={12} />
      {t("agent.jumpBottom")}
    </button>
  );
}
