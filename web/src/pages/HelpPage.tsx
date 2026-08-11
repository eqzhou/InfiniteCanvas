import {
  Bot,
  Boxes,
  Clapperboard,
  KeyRound,
  LayoutDashboard,
  Library,
  MessageSquareText,
  ShieldCheck,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";

import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator, type AgentHelpMessageKey } from "@/i18n/messages/agent-help";

type HelpSection = {
  id: string;
  title: string;
  summary: string;
  steps: readonly string[];
  note?: string;
  links?: readonly { href: string; label: string }[];
  icon: LucideIcon;
};

type HelpTranslator = (key: AgentHelpMessageKey, params?: Readonly<Record<string, string | number>>) => string;

export const HELP_SECTION_IDS = [
  "signin", "canvas", "nodes", "prompts", "assets", "workbench", "agent-skills", "director", "auth-modes",
] as const;

export function getHelpSections(t: HelpTranslator): readonly HelpSection[] {
  return [
    {
      id: "signin", title: t("help.signin.title"), summary: t("help.signin.summary"),
      steps: [t("help.signin.step1"), t("help.signin.step2"), t("help.signin.step3")],
      note: t("help.signin.note"), links: [{ href: "/", label: t("help.signin.link") }], icon: KeyRound,
    },
    {
      id: "canvas", title: t("help.canvas.title"), summary: t("help.canvas.summary"),
      steps: [t("help.canvas.step1"), t("help.canvas.step2"), t("help.canvas.step3")],
      note: t("help.canvas.note"), links: [{ href: "/", label: t("help.canvas.link") }], icon: LayoutDashboard,
    },
    {
      id: "nodes", title: t("help.nodes.title"), summary: t("help.nodes.summary"),
      steps: [t("help.nodes.step1"), t("help.nodes.step2"), t("help.nodes.step3")],
      note: t("help.nodes.note"), icon: Boxes,
    },
    {
      id: "prompts", title: t("help.prompts.title"), summary: t("help.prompts.summary"),
      steps: [t("help.prompts.step1"), t("help.prompts.step2"), t("help.prompts.step3")],
      note: t("help.prompts.note"), links: [{ href: "/prompts", label: t("help.prompts.link") }], icon: MessageSquareText,
    },
    {
      id: "assets", title: t("help.assets.title"), summary: t("help.assets.summary"),
      steps: [t("help.assets.step1"), t("help.assets.step2"), t("help.assets.step3")],
      note: t("help.assets.note"),
      links: [{ href: "/assets", label: t("help.assets.link") }, { href: "/library", label: t("help.assets.serverLink") }], icon: Library,
    },
    {
      id: "workbench", title: t("help.workbench.title"), summary: t("help.workbench.summary"),
      steps: [t("help.workbench.step1"), t("help.workbench.step2"), t("help.workbench.step3"), t("help.workbench.step4"), t("help.workbench.step5")],
      note: t("help.workbench.note"),
      links: [
        { href: "/workbench/image", label: t("help.workbench.imageLink") },
        { href: "/workbench/video", label: t("help.workbench.videoLink") },
        { href: "/workbench/workflows", label: t("help.workbench.workflowLink") },
      ], icon: WandSparkles,
    },
    {
      id: "agent-skills", title: t("help.agent.title"), summary: t("help.agent.summary"),
      steps: [t("help.agent.step1"), t("help.agent.step2"), t("help.agent.step3"), t("help.agent.step4")],
      note: t("help.agent.note"), links: [{ href: "/", label: t("help.agent.link") }], icon: Bot,
    },
    {
      id: "director", title: t("help.director.title"), summary: t("help.director.summary"),
      steps: [t("help.director.step1"), t("help.director.step2"), t("help.director.step3")],
      note: t("help.director.note"), links: [{ href: "/", label: t("help.director.link") }], icon: Clapperboard,
    },
    {
      id: "auth-modes", title: t("help.authModes.title"), summary: t("help.authModes.summary"),
      steps: [t("help.authModes.step1"), t("help.authModes.step2"), t("help.authModes.step3")],
      note: t("help.authModes.note"), icon: ShieldCheck,
    },
  ];
}

export function HelpPage() {
  const { locale, t: baseT } = useI18n();
  const t = createAgentHelpTranslator(baseT, locale);
  const sections = getHelpSections(t);

  return (
    <div className="h-full overflow-y-auto bg-[var(--ob-bg)]" aria-labelledby="help-title">
      <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 sm:px-6 sm:py-9 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10 lg:px-8">
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ob-accent)]">{t("help.guide")}</p>
          <h1 id="help-title" className="mt-2 text-2xl font-bold tracking-tight text-[var(--ob-ink)] sm:text-3xl">{t("help.title")}</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--ob-muted)]">{t("help.description")}</p>
          <nav aria-label={t("help.topics")} className="ob-card mt-5 flex gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible">
            {sections.map(({ id, title }) => (
              <a key={id} href={`#${id}`} className="shrink-0 rounded-lg px-3 py-2 text-sm text-[var(--ob-muted)] transition-colors hover:bg-[var(--ob-accent-soft)] hover:text-[var(--ob-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ob-accent)]">{title}</a>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 space-y-5">
          <section aria-label={t("help.quickStart")} className="ob-card overflow-hidden p-5 sm:p-7">
            <div className="grid gap-5 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <h2 className="text-lg font-semibold text-[var(--ob-ink)]">{t("help.firstTime")}</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ob-muted)]">{t("help.firstTimeDescription")}</p>
              </div>
              <Link to="/" className="ob-btn-primary justify-center whitespace-nowrap px-4 py-2 text-sm font-medium">{t("help.enterCanvas")}</Link>
            </div>
          </section>

          {sections.map(({ id, title, summary, steps, note, links, icon: Icon }) => (
            <section key={id} id={id} aria-labelledby={`${id}-title`} className="ob-card scroll-mt-6 p-5 sm:p-7">
              <div className="flex items-start gap-3">
                <span aria-hidden="true" className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]"><Icon size={18} /></span>
                <div className="min-w-0">
                  <h2 id={`${id}-title`} className="text-lg font-semibold text-[var(--ob-ink)]">{title}</h2>
                  <p className="mt-1.5 text-sm leading-6 text-[var(--ob-muted)]">{summary}</p>
                </div>
              </div>
              <ol className="mt-5 space-y-3 pl-1">
                {steps.map((step, index) => (
                  <li key={step} className="flex gap-3 text-sm leading-6 text-[var(--ob-ink)]">
                    <span aria-hidden="true" className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--ob-accent-soft)] text-xs font-semibold text-[var(--ob-accent)]">{index + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              {note ? <p className="mt-5 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] px-3.5 py-3 text-sm leading-6 text-[var(--ob-muted)]"><strong className="font-semibold text-[var(--ob-ink)]">{t("help.note")}</strong>{note}</p> : null}
              {links?.length ? (
                <div className="mt-5 flex flex-wrap gap-2" aria-label={t("help.relatedPages", { title })}>
                  {links.map((link) => <Link key={link.href} to={link.href} className="ob-btn px-3 py-1.5 text-sm">{link.label}</Link>)}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
