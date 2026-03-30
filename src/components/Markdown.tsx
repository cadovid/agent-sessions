import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={`markdown-content ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-4 mb-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-4 mb-1">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          h1: ({ children }) => <h1 className="font-bold text-[1.1em] mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="font-bold text-[1.05em] mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="font-semibold mb-0.5">{children}</h3>,
          code: ({ className, children, ...props }) => {
            const isBlock = className?.includes('language-');
            if (isBlock) {
              return (
                <pre className="bg-muted/50 rounded px-2 py-1.5 my-1 overflow-x-auto text-[0.85em]">
                  <code className={className} {...props}>{children}</code>
                </pre>
              );
            }
            return (
              <code className="bg-muted/50 rounded px-1 py-0.5 text-[0.9em]" {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-muted-foreground/30 pl-2 my-1 text-muted-foreground">
              {children}
            </blockquote>
          ),
          a: ({ children }) => (
            <span className="text-blue-400 underline">{children}</span>
          ),
          table: ({ children }) => (
            <table className="border-collapse text-[0.85em] my-1">{children}</table>
          ),
          th: ({ children }) => (
            <th className="border border-border px-2 py-0.5 bg-muted/30 font-semibold text-left">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-0.5">{children}</td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
