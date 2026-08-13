import { useEffect, useState } from "react";
import { Check, Copy, MailPlus, Send } from "lucide-react";
import { EmptyState, Notice, SectionHeader } from "@/components/admin/AdminSection";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useI18n } from "@/i18n/I18nProvider";
import { createTenantInvitation, listTenantInvitations, revokeTenantInvitation, type TenantInvitation } from "@/services/admin";

type InvitationState = "accepted" | "revoked" | "pending";

function invitationState(item: TenantInvitation): InvitationState {
  if (item.acceptedAt) return "accepted";
  if (item.revokedAt) return "revoked";
  return "pending";
}

const stateTone: Record<InvitationState, "success" | "danger" | "warning"> = { accepted: "success", revoked: "danger", pending: "warning" };
const stateDot: Record<InvitationState, string> = { accepted: "succeeded", revoked: "failed", pending: "pending" };

export function normalizeInvitationExpiryHours(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 720 ? parsed : null;
}

export function TenantInvitationsPanel({ actorRole }: { actorRole: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<TenantInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [expiry, setExpiry] = useState("168");
  const [createdLink, setCreatedLink] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<TenantInvitation | null>(null);
  const [revokeBusyId, setRevokeBusyId] = useState<string | null>(null);

  const expiryHours = normalizeInvitationExpiryHours(expiry);
  const canCreate = Boolean(email.trim()) && expiryHours !== null;

  const load = async () => {
    try { setItems(await listTenantInvitations()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const create = async () => {
    if (busy || !canCreate || expiryHours === null) return;
    setBusy(true); setError(""); setNotice(""); setCreatedLink("");
    try {
      const result = await createTenantInvitation({ email: email.trim(), role, expiresInHours: expiryHours });
      const base = typeof window !== "undefined" ? window.location.origin : "";
      setCreatedLink(`${base}/#invite=${encodeURIComponent(result.token)}`);
      setNotice(t("admin.invitationCreated")); setEmail(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    if (revokeBusyId) return;
    setRevokeBusyId(id); setError(""); setNotice("");
    try {
      await revokeTenantInvitation(id);
      setItems((current) => current.map((item) => item.id === id ? { ...item, revokedAt: new Date().toISOString() } : item));
      setPendingRevoke(null);
    } catch (cause) {
      setPendingRevoke(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { setRevokeBusyId(null); }
  };
  const copy = async () => {
    if (!createdLink) return;
    try { await navigator.clipboard.writeText(createdLink); setNotice(t("admin.copyDone")); } catch { setError(t("admin.copyFailed")); }
  };
  const pending = items.filter((item) => invitationState(item) === "pending").length;
  return (
    <section className="ob-admin-section" aria-busy={loading || busy}>
      <SectionHeader
        icon={<MailPlus size={16} />}
        title={t("admin.invitationTitle")}
        desc={t("admin.invitationHint")}
        actions={loading ? null : <span className="ob-micro-label">{t("admin.invitations.count", { count: pending })}</span>}
      />
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.invitationEmail")}</span>
          <input className="ob-field w-60" type="email" autoComplete="off" value={email} placeholder="name@example.com" disabled={busy} onChange={(event) => setEmail(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && email.trim()) void create(); }} />
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.invitationRole")}</span>
          <select className="ob-field w-32" value={role} disabled={busy} onChange={(event) => setRole(event.target.value as "member" | "admin")}>
            <option value="member">{t("admin.invitationMember")}</option>
            <option value="admin" disabled={actorRole !== "owner"}>{t("admin.invitationAdmin")}</option>
          </select>
        </label>
        <label className="block">
          <span className="ob-micro-label mb-1">{t("admin.invitationExpiry")}</span>
          <input className="ob-field w-24" type="number" min={1} max={720} value={expiry} disabled={busy} aria-invalid={expiry.length > 0 && expiryHours === null} onChange={(event) => setExpiry(event.target.value)} />
        </label>
        <button type="button" className="ob-btn ob-btn-primary" disabled={busy || !canCreate} onClick={() => void create()}>
          <Send size={14} aria-hidden />{busy ? t("admin.saving") : t("admin.createInvitation")}
        </button>
      </div>
      {expiry.length > 0 && expiryHours === null ? <Notice tone="danger">{t("admin.invitationExpiryInvalid")}</Notice> : null}
      {createdLink ? (
        <div className="mt-3 rounded-[0.625rem] border border-[color-mix(in_srgb,var(--ob-accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--ob-accent)_7%,transparent)] p-3">
          <span className="ob-micro-label mb-1.5">{t("admin.invitationLink")}</span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-xs text-[var(--ob-ink)]">{createdLink}</code>
            <button type="button" className="ob-btn" onClick={() => void copy()}>
              {notice === t("admin.copyDone") ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
              {t("admin.copy")}
            </button>
          </div>
        </div>
      ) : null}
      <div className="mt-3 space-y-2 empty:mt-0">
        {notice ? <Notice tone="success">{notice}</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <div className="mt-4">
        <span className="ob-micro-label mb-1.5">{t("admin.invitationList")}</span>
        {loading ? <Notice tone="info">{t("admin.invitations.loading")}</Notice> : items.length === 0 ? (
          <EmptyState icon={<MailPlus size={20} />} title={t("admin.invitations.empty")} />
        ) : (
          <ul className="divide-y divide-[color-mix(in_srgb,var(--ob-line)_55%,transparent)]">
            {items.map((item) => {
              const state = invitationState(item);
              return (
                <li key={item.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-[var(--ob-ink)]">{item.email}</span>
                  <span className="ob-micro-label">
                    {item.role === "admin" ? t("admin.invitationAdmin") : t("admin.invitationMember")}
                  </span>
                  <span className="ob-status-chip" data-tone={stateTone[state]}>
                    <span className="ob-status-dot" data-status={stateDot[state]} aria-hidden />
                    {state === "accepted" ? t("admin.invitationAccepted") : state === "revoked" ? t("admin.invitationRevoked") : t("admin.invitationPending")}
                  </span>
                  {state === "pending" ? (
                    <button type="button" className="ob-btn ob-btn-danger" disabled={revokeBusyId !== null} onClick={() => setPendingRevoke(item)}>{t("admin.revokeInvitation")}</button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {pendingRevoke ? (
        <ConfirmDialog
          title={t("admin.revokeInvitationTitle")}
          message={t("admin.confirmRevokeInvitation", { email: pendingRevoke.email })}
          confirmLabel={t("admin.revokeInvitation")}
          busy={revokeBusyId === pendingRevoke.id}
          onCancel={() => { if (!revokeBusyId) setPendingRevoke(null); }}
          onConfirm={() => void revoke(pendingRevoke.id)}
        />
      ) : null}
    </section>
  );
}
