// 预加载：把「原生壳能力」安全地暴露给页面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nativeShell', {
  isElectron: true,
  getConfig: () => ipcRenderer.invoke('shell:getConfig'),
  getGpu: () => ipcRenderer.invoke('shell:gpu'),
  relaunch: (cfg) => ipcRenderer.invoke('shell:relaunch', cfg),
});
