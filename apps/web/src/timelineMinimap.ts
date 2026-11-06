import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { TranscriptItem } from "./transcript";

const itemSpacing = 8;
export const minimapMinItems = 2;
const maxHeightCss = "calc(100vh - 18rem)";
const persistentGutter = 48;
const hitStripLeft = 12;
const hitStripMaxWidth = 40;
const expandedHitStripWidth = "22rem";
const navigationReach = 14;
// The tooltip shows three lines. This bounds parsing work on a long reply.
const previewSourceChars = 1500;

export type MinimapItem = {
  id: string;
  userText: string;
  assistantText: string | null;
};

export function deriveMinimapItems(items: readonly TranscriptItem[]) {
  const derived: MinimapItem[] = [];
  for (const item of items) {
    if (item.kind !== "message") {
      continue;
    }
    const { id, author, body } = item.message;
    const turn = derived.at(-1);
    if (author === "human") {
      derived.push({ id, userText: body, assistantText: null });
    } else if (turn) {
      turn.assistantText = body;
    }
  }
  return derived;
}

export const minimapItemsEqual = (a: readonly MinimapItem[], b: readonly MinimapItem[]) =>
  a.length === b.length &&
  a.every(
    (item, index) =>
      item.id === b[index]?.id &&
      item.userText === b[index].userText &&
      item.assistantText === b[index].assistantText,
  );

const previewParser = unified().use(remarkParse).use(remarkGfm).freeze();

const inlineParents = new Set<Nodes["type"]>([
  "paragraph",
  "heading",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
]);

const blockTags =
  /^(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|th|thead|tr|ul)$/i;

function nodeText(node: Nodes): string {
  if (node.type === "html") {
    return node.value
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<\/?([a-z][\w-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (_, tag: string) =>
        blockTags.test(tag) ? " " : "",
      );
  }
  if (node.type === "break") {
    return " ";
  }
  if ("value" in node) {
    return node.value;
  }
  if (node.type === "image" || node.type === "imageReference") {
    return node.alt ?? "";
  }
  if (!("children" in node)) {
    return "";
  }
  return node.children.map(nodeText).join(inlineParents.has(node.type) ? "" : " ");
}

const compact = (text: string) => text.replace(/\s+/g, " ").trim();

// Plain text for the preview card, which React renders as text and never as markup.
export function minimapPreview({ userText, assistantText }: MinimapItem) {
  return {
    userText: compact(userText),
    assistantText:
      assistantText === null
        ? null
        : compact(nodeText(previewParser.parse(assistantText.slice(0, previewSourceChars)))) ||
          null,
  };
}

export function minimapHeightStyle(itemCount: number) {
  const natural = Math.max(1, (itemCount - 1) * itemSpacing);
  return `min(${natural}px, ${maxHeightCss})`;
}

export function minimapTopPercent(index: number, itemCount: number) {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function minimapIndexFromPointer({
  itemCount,
  railTop,
  railHeight,
  pointerY,
}: {
  itemCount: number;
  railTop: number;
  railHeight: number;
  pointerY: number;
}) {
  if (itemCount <= 0 || railHeight <= 0) {
    return null;
  }
  const progress = Math.max(0, Math.min(1, (pointerY - railTop) / railHeight));
  return Math.round(progress * (itemCount - 1));
}

export function minimapFisheyeClass(distance: number | null) {
  if (distance === 0) {
    return "scale-x-100";
  }
  if (distance === 1) {
    return "scale-x-[0.667]";
  }
  return distance === 2 ? "scale-x-[0.417]" : "scale-x-[0.333]";
}

// The first message on screen, otherwise the turn being read.
export function minimapCurrentIndex(
  rows: readonly { top: number; bottom: number }[],
  view: { top: number; bottom: number },
) {
  let preceding: number | null = null;
  for (const [index, row] of rows.entries()) {
    if (row.bottom > view.top) {
      return row.top < view.bottom ? index : preceding;
    }
    preceding = index;
  }
  return preceding;
}

const sideGutter = (viewportWidth: number, contentWidth: number) =>
  !Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth)
    ? 0
    : Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2);

export const minimapHasPersistentGutter = (viewportWidth: number, contentWidth: number) =>
  sideGutter(viewportWidth, contentWidth) >= persistentGutter;

export const minimapHitStripWidth = (viewportWidth: number, contentWidth: number) =>
  Math.max(
    0,
    Math.min(hitStripMaxWidth, Math.floor(sideGutter(viewportWidth, contentWidth)) - hitStripLeft),
  );

export const minimapNavigationInteractive = (collapsedWidth: number) =>
  collapsedWidth >= navigationReach;

export const minimapInteractiveWidth = (collapsedWidth: number, expanded: boolean) =>
  expanded ? expandedHitStripWidth : collapsedWidth;

export const minimapVisibilityClass = (persistent: boolean) =>
  persistent
    ? "opacity-100"
    : "hidden opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 [@media(pointer:fine)]:block";
