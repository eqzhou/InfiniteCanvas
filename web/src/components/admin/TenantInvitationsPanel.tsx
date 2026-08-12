import { useEffect, useState } from "react";
import { useI18n } from "@/i18n/I18nProvider";
import { createTenantInvitation, listTenantInvitations, revokeTenantInvitation, type TenantInvitation } from "@/services/admin";

export function TenantInvitationsPanel({ actorRole }: { actorRole: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<TenantInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [expiry, setExpiry] = useState("168");
  const [createdLink, setCreatedLink] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setItems(await listTenantInvitations()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { void load(); }, []);
  const create = async () => {
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); setCreatedLink("");
    try {
      const result = await createTenantInvitation({ email, role, expiresInHours: Number(expiry) });
      const base = typeof window !== "undefined" ? window.location.origin : "";
      setCreatedLink(`${base}/#invite=${encodeURIComponent(result.token)}`);
      setNotice(t("admin.invitationCreated")); setEmail(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    try { await revokeTenantInvitation(id); setItems((current) => current.map((item) => item.id === id ? { ...item, revokedAt: new Date().toISOString() } : item)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const copy = async () => {
    if (!createdLink) return;
    try { await navigator.clipboard.writeText(createdLink); setNotice(t("admin.copyDone")); } catch { setError(t("admin.copyFailed")); }
  };
  return <section className="space-y-3 rounded-xl border border-[var(--ob-line)] p-4"><div><h3 className="font-semibold">{t("admin.invitationTitle")}</h3><p className="mt-1 text-sm text-[var(--ob-muted)]">{t("admin.invitationHint")}</p></div><div className="flex flex-wrap items-end gap-2"><label className="block text-sm"><span className="sr-only">{t("admin.invitationEmail")}</span><input className="ob-field w-64" type="email" value={email} placeholder={t("admin.invitationEmail")} onChange={(event) => setEmail(event.target.value)} /></label><label className="block text-sm"><span className="sr-only">{t("admin.invitationRole")}</span><select className="ob-field w-32" value={role} onChange={(event) => setRole(event.target.value as "member" | "admin")}><option value="member">{t("admin.invitationMember")}</option><option value="admin" disabled={actorRole !== "owner"}>{t("admin.invitationAdmin")}</option></select></label><label className="block text-sm"><span className="sr-only">{t("admin.invitationExpiry")}</span><input className="ob-field w-28" type="number" min={1} max={720} value={expiry} onChange={(event) => setExpiry(event.target.value)} /></label><button type="button" className="ob-btn ob-btn-primary" disabled={busy || !email.trim()} onClick={() => void create()}>{busy ? t("admin.saving") : t("admin.createInvitation")}</button></div>{createdLink ? <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--ob-canvas)] p-3 text-sm"><code className="min-w-0 flex-1 break-all">{createdLink}</code><button type="button" className="ob-btn" onClick={() => void copy()}>{t("admin.copy")}</button></div> : null}{notice ? <p role="status" className="text-sm text-emerald-600">{notice}</p> : null}{error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}<div><h4 className="mb-2 text-sm font-medium">{t("admin.invitationList")}</h4><div className="space-y-1 text-sm">{items.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ob-line)] py-2"><span>{item.email} · {item.role} · {item.acceptedAt ? t("admin.invitationAccepted") : item.revokedAt ? t("admin.invitationRevoked") : t("admin.invitationPending")}</span>{!item.acceptedAt && !item.revokedAt ? <button type="button" className="ob-btn" onClick={() => void revoke(item.id)}>{t("admin.revokeInvitation")}</button> : null}</div>)}</div></div></section>;
}
