import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("beeDesktop", {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pick-folder"),
});
