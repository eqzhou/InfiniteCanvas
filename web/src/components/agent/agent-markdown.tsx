import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function AgentMarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer" className="underline">{children}</a>
        ),
        img: () => <span>[图片]</span>,
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
