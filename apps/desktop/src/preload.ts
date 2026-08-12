import { contextBridge, ipcRenderer } from "electron";

import {
  agentEventSchema,
  agentSnapshotSchema,
  desktopChannels,
  hostInfoSchema,
} from "./contracts";

const desktopApi = Object.freeze({
  getHostInfo: async () =>
    hostInfoSchema.parse(await ipcRenderer.invoke(desktopChannels.getHostInfo)),
  agent: Object.freeze({
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
});

contextBridge.exposeInMainWorld("mhubDesktop", desktopApi);
