import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator } from "@/i18n/messages/agent-help";

export function AgentMarkdownMessage({ text }: { text: string }) {
  const { locale, t: baseT } = useI18n();
  const t = createAgentHelpTranslator(baseT, locale);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer" className="underline">{children}</a>
        ),
        img: () => <span>[{t("agent.imageAlt")}]</span>,
        pre: ({ children }) => (
          <pre
            data-agent-code-block
            className="max-w-full overflow-auto rounded bg-[var(--ob-accent-soft)] p-1 whitespace-pre"
          >
            {children}
          </pre>
        ),
        code: ({ children, className }) => (
          <code className={className}>{children}</code>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
