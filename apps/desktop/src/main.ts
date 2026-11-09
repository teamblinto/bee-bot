import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  safeStorage,
  shell,
  Tray,
} from "electron";

import { watchNotices } from "./notices.ts";
import { sendPower, startServer, stopServer } from "./server.ts";
import { loadVaultKey } from "./vault.ts";

const devServerUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;

// The server inherits this: boxd's sources and the box image ship beside the app, not in a repo.
if (app.isPackaged) {
  process.env.BEEBOT_BOX_ROOT = NodePath.join(process.resourcesPath, "box");
}

// Windows drops notifications from an app whose ID doesn't match its Start Menu shortcut.
if (process.platform === "win32") {
  app.setAppUserModelId("com.teamblinto.beebot");
}

let connection: Awaited<ReturnType<typeof startServer>>;
let serverStopped = false;
let quitting = false;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let stopNotices: (() => void) | undefined;
// Electron drops a notification's click handler once nothing holds the notification.
const shownNotifications = new Set<Notification>();

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
  mainWindow = window;

  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
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

function openWindow() {
  if (!connection) {
    return;
  }
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

// A honey-coloured dot, drawn here so the tray needs no image asset.
function trayIcon() {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= size / 2 - 1) {
        pixels.set([0x1a, 0xb3, 0xf5, 0xff], (y * size + x) * 4);
      }
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("Bee Bot");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Bee Bot", click: openWindow },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", openWindow);
}

// Listening keeps Electron from quitting with the last window: the tray decides when to quit.
app.on("window-all-closed", () => {});

app.on("activate", openWindow);

app.on("before-quit", (event) => {
  quitting = true;
  if (serverStopped) {
    return;
  }
  event.preventDefault();
  stopNotices?.();
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
      vault: await loadVaultKey(safeStorage, NodePath.join(app.getPath("userData"), "vault-key")),
    });
  } catch {
    app.quit();
    return;
  }
  powerMonitor.on("suspend", () => sendPower("suspend"));
  powerMonitor.on("resume", () => sendPower("resume"));
  createTray();
  createWindow();
  stopNotices = watchNotices(connection.url, connection.token, ({ title, body }) => {
    if (!Notification.isSupported() || BrowserWindow.getFocusedWindow()) {
      return;
    }
    const notification = new Notification({ title, body });
    notification.on("click", openWindow);
    notification.on("close", () => shownNotifications.delete(notification));
    notification.show();
    shownNotifications.add(notification);
  });
}

// One server per database: a second one would write events this one never broadcasts.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", openWindow);
  void app.whenReady().then(start);
} else {
  app.quit();
}
