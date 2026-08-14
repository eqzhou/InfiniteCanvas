import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import { APP_VERSION } from "@/constant/env";
import {
  isNewerVersion,
  parseChangelog,
  type ReleaseInfo,
} from "@/lib/release";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { useI18n } from "@/i18n/I18nProvider";

function localReleases(): ReleaseInfo[] {
  return Array.isArray(__APP_RELEASES__) ? __APP_RELEASES__ : [];
}

function tagClass(type: string): string {
  if (type === "新增") return "border border-[color-mix(in_srgb,var(--ob-accent)_35%,transparent)] bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]";
  if (type === "修复") return "border border-[color-mix(in_srgb,var(--ob-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--ob-danger)_12%,transparent)] text-[var(--ob-danger)]";
  if (type === "调整") return "border border-[color-mix(in_srgb,var(--ob-info)_30%,transparent)] bg-[color-mix(in_srgb,var(--ob-info)_12%,transparent)] text-[var(--ob-info)]";
  if (type === "文档") return "border border-[color-mix(in_srgb,var(--ob-line)_80%,transparent)] bg-[var(--ob-surface-2)] text-[var(--ob-muted)]";
  return "border border-[var(--ob-line)] bg-[var(--ob-surface-2)] text-[var(--ob-muted)]";
}

export function VersionReleaseModal({
  menuItem = false,
  menuItemRole = menuItem,
  onOpen,
  onClose,
}: {
  menuItem?: boolean;
  menuItemRole?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
} = {}) {
  const { t } = useI18n();
  const bundled = useMemo(localReleases, []);
  const [open, setOpen] = useState(false);
  const [latestVersion, setLatestVersion] = useState(APP_VERSION);
  const [releases, setReleases] = useState<ReleaseInfo[]>(bundled);
  const [checking, setChecking] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const hasNew = isNewerVersion(latestVersion, APP_VERSION);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  useEscapeDismiss(open, close, 100);

  const checkLatest = useCallback(async (showError = false) => {
    setChecking(true);
    try {
      // Self-hosted: prefer local VERSION/CHANGELOG assets first; no remote required.
      setLatestVersion(APP_VERSION);
      setReleases(bundled.length ? bundled : parseChangelog(""));
    } catch {
      if (showError) {
        // soft fail
      }
    } finally {
      setChecking(false);
    }
  }, [bundled]);

  useEffect(() => {
    void checkLatest(false);
  }, [checkLatest]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (trigger && !trigger.closest("[inert]") && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role={menuItem && menuItemRole ? "menuitem" : undefined}
        className={menuItem
          ? "relative flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--ob-accent-soft)]"
          : "relative rounded-md px-2 py-1 text-xs font-medium text-[var(--ob-muted)] hover:bg-[var(--ob-accent-soft)] hover:text-[var(--ob-ink)]"}
        title={t("release.view")}
        onClick={() => {
          setOpen(true);
          onOpen?.();
          void checkLatest(true);
        }}
      >
        {menuItem ? t("release.menu", { version: APP_VERSION }) : APP_VERSION}
        {hasNew ? (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--ob-accent)]" />
        ) : null}
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div className="ob-overlay z-[120] p-4" role="presentation" onClick={close}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="version-release-title"
            className="ob-dialog ob-surface ob-view-fade-in mx-auto mt-[6vh] flex flex-col max-w-2xl shadow-[var(--ob-elev-2)]"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-3 border-b border-[var(--ob-line)] px-5 py-4">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]">
                <Sparkles size={16} aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="ob-page-kicker">{t("release.title")}</p>
                <h2 id="version-release-title" className="text-base font-semibold tracking-tight text-[var(--ob-ink)]">{t("release.title")}</h2>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className="ob-icon-btn ob-icon-btn-sm ml-auto"
                aria-label={t("release.close")}
                title={t("release.close")}
                onClick={close}
              >
                <X size={16} />
              </button>
            </header>
            <div className="grid grid-cols-2 gap-3 border-b border-[var(--ob-line)] p-4">
              <div className="rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface-2)] p-3 shadow-xs">
                <div className="text-xs text-[var(--ob-muted)]">{t("release.current")}</div>
                <div className="mt-1 font-mono text-base font-semibold text-[var(--ob-ink)]">{APP_VERSION}</div>
              </div>
              <div className="rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface-2)] p-3 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-[var(--ob-muted)]">{t("release.latest")}</div>
                  <button
                    type="button"
                    className="text-[11px] font-medium text-[var(--ob-accent)] underline-offset-2 hover:underline"
                    onClick={() => void checkLatest(true)}
                  >
                    {checking ? t("release.checking") : t("release.check")}
                  </button>
                </div>
                <div className="mt-1 font-mono text-base font-semibold text-[var(--ob-ink)]">{latestVersion}</div>
              </div>
            </div>
            <div className="ob-dialog-body flex-1 min-h-0 overflow-auto p-5">
              <ol className="space-y-6">
                {releases.map((release) => (
                  <li key={`${release.version}-${release.date}`} className="relative">
                    <div className="mb-2.5 flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-[var(--ob-ink)]">
                        {release.version === "Unreleased" ? t("release.unreleased") : release.version}
                      </span>
                      {release.date ? (
                        <span className="font-mono text-xs text-[var(--ob-muted)]">{release.date}</span>
                      ) : null}
                      {release.version === latestVersion ? (
                        <span className="ob-chip border-[color-mix(in_srgb,var(--ob-accent)_35%,transparent)] bg-[var(--ob-accent-soft)] text-[10px] text-[var(--ob-accent)] font-medium">
                          {t("release.newest")}
                        </span>
                      ) : null}
                      {release.version === APP_VERSION ? (
                        <span className="ob-chip text-[10px] font-medium">{t("release.active")}</span>
                      ) : null}
                    </div>
                    <ul className="space-y-2">
                      {release.items.map((item, index) => (
                        <li key={`${release.version}-${index}`} className="flex items-start gap-2.5 text-xs leading-relaxed">
                          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-medium ${tagClass(item.type)}`}>
                            {item.type}
                          </span>
                          <span className="min-w-0 flex-1 text-[var(--ob-ink)]">{item.content}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
              {!releases.length ? (
                <div className="ob-empty border-0 bg-transparent py-10">
                  <p className="ob-empty-title">{t("release.empty")}</p>
                  <p className="ob-empty-desc">{t("release.emptyDescription")}</p>
                </div>
              ) : null}
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
