import type { SettingsFeedback } from "./settings-notices";

export function SettingsFeedbackBar({
  error,
  feedback,
}: {
  error: string | null;
  feedback: SettingsFeedback | null;
}) {
  if (!error && !feedback) {
    return <div data-settings-notice hidden />;
  }
  return (
    <div data-settings-notice className="space-y-2 border-b border-[var(--ob-line)] px-4 py-3 sm:px-6">
      {error ? (
        <p role="alert" className="rounded-md bg-[color-mix(in_srgb,var(--ob-danger)_12%,transparent)] px-3 py-2 text-sm text-[var(--ob-danger)]">
          {error}
        </p>
      ) : null}
      {feedback ? (
        <p
          role={feedback.tone === "danger" ? "alert" : "status"}
          className={feedback.tone === "danger"
            ? "rounded-md bg-[color-mix(in_srgb,var(--ob-danger)_12%,transparent)] px-3 py-2 text-sm text-[var(--ob-danger)]"
            : "rounded-md bg-[color-mix(in_srgb,var(--ob-accent)_12%,transparent)] px-3 py-2 text-sm text-[var(--ob-ink)]"}
        >
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}
