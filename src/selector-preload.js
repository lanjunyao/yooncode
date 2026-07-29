const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('selector', {
  onImage: callback => ipcRenderer.on('selection:image', (_, value) => callback(value)),
  complete: rect => ipcRenderer.send('selection:complete', rect),
  cancel: () => ipcRenderer.send('selection:cancel')
});
