import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { iconProps } from "./ui";

export function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className="button !min-h-8 !px-2 text-ink-secondary"
      aria-label={copied ? "Copied" : label}
      onClick={() => void copy()}
    >
      {copied ? <Check {...iconProps} /> : <Copy {...iconProps} />}
    </button>
  );
}
