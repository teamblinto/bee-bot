import type { DesktopUpdateState } from "@beebot/contracts";
import { useEffect, useState } from "react";

declare global {
  interface Window {
    // Set by the desktop app's preload. A plain browser has none; older desktop builds lack updates.
    beeDesktop?: {
      pickFolder: () => Promise<string | null>;
      updates?: {
        getState: () => Promise<DesktopUpdateState>;
        onState: (listener: (state: DesktopUpdateState) => void) => () => void;
        install: () => Promise<void>;
      };
    };
  }
}

export function useDesktopUpdate() {
  const [state, setState] = useState<DesktopUpdateState>();
  useEffect(() => {
    const updates = window.beeDesktop?.updates;
    if (!updates) {
      return;
    }
    const unsubscribe = updates.onState(setState);
    void updates.getState().then((initial) => setState((pushed) => pushed ?? initial));
    return unsubscribe;
  }, []);
  return state;
}
