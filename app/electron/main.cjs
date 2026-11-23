// BRAIN2 Electron main process.
// Starts the Python backend (local mode), creates windows and the native menu.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const REPO_ROOT = path.resolve(__dirname, "..", "..");

let backend = null;
let backendConfig = null; // { baseUrl, token }

// ---------------------------------------------------------------- backend
function findPython() {
  if (process.env.BRAIN2_PYTHON) return process.env.BRAIN2_PYTHON;
  const venv = path.join(REPO_ROOT, "backend", ".venv", isWin ? "Scripts/python.exe" : "bin/python");
  if (fs.existsSync(venv)) return venv;
  return isWin ? "python" : "python3";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (backend && backend.exitCode !== null) throw new Error("Backend exited during startup");
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw lastErr || new Error("Backend did not start in time");
}

async function startBackend() {
  if (process.env.BRAIN2_API_URL) {
    // Connect to an already running backend (e.g. server mode).
    backendConfig = { baseUrl: process.env.BRAIN2_API_URL.replace(/\/$/, ""), token: process.env.BRAIN2_TOKEN || "" };
    return;
  }
  const port = await freePort();
  const token = crypto.randomBytes(24).toString("base64url");
  const python = findPython();
  backend = spawn(python, ["-m", "brain2", "serve", "--port", String(port), "--token", token, "--exit-with-parent"], {
    cwd: path.join(REPO_ROOT, "backend"),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  backend.on("exit", (code) => {
    if (code && !app.isQuitting) console.error(`[brain2] backend exited with code ${code}`);
  });
  backendConfig = { baseUrl: `http://127.0.0.1:${port}`, token };
  await waitForHealth(backendConfig.baseUrl);
}

function stopBackend() {
  if (backend && backend.exitCode === null) {
    backend.kill();
  }
}

// ---------------------------------------------------------------- windows
function createWindow(query = {}) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "BRAIN2",
    backgroundColor: "#1e1e1e",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true, // built-in PDF viewer
      spellcheck: true,
    },
  });

  const search = new URLSearchParams(query).toString();
  if (DEV_URL) {
    win.loadURL(`${DEV_URL}${search ? `?${search}` : ""}`);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"), { search });
  }

  // External links open in the user's browser; never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    if (url.split("?")[0] !== current.split("?")[0]) {
      event.preventDefault();
      if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    }
  });
  return win;
}

function sendMenu(action, payload) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send("brain2:menu", action, payload);
}

function buildMenu() {
  const options = {
    label: "Options",
    submenu: [
      { label: "System settings…", accelerator: "CmdOrCtrl+,", click: () => sendMenu("settings", "general") },
      { label: "Account connectors…", click: () => sendMenu("settings", "connectors") },
      { label: "System prompts…", click: () => sendMenu("settings", "system-prompts") },
      { label: "Agent prompts…", click: () => sendMenu("settings", "agent-prompts") },
      { label: "Sync & data…", click: () => sendMenu("settings", "sync") },
    ],
  };
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { label: "Settings…", accelerator: "Cmd+,", click: () => sendMenu("settings", "general") },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New note", accelerator: "CmdOrCtrl+N", click: () => sendMenu("new-note") },
        { label: "New vault…", click: () => sendMenu("new-vault") },
        { label: "New window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        { label: "Quick switcher", accelerator: "CmdOrCtrl+O", click: () => sendMenu("quick-switcher") },
        { label: "Command palette", accelerator: "CmdOrCtrl+P", click: () => sendMenu("command-palette") },
        { type: "separator" },
        { label: "Close tab", accelerator: "CmdOrCtrl+W", click: () => sendMenu("close-tab") },
        isMac ? { role: "close", accelerator: "CmdOrCtrl+Shift+W" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Toggle reading view", accelerator: "CmdOrCtrl+E", click: () => sendMenu("toggle-reading") },
        { label: "Search in vault", accelerator: "CmdOrCtrl+Shift+F", click: () => sendMenu("search") },
        { label: "Graph view", accelerator: "CmdOrCtrl+G", click: () => sendMenu("graph") },
        { type: "separator" },
        { label: "Toggle left sidebar", accelerator: "CmdOrCtrl+\\", click: () => sendMenu("toggle-left") },
        { label: "Toggle right sidebar", accelerator: "CmdOrCtrl+Shift+\\", click: () => sendMenu("toggle-right") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    options,
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- IPC
ipcMain.on("brain2:config", (event) => {
  event.returnValue = { ...backendConfig, platform: process.platform };
});
ipcMain.handle("brain2:pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("brain2:open-window", (_e, query) => {
  createWindow(query || {});
});
ipcMain.handle("brain2:reveal", (_e, fullPath) => {
  if (typeof fullPath === "string" && fs.existsSync(fullPath)) shell.showItemInFolder(fullPath);
});
ipcMain.handle("brain2:open-path", (_e, fullPath) => {
  if (typeof fullPath === "string" && fs.existsSync(fullPath)) return shell.openPath(fullPath);
});
ipcMain.handle("brain2:open-external", (_e, url) => {
  if (typeof url === "string" && /^https?:|^mailto:/.test(url)) shell.openExternal(url);
});

// ---------------------------------------------------------------- lifecycle
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setName("BRAIN2");
    try {
      await startBackend();
    } catch (err) {
      dialog.showErrorBox(
        "BRAIN2 could not start",
        `The Python backend failed to start.\n\n${err && err.message}\n\n` +
          "Run `make setup` (or see README) to install the backend.",
      );
      app.exit(1);
      return;
    }
    buildMenu();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    stopBackend();
  });
  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });
  process.on("exit", stopBackend);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      stopBackend();
      app.exit(0);
    });
  }
}
