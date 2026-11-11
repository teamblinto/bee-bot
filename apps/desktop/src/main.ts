import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

import { type Command, protocolVersion } from "@beebot/contracts";
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  safeStorage,
  shell,
  Tray,
} from "electron";

import { watchNotices } from "./notices.ts";
import { sendIdle, sendPower, startServer, stopServer } from "./server.ts";
import { loadVaultKey } from "./vault.ts";

const devServerUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;

// The server inherits this: boxd's sources and the box image ship beside the app, not in a repo.
if (app.isPackaged) {
  process.env.BEEBOT_BOX_ROOT = NodePath.join(process.resourcesPath, "box");
}

// Windows drops notifications from an app whose ID doesn't match its Start Menu shortcut.
if (process.platform === "win32") {
  app.setAppUserModelId("com.teamblinto.beebot");
  // A bot uses this PC only while Bee Bot's window can be seen. Without this, Chromium calls a
  // window covered by the apps the bot opens hidden, and the bot would stop itself.
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

// Takes this PC back from whatever bot is using it, like the panel's Take control. Three modifiers
// and a letter: on every keyboard, reserved by nothing in Windows, and unlikely to clash with apps.
const stopShortcut = "Ctrl+Alt+Shift+X";

let connection: Awaited<ReturnType<typeof startServer>>;
let serverStopped = false;
let quitting = false;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let stopNotices: (() => void) | undefined;
let idleTimer: NodeJS.Timeout | undefined;
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

  const query = {
    serverUrl: connection.url,
    token: connection.token,
    ...(globalShortcut.isRegistered(stopShortcut) && { stopShortcut }),
  };
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

function takeHostBack() {
  const url = new URL("/commands", connection.url);
  url.searchParams.set("protocolVersion", String(protocolVersion));
  void fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "host-hold", held: true } satisfies Command),
  }).catch(() => {});
}

app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("before-quit", (event) => {
  quitting = true;
  if (serverStopped) {
    return;
  }
  event.preventDefault();
  stopNotices?.();
  clearInterval(idleTimer);
  void stopServer().finally(() => {
    serverStopped = true;
    app.quit();
  });
});

async function start() {
  // The server runs in the owner's session, so it can drive this desktop for `host` bots.
  const hostControl = true;
  const cuaDriver = NodePath.join(
    app.isPackaged ? process.resourcesPath : NodePath.join(__dirname, "../vendor"),
    "cua-driver",
    "cua-driver.exe",
  );
  const hasCuaDriver = process.platform === "win32" && NodeFS.existsSync(cuaDriver);
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
      hostControl,
      ...(hasCuaDriver && { cuaDriver }),
    });
  } catch {
    app.quit();
    return;
  }
  powerMonitor.on("suspend", () => sendPower("suspend"));
  powerMonitor.on("resume", () => sendPower("resume"));
  if (process.platform === "win32") {
    globalShortcut.register(stopShortcut, takeHostBack);
  }
  if (process.platform === "win32" && hostControl) {
    idleTimer = setInterval(() => sendIdle(powerMonitor.getSystemIdleTime()), 1000);
  }
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
