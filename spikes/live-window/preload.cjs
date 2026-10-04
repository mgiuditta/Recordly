const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spike", {
	onCursor: (fn) => ipcRenderer.on("cursor", (_e, p) => fn(p)),
	onToggleZoom: (fn) => ipcRenderer.on("toggle-zoom", () => fn()),
	log: (msg) => ipcRenderer.send("log", msg),
});
