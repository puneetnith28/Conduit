import { app, BrowserWindow, ipcMain, dialog, Notification, Menu, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { DaemonManager, ServiceStatus } from './daemon-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * `dist/` — this file is `dist/electron/main.mjs` in both a dev run
 * (`electron dist/electron/main.mjs`) and a packaged app, so `__dirname` is
 * the only reliable anchor. `app.getAppPath()` points at the repo root in dev
 * and at `resources/app` when packaged.
 */
const distRoot = path.resolve(__dirname, '..');

let mainWindow: BrowserWindow | null = null;
let lastStatus: ServiceStatus | null = null;
const daemonManager = new DaemonManager();

/** The only origin the app window is ever allowed to be showing. */
function isOwnPage(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:' || u.protocol === 'data:') return true;   // the loading page
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
      && u.port === String(lastStatus?.port ?? 3200);
  } catch { return false; }
}

/**
 * Keep the outside world out of the application window.
 *
 * Agent and model output is rendered as markdown, and `renderMarkdown` turns a
 * link into a real `<a target="_blank">`. In a browser that is a new tab. In
 * Electron, with no handler installed, it opened a *new application window* on
 * the remote page — carrying the preload bridge, with no address bar to say
 * where the user had ended up. `location.href` was worse: it navigated the
 * control centre itself away, and there is no back button to return.
 *
 * Measured before this existed: an anchor click, `window.open` and a top-level
 * navigation all loaded example.com inside the packaged app.
 *
 * Links still work — they open in the browser the user actually chose, which is
 * where an external link belongs.
 */
/**
 * Hand an external link to the user's browser?
 *
 * Always, except when something is deliberately driving the app to check that
 * external links do not open *inside* it. That check has to click a real
 * https link, and handing every one of those to the real browser meant running
 * the desktop audit sprayed tabs across the user's actual session.
 *
 * Only the hand-off is suppressed. The deny — the half that keeps a remote
 * page out of a window with preload and no address bar — still runs, so the
 * check still tests the thing worth testing.
 */
const handOffExternalLinks = process.env.CONDUIT_NO_EXTERNAL_OPEN !== '1';

function openOutside(url: string): void {
  if (!handOffExternalLinks) return;
  shell.openExternal(url).catch(() => { /* no browser, nothing to do */ });
}

function guardNavigation(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !isOwnPage(url)) openOutside(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isOwnPage(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) openOutside(url);
  });
}

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

/** Loaded before the backend is up, so the window is never blank or white. */
function splashPage(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0}
  body{background:#faf8f5;color:#3a3532;display:flex;align-items:center;justify-content:center;
       font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .box{text-align:center}
  .dot{width:8px;height:8px;border-radius:50%;background:#c96442;display:inline-block;margin:0 3px;
       animation:p 1.2s infinite ease-in-out}
  .dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}
  @keyframes p{0%,80%,100%{opacity:.25}40%{opacity:1}}
  h1{font-size:15px;font-weight:600;margin:0 0 6px}
  p{margin:0;font-size:12px;opacity:.6}
</style>
<div class="box">
  <h1>Starting Conduit</h1>
  <p>Bringing up the agent daemon…</p>
  <div style="margin-top:14px"><i class="dot"></i><i class="dot"></i><i class="dot"></i></div>
</div>`)}`;
}

/** Shown instead of Chromium's ERR_CONNECTION_REFUSED page when startup fails. */
function errorPage(status: ServiceStatus): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const log = status.log ? `<pre>${esc(status.log)}</pre>` : '';
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0}
  body{background:#faf8f5;color:#3a3532;padding:48px;box-sizing:border-box;
       font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  h1{font-size:18px;margin:0 0 10px}
  .msg{color:#8a4b32;margin-bottom:18px;white-space:pre-wrap}
  pre{background:#f0ece6;border:1px solid #e0d9d0;border-radius:6px;padding:12px;
      font-size:11px;max-height:40vh;overflow:auto;white-space:pre-wrap}
  .hint{font-size:12px;opacity:.65;margin-top:18px}
</style>
<h1>Conduit could not start</h1>
<div class="msg">${esc(status.error || 'Unknown error.')}</div>
${log}
<div class="hint">Quit and reopen Conduit to try again. If this persists, run
<code>npm run build</code> in the source tree, or start the backend manually with
<code>npm run start:all</code> and reopen this app — it will attach to it.</div>`)}`;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Conduit',
    backgroundColor: '#faf8f5',
    // Do not paint until there is something to see — the backend takes seconds
    // to come up, and an empty frame reads as a crash.
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium throttles timers to ~1/sec in an unfocused window. The
      // voice energy gate polls at 50ms, so hands-free listening collapsed
      // exactly when it matters — while you are working in another app.
      // Measured: 6 samples in 12s backgrounded vs 239 focused.
      backgroundThrottling: false,
    },
  });

  const win = mainWindow;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { mainWindow = null; });
  guardNavigation(win.webContents);

  // The renderer subscribes in its own script, so a status sent before the
  // document exists is dropped. Re-send on every load instead.
  win.webContents.on('did-finish-load', () => {
    if (lastStatus) win.webContents.send('conduit:daemon-status', lastStatus);
  });

  await win.loadURL(splashPage());

  let status: ServiceStatus;
  try {
    status = await daemonManager.startServices(distRoot);
  } catch (err: any) {
    status = { ready: false, port: 3200, phase: 'failed', error: err?.message || String(err) };
  }
  lastStatus = status;

  if (win.isDestroyed()) return;

  if (!status.ready) {
    console.error('[main] Backend failed to start:', status.error);
    await win.loadURL(errorPage(status));
    return;
  }

  const target = isDev && process.env.VITE_DEV_SERVER_URL
    ? process.env.VITE_DEV_SERVER_URL
    : `http://127.0.0.1:${status.port}/`;

  await loadWithRetry(win, target, status);
}

/**
 * The health probe says the server is listening, but the first navigation can
 * still race the listener. Retry a few times before giving up.
 */
async function loadWithRetry(win: BrowserWindow, url: string, status: ServiceStatus): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (win.isDestroyed()) return;
    try {
      await win.loadURL(url);
      return;
    } catch (err: any) {
      // -3 is ERR_ABORTED, which a superseded navigation raises — not a failure.
      if (err?.errno === -3) return;
      console.warn(`[main] Load attempt ${attempt + 1} failed: ${err?.message}`);
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!win.isDestroyed()) {
    await win.loadURL(errorPage({
      ...status,
      ready: false,
      error: `The backend is running on port ${status.port}, but the window could not load ${url}.`,
    }));
  }
}

/** Send a channel to the renderer, restoring and focusing the window first. */
function sendToWindow(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send(channel, ...args);
}

function setupNativeMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: any[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' }, { type: 'separator' }, { role: 'services' },
            { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' },
            { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Local Project...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            if (!mainWindow) return;
            const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('conduit:project-opened', result.filePaths[0]);
            }
          },
        },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      // These were `globalShortcut.register(...)` — which steals the accelerator
      // from every other application on the machine for as long as Conduit is
      // open. As menu accelerators they fire only when Conduit has focus.
      label: 'Go',
      submenu: [
        {
          label: 'Command Panel',
          accelerator: 'CmdOrCtrl+J',
          click: () => sendToWindow('conduit:toggle-keeper'),
        },
        {
          label: 'Toggle Voice',
          accelerator: 'CmdOrCtrl+;',
          click: () => sendToWindow('conduit:toggle-voice'),
        },
        {
          label: 'Focus Terminal',
          accelerator: 'CmdOrCtrl+Shift+Y',
          click: () => sendToWindow('conduit:focus-terminal'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- IPC ---
ipcMain.handle('conduit:select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Engineering Project Directory',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('conduit:get-version', () => app.getVersion());

// Lets a renderer that loaded late ask for the status rather than wait for a push.
ipcMain.handle('conduit:get-daemon-status', () => lastStatus);

ipcMain.on('conduit:notification', (_event, payload) => {
  const title = String(payload?.title ?? 'Conduit');
  const body = String(payload?.body ?? '');
  if (Notification.isSupported()) new Notification({ title, body }).show();
});

// --- Lifecycle ---
// A second instance would spawn a second daemon and lose the port race; focus
// the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Belt and braces: anything that manages to create a webContents — a
  // devtools window, a future second window — is guarded too, not just the one
  // window `createWindow` knows about.
  app.on('web-contents-created', (_e, contents) => guardNavigation(contents));

  app.whenReady().then(async () => {
    setupNativeMenu();
    await createWindow();

    // electron-updater has no feed outside a packaged build, and `isDev` also
    // covers NODE_ENV, which is the wrong signal here.
    if (app.isPackaged) {
      import('electron-updater').then(({ autoUpdater }) => {
        autoUpdater.checkForUpdatesAndNotify().catch((err) => {
          console.log('[AutoUpdater] Update check skipped/offline:', err.message);
        });
      }).catch((err) => {
        console.log('[AutoUpdater] Unavailable:', err?.message);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Must be synchronous: Electron does not wait for a promise here, so the old
// `import('electron').then(...)` never ran before the process was gone.
app.on('before-quit', () => {
  daemonManager.stopServices();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
