import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { APP_VERSION } from "@/constant/env";
import {
  isNewerVersion,
  parseChangelog,
  type ReleaseInfo,
} from "@/lib/release";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

function localReleases(): ReleaseInfo[] {
  return Array.isArray(__APP_RELEASES__) ? __APP_RELEASES__ : [];
}

function tagClass(type: string): string {
  if (type === "新增") return "bg-emerald-500/15 text-emerald-700";
  if (type === "修复") return "bg-red-500/15 text-red-600";
  if (type === "调整") return "bg-sky-500/15 text-sky-700";
  if (type === "文档") return "bg-violet-500/15 text-violet-700";
  return "bg-[var(--ob-accent-soft)] text-[var(--ob-muted)]";
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
        title="查看版本更新"
        onClick={() => {
          setOpen(true);
          onOpen?.();
          void checkLatest(true);
        }}
      >
        {menuItem ? `版本更新 · ${APP_VERSION}` : APP_VERSION}
        {hasNew ? (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
        ) : null}
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div className="ob-overlay ob-release-overlay p-3" role="presentation">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="version-release-title"
            className="ob-dialog flex flex-col max-w-2xl"
          >
            <header className="ob-dialog-header px-4 py-3">
              <div className="min-w-0">
                <p className="ob-page-kicker">Release</p>
                <h2 id="version-release-title" className="text-base font-semibold tracking-tight">版本更新</h2>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className="ob-icon-btn ml-auto"
                aria-label="关闭版本说明"
                title="关闭版本说明"
                onClick={close}
              >
                ×
              </button>
            </header>
            <div className="grid grid-cols-2 gap-3 border-b border-[var(--ob-line)] p-4">
              <div className="rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_55%,transparent)] p-3 shadow-[var(--ob-elev-1)]">
                <div className="text-xs text-[var(--ob-muted)]">当前版本</div>
                <div className="mt-1 text-base font-semibold">{APP_VERSION}</div>
              </div>
              <div className="rounded-xl border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_55%,transparent)] p-3 shadow-[var(--ob-elev-1)]">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-[var(--ob-muted)]">最新版本</div>
                  <button
                    type="button"
                    className="text-[11px] font-medium text-[var(--ob-accent)] underline-offset-2 hover:underline"
                    onClick={() => void checkLatest(true)}
                  >
                    {checking ? "检查中..." : "检查更新"}
                  </button>
                </div>
                <div className="mt-1 text-base font-semibold">{latestVersion}</div>
              </div>
            </div>
            <div className="ob-dialog-body flex-1 min-h-0 overflow-auto p-4">
              <ol className="space-y-5">
                {releases.map((release) => (
                  <li key={`${release.version}-${release.date}`}>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">
                        {release.version === "Unreleased" ? "未发布" : release.version}
                      </span>
                      {release.date ? (
                        <span className="text-xs text-[var(--ob-muted)]">{release.date}</span>
                      ) : null}
                      {release.version === latestVersion ? (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700">最新</span>
                      ) : null}
                      {release.version === APP_VERSION ? (
                        <span className="rounded bg-[var(--ob-accent-soft)] px-1.5 py-0.5 text-[10px]">当前</span>
                      ) : null}
                    </div>
                    <ul className="space-y-1.5">
                      {release.items.map((item, index) => (
                        <li key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6">
                          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] ${tagClass(item.type)}`}>
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
                  <p className="ob-empty-title">暂无更新日志</p>
                  <p className="ob-empty-desc">本地 CHANGELOG 为空时会显示这里。</p>
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
