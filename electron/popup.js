// Avisos do app. No macOS, um app sem a assinatura da Apple manda a notificação do sistema e ela
// simplesmente não aparece; por isso lá o XMeeting mostra o próprio aviso: uma janelinha no canto
// superior direito, por cima das outras e sem roubar o foco. Nos outros sistemas, notificação normal.
import { BrowserWindow, Notification, screen } from 'electron';

const WIDTH = 380;
const HEIGHT = 132;
const MARGIN = 14;
const open = []; // avisos na tela, de cima para baixo

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page({ title, body, actions }) {
  const buttons = actions
    .map((a, i) => `<a href="xmeeting-aviso://${i}" class="${a.primary ? 'primary' : ''}">${esc(a.label)}</a>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root { --bg: #ffffff; --text: #1d1d1f; --muted: #6c6c72; --border: #e2e2e6; --accent: #4f5bd5; --accent-text: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #23242a; --text: #f1f1f3; --muted: #a2a3a9; --border: #3a3b42; --accent: #8b93ff; --accent-text: #11131c; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: transparent; font: 13px -apple-system, system-ui, sans-serif; color: var(--text); -webkit-user-select: none; }
.card { height: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 14px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; overflow: hidden; }
.app { font-size: 11px; color: var(--muted); }
.title { font-weight: 650; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.body { color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.actions { margin-top: auto; display: flex; gap: 8px; justify-content: flex-end; }
a { text-decoration: none; color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 5px 12px; font-weight: 500; cursor: default; }
a:hover { border-color: var(--accent); }
a.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
</style></head><body><div class="card">
<div class="app">XMeeting Notes</div>
<div class="title">${esc(title)}</div>
<div class="body">${esc(body)}</div>
<div class="actions">${buttons}</div>
</div></body></html>`;
}

function place() {
  const area = screen.getPrimaryDisplay().workArea;
  open.forEach((w, i) => {
    if (!w.isDestroyed()) w.setPosition(area.x + area.width - WIDTH - MARGIN, area.y + MARGIN + i * (HEIGHT + 10));
  });
}

function showPopup({ title, body, actions, timeoutMs }) {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    type: process.platform === 'darwin' ? 'panel' : undefined, // clicável sem ativar o app
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const close = () => {
    if (!win.isDestroyed()) win.close();
  };
  // Os botões são links "xmeeting-aviso://N": a navegação é cancelada e vira a ação N.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    const i = Number(url.match(/^xmeeting-aviso:\/\/(\d+)/)?.[1]);
    close();
    if (Number.isInteger(i)) actions[i]?.onClick?.();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => {
    open.splice(open.indexOf(win), 1);
    place();
  });
  open.push(win);
  place();
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page({ title, body, actions }))}`);
  win.once('ready-to-show', () => win.showInactive());
  if (timeoutMs) setTimeout(close, timeoutMs);
  return win;
}

/**
 * Mostra um aviso. actions: [{ label, primary?, onClick? }]; onClick (sem actions) = clicar no aviso.
 * timeoutMs: some sozinho depois disso (0 = só fecha num botão).
 */
export function notifyUser({ title, body = '', onClick = null, actions = null, timeoutMs = 15_000 }) {
  if (process.platform === 'darwin') {
    const list = actions ?? [{ label: 'Fechar' }, ...(onClick ? [{ label: 'Abrir', primary: true, onClick }] : [])];
    return showPopup({ title, body, actions: list, timeoutMs });
  }
  if (!Notification.isSupported()) return null;
  const n = new Notification({ title, body });
  const main = onClick ?? actions?.find((a) => a.primary)?.onClick;
  if (main) n.on('click', main);
  n.show();
  return n;
}

