import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { PasswordField } from "@/components/auth/PasswordField";
import { isGuestIdentity, useOptionalAuth } from "@/components/auth/AuthGate";
import { useI18n } from "@/i18n/I18nProvider";
import { PASSWORD_MIN_LENGTH, passwordPolicyError, passwordsMatch } from "@/lib/password-policy";
import { AuthHttpError, changePassword } from "@/services/auth-session";

export function SettingsAccountSection() {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const signedIn = Boolean(auth?.user && !isGuestIdentity(auth.user));
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!signedIn || busy) return;
    const policyError = passwordPolicyError(newPassword);
    if (policyError === "too-short") {
      setNotice(null);
      setError(t("auth.passwordTooShort"));
      return;
    }
    if (policyError === "too-long") {
      setNotice(null);
      setError(t("auth.passwordTooLong"));
      return;
    }
    if (!passwordsMatch(newPassword, confirmPassword)) {
      setNotice(null);
      setError(t("auth.passwordMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice(t("settings.passwordChanged"));
    } catch (cause) {
      if (cause instanceof AuthHttpError && cause.status === 401) {
        setError(t("settings.currentPasswordIncorrect"));
      } else {
        setError(t("settings.passwordChangeFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ob-settings-section mb-5" data-section-id="account">
      <div className="ob-settings-section-header">
        <span className="ob-settings-section-icon"><KeyRound size={14} /></span>
        <div>
          <div className="ob-settings-section-title">{t("settings.account")}</div>
          <div className="ob-settings-section-desc">{t("settings.accountDescription")}</div>
        </div>
      </div>

      {signedIn ? (
        <form className="max-w-md space-y-3" onSubmit={(event) => void submit(event)}>
          <PasswordField
            name="currentPassword"
            label={t("auth.currentPassword")}
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
            placeholder={t("auth.currentPasswordOptional")}
            disabled={busy}
            minLength={0}
          />
          <PasswordField
            name="newPassword"
            label={t("auth.newPassword")}
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            placeholder={t("auth.passwordPlaceholder")}
            disabled={busy}
          />
          <PasswordField
            name="confirmPassword"
            label={t("auth.confirmPassword")}
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            placeholder={t("auth.passwordPlaceholder")}
            disabled={busy}
          />
          {notice ? <p role="status" className="text-sm text-[var(--ob-success,var(--ob-accent))]">{notice}</p> : null}
          {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
          <button type="submit" className="ob-btn-primary" disabled={busy}>
            {busy ? t("auth.working") : t("settings.changePassword")}
          </button>
        </form>
      ) : (
        <p className="text-sm text-[var(--ob-muted)]">{t("settings.passwordSignInRequired")}</p>
      )}
    </section>
  );
}
