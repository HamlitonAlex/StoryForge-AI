const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('get-version'),
  getPlatform: () => process.platform,
  openExternal: (url) => ipcRenderer.send('open-external', url),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFile: () => ipcRenderer.invoke('select-file'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  saveFile: (filePath, content) => ipcRenderer.invoke('save-file', { filePath, content }),
  saveImage: (fileName, base64Data) => ipcRenderer.invoke('save-image', { fileName, base64Data }),
  getAppDataPath: () => ipcRenderer.invoke('get-app-data-path'),
  deleteImage: (fileName) => ipcRenderer.invoke('delete-image', fileName)
});
