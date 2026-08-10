import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

export type TextEntryDialogProps = {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel: string;
  multiline?: boolean;
  onValueChange?: (value: string) => void;
  onClose: () => void;
  onSubmit: (value: string) => void;
};

export function TextEntryDialog(props: TextEntryDialogProps) {
  const { open, initialValue = "", onClose } = props;
  const [value, setValue] = useState(initialValue);

  useEscapeDismiss(open, onClose);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [initialValue, open]);

  if (!open) return null;

  return createPortal(
    <TextEntryDialogContent {...props} value={value} onValueChange={(next) => { setValue(next); props.onValueChange?.(next); }} />,
    document.body,
  );
}

export function TextEntryDialogContent({
  title,
  label,
  placeholder,
  submitLabel,
  multiline = true,
  onClose,
  onSubmit,
  value,
  onValueChange,
}: Omit<TextEntryDialogProps, "open" | "initialValue"> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = value.trim();
    if (next) onSubmit(next);
  };

  return (
    <div
      className="ob-overlay-canvas p-4"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="text-entry-dialog-title"
        className="ob-dialog max-w-3xl p-0"
        onSubmit={submit}
      >
        <header className="ob-dialog-header px-4 py-3">
          <h2 id="text-entry-dialog-title" className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            className="ob-icon-btn ml-auto"
            aria-label="关闭输入框"
            title="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="ob-dialog-body">
          <label className="block text-sm">
            <span className="ob-label">{label}</span>
            {multiline ? (
              <textarea
                autoFocus
                aria-label="长提示词编辑器"
                className="ob-field min-h-[min(55vh,32rem)] resize-y font-mono leading-relaxed"
                value={value}
                placeholder={placeholder}
                onChange={(event) => onValueChange(event.target.value)}
              />
            ) : (
              <input
                autoFocus
                className="ob-field"
                value={value}
                placeholder={placeholder}
                onChange={(event) => onValueChange(event.target.value)}
              />
            )}
          </label>
          {multiline ? <p className="mt-2 text-right text-xs text-[var(--ob-muted)]">{value.length} 字符</p> : null}
        </div>
        <footer className="ob-dialog-footer">
          <button type="button" className="ob-btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="ob-btn-primary" disabled={!value.trim()}>
            {submitLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
