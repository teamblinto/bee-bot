import { useState } from "react";

import { Tooltip } from "./Tooltip";

const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";

// Stable for a value, so the blur doesn't flicker on re-render. While hidden, the real value is not
// in the page at all, so a screenshot or screen share can't recover it from under the blur.
export function redactedPlaceholder(value: string) {
  let state = 0x811c9dc5;
  for (const char of value) {
    state = Math.imul(state ^ (char.codePointAt(0) ?? 0), 0x01000193);
  }
  return Array.from(value, (char) => {
    if ("@.-_".includes(char)) {
      return char;
    }
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return alphabet[Math.abs(state) % alphabet.length];
  }).join("");
}

export function RedactedText({ value, label }: { value: string; label: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Tooltip label={revealed ? `Hide ${label}` : `Show ${label}`}>
      <button
        type="button"
        aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
        aria-pressed={revealed}
        className={`min-w-0 truncate rounded-sm font-mono text-label transition hover:text-ink ${revealed ? "text-ink-secondary" : "text-ink-secondary blur-xs select-none"}`}
        onClick={() => setRevealed((shown) => !shown)}
      >
        {revealed ? value : redactedPlaceholder(value)}
      </button>
    </Tooltip>
  );
}
