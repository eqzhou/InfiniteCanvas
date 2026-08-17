import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useI18n } from "@/i18n/I18nProvider";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/password-policy";

type PasswordFieldProps = {
  name?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  minLength?: number;
};

export function PasswordField({
  name = "password",
  label,
  value,
  onChange,
  autoComplete,
  required,
  placeholder,
  disabled,
  minLength = PASSWORD_MIN_LENGTH,
}: PasswordFieldProps) {
  const { t } = useI18n();
  const inputId = useId();
  const [visible, setVisible] = useState(false);
  const revealLabel = visible ? t("auth.hidePassword") : t("auth.showPassword");

  return (
    <div className="block space-y-1.5">
      <label className="text-sm text-[var(--ob-muted)]" htmlFor={inputId}>{label}</label>
      <div className="relative flex items-center">
        <input
          id={inputId}
          className="ob-field pr-9"
          type={visible ? "text" : "password"}
          name={name}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          maxLength={PASSWORD_MAX_LENGTH}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        <button
          type="button"
          className="ob-icon-btn ob-icon-btn-sm absolute right-1 text-[var(--ob-muted)] hover:text-[var(--ob-ink)]"
          aria-label={revealLabel}
          aria-pressed={visible}
          aria-controls={inputId}
          title={revealLabel}
          disabled={disabled}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
