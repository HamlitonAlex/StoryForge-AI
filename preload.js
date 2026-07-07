const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('get-version'),
  getPlatform: () => process.platform,
  openExternal: (url) => ipcRenderer.send('open-external', url),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  saveFile: (filePath, content) => ipcRenderer.invoke('save-file', { filePath, content })
});
