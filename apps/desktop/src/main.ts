import * as NodePath from "node:path";

import { app, BrowserWindow } from "electron";

function createWindow() {
  const window = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    minWidth: 840,
    minHeight: 620,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl && !app.isPackaged) {
    void window.loadURL(devServerUrl);
  } else {
    const webIndex = app.isPackaged ? "../web/index.html" : "../../web/dist/index.html";
    void window.loadFile(NodePath.join(__dirname, webIndex));
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

void app.whenReady().then(createWindow);
