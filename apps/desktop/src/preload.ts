import { contextBridge, ipcRenderer } from "electron";

import {
  activationRequestSchema,
  activationResultSchema,
  agentEventSchema,
  agentSnapshotSchema,
  desktopChannels,
  hostInfoSchema,
  updateEventSchema,
  updateSnapshotSchema,
} from "./contracts";

const desktopApi = Object.freeze({
  getHostInfo: async () =>
    hostInfoSchema.parse(await ipcRenderer.invoke(desktopChannels.getHostInfo)),
  agent: Object.freeze({
    activate: async (payload: unknown) =>
      activationResultSchema.parse(
        await ipcRenderer.invoke(
          desktopChannels.agentActivate,
          activationRequestSchema.parse(payload),
        ),
      ),
    getState: async () =>
      agentSnapshotSchema.parse(await ipcRenderer.invoke(desktopChannels.agentGetState)),
    start: async () =>
      agentSnapshotSchema.parse(await ipcRenderer.invoke(desktopChannels.agentStart)),
    stop: async () =>
      agentSnapshotSchema.parse(await ipcRenderer.invoke(desktopChannels.agentStop)),
    onStateChanged: (
      listener: (snapshot: ReturnType<typeof agentEventSchema.parse>["snapshot"]) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(agentEventSchema.parse(payload).snapshot);
      };
      ipcRenderer.on(desktopChannels.agentStateChanged, handler);
      return () => ipcRenderer.removeListener(desktopChannels.agentStateChanged, handler);
    },
  }),
  updates: Object.freeze({
    getState: async () =>
      updateSnapshotSchema.parse(await ipcRenderer.invoke(desktopChannels.updateGetState)),
    check: async () =>
      updateSnapshotSchema.parse(await ipcRenderer.invoke(desktopChannels.updateCheck)),
    download: async () =>
      updateSnapshotSchema.parse(await ipcRenderer.invoke(desktopChannels.updateDownload)),
    install: async () =>
      updateSnapshotSchema.parse(await ipcRenderer.invoke(desktopChannels.updateInstall)),
    onStateChanged: (
      listener: (snapshot: ReturnType<typeof updateEventSchema.parse>["snapshot"]) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(updateEventSchema.parse(payload).snapshot);
      };
      ipcRenderer.on(desktopChannels.updateStateChanged, handler);
      return () => ipcRenderer.removeListener(desktopChannels.updateStateChanged, handler);
    },
  }),
});

contextBridge.exposeInMainWorld("mhubDesktop", desktopApi);
