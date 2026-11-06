import type { Bot } from "@beebot/contracts";
import type { CSSProperties } from "react";

function hue(id: string) {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return hash;
}

export function Avatar({ bot, className = "size-8" }: { bot: Bot; className?: string }) {
  return (
    <span
      aria-hidden
      className={`avatar flex shrink-0 items-center justify-center rounded-full text-name font-medium ${className}`}
      style={{ "--hue": hue(bot.id) } as CSSProperties}
    >
      {[...bot.name][0]?.toUpperCase()}
    </span>
  );
}
