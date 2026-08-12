import path from "node:path";
import { app, BrowserWindow, ipcMain, session, shell } from "electron";

import { ActivationManager } from "./activation-manager";
import { DesktopAgentRuntime } from "./agent-runtime";
import {
  activationRequestSchema,
  activationResultSchema,
  agentEventSchema,
  agentSnapshotSchema,
  desktopChannels,
  hostInfoSchema,
} from "./contracts";
import { SafeStorageSecretStore } from "./secure-store";

let mainWindow: BrowserWindow | null = null;
let agentRuntime: DesktopAgentRuntime | null = null;
let activationManager: ActivationManager | null = null;

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
  ipcMain.handle(desktopChannels.agentGetState, () =>
    agentSnapshotSchema.parse(agentRuntime?.getSnapshot()),
  );
  ipcMain.handle(desktopChannels.agentStart, async () => {
    if (!agentRuntime) {
      throw new Error("AGENT_RUNTIME_UNAVAILABLE");
    }
    return agentSnapshotSchema.parse(await agentRuntime.start());
  });
  ipcMain.handle(desktopChannels.agentStop, async () => {
    if (!agentRuntime) {
      throw new Error("AGENT_RUNTIME_UNAVAILABLE");
    }
    return agentSnapshotSchema.parse(await agentRuntime.stop());
  });
  ipcMain.handle(desktopChannels.agentActivate, async (_event, payload: unknown) => {
    if (!activationManager) {
      throw new Error("ACTIVATION_CONFIGURATION_REQUIRED");
    }
    const request = activationRequestSchema.parse(payload);
    const activated = await activationManager.activate(request.activationCode);
    await agentRuntime?.stop();
    agentRuntime = new DesktopAgentRuntime(hostPlatform(), activated.config);
    agentRuntime.subscribe(broadcastAgentState);
    return activationResultSchema.parse(activated.result);
  });
}

function broadcastAgentState(snapshot: ReturnType<DesktopAgentRuntime["getSnapshot"]>) {
  const event = agentEventSchema.parse({ snapshot });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(desktopChannels.agentStateChanged, event);
  }
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
    const controlUrl = process.env.MHUB_RELAY_CONTROL_URL?.trim();
    const activationApiUrl = process.env.MHUB_AGENT_ACTIVATION_API_URL?.trim();
    const platform = hostPlatform();
    if (controlUrl && activationApiUrl && platform !== "unsupported") {
      activationManager = new ActivationManager({
        apiUrl: activationApiUrl,
        controlUrl,
        platform,
        store: new SafeStorageSecretStore(
          path.join(app.getPath("userData"), "agent-credentials.enc"),
        ),
      });
      try {
        const config = await activationManager.loadRuntimeConfig();
        agentRuntime = new DesktopAgentRuntime(hostPlatform(), config);
      } catch {
        agentRuntime = new DesktopAgentRuntime(hostPlatform(), null);
      }
    } else {
      agentRuntime = new DesktopAgentRuntime(hostPlatform());
    }
    agentRuntime.subscribe(broadcastAgentState);
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

  app.on("before-quit", () => {
    void agentRuntime?.stop();
  });
}
