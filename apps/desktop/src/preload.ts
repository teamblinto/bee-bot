import type { DesktopUpdateState } from "@beebot/contracts";
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("beeDesktop", {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pick-folder"),
  updates: {
    getState: (): Promise<DesktopUpdateState> => ipcRenderer.invoke("update-state"),
    onState: (listener: (state: DesktopUpdateState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) =>
        listener(state);
      ipcRenderer.on("update-state-changed", handler);
      return () => {
        ipcRenderer.off("update-state-changed", handler);
      };
    },
    install: (): Promise<void> => ipcRenderer.invoke("update-install"),
  },
});
