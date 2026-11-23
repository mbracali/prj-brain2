// Exposes a minimal, explicit bridge to the renderer.
const { contextBridge, ipcRenderer } = require("electron");

const config = ipcRenderer.sendSync("brain2:config");

contextBridge.exposeInMainWorld("brain2", {
  config,
  pickFolder: () => ipcRenderer.invoke("brain2:pick-folder"),
  openWindow: (query) => ipcRenderer.invoke("brain2:open-window", query),
  reveal: (fullPath) => ipcRenderer.invoke("brain2:reveal", fullPath),
  openPath: (fullPath) => ipcRenderer.invoke("brain2:open-path", fullPath),
  openExternal: (url) => ipcRenderer.invoke("brain2:open-external", url),
  onMenu: (callback) => {
    const listener = (_event, action, payload) => callback(action, payload);
    ipcRenderer.on("brain2:menu", listener);
    return () => ipcRenderer.removeListener("brain2:menu", listener);
  },
});
