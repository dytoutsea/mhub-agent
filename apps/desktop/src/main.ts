import path from "node:path";
import { app, BrowserWindow, ipcMain, session, shell } from "electron";

import { desktopChannels, hostInfoSchema } from "./contracts";

let mainWindow: BrowserWindow | null = null;

function hostPlatform(): "windows" | "macos" | "unsupported" {
  if (process.platform === "win32") {
    return "windows";
  }
  if (process.platform === "darwin") {
    return "macos";
  }
  return "unsupported";
}

function registerIpcHandlers() {
  ipcMain.handle(desktopChannels.getHostInfo, () =>
    hostInfoSchema.parse({
      appVersion: app.getVersion(),
      platform: hostPlatform(),
    }),
  );
}

function enforceProductionContentSecurityPolicy() {
  if (!app.isPackaged) {
    return;
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        ],
      },
    });
  });
}

async function createMainWindow() {
  const window = new BrowserWindow({
    backgroundColor: "#f4f6f8",
    height: 720,
    minHeight: 600,
    minWidth: 760,
    show: false,
    title: "MHub Agent",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
    },
    width: 1040,
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === "https:") {
        void shell.openExternal(url);
      }
    } catch {
      // Invalid and non-HTTPS URLs stay blocked.
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });

  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  const developmentRendererUrl = process.env.MHUB_RENDERER_URL;
  if (!app.isPackaged && developmentRendererUrl) {
    await window.loadURL(developmentRendererUrl);
  } else {
    const rendererPath = app.isPackaged
      ? path.join(process.resourcesPath, "renderer", "index.html")
      : path.join(app.getAppPath(), "../mobile/dist/index.html");
    await window.loadFile(rendererPath);
  }

  mainWindow = window;
}

const ownsSingleInstanceLock = app.requestSingleInstanceLock();

if (!ownsSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpcHandlers();
    enforceProductionContentSecurityPolicy();
    await createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
