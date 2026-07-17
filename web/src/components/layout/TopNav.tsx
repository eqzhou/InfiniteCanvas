import { useBoardStore } from "@/stores/use-board-store";
import { Link, useLocation } from "react-router-dom";
import {
  Bookmark,
  Bot,
  HelpCircle,
  LayoutDashboard,
  MessageSquare,
  Moon,
  Puzzle,
  Settings,
  Sun,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";

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

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setConfig({ ...config, theme: next });
    document.documentElement.classList.toggle("dark", next === "dark");
  };

  const links = [
    { to: "/", label: "画布", icon: LayoutDashboard },
    { to: "/assets", label: "素材", icon: Bookmark },
    { to: "/prompts", label: "提示词", icon: Sparkles },
    { to: "/plugins", label: "插件", icon: Puzzle },
    { to: "/workbench/image", label: "工作台", icon: WandSparkles },
  ];

  return (
    <header className="flex h-14 items-center gap-1 border-b border-[var(--ob-line)] bg-[var(--ob-panel)] px-2 sm:gap-3 sm:px-4">
      <div className="flex items-center gap-2 font-semibold tracking-tight">
        <span className="inline-grid h-8 w-8 place-items-center rounded-md bg-[var(--ob-accent)] text-white">
          OB
        </span>
        <span className="hidden sm:inline">OpenBoard</span>
      </div>
      <nav className="flex items-center gap-0.5 sm:ml-4 sm:gap-1">
        {links.map((l) => {
          const Icon = l.icon;
          const active = location.pathname === l.to || (l.to.startsWith("/workbench") && location.pathname.startsWith("/workbench"));
          return (
            <Link
              key={l.to}
              to={l.to}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm sm:px-3",
                active
                  ? "bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]"
                  : "text-[var(--ob-muted)] hover:bg-[var(--ob-accent-soft)] hover:text-[var(--ob-ink)]",
              )}
            >
              <Icon size={16} />
              <span className="hidden sm:inline">{l.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          className="rounded-md p-1.5 hover:bg-[var(--ob-accent-soft)] sm:p-2"
          title="助手面板"
          onClick={() => setShowAssistant(!showAssistant)}
        >
          <MessageSquare size={18} />
        </button>
        <button
          type="button"
          className={`rounded-md p-1.5 hover:bg-[var(--ob-accent-soft)] sm:p-2 ${showLocalAgent ? "bg-[var(--ob-accent-soft)]" : ""}`}
          title="本地 Agent"
          onClick={() => setShowLocalAgent(!showLocalAgent)}
        >
          <Bot size={18} />
        </button>
        <button
          type="button"
          className="hidden rounded-md p-1.5 hover:bg-[var(--ob-accent-soft)] sm:block sm:p-2"
          title="快捷键"
          onClick={() => setShowShortcuts(true)}
        >
          <HelpCircle size={18} />
        </button>
        <button
          type="button"
          className="hidden rounded-md p-1.5 hover:bg-[var(--ob-accent-soft)] sm:block sm:p-2"
          title="主题"
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 hover:bg-[var(--ob-accent-soft)] sm:p-2"
          title="设置"
          onClick={onOpenSettings}
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}
