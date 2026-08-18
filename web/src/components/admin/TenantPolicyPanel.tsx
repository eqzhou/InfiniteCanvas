import { useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Notice, SectionHeader } from "@/components/admin/AdminSection";
import { useI18n } from "@/i18n/I18nProvider";
import {
  DEFAULT_TENANT_POLICY,
  getTenantPolicy,
  updateTenantPolicy,
  type TenantPolicy,
} from "@/services/auth-session";

const defaultModelFields = [
  ["defaultTextModel", "settings.defaultTextModel"],
  ["defaultImageModel", "settings.defaultImageModel"],
  ["defaultVideoModel", "settings.defaultVideoModel"],
  ["defaultAudioModel", "settings.defaultAudioModel"],
] as const;

export function parseTenantModelList(value: string): string[] {
  return [...new Set(value.split("\n").map((item) => item.trim()).filter(Boolean))];
}

export function tenantPolicyWritePayload(policy: TenantPolicy, modelDraft: string): TenantPolicy {
  return { ...policy, availableModels: parseTenantModelList(modelDraft) };
}

export function TenantPolicyPanel() {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<TenantPolicy>(DEFAULT_TENANT_POLICY);
  const [modelDraft, setModelDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getTenantPolicy()
      .then((value) => {
        if (cancelled) return;
        setPolicy(value);
        setModelDraft((value.availableModels ?? []).join("\n"));
        setLoaded(true);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const models = useMemo(() => parseTenantModelList(modelDraft), [modelDraft]);
  const save = async (next: TenantPolicy) => {
    if (busy || !loaded) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await updateTenantPolicy(next);
      setPolicy(saved);
      setModelDraft((saved.availableModels ?? []).join("\n"));
      setNotice(t("settings.sitePolicySaved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.sitePolicySaveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const persist = (next: TenantPolicy) => {
    void save(tenantPolicyWritePayload(next, modelDraft));
  };

  const toggle = (key: "allowCustomChannel" | "allowCloudChannel") => {
    persist({ ...policy, [key]: !policy[key] });
  };

  return (
    <div className="ob-admin-stack max-w-4xl" aria-busy={loading || busy}>
      <section className="ob-admin-section">
        <SectionHeader
          icon={<ShieldCheck size={16} />}
          title={t("settings.sitePolicy")}
          desc={t("settings.sitePolicyDescription")}
        />
        <p className="mb-3 text-xs text-[var(--ob-muted)]">{t("settings.sitePolicyHint")}</p>
        {loading ? <Notice tone="info">{t("settings.loadingPolicy")}</Notice> : !loaded ? (
          <button type="button" className="ob-btn" onClick={() => {
            setLoading(true);
            setError("");
            void getTenantPolicy()
              .then((value) => {
                setPolicy(value);
                setModelDraft((value.availableModels ?? []).join("\n"));
                setLoaded(true);
              })
              .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
              .finally(() => setLoading(false));
          }}>{t("settings.retry")}</button>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <PolicySwitch
                label={t("settings.allowCustomChannels")}
                checked={policy.allowCustomChannel}
                disabled={busy}
                onChange={() => toggle("allowCustomChannel")}
              />
              <PolicySwitch
                label={t("settings.allowCloudGeneration")}
                checked={policy.allowCloudChannel}
                disabled={busy}
                onChange={() => toggle("allowCloudChannel")}
              />
            </div>
            <div className="mt-4 rounded-xl border border-[var(--ob-line)] p-3">
              <label className="grid gap-2">
                <span className="text-xs text-[var(--ob-muted)]">{t("settings.availableModels")}</span>
                <textarea
                  className="ob-field min-h-28 resize-y font-mono text-xs"
                  aria-label={t("settings.availableModelsLabel")}
                  value={modelDraft}
                  disabled={busy}
                  onChange={(event) => setModelDraft(event.target.value)}
                  placeholder="gpt-image-2&#10;gpt-5.5"
                />
              </label>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {defaultModelFields.map(([key, labelKey]) => {
                  const current = policy[key] ?? "";
                  const options = current && !models.includes(current) ? [...models, current] : models;
                  return (
                    <label key={key} className="grid gap-1">
                      <span className="text-xs text-[var(--ob-muted)]">{t(labelKey)}</span>
                      <select
                        className="ob-field"
                        value={current}
                        disabled={busy}
                        onChange={(event) => persist({ ...policy, [key]: event.target.value })}
                      >
                        <option value="">{t("settings.unsetModel")}</option>
                        {options.map((model) => <option key={model} value={model}>{model}</option>)}
                      </select>
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                className="ob-btn ob-btn-primary mt-3"
                disabled={busy}
                onClick={() => persist(policy)}
              >
                {busy ? t("admin.saving") : t("settings.saveModelList")}
              </button>
            </div>
          </>
        )}
        <div className="mt-3 space-y-2 empty:mt-0">
          {notice ? <Notice tone="success">{notice}</Notice> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </div>
      </section>
    </div>
  );
}

function PolicySwitch({ label, checked, disabled, onChange }: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <label className="ob-toggle-field">
      <button
        type="button"
        role="switch"
        className="ob-switch"
        aria-label={label}
        aria-checked={checked}
        data-checked={checked ? "true" : "false"}
        disabled={disabled}
        onClick={onChange}
      />
      <span className="text-sm text-[var(--ob-ink)]">{label}</span>
    </label>
  );
}
