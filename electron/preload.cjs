const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gf', {
  isElectron: true,
  platform: process.platform,
  version: process.env.npm_package_version || '1.0.0',
  openFiles: () => ipcRenderer.invoke('gf:openFiles'),
  saveFile: (defaultName, bytes) => ipcRenderer.invoke('gf:saveFile', defaultName, bytes),
  httpGet: (url, headers) => ipcRenderer.invoke('gf:httpGet', url, headers),
  httpGetBinary: (url, headers) => ipcRenderer.invoke('gf:httpGetBinary', url, headers),
  captureSystemAudio: () => ipcRenderer.invoke('gf:captureSystemAudio'),
});