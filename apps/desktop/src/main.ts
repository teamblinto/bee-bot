import * as NodePath from "node:path";

import { app, BrowserWindow } from "electron";

import { startServer, stopServer } from "./server.ts";

const devServerUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;

let connection: Awaited<ReturnType<typeof startServer>>;
let serverStopped = false;

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

  const query = { serverUrl: connection.url, token: connection.token };
  if (devServerUrl) {
    void window.loadURL(`${devServerUrl}?${new URLSearchParams(query)}`);
  } else {
    const webIndex = app.isPackaged ? "../web/index.html" : "../../web/dist/index.html";
    void window.loadFile(NodePath.join(__dirname, webIndex), { query });
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (connection && BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", (event) => {
  if (serverStopped) {
    return;
  }
  event.preventDefault();
  void stopServer().finally(() => {
    serverStopped = true;
    app.quit();
  });
});

async function start() {
  try {
    connection = await startServer({
      entry: NodePath.join(
        __dirname,
        app.isPackaged ? "../server/index.cjs" : "../../server/dist/index.cjs",
      ),
      dataDir: NodePath.join(app.getPath("userData"), "server"),
      allowedOrigins: [devServerUrl ? new URL(devServerUrl).origin : "file://"],
    });
  } catch {
    app.quit();
    return;
  }
  createWindow();
}

// One server per database: a second one would write events this one never broadcasts.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    window?.show();
    window?.focus();
  });
  void app.whenReady().then(start);
} else {
  app.quit();
}
