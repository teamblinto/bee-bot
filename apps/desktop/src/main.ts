import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, shell } from "electron";

import { startServer, stopServer } from "./server.ts";

const devServerUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;

// Windows drops notifications from an app whose ID doesn't match its Start Menu shortcut.
if (process.platform === "win32") {
  app.setAppUserModelId("com.teamblinto.beebot");
}

let connection: Awaited<ReturnType<typeof startServer>>;
let serverStopped = false;

function createWindow() {
  const window = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    minWidth: 360,
    minHeight: 620,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (["http:", "https:"].includes(URL.parse(url)?.protocol ?? "")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const query = { serverUrl: connection.url, token: connection.token };
  const webIndex = NodePath.join(
    __dirname,
    app.isPackaged ? "../web/index.html" : "../../web/dist/index.html",
  );
  const isApp = (url: URL | null) =>
    devServerUrl
      ? url?.origin === new URL(devServerUrl).origin
      : url?.protocol === "file:" && url.pathname === pathToFileURL(webIndex).pathname;
  window.webContents.on("will-navigate", (event) => {
    if (!isApp(URL.parse(event.url))) {
      event.preventDefault();
    }
  });

  if (devServerUrl) {
    void window.loadURL(`${devServerUrl}?${new URLSearchParams(query)}`);
  } else {
    void window.loadFile(webIndex, { query });
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
      fakeEngine: Boolean(devServerUrl),
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
