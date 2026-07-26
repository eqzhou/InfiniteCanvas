import type { LocalWorkspaceMigrationPreflight } from "@/services/local-workspace-migration";
import type { MigrationCredentialSummary } from "@/services/local-migration-resources";

export type LoginMigrationPhase = "idle" | "migrating" | "cancelled" | "complete" | "error";

export function formatMigrationBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export function LoginMigrationDialog({
  preflight,
  phase,
  completedOperations,
  availableBytes,
  error,
  credentials = { present: false, labels: [] },
  includeSecrets = false,
  onIncludeSecretsChange = () => undefined,
  onMigrate,
  onCancel,
  onKeepLocal,
  onContinue,
}: {
  preflight: LocalWorkspaceMigrationPreflight;
  phase: LoginMigrationPhase;
  completedOperations: number;
  availableBytes: number | null;
  error: string | null;
  credentials?: MigrationCredentialSummary;
  includeSecrets?: boolean;
  onIncludeSecretsChange?: (include: boolean) => void;
  onMigrate: () => void;
  onCancel: () => void;
  onKeepLocal: () => void;
  onContinue: () => void;
}) {
  const totalOperations = preflight.inventory.resourceCount;
  const conflicts = preflight.conflicts.length;
  const projectCount = preflight.inventory.counts.project;
  const busy = phase === "migrating";
  const capacityBlocked = availableBytes !== null && preflight.pendingBytes > availableBytes;

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-migration-title"
        className="ob-surface-glass w-full max-w-lg p-6 shadow-[var(--ob-elev-2)] sm:p-8"
      >
        <p className="ob-page-kicker">Local workspace</p>
        <h1 id="login-migration-title" className="mt-1 text-xl font-semibold text-[var(--ob-ink)]">
          发现本地工作区数据
        </h1>
        <p className="mt-2 text-sm text-[var(--ob-muted)]">
          登录已成功。请选择是否将这台浏览器中的数据迁移到当前账号；在你确认前不会加载或清理本地工作区。
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border border-[var(--ob-line)] p-3">
            <dt className="text-[var(--ob-muted)]">本地内容</dt>
            <dd className="mt-1 font-medium">{projectCount} 个画布 · {preflight.inventory.resourceCount} 个资源</dd>
          </div>
          <div className="rounded-lg border border-[var(--ob-line)] p-3">
            <dt className="text-[var(--ob-muted)]">总大小 / 待传输</dt>
            <dd className="mt-1 font-medium">
              {formatMigrationBytes(preflight.inventory.totalBytes)} / {formatMigrationBytes(preflight.pendingBytes)}
            </dd>
          </div>
          <div className="rounded-lg border border-[var(--ob-line)] p-3">
            <dt className="text-[var(--ob-muted)]">账号中已存在</dt>
            <dd className="mt-1 font-medium">{preflight.alreadyPresent.length} 个相同资源</dd>
          </div>
          <div className="rounded-lg border border-[var(--ob-line)] p-3">
            <dt className="text-[var(--ob-muted)]">冲突</dt>
            <dd className="mt-1 font-medium">{conflicts} 项冲突</dd>
          </div>
        </dl>

        <p className="mt-3 text-xs text-[var(--ob-muted)]">
          账号存储容量：{availableBytes === null ? "容量不可用（尚未完成检查）" : `${formatMigrationBytes(availableBytes)} 可用`}
          {capacityBlocked ? `；待传输 ${formatMigrationBytes(preflight.pendingBytes)}，空间不足` : ""}
        </p>

        {credentials.present ? (
          <fieldset className="mt-4 rounded-lg border border-[var(--ob-line)] p-3 text-sm">
            <legend className="px-1 font-medium">浏览器本地凭据（默认不迁移）</legend>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--ob-muted)]">
              {credentials.labels.map((label) => <li key={label}>{label}</li>)}
            </ul>
            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                checked={includeSecrets}
                disabled={busy}
                onChange={(event) => onIncludeSecretsChange(event.target.checked)}
              />
              <span>我明确同意将以上凭据加密迁移到当前账号</span>
            </label>
            <p className="mt-2 text-xs text-[var(--ob-muted)]">不勾选时只迁移内容，凭据不会上传。</p>
          </fieldset>
        ) : null}

        {conflicts ? (
          <div role="alert" className="mt-4 rounded-lg border border-[var(--ob-warning)] p-3 text-sm text-[var(--ob-warning)]">
            检测到同名但内容不同的账号数据。OpenBoard 不会覆盖账号中的现有数据；请先保留本地，稍后通过冲突处理流程合并。
          </div>
        ) : null}
        {phase === "migrating" ? (
          <div className="mt-4" role="status" aria-live="polite">
            <div className="flex justify-between text-sm"><span>正在迁移，可在失败后继续</span><span>{completedOperations} / {totalOperations}</span></div>
            <progress className="mt-2 w-full" max={Math.max(1, totalOperations)} value={completedOperations} />
          </div>
        ) : null}
        {phase === "complete" ? (
          <div role="status" className="mt-4 rounded-lg border border-[var(--ob-success)] p-3 text-sm text-[var(--ob-success)]">
            迁移完成，服务端清单已验证，本地副本已安全清理。
          </div>
        ) : null}
        {error ? <div role="alert" className="mt-4 rounded-lg border border-[var(--ob-danger)] p-3 text-sm text-[var(--ob-danger)]">{error}</div> : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {phase !== "complete" ? (
            <button type="button" className="ob-btn" onClick={busy ? onCancel : onKeepLocal}>
              {busy ? "取消迁移" : "保留本地，暂不迁移"}
            </button>
          ) : null}
          {phase === "complete" ? (
            <button type="button" className="ob-btn-primary" onClick={onContinue}>进入工作区</button>
          ) : (
            <button type="button" className="ob-btn-primary" disabled={busy || conflicts > 0 || capacityBlocked} onClick={onMigrate}>
              {phase === "error" || phase === "cancelled" ? "继续迁移" : phase === "migrating" ? "正在迁移…" : "迁移到当前账号"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
