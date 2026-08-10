import { contextBridge, ipcRenderer } from "electron";

import { desktopChannels, hostInfoSchema } from "./contracts";

const desktopApi = Object.freeze({
  getHostInfo: async () =>
    hostInfoSchema.parse(await ipcRenderer.invoke(desktopChannels.getHostInfo)),
});

contextBridge.exposeInMainWorld("mhubDesktop", desktopApi);
