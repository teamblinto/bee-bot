import { Children, isValidElement, type ReactNode, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { createIncrementalMarkdownPlugin } from "../markdown-incremental";
import { CopyButton } from "./CopyButton";

function safeUrl(url: string) {
  return URL.parse(url)?.protocol.match(/^https?:$/) ? url : "";
}

function ExternalLink({ href, label }: { href: string; label: ReactNode }) {
  return (
    <a href={href} title={href} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}

function fenceLanguage(children: ReactNode) {
  const code = Children.toArray(children)[0];
  const className = isValidElement<{ className?: string }>(code) ? code.props.className : undefined;
  return /(?:^|\s)language-(\S+)/.exec(className ?? "")?.[1] ?? "text";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const block = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <div className="flex items-center justify-between gap-2 pt-1 pr-1 pl-3 select-none">
        <span className="truncate font-mono text-micro text-ink-faint">
          {fenceLanguage(children)}
        </span>
        <CopyButton label="Copy code" text={() => block.current?.textContent ?? ""} />
      </div>
      <pre ref={block} tabIndex={0}>
        {children}
      </pre>
    </div>
  );
}

// `urlTransform` has already emptied every URL that isn't http or https.
const components: Components = {
  a: ({ href, children }) =>
    href ? <ExternalLink href={href} label={children} /> : <span>{children}</span>,
  // Images never load: a model-written image URL can leak data.
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <ExternalLink href={src} label={`${alt || "Image link"} (${URL.parse(src)?.host})`} />
    ) : (
      <span>{alt}</span>
    ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

const finishedPlugins = [remarkGfm];

function StreamingMarkdown({ text }: { text: string }) {
  // One cache per stream: a finished fence is parsed once, not again on every batch of text.
  const [plugins] = useState(() => [remarkGfm, createIncrementalMarkdownPlugin()]);
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={plugins} urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  if (streaming) {
    return <StreamingMarkdown text={text} />;
  }
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={finishedPlugins} urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
