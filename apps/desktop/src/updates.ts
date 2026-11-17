import { type DesktopUpdateState, ErrorName } from "@beebot/contracts";
import { app, dialog } from "electron";
import { autoUpdater } from "electron-updater";

import { sendUsage } from "./server.ts";

const firstCheckDelayMs = 10_000;
const checkIntervalMs = 4 * 60 * 60 * 1000;

let state: DesktopUpdateState = { status: "disabled" };
let checkedByUser = false;

export function updateState() {
  return state;
}

// The feed comes from app-update.yml, which electron-builder writes into a packaged app's resources.
export function startUpdates(onChange: (state: DesktopUpdateState) => void) {
  if (!app.isPackaged) {
    return;
  }
  const set = (next: DesktopUpdateState) => {
    state = next;
    onChange(state);
  };
  let version = "";
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => set({ status: "checking" }));
  autoUpdater.on("update-not-available", () => {
    set({ status: "idle" });
    if (checkedByUser) {
      void dialog.showMessageBox({ message: `Bee Bot ${app.getVersion()} is the latest version.` });
    }
  });
  autoUpdater.on("update-available", (info) => {
    version = info.version;
    set({ status: "downloading", version, percent: 0 });
  });
  autoUpdater.on("download-progress", ({ percent }) =>
    set({ status: "downloading", version, percent }),
  );
  autoUpdater.on("update-downloaded", (info) => set({ status: "ready", version: info.version }));
  autoUpdater.on("error", (error) => {
    console.error("Update failed:", error);
    const downloading = state.status === "downloading";
    const code = ErrorName.safeParse((error as NodeJS.ErrnoException).code);
    sendUsage("update_failed", {
      stage: downloading ? "download" : "check",
      code: code.success ? code.data : null,
    });
    const message = downloading
      ? "The update couldn't be downloaded."
      : "Couldn't check for updates.";
    // A background check that fails, offline most often, just waits for the next one.
    set({ status: "idle" });
    if (checkedByUser) {
      void dialog.showMessageBox({ type: "error", message, detail: error.message });
    }
  });
  set({ status: "idle" });
  setTimeout(() => checkForUpdates(false), firstCheckDelayMs);
  setInterval(() => checkForUpdates(false), checkIntervalMs);
}

export function checkForUpdates(byUser: boolean) {
  if (state.status !== "idle") {
    return;
  }
  checkedByUser = byUser;
  // Failures also arrive as the "error" event, which reports them.
  autoUpdater.checkForUpdates().catch(() => {});
}

export function quitAndInstall() {
  autoUpdater.quitAndInstall(true, true);
}
