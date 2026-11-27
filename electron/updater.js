// Atualização automática a partir das versões publicadas em Releases do repositório do app no
// GitHub (RELEASES_REPO, que precisa ser público para o app instalado conseguir ler).
//
// - Windows e Linux (AppImage): baixa a versão nova em segundo plano e instala quando o app fecha,
//   ou na hora, pelo botão "Reiniciar e atualizar".
// - macOS e Linux (.deb): só avisa e abre a página para baixar. O macOS só deixa um app se trocar
//   sozinho se ele tiver a assinatura da Apple, e o .deb pediria a senha do sistema.
import { app, Notification, shell } from 'electron';

// Tem que ser igual a "build.publish" no package.json (o workflow confere antes de gerar os
// instaladores). Fica aqui porque o app instalado não leva a configuração do build, e no macOS
// o electron-builder nem grava o app-update.yml.
export const RELEASES_REPO = 'MarcusHaugg/XMeeting_Notes';

const FIRST_CHECK_MS = 20_000; // deixa o app abrir antes
const CHECK_EVERY_MS = 4 * 60 * 60_000;

// status: idle | checking | none (está na última) | downloading | ready (baixada, falta reiniciar)
//         | available (existe, baixar na página) | error
let state = { status: 'idle', version: null, error: null };
let hooks = { onChange: () => {}, canInstallNow: () => null, beforeInstall: () => {}, install: () => installUpdate() };
let autoUpdater = null;
let releasesPage = null;
let checking = null;
const announced = new Set();

/** Windows (instalador NSIS) e Linux AppImage instalam sozinhos; o resto só avisa. */
export const canSelfInstall = (platform = process.platform, env = process.env) =>
  platform === 'win32' || (platform === 'linux' && Boolean(env.APPIMAGE));

/** "1.2.10" > "1.2.9"? Ignora o "v" do começo e o que vier depois de "-" (pré-versões). */
export function isNewer(candidate, current) {
  const parts = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * Última versão publicada, sem usar a API do GitHub (que limita 60 consultas por hora por IP, e
 * vários computadores da mesma empresa saem pelo mesmo IP): a página /releases/latest redireciona
 * para /releases/tag/vX.Y.Z.
 */
export async function latestPublishedVersion(page, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(page, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null; // nenhuma versão publicada ainda
  const location = res.headers.get('location') ?? '';
  const tag = location.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
  if (res.status >= 300 && res.status < 400) return tag ? decodeURIComponent(tag).replace(/^v/, '') : null;
  throw new Error(`O GitHub respondeu ${res.status} ao procurar a versão nova.`);
}

export function updateState() {
  return {
    ...state,
    current: app.getVersion(),
    enabled: Boolean(releasesPage),
    selfInstall: Boolean(autoUpdater),
    page: releasesPage,
  };
}

function set(patch) {
  state = { ...state, ...patch };
  hooks.onChange(updateState());
}

function announce(title, body, onClick) {
  if (announced.has(state.version) || !Notification.isSupported()) return;
  announced.add(state.version);
  const n = new Notification({ title, body });
  n.on('click', onClick);
  n.show();
}

/**
 * Liga a atualização automática (só no app instalado).
 * hooks: onChange(state) quando o estado muda; canInstallNow() → texto do motivo para não
 * reiniciar agora (ex.: gravando) ou null; beforeInstall() logo antes de fechar para instalar;
 * install() quando clicam no aviso de atualização pronta.
 */
export async function initUpdater(handlers = {}) {
  hooks = { ...hooks, ...handlers };
  if (!app.isPackaged) return;
  releasesPage = `https://github.com/${RELEASES_REPO}/releases/latest`;

  if (canSelfInstall()) {
    try {
      const { default: updater } = await import('electron-updater'); // pacote CommonJS
      autoUpdater = updater.autoUpdater;
      autoUpdater.logger = null;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true; // "Sair do XMeeting" também instala
      autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, error: null }));
      autoUpdater.on('update-not-available', () => set({ status: 'none', error: null }));
      autoUpdater.on('update-downloaded', (info) => {
        set({ status: 'ready', version: info.version, error: null });
        announce(
          `Atualização pronta: XMeeting Notes ${info.version}`,
          'Ela é instalada quando você fechar o app. Clique para reiniciar e atualizar agora.',
          () => hooks.install()
        );
      });
      autoUpdater.on('error', (err) => {
        if (state.status !== 'ready') set({ status: 'error', error: err?.message ?? String(err) });
      });
    } catch (err) {
      console.warn('Atualização automática indisponível:', err.message);
      autoUpdater = null;
    }
  }

  setTimeout(() => checkForUpdate().catch(() => {}), FIRST_CHECK_MS);
  setInterval(() => checkForUpdate().catch(() => {}), CHECK_EVERY_MS).unref?.();
}

/** Procura uma versão nova (sozinho a cada 4 h, ou pelo botão nas Configurações). */
export function checkForUpdate() {
  if (!releasesPage) return Promise.resolve(updateState());
  if (state.status === 'ready' || state.status === 'downloading') return Promise.resolve(updateState());
  if (checking) return checking;
  checking = (async () => {
    set({ status: 'checking', error: null });
    try {
      if (autoUpdater) {
        await autoUpdater.checkForUpdates(); // os eventos acima atualizam o estado
        if (state.status === 'checking') set({ status: 'none' });
        return updateState();
      }
      const latest = await latestPublishedVersion(releasesPage);
      if (latest && isNewer(latest, app.getVersion())) {
        set({ status: 'available', version: latest });
        announce(
          `Nova versão do XMeeting Notes: ${latest}`,
          'Clique para baixar. Suas reuniões e configurações continuam no computador.',
          () => shell.openExternal(releasesPage)
        );
      } else {
        set({ status: 'none' });
      }
    } catch (err) {
      set({ status: 'error', error: err?.message ?? String(err) });
    } finally {
      checking = null;
    }
    return updateState();
  })();
  return checking;
}

/**
 * Baixada: fecha e instala (o app abre de novo sozinho). Só disponível para baixar: abre a página.
 * Devolve { ok, reason } (reason = por que não dá para reiniciar agora).
 */
export async function installUpdate() {
  if (state.status === 'available' && releasesPage) {
    await shell.openExternal(releasesPage);
    return { ok: true };
  }
  if (state.status !== 'ready' || !autoUpdater) return { ok: false, reason: 'Nenhuma atualização pronta para instalar.' };
  const reason = hooks.canInstallNow();
  if (reason) return { ok: false, reason };
  hooks.beforeInstall();
  setImmediate(() => autoUpdater.quitAndInstall(true, true)); // silencioso e abre de novo depois
  return { ok: true };
}
