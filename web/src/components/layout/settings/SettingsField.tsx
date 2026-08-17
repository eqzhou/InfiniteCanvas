export function SettingsField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="ob-label !mb-0">{label}</span>
      {children}
    </label>
  );
}

export function SettingsCompactField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs text-[var(--ob-muted)] md:hidden">{label}</span>
      {children}
    </label>
  );
}
