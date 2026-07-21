import { useCallback, useEffect, useMemo, useState } from "react";
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

export function VersionReleaseModal({ menuItem = false }: { menuItem?: boolean } = {}) {
  const bundled = useMemo(localReleases, []);
  const [open, setOpen] = useState(false);
  const [latestVersion, setLatestVersion] = useState(APP_VERSION);
  const [releases, setReleases] = useState<ReleaseInfo[]>(bundled);
  const [checking, setChecking] = useState(false);
  const hasNew = isNewerVersion(latestVersion, APP_VERSION);
  useEscapeDismiss(open, () => setOpen(false), 100);

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

  return (
    <>
      <button
        type="button"
        role={menuItem ? "menuitem" : undefined}
        className={menuItem
          ? "relative flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--ob-accent-soft)]"
          : "relative rounded-md px-2 py-1 text-xs font-medium text-[var(--ob-muted)] hover:bg-[var(--ob-accent-soft)] hover:text-[var(--ob-ink)]"}
        title="查看版本更新"
        onClick={() => {
          setOpen(true);
          void checkLatest(true);
        }}
      >
        {menuItem ? `版本更新 · ${APP_VERSION}` : APP_VERSION}
        {hasNew ? (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
        ) : null}
      </button>
      {open ? (
        <div className="fixed inset-0 z-[130] grid place-items-center bg-black/45 p-3" role="presentation">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="version-release-title"
            className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] shadow-[var(--ob-shadow)]"
          >
            <header className="flex items-center gap-2 border-b border-[var(--ob-line)] px-4 py-3">
              <h2 id="version-release-title" className="text-base font-semibold">版本更新</h2>
              <button
                type="button"
                className="ml-auto rounded-md px-2 py-1 text-sm text-[var(--ob-muted)] hover:bg-[var(--ob-accent-soft)]"
                onClick={() => setOpen(false)}
              >
                关闭
              </button>
            </header>
            <div className="grid grid-cols-2 gap-3 border-b border-[var(--ob-line)] p-4">
              <div className="rounded-md border border-[var(--ob-line)] p-3">
                <div className="text-xs text-[var(--ob-muted)]">当前版本</div>
                <div className="mt-1 text-base font-semibold">{APP_VERSION}</div>
              </div>
              <div className="rounded-md border border-[var(--ob-line)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-[var(--ob-muted)]">最新版本</div>
                  <button
                    type="button"
                    className="text-[11px] text-[var(--ob-muted)] underline-offset-2 hover:underline"
                    onClick={() => void checkLatest(true)}
                  >
                    {checking ? "检查中..." : "检查更新"}
                  </button>
                </div>
                <div className="mt-1 text-base font-semibold">{latestVersion}</div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
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
                <p className="py-8 text-center text-sm text-[var(--ob-muted)]">暂无更新日志</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
