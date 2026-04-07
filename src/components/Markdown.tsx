import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';

interface MarkdownProps {
  children: string;
  className?: string;
}

// Preprocess: wrap bare absolute file paths in markdown links (outside code blocks)
function linkifyFilePaths(text: string): string {
  // Don't modify content inside code fences
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts
    .map((part, i) => {
      // Odd indices are code blocks/spans — leave untouched
      if (i % 2 === 1) return part;
      // Match absolute paths (not already inside markdown links)
      return part.replace(
        /(?<!\[)(?<!\()(\/(home|etc|usr|var|tmp|opt|mnt|srv|root|nix)\/[^\s),\]'"]+)/g,
        '[$1](file://$1)'
      );
    })
    .join('');
}

export function Markdown({ children, className }: MarkdownProps) {
  const processed = linkifyFilePaths(children);

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
            const hasNewlines = typeof children === 'string' && children.includes('\n');
            const isBlock = className?.includes('language-') || hasNewlines;
            const isDiff = className?.includes('language-diff');

            if (isBlock && isDiff && typeof children === 'string') {
              // Render diff with colored lines
              const lines = children.split('\n');
              return (
                <pre className="bg-muted/50 rounded px-2 py-1.5 my-1 overflow-x-auto text-[0.85em]">
                  <code>
                    {lines.map((line, i) => {
                      let lineClass = '';
                      if (line.startsWith('+ ') || line.startsWith('+\t')) lineClass = 'text-emerald-400 bg-emerald-400/10';
                      else if (line.startsWith('- ') || line.startsWith('-\t')) lineClass = 'text-red-400 bg-red-400/10';
                      else if (line.startsWith('@@')) lineClass = 'text-blue-400';
                      else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) lineClass = 'text-muted-foreground';
                      return lineClass
                        ? <div key={i} className={lineClass}>{line}</div>
                        : <span key={i}>{line}{i < lines.length - 1 ? '\n' : ''}</span>;
                    })}
                  </code>
                </pre>
              );
            }

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
          a: ({ href, children }) => {
            const handleClick = async (e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              if (!href) return;
              if (href.startsWith('file://')) {
                const path = href.replace('file://', '');
                await invoke('open_in_editor', { path }).catch(console.error);
              } else {
                await openUrl(href).catch(console.error);
              }
            };
            const isFile = href?.startsWith('file://');
            return (
              <span
                className={`underline cursor-pointer hover:opacity-80 ${isFile ? 'text-emerald-400' : 'text-blue-400'}`}
                onClick={handleClick}
                title={href}
              >
                {children}
              </span>
            );
          },
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
        {processed}
      </ReactMarkdown>
    </div>
  );
}
