// Ícone na barra do sistema (bandeja do Windows / barra de menus do macOS / área de notificação
// do Linux). Fechar a janela só esconde o app: ele continua rodando aqui para avisar quando uma
// reunião da agenda começar. "Sair" no menu encerra de verdade.
import { app, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ICON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');

let tray = null;
let actions = null;

function icon() {
  const size = process.platform === 'darwin' ? 18 : 16;
  const img = nativeImage.createFromPath(ICON);
  return img.isEmpty() ? img : img.resize({ width: size, height: size, quality: 'best' });
}

/** Abrir junto com o computador (só no app instalado: no desenvolvimento abriria o Electron puro). */
export const canOpenAtLogin = () => app.isPackaged && process.platform !== 'linux';
export const opensAtLogin = () => canOpenAtLogin() && app.getLoginItemSettings().openAtLogin;
export function setOpenAtLogin(enabled) {
  if (!canOpenAtLogin()) return false;
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
  refreshTray();
  return opensAtLogin();
}

/** O app foi aberto pelo sistema no login? Então começa escondido, só no ícone. */
export function startedAtLogin() {
  if (process.argv.includes('--hidden')) return true; // Windows (args do item de login)
  try {
    return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch {
    return false;
  }
}

export function refreshTray() {
  if (!tray || !actions) return;
  const recording = actions.isRecording();
  const template = [
    { label: recording ? '● Gravando: abrir o XMeeting' : 'Abrir o XMeeting', click: actions.open },
    recording ? { label: 'Parar gravação', click: actions.stop } : { label: 'Gravar agora', click: actions.record },
    { type: 'separator' },
  ];
  if (canOpenAtLogin()) {
    template.push({ label: 'Abrir ao ligar o computador', type: 'checkbox', checked: opensAtLogin(), click: (item) => setOpenAtLogin(item.checked) });
    template.push({ type: 'separator' });
  }
  template.push({ label: 'Sair do XMeeting', click: actions.quit });
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(recording ? 'XMeeting Notes: gravando' : 'XMeeting Notes');
}

/** actions: { open, record, stop, quit, isRecording } */
export function createTray(handlers) {
  actions = handlers;
  try {
    tray = new Tray(icon());
  } catch (err) {
    console.warn('Não consegui criar o ícone na barra do sistema:', err.message);
    tray = null;
    return null;
  }
  // No Windows e no Linux, um clique no ícone abre a janela; no macOS o clique abre o menu.
  if (process.platform !== 'darwin') tray.on('click', actions.open);
  refreshTray();
  return tray;
}

export const hasTray = () => Boolean(tray);
