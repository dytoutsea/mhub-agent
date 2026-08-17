import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
  Tray,
} from "electron";

import { ActivationManager } from "./activation-manager";
import { DesktopAgentRuntime } from "./agent-runtime";
import {
  activationRequestSchema,
  activationResultSchema,
  agentEventSchema,
  agentSnapshotSchema,
  desktopChannels,
  hostInfoSchema,
  updateSnapshotSchema,
} from "./contracts";
import { FileDesktopPreferencesStore } from "./desktop-preferences";
import { prepareTrayIcon, revealDesktopWindow } from "./desktop-shell";
import { DesktopUpdater } from "./desktop-updater";
import { resolveRendererPath } from "./renderer-path";
import { SafeStorageSecretStore } from "./secure-store";
import { DesktopSystemLifecycle } from "./system-lifecycle";

let mainWindow: BrowserWindow | null = null;
let agentRuntime: DesktopAgentRuntime | null = null;
let activationManager: ActivationManager | null = null;
let tray: Tray | null = null;
let systemLifecycle: DesktopSystemLifecycle | null = null;
let desktopUpdater: DesktopUpdater | null = null;
let quitting = false;
let desktopReady = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mhub",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

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
    await systemLifecycle?.requestStart();
    return agentSnapshotSchema.parse(agentRuntime.getSnapshot());
  });
  ipcMain.handle(desktopChannels.agentStop, async () => {
    if (!agentRuntime) {
      throw new Error("AGENT_RUNTIME_UNAVAILABLE");
    }
    await systemLifecycle?.requestStop();
    return agentSnapshotSchema.parse(agentRuntime.getSnapshot());
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
    await systemLifecycle?.activated();
    return activationResultSchema.parse(activated.result);
  });
  ipcMain.handle(desktopChannels.updateGetState, () =>
    updateSnapshotSchema.parse(desktopUpdater?.getSnapshot()),
  );
  ipcMain.handle(desktopChannels.updateCheck, async () => {
    if (!desktopUpdater) {
      throw new Error("UPDATE_UNSUPPORTED");
    }
    return updateSnapshotSchema.parse(await desktopUpdater.check());
  });
  ipcMain.handle(desktopChannels.updateDownload, async () => {
    if (!desktopUpdater) {
      throw new Error("UPDATE_UNSUPPORTED");
    }
    return updateSnapshotSchema.parse(await desktopUpdater.download());
  });
  ipcMain.handle(desktopChannels.updateInstall, () => {
    if (!desktopUpdater) {
      throw new Error("UPDATE_UNSUPPORTED");
    }
    return updateSnapshotSchema.parse(desktopUpdater.install());
  });
}

function broadcastAgentState(snapshot: ReturnType<DesktopAgentRuntime["getSnapshot"]>) {
  const event = agentEventSchema.parse({ snapshot });
  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(desktopChannels.agentStateChanged, event);
  }
}

function broadcastUpdateState(snapshot: ReturnType<DesktopUpdater["getSnapshot"]>) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(desktopChannels.updateStateChanged, { snapshot });
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray || !agentRuntime) {
    return;
  }
  const snapshot = agentRuntime.getSnapshot();
  const canStart = snapshot.state === "stopped" || snapshot.state === "degraded";
  const canStop =
    snapshot.state === "online" ||
    snapshot.state === "connecting" ||
    snapshot.state === "backoff" ||
    snapshot.state === "paused";
  const updateSnapshot = desktopUpdater?.getSnapshot();
  const updateAction =
    updateSnapshot?.state === "available"
      ? {
          label: `下载更新 ${updateSnapshot.availableVersion ?? ""}`.trim(),
          action: () => void desktopUpdater?.download().catch(() => undefined),
        }
      : updateSnapshot?.state === "downloaded"
        ? { label: "安装已下载更新", action: () => desktopUpdater?.install() }
        : { label: "检查更新", action: () => void desktopUpdater?.check().catch(() => undefined) };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示黄雀云Agent",
        click: () => showMainWindow(),
      },
      { type: "separator" },
      {
        label:
          updateSnapshot?.state === "downloading" || updateSnapshot?.state === "checking"
            ? "正在检查更新..."
            : updateAction.label,
        enabled:
          Boolean(desktopUpdater) &&
          updateSnapshot?.state !== "downloading" &&
          updateSnapshot?.state !== "checking",
        click: updateAction.action,
      },
      { type: "separator" },
      {
        label: snapshot.state === "online" ? "代理在线" : `代理状态：${snapshot.state}`,
        enabled: false,
      },
      {
        label: "启动代理",
        enabled: canStart,
        click: () => void systemLifecycle?.requestStart().catch(() => undefined),
      },
      {
        label: "停止代理",
        enabled: canStop,
        click: () => void systemLifecycle?.requestStop(),
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => app.quit(),
      },
    ]),
  );
}

function showMainWindow() {
  revealDesktopWindow(mainWindow, () => void createMainWindow());
}

async function createTray() {
  if (tray) {
    return;
  }
  const trayIconPath = app.isPackaged
    ? path.join(process.resourcesPath, "tray", "mhub-agent.png")
    : path.join(app.getAppPath(), "assets", "mhub-agent.png");
  let trayIcon = prepareTrayIcon(nativeImage.createFromPath(trayIconPath), process.platform);
  if (!trayIcon) {
    try {
      trayIcon = prepareTrayIcon(
        await app.getFileIcon(process.execPath, { size: "small" }),
        process.platform,
      );
    } catch {
      trayIcon = null;
    }
  }
  if (!trayIcon) {
    return;
  }
  tray = new Tray(trayIcon);
  tray.setToolTip("黄雀云Agent");
  tray.on("click", showMainWindow);
  updateTrayMenu();
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

function applyLoginItem(enabled: boolean) {
  if (!app.isPackaged || hostPlatform() === "unsupported") {
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
}

function registerSystemLifecycleEvents() {
  powerMonitor.on("suspend", () => {
    void systemLifecycle?.suspend().catch(() => undefined);
  });
  powerMonitor.on("resume", () => {
    void systemLifecycle
      ?.networkChanged(net.isOnline())
      .then(() => systemLifecycle?.resume())
      .catch(() => undefined);
  });
  let previousOnline = net.isOnline();
  const networkTimer = setInterval(() => {
    const online = net.isOnline();
    if (online !== previousOnline) {
      previousOnline = online;
      void systemLifecycle?.networkChanged(online).catch(() => undefined);
    }
  }, 5_000);
  networkTimer.unref();
}

function registerRendererProtocol() {
  const rendererRoot = app.isPackaged
    ? path.join(process.resourcesPath, "renderer")
    : path.join(app.getAppPath(), "../mobile/dist");
  protocol.handle("mhub", (request) => {
    const resolvedPath = resolveRendererPath(rendererRoot, request.url);
    if (!resolvedPath) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(resolvedPath).toString());
  });
}

async function createMainWindow() {
  const window = new BrowserWindow({
    backgroundColor: "#f4f6f8",
    height: 720,
    minHeight: 600,
    minWidth: 760,
    show: false,
    title: "黄雀云Agent",
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
  window.on("close", (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  const developmentRendererUrl = process.env.MHUB_RENDERER_URL;
  if (!app.isPackaged && developmentRendererUrl) {
    await window.loadURL(developmentRendererUrl);
  } else {
    await window.loadURL("mhub://renderer/index.html");
  }

  mainWindow = window;
}

const ownsSingleInstanceLock = app.requestSingleInstanceLock();

if (!ownsSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (desktopReady) {
      showMainWindow();
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
    desktopUpdater = new DesktopUpdater({
      enabled: app.isPackaged,
      currentVersion: app.getVersion(),
      ...(process.env.MHUB_UPDATE_FEED_URL ? { feedUrl: process.env.MHUB_UPDATE_FEED_URL } : {}),
      onSnapshot: broadcastUpdateState,
    });
    systemLifecycle = new DesktopSystemLifecycle({
      runtime: () => agentRuntime,
      preferences: new FileDesktopPreferencesStore(
        path.join(app.getPath("userData"), "desktop-preferences.json"),
      ),
      applyLoginItem,
      isOnline: () => net.isOnline(),
    });
    registerIpcHandlers();
    registerRendererProtocol();
    enforceProductionContentSecurityPolicy();
    await createTray();
    registerSystemLifecycleEvents();
    await systemLifecycle.initialize().catch(() => undefined);
    await createMainWindow();
    desktopReady = true;

    app.on("activate", () => {
      showMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (!tray) {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    quitting = true;
    void agentRuntime?.stop();
    tray?.destroy();
    tray = null;
  });
}
