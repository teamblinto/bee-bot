import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Children, isValidElement, type ReactNode, useEffect, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { highlight } from "../highlight";
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

function fence(children: ReactNode) {
  const code = Children.toArray(children)[0];
  const props = isValidElement<{ className?: string; children?: ReactNode }>(code)
    ? code.props
    : {};
  return {
    language: /(?:^|\s)language-(\S+)/.exec(props.className ?? "")?.[1] ?? "text",
    text: typeof props.children === "string" ? props.children.replace(/\n$/, "") : undefined,
  };
}

type Highlighted = Awaited<ReturnType<typeof highlight>>;

// Shiki's tree holds only spans and text, so it renders as React elements, never as HTML.
function CodeBlock({ children, colored = false }: { children?: ReactNode; colored?: boolean }) {
  const block = useRef<HTMLPreElement>(null);
  const { language, text } = fence(children);
  const [result, setResult] = useState<{ text: string; language: string; tree: Highlighted }>();
  useEffect(() => {
    if (colored && text !== undefined) {
      highlight(text, language).then(
        (tree) => setResult({ text, language, tree }),
        () => {},
      );
    }
  }, [colored, language, text]);
  // A late answer for older text is ignored.
  const tree =
    result && result.text === text && result.language === language ? result.tree : undefined;
  return (
    <div className="code-block">
      <div className="flex h-8 items-center justify-between gap-2 border-b border-edge-subtle pr-1 pl-3 select-none">
        <span className="truncate text-caption text-ink-secondary">{language}</span>
        <CopyButton label="Copy code" text={() => block.current?.textContent ?? ""} />
      </div>
      <pre ref={block} tabIndex={0} className="pt-3">
        {tree ? toJsxRuntime(tree, { Fragment, jsx, jsxs }) : children}
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

// Streaming text changes every batch, so only a finished message is colored.
const finishedComponents: Components = {
  ...components,
  pre: ({ children }) => <CodeBlock colored>{children}</CodeBlock>,
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
      <ReactMarkdown
        remarkPlugins={finishedPlugins}
        urlTransform={safeUrl}
        components={finishedComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
