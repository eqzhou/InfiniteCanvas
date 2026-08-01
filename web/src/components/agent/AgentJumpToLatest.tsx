import { ArrowDown } from "lucide-react";

export function AgentJumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      title="回到底部"
      className="absolute bottom-2 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--ob-line)] bg-[var(--ob-panel)] px-2 py-1 text-[10px] shadow-[var(--ob-elev-1)]"
      onClick={onClick}
    >
      <ArrowDown size={12} />
      回到底部
    </button>
  );
}
