import { useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { Link, useLocation } from "react-router-dom";
import {
  Bookmark,
  Archive,
  Bot,
  HelpCircle,
  LayoutDashboard,
  MessageSquare,
  MoreHorizontal,
  Moon,
  Puzzle,
  Settings,
  LogOut,
  UserRound,
  Sun,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { exportProjectBundle } from "@/lib/project-bundle";
import { VersionReleaseModal } from "@/components/layout/VersionReleaseModal";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

export function TopNav({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const location = useLocation();
  const theme = useBoardStore((s) => s.config.theme);
  const setConfig = useBoardStore((s) => s.setConfig);
  const config = useBoardStore((s) => s.config);
  const showAssistant = useBoardStore((s) => s.showAssistant);
  const setShowAssistant = useBoardStore((s) => s.setShowAssistant);
  const setShowShortcuts = useBoardStore((s) => s.setShowShortcuts);
  const showLocalAgent = useBoardStore((s) => s.showLocalAgent);
  const setShowLocalAgent = useBoardStore((s) => s.setShowLocalAgent);
  const activeProject = useBoardStore((s) =>
    s.projects.find((project) => project.id === s.activeProjectId) ?? null);
  const [compactMenuOpen, setCompactMenuOpen] = useState(false);
  const auth = useOptionalAuth();
  useEscapeDismiss(compactMenuOpen, () => setCompactMenuOpen(false), 40);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setConfig({ ...config, theme: next });
    document.documentElement.classList.toggle("dark", next === "dark");
  };

  const downloadActiveProject = () => {
    if (!activeProject) return;
    void exportProjectBundle(activeProject)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${activeProject.title || "openboard"}.openboard`;
        anchor.click();
        URL.revokeObjectURL(url);
      })
      .catch((error) => alert(error instanceof Error ? error.message : String(error)));
  };

  const links = [
    { to: "/", label: "画布", icon: LayoutDashboard },
    { to: "/assets", label: "素材", icon: Bookmark },
    { to: "/prompts", label: "提示词", ariaLabel: "提示库页面", icon: Sparkles },
    { to: "/plugins", label: "插件", icon: Puzzle },
    { to: "/workbench/image", label: "工作台", icon: WandSparkles },
  ];

  return (
    <header className="relative z-[70] flex h-14 shrink-0 items-center gap-1 border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-2 shadow-[var(--ob-elev-1)] backdrop-blur-md sm:gap-2 sm:px-3 lg:gap-3 lg:px-4">
      <div className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
        <span className="inline-grid h-8 w-8 place-items-center rounded-lg bg-[var(--ob-accent)] text-sm font-bold tracking-tight text-white shadow-[0_2px_8px_color-mix(in_srgb,var(--ob-accent)_40%,transparent)]">
          OB
        </span>
        <span className="hidden text-[var(--ob-ink)] lg:inline">OpenBoard</span>
      </div>
      <nav className="ob-toolbar-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto sm:ml-2 lg:ml-4">
        {links.map((l) => {
          const Icon = l.icon;
          const active = location.pathname === l.to || (l.to.startsWith("/workbench") && location.pathname.startsWith("/workbench"));
          return (
            <Link
              key={l.to}
              to={l.to}
              aria-label={"ariaLabel" in l ? l.ariaLabel : `${l.label}页面`}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors duration-150 lg:px-3.5",
                active
                  ? "bg-[var(--ob-accent-soft)] text-[var(--ob-accent)] shadow-sm ring-1 ring-[color-mix(in_srgb,var(--ob-accent)_18%,transparent)]"
                  : "text-[var(--ob-muted)] hover:bg-[var(--ob-accent-soft)] hover:text-[var(--ob-ink)]",
              )}
            >
              <Icon size={16} />
              <span className="hidden xl:inline">{l.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
        {location.pathname === "/" ? (
          <button
            type="button"
            className="ob-icon-btn hidden disabled:opacity-40 lg:grid"
            title="导出当前画布包"
            disabled={!activeProject}
            onClick={downloadActiveProject}
          >
            <Archive size={18} />
          </button>
        ) : null}
        <button
          type="button"
          className={cn("ob-icon-btn", showAssistant && "is-active")}
          title="助手面板"
          aria-controls="canvas-assistant"
          aria-expanded={showAssistant}
          onClick={() => setShowAssistant(!showAssistant)}
        >
          <MessageSquare size={18} />
        </button>
        <button
          type="button"
          className={cn("ob-icon-btn hidden lg:grid", showLocalAgent && "is-active")}
          title="本地 Agent"
          onClick={() => setShowLocalAgent(!showLocalAgent)}
        >
          <Bot size={18} />
        </button>
        <button
          type="button"
          className="ob-icon-btn hidden lg:grid"
          title="快捷键"
          onClick={() => setShowShortcuts(true)}
        >
          <HelpCircle size={18} />
        </button>
        <button
          type="button"
          className="ob-icon-btn hidden lg:grid"
          title="主题"
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <div className="hidden lg:block">
          <VersionReleaseModal />
        </div>
        <div className="lg:hidden">
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
                className="ob-surface-glass fixed right-2 top-14 z-[90] w-48 p-1.5"
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
                    setShowLocalAgent(!showLocalAgent);
                    setCompactMenuOpen(false);
                  }}
                >
                  <Bot size={16} />
                  本地 Agent
                </button>
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
                {auth?.user ? (
                  <div className="mt-1 border-t border-[var(--ob-line)] pt-1">
                    <div className="px-3 py-1.5 text-xs text-[var(--ob-muted)]">
                      <div className="truncate font-medium text-[var(--ob-ink)]" title={auth.user.email}>
                        {auth.user.displayName || auth.user.email}
                      </div>
                      {auth.usageLabel ? (
                        <div className="mt-0.5 truncate" title={auth.usageLabel}>{auth.usageLabel}</div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--ob-accent-soft)]"
                      onClick={() => {
                        setCompactMenuOpen(false);
                        void auth.logout();
                      }}
                    >
                      <LogOut size={16} />
                      退出登录
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
        {auth?.user ? (
          <div className="hidden items-center gap-1.5 lg:flex">
            <span className="ob-chip max-w-[10rem] truncate" title={auth.user.email}>
              <UserRound size={12} className="mr-1 inline" />
              {auth.user.displayName || auth.user.email}
            </span>
            {auth.usageLabel ? (
              <span className="ob-chip max-w-[11rem] truncate" title={auth.usageLabel}>{auth.usageLabel}</span>
            ) : null}
            <button type="button" className="ob-icon-btn" title="退出登录" onClick={() => void auth.logout()}>
              <LogOut size={16} />
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="ob-icon-btn"
          title="设置"
          onClick={onOpenSettings}
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}
