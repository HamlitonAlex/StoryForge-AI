// preload.js - Electron预加载脚本
// 在渲染进程中安全地暴露Node.js能力

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 获取应用版本
  getVersion: () => ipcRenderer.invoke('get-version'),
  // 获取平台信息
  getPlatform: () => process.platform,
  // 打开外部链接
  openExternal: (url) => ipcRenderer.send('open-external', url)
});
