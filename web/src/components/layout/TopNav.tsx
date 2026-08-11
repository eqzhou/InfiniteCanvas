import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { Link, useLocation } from "react-router";
import {
  Bookmark,
  Archive,
  Bot,
  HelpCircle,
  BookOpen,
  LayoutDashboard,
  Library,
  Menu,
  MoreHorizontal,
  Moon,
  Puzzle,
  Settings,
  LogOut,
  LogIn,
  UserRound,
  Sun,
  Sparkles,
  ScrollText,
  WandSparkles,
  ListTodo,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { exportCompleteProjectBundle } from "@/services/film-bundle";
import { VersionReleaseModal } from "@/components/layout/VersionReleaseModal";
import { isGuestIdentity, useOptionalAuth } from "@/components/auth/AuthGate";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { canManageAdmin } from "@/services/admin";
import type { UsageSnapshot } from "@/services/auth-session";
import { useI18n } from "@/i18n/I18nProvider";

function UsageSummary({ snapshot, label }: { snapshot: UsageSnapshot | null; label: string }) {
  if (!snapshot) {
    return <span className="ob-chip max-w-[15rem] whitespace-normal break-words leading-tight" title={label}>{label}</span>;
  }
  return (
    <span
      className="ob-chip max-w-[15rem] flex-wrap gap-x-1 gap-y-0.5 whitespace-normal leading-tight"
      title={label}
      aria-label={label}
    >
      <span className="whitespace-nowrap">{snapshot.plan || "free"}</span>
      <span aria-hidden="true">·</span>
      <span className="whitespace-nowrap">团队本月生成 {snapshot.generationThisMonth}/{snapshot.generationQuotaMonthly}</span>
      {typeof snapshot.credits === "number" ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="whitespace-nowrap">个人算力 {snapshot.credits}</span>
        </>
      ) : null}
    </span>
  );
}

export function TopNav({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const location = useLocation();
  const theme = useBoardStore((s) => s.config.theme);
  const setConfig = useBoardStore((s) => s.setConfig);
  const config = useBoardStore((s) => s.config);
  const setShowShortcuts = useBoardStore((s) => s.setShowShortcuts);
  const showLocalAgent = useBoardStore((s) => s.showLocalAgent);
  const setShowLocalAgent = useBoardStore((s) => s.setShowLocalAgent);
  const activeProject = useBoardStore((s) =>
    s.projects.find((project) => project.id === s.activeProjectId) ?? null);
  const [compactMenuOpen, setCompactMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  const auth = useOptionalAuth();
  // The server synthesizes a guest identity in optional mode, so a non-null
  // user does not mean somebody is actually signed in.
  const signedInUser = auth?.user && !isGuestIdentity(auth.user) ? auth.user : null;
  useEscapeDismiss(compactMenuOpen, () => setCompactMenuOpen(false), 40);
  useEscapeDismiss(mobileNavOpen, () => setMobileNavOpen(false), 35);

  // Close mobile nav on route change
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // A mobile drawer must never remain mounted over the desktop layout after a
  // viewport rotation or resize crosses the navigation breakpoint.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileNavOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  // Prevent background scrolling, move focus into the drawer, and restore the
  // exact prior state when the drawer closes.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => mobileCloseButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      if (mobileMenuButtonRef.current && document.contains(mobileMenuButtonRef.current)) {
        mobileMenuButtonRef.current.focus();
      }
    };
  }, [mobileNavOpen]);

  const trapMobileNavFocus = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(mobileNavRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setConfig({ ...config, theme: next });
    document.documentElement.classList.toggle("dark", next === "dark");
  }, [theme, config, setConfig]);

  const downloadActiveProject = useCallback(() => {
    if (!activeProject) return;
    void exportCompleteProjectBundle(activeProject)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${activeProject.title || "openboard"}.openboard`;
        anchor.click();
        URL.revokeObjectURL(url);
      })
      .catch((error) => alert(error instanceof Error ? error.message : String(error)));
  }, [activeProject]);

  const canManage = canManageAdmin(auth);
  const links = [
    { to: "/", label: t("nav.canvas"), icon: LayoutDashboard },
    { to: "/assets", label: t("nav.assets"), icon: Bookmark },
    { to: "/library", label: t("nav.serverLibrary"), ariaLabel: t("nav.serverLibrary"), icon: Library },
    { to: "/ai-logs", label: t("nav.aiLogs"), ariaLabel: t("nav.aiLogs"), icon: ScrollText },
    { to: "/prompts", label: t("nav.prompts"), ariaLabel: t("nav.prompts"), icon: Sparkles },
    { to: "/plugins", label: t("nav.plugins"), icon: Puzzle },
    { to: "/workbench/image", label: t("nav.workbench"), icon: WandSparkles },
    { to: "/tasks", label: t("nav.tasks"), icon: ListTodo },
    ...(canManage ? [{ to: "/admin", label: t("nav.admin"), icon: Settings }] : []),
  ];

  const isLinkActive = (to: string) =>
    location.pathname === to || (to.startsWith("/workbench") && location.pathname.startsWith("/workbench"));

  return (
    <>
      {/* ── Mobile slide-in navigation ── */}
      <div
        className="ob-mobile-nav-overlay"
        data-open={mobileNavOpen}
        onClick={() => setMobileNavOpen(false)}
        aria-hidden="true"
      />
      <nav
        ref={mobileNavRef}
        className="ob-mobile-nav-panel"
        data-open={mobileNavOpen}
        aria-label="移动端导航"
        aria-hidden={!mobileNavOpen}
        inert={!mobileNavOpen}
        role="navigation"
        onKeyDown={trapMobileNavFocus}
      >
        <div className="ob-mobile-nav-header">
          <span className="inline-grid h-8 w-8 place-items-center rounded-lg bg-[var(--ob-accent)] text-sm font-bold tracking-tight text-white shadow-[0_2px_8px_color-mix(in_srgb,var(--ob-accent)_40%,transparent)]">
            OB
          </span>
          <span className="flex-1 font-semibold tracking-tight text-[var(--ob-ink)]">OpenBoard</span>
          <button
            ref={mobileCloseButtonRef}
            type="button"
            className="ob-icon-btn"
            aria-label="关闭导航菜单"
            onClick={() => setMobileNavOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <div className="ob-mobile-nav-links">
          {links.map((l) => {
            const Icon = l.icon;
            const active = isLinkActive(l.to);
            return (
              <Link
                key={l.to}
                to={l.to}
                className="ob-mobile-nav-link"
                data-active={active}
                aria-label={"ariaLabel" in l ? l.ariaLabel : `${l.label}页面`}
                aria-current={active ? "page" : undefined}
              >
                <Icon size={18} />
                {l.label}
              </Link>
            );
          })}
        </div>

        {/* Tools section in mobile nav */}
        <div className="ob-mobile-nav-section">
          <div className="ob-mobile-nav-section-label">工具</div>
          {location.pathname === "/" ? (
            <button
              type="button"
              className="ob-mobile-nav-link"
              disabled={!activeProject}
              style={!activeProject ? { opacity: 0.4 } : undefined}
              onClick={() => {
                downloadActiveProject();
                setMobileNavOpen(false);
              }}
            >
              <Archive size={18} />
              导出当前画布
            </button>
          ) : null}
          <button
            type="button"
            className="ob-mobile-nav-link"
            data-active={showLocalAgent}
            onClick={() => {
              setShowLocalAgent(!showLocalAgent);
              setMobileNavOpen(false);
            }}
          >
            <Bot size={18} />
            画布 Agent
          </button>
          <button
            type="button"
            className="ob-mobile-nav-link"
            onClick={() => {
              setShowShortcuts(true);
              setMobileNavOpen(false);
            }}
          >
            <HelpCircle size={18} />
            快捷键
          </button>
          <Link
            to="/help"
            className="ob-mobile-nav-link"
            data-active={location.pathname === "/help"}
            onClick={() => setMobileNavOpen(false)}
          >
            <BookOpen size={18} />
            使用帮助
          </Link>
          <button
            type="button"
            className="ob-mobile-nav-link"
            onClick={() => {
              toggleTheme();
              setMobileNavOpen(false);
            }}
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            切换主题
          </button>
        </div>

        {/* User section in mobile nav */}
        {signedInUser ? (
          <div className="ob-mobile-nav-section">
            <div className="px-3 py-1.5 text-xs text-[var(--ob-muted)]">
              <div className="truncate font-medium text-[var(--ob-ink)]" title={signedInUser.email}>
                {signedInUser.displayName || signedInUser.email}
              </div>
              {auth?.usageLabel ? (
                <div className="mt-0.5 break-words whitespace-normal leading-relaxed" title={auth.usageLabel}>{auth.usageLabel}</div>
              ) : null}
            </div>
            <button
              type="button"
              className="ob-mobile-nav-link"
              onClick={() => {
                setMobileNavOpen(false);
                void auth?.logout();
              }}
            >
              <LogOut size={18} />
              退出登录
            </button>
          </div>
        ) : auth?.canLogin ? (
          <div className="ob-mobile-nav-section">
            <button
              type="button"
              className="ob-mobile-nav-link"
              onClick={() => {
                setMobileNavOpen(false);
                auth.requestLogin();
              }}
            >
              <LogIn size={18} />
              登录
            </button>
          </div>
        ) : null}

        {/* Version in mobile nav */}
        <div className="ob-mobile-nav-section">
          <VersionReleaseModal
            menuItem
            menuItemRole={false}
            onOpen={() => setMobileNavOpen(false)}
            onClose={() => mobileMenuButtonRef.current?.focus()}
          />
        </div>
      </nav>

      {/* ── Top header bar ── */}
      <header className="ob-header-glow relative z-[70] flex h-14 shrink-0 items-center gap-1 border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-1.5 shadow-[var(--ob-elev-1)] backdrop-blur-md sm:gap-2 sm:px-3 xl:gap-3 xl:px-4">
        {/* Left: Logo + Hamburger */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Hamburger — visible below md (768px) */}
          <button
            ref={mobileMenuButtonRef}
            type="button"
            className="ob-hamburger"
            aria-label="打开导航菜单"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
            <span className="inline-grid h-8 w-8 place-items-center rounded-lg bg-[var(--ob-accent)] text-sm font-bold tracking-tight text-white shadow-[0_2px_8px_color-mix(in_srgb,var(--ob-accent)_40%,transparent)]">
              OB
            </span>
            <span className="hidden text-[var(--ob-ink)] xl:inline">OpenBoard</span>
          </div>
        </div>

        {/* Center: Desktop navigation — hidden below md (768px) */}
        <nav className="ob-desktop-nav ob-toolbar-scroll min-w-0 flex-1 items-center gap-0.5 overflow-x-auto sm:ml-2 xl:ml-4">
          {links.map((l) => {
            const Icon = l.icon;
            const active = isLinkActive(l.to);
            return (
              <Link
                key={l.to}
                to={l.to}
                aria-label={"ariaLabel" in l ? l.ariaLabel : `${l.label}页面`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors duration-150 xl:px-3",
                  active
                    ? "bg-[var(--ob-accent-soft)] text-[var(--ob-accent)] shadow-sm ring-1 ring-[color-mix(in_srgb,var(--ob-accent)_18%,transparent)]"
                    : "text-[var(--ob-muted)] hover:bg-[var(--ob-accent-soft)] hover:text-[var(--ob-ink)]",
                )}
              >
                <Icon size={16} />
                <span className="ob-desktop-nav-label">{l.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Right: Tools + User */}
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
          {/* Full tools appear only when the complete desktop header fits. */}
          <div className="ob-global-tools hidden items-center gap-1 border-r border-[var(--ob-line)] pr-1.5" role="group" aria-label="全局工具">
            {location.pathname === "/" ? (
              <button
                type="button"
                className="ob-icon-btn disabled:opacity-40"
                title="导出当前画布包"
                aria-label="导出当前画布包"
                disabled={!activeProject}
                onClick={downloadActiveProject}
              >
                <Archive size={18} />
              </button>
            ) : null}
            <button
              type="button"
              className={cn("ob-icon-btn", showLocalAgent && "is-active")}
              title="画布 Agent"
              aria-label="画布 Agent"
              aria-controls="canvas-agent"
              aria-expanded={showLocalAgent}
              onClick={() => setShowLocalAgent(!showLocalAgent)}
            >
              <Bot size={18} />
            </button>
            <button
              type="button"
              className="ob-icon-btn"
              title="快捷键"
              aria-label="快捷键"
              onClick={() => setShowShortcuts(true)}
            >
              <HelpCircle size={18} />
            </button>
            <Link
              to="/help"
              className={cn("ob-icon-btn", location.pathname === "/help" && "is-active")}
              title="使用帮助"
              aria-label="打开使用帮助"
            >
              <BookOpen size={18} />
            </Link>
            <button
              type="button"
              className="ob-icon-btn"
              title="主题"
              aria-label="切换主题"
              onClick={toggleTheme}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <VersionReleaseModal />
          </div>

          {/* Tablet/compact-desktop Agent shortcut; mobile uses the drawer. */}
          <button
            type="button"
            className={cn("ob-icon-btn ob-agent-shortcut", showLocalAgent && "is-active")}
            title="画布 Agent"
            aria-label="画布 Agent"
            aria-controls="canvas-agent"
            aria-expanded={showLocalAgent}
            onClick={() => setShowLocalAgent(!showLocalAgent)}
          >
            <Bot size={18} />
          </button>

          {/* Compact menu is used until the full desktop tool group fits. */}
          <div className="ob-compact-menu hidden md:block">
            <button
              type="button"
              className="ob-icon-btn"
              title="更多"
              aria-haspopup="menu"
              aria-expanded={compactMenuOpen}
              onClick={() => setCompactMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={18} />
            </button>
            {compactMenuOpen ? (
              <>
                <button
                  type="button"
                  aria-label="关闭更多操作"
                  className="fixed inset-0 z-[80] cursor-default bg-transparent"
                  onClick={() => setCompactMenuOpen(false)}
                />
                <div
                  role="menu"
                  aria-label="更多操作"
                  className="ob-surface-glass absolute right-0 top-full z-[90] mt-1 w-48 p-1.5"
                >
                  {location.pathname === "/" ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!activeProject}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--ob-accent-soft)] disabled:opacity-40"
                      onClick={() => {
                        downloadActiveProject();
                        setCompactMenuOpen(false);
                      }}
                    >
                      <Archive size={16} />
                      导出当前画布
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--ob-accent-soft)]"
                    onClick={() => {
                      setShowShortcuts(true);
                      setCompactMenuOpen(false);
                    }}
                  >
                    <HelpCircle size={16} />
                    快捷键
                  </button>
                  <Link
                    to="/help"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--ob-accent-soft)]"
                    onClick={() => setCompactMenuOpen(false)}
                  >
                    <BookOpen size={16} />
                    使用帮助
                  </Link>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--ob-accent-soft)]"
                    onClick={() => {
                      toggleTheme();
                      setCompactMenuOpen(false);
                    }}
                  >
                    {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
                    切换主题
                  </button>
                  <div className="mt-1 border-t border-[var(--ob-line)] pt-1">
                    <VersionReleaseModal menuItem onClose={() => setCompactMenuOpen(false)} />
                  </div>
                  {signedInUser ? (
                    <div className="mt-1 border-t border-[var(--ob-line)] pt-1 xl:hidden">
                      <div className="px-3 py-1.5 text-xs text-[var(--ob-muted)]">
                        <div className="truncate font-medium text-[var(--ob-ink)]" title={signedInUser.email}>
                          {signedInUser.displayName || signedInUser.email}
                        </div>
                        {auth?.usageLabel ? (
                          <div className="mt-0.5 break-words whitespace-normal leading-relaxed" title={auth.usageLabel}>{auth.usageLabel}</div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--ob-accent-soft)]"
                        onClick={() => {
                          setCompactMenuOpen(false);
                          void auth?.logout();
                        }}
                      >
                        <LogOut size={16} />
                        退出登录
                      </button>
                    </div>
                  ) : auth?.canLogin ? (
                    <div className="mt-1 border-t border-[var(--ob-line)] pt-1 xl:hidden">
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--ob-accent-soft)]"
                        onClick={() => {
                          setCompactMenuOpen(false);
                          auth.requestLogin();
                        }}
                      >
                        <LogIn size={16} />
                        登录
                      </button>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>

          {/* User info + Settings */}
          <div className="flex items-center gap-1 sm:gap-1.5" role="group" aria-label="账号与设置">
            {signedInUser ? (
              <div className="hidden items-center gap-1.5 xl:flex">
                <span className="ob-chip max-w-[10rem] truncate" title={signedInUser.email}>
                  <UserRound size={12} className="mr-1 inline" />
                  {signedInUser.displayName || signedInUser.email}
                </span>
                {auth?.usageLabel ? (
                  <UsageSummary snapshot={auth.usageSnapshot} label={auth.usageLabel} />
                ) : null}
                <button
                  type="button"
                  className="ob-icon-btn"
                  title="退出登录"
                  aria-label="退出登录"
                  onClick={() => void auth?.logout()}
                >
                  <LogOut size={16} />
                </button>
              </div>
            ) : auth?.canLogin ? (
              <button
                type="button"
                className="ob-btn"
                title="登录"
                aria-label="登录"
                onClick={auth.requestLogin}
              >
                <LogIn size={16} className="mr-1 inline" />
                登录
              </button>
            ) : null}
            <button
              type="button"
              className="ob-icon-btn"
              title="设置"
              aria-label="打开设置"
              onClick={onOpenSettings}
            >
              <Settings size={18} />
            </button>
          </div>
        </div>
      </header>
    </>
  );
}
