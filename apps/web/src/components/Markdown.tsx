import { useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CopyButton } from "./CopyButton";

function safeUrl(url: string) {
  return URL.parse(url)?.protocol.match(/^https?:$/) ? url : "";
}

function ExternalLink({ href, label }: { href: string; label: React.ReactNode }) {
  return (
    <a href={href} title={href} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const block = useRef<HTMLPreElement>(null);
  return (
    <div className="relative">
      <pre ref={block} tabIndex={0}>
        {children}
      </pre>
      <div className="absolute top-1 right-1 rounded-field bg-code">
        <CopyButton label="Copy code" text={() => block.current?.textContent ?? ""} />
      </div>
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

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
