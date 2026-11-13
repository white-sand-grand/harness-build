import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, HostCommand, Snapshot } from '../contracts.ts';
const bridge: DesktopBridge = {
  request: (command: HostCommand) => ipcRenderer.invoke('mh:request', command),
  chooseProject: () => ipcRenderer.invoke('mh:choose-project'),
  subscribe: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => listener(snapshot);
    ipcRenderer.on('mh:snapshot', receive);
    return () => ipcRenderer.removeListener('mh:snapshot', receive);
  },
};
contextBridge.exposeInMainWorld('mh', Object.freeze(bridge));
