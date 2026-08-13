import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

/** Section head shared by every admin panel: accent icon, title, optional description and trailing actions. */
export function SectionHeader({ icon, title, desc, actions }: { icon: ReactNode; title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="ob-admin-section-header">
      <span className="ob-admin-section-icon" aria-hidden>{icon}</span>
      <div className="ob-admin-section-heading">
        <h2 className="ob-admin-section-title">{title}</h2>
        {desc ? <p className="ob-admin-section-desc">{desc}</p> : null}
      </div>
      {actions ? <div className="ob-admin-section-actions">{actions}</div> : null}
    </div>
  );
}

/** Inline status line. Danger is announced assertively; everything else is polite. */
export function Notice({ tone, children }: { tone: "success" | "danger" | "warning" | "info"; children: ReactNode }) {
  return <p className="ob-notice" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>{children}</p>;
}

export function EmptyState({ icon, title, desc }: { icon?: ReactNode; title: string; desc?: string }) {
  return (
    <div className="ob-empty">
      <span className="ob-empty-icon" aria-hidden>{icon ?? <Inbox size={20} />}</span>
      <p className="ob-empty-title">{title}</p>
      {desc ? <p className="ob-empty-desc">{desc}</p> : null}
    </div>
  );
}
