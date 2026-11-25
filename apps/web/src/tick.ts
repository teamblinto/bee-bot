import { formatElapsed } from "./labels";

const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  subscribers.add(listener);
  timer ??= setInterval(() => subscribers.forEach((notify) => notify()), 1000);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

// A ref callback: a ticking label writes to the DOM, so it never re-renders the transcript.
function tickText(text: () => string) {
  return (node: HTMLElement | null) => {
    if (!node) {
      return undefined;
    }
    const write = () => {
      node.textContent = text();
    };
    write();
    return subscribe(write);
  };
}

export const tickElapsed = (startedAt: string) =>
  tickText(() => formatElapsed(Date.now() - Date.parse(startedAt)));

export const tickRemaining = (endsAt: string) =>
  tickText(() => formatElapsed(Date.parse(endsAt) - Date.now()));
