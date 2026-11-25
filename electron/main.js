import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeTheme, powerSaveBlocker, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { exportAudioFile, finalizeAudio, probeDuration } from './media.js';
import { Transcriber } from './transcriber.js';
import { getSettings, initSettings, updateSettings } from './settings.js';
import { formatTimestamp, transcriptToText } from './speech.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKS = new Set(['mic', 'system']);

app.setName('XMeeting Notes');

// Windows: %LOCALAPPDATA% (fora do OneDrive e do perfil "roaming", o áudio das reuniões não
// vai para a nuvem). macOS: ~/Library/Application Support. Linux: ~/.config.
const dataRoot = process.env.LOCALAPPDATA || app.getPath('appData');
const userDataDir = path.join(dataRoot, 'XMeetingNotes');
const legacyDir = path.join(dataRoot, 'MeetingNotes'); // nome antigo do app
if (!fs.existsSync(userDataDir) && fs.existsSync(legacyDir)) {
  try {
    fs.renameSync(legacyDir, userDataDir);
  } catch {
    /* pasta antiga em uso: segue com a nova */
  }
}
app.setPath('userData', userDataDir);

// Linux: o "loopback" do Electron não é oficial; este recurso do Chromium usa o monitor do
// PulseAudio/PipeWire. Se não funcionar, a interface procura o dispositivo "Monitor" sozinha.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'PulseaudioLoopbackForScreenShare');

let win = null;
let recording = null; // { id, streams: { mic, system }, blocker }
let quitting = false;
let transcriber = null;

const notify = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) || 'reuniao';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start);
}

async function start() {
  const userData = app.getPath('userData');
  store.initStore(userData);
  initSettings(userData);
  transcriber = new Transcriber({ cacheDir: path.join(userData, 'models'), notify });

  setupPermissions();
  registerIpc();
  await resetInterruptedTranscripts();
  createWindow();
  finalizeInterruptedRecordings(); // em segundo plano

  if (app.commandLine.hasSwitch('selftest') || app.commandLine.hasSwitch('demo')) {
    const dev = await import('./dev.js');
    dev.run({ app, win, transcriber, setQuitting: () => (quitting = true) }).catch((err) => {
      console.error('[dev] falhou:', err);
      app.exit(1);
    });
  }
}

function setupPermissions() {
  const ses = session.defaultSession;
  // Só o necessário: microfone (media) e captura do áudio do sistema (display-capture).
  const allowed = new Set(['media', 'display-capture']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  // O "compartilhar tela" da interface é atendido aqui, sem diálogo:
  // tela principal (o vídeo é descartado) + loopback = tudo que sai nos alto-falantes/fones.
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback(null));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: 'XMeeting Notes',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17181b' : '#f7f6f3',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // continua gravando com a janela minimizada
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', onWindowClose);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function onWindowClose(event) {
  if (quitting) return;
  const recordingNow = Boolean(recording);
  if (!recordingNow && !transcriber.busy) return;

  event.preventDefault();
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    title: 'XMeeting Notes',
    buttons: ['Cancelar', recordingNow ? 'Parar gravação e sair' : 'Sair mesmo assim'],
    defaultId: 0,
    cancelId: 0,
    message: recordingNow ? 'Uma reunião está sendo gravada.' : 'Uma transcrição está em andamento.',
    detail: recordingNow
      ? 'Ao sair, a gravação é encerrada e o áudio gravado até agora fica salvo.'
      : 'Ela será interrompida. Você pode transcrever de novo depois.',
  });
  if (choice !== 1) return;

  quitting = true;
  if (recordingNow) {
    notify('recording:force-stop'); // a interface encerra a gravação e chama rec:stop
    setTimeout(() => app.quit(), 10_000); // garantia, caso a interface não responda
  } else {
    app.quit();
  }
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));

  handle('settings:get', () => getSettings());
  handle('settings:set', (patch) => updateSettings(patch));

  handle('meetings:list', () => store.list());
  handle('meetings:get', (id) => store.get(id));
  handle('meetings:update', (id, patch = {}) => {
    const clean = {};
    if (typeof patch.title === 'string') clean.title = patch.title.trim().slice(0, 200) || 'Reunião sem título';
    if (typeof patch.notes === 'string') clean.notes = patch.notes.slice(0, 500_000);
    return store.update(id, clean);
  });
  handle('meetings:remove', async (id) => {
    if (recording?.id === id) throw new Error('Pare a gravação antes de excluir esta reunião.');
    if (transcriber.isActive(id)) throw new Error('Cancele a transcrição antes de excluir esta reunião.');
    await store.remove(id);
  });

  handle('rec:start', startRecording);
  ipcMain.on('rec:chunk', (_event, id, track, data) => writeChunk(id, track, data));
  handle('rec:stop', stopRecording);

  handle('transcript:start', (id) => transcriber.enqueue(id));
  handle('transcript:cancel', (id) => transcriber.cancel(id));
  handle('transcript:copy', async (id) => clipboard.writeText(await transcriptText(id)));
  handle('transcript:export', exportTranscript);

  handle('audio:export', exportAudio);
  handle('folder:open', (id) => shell.openPath(store.dirOf(id)));
  handle('folder:open-data', () => shell.openPath(app.getPath('userData')));
}

// ---------------------------------------------------------------- gravação

async function startRecording({ hasSystemAudio } = {}) {
  if (recording) throw new Error('Já existe uma gravação em andamento.');
  const meta = await store.create({ hasSystemAudio });
  recording = { id: meta.id, streams: {}, blocker: powerSaveBlocker.start('prevent-app-suspension') };
  return meta;
}

// Os pedaços chegam a cada segundo e vão direto para o disco: se o app fechar
// de repente, o áudio gravado até ali não se perde.
function writeChunk(id, track, data) {
  if (!recording || recording.id !== id || !TRACKS.has(track) || !data) return;
  const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let stream = recording.streams[track];
  if (!stream) {
    stream = fs.createWriteStream(store.trackPath(id, track), { flags: 'a' });
    stream.on('error', (err) => console.error(`Erro ao gravar a trilha ${track}:`, err));
    recording.streams[track] = stream;
  }
  stream.write(buf);
}

async function stopRecording(id) {
  if (!recording || recording.id !== id) throw new Error('Nenhuma gravação em andamento.');
  const current = recording;
  recording = null;
  await Promise.all(Object.values(current.streams).map((s) => new Promise((resolve) => s.end(resolve))));
  powerSaveBlocker.stop(current.blocker);
  await store.update(id, { status: 'finalizing', endedAt: new Date().toISOString() });
  notify('meetings:changed');

  if (quitting) {
    setImmediate(() => app.quit()); // o áudio final é montado na próxima vez que o app abrir
    return;
  }
  finalizeMeeting(id); // monta o áudio completo em segundo plano
}

async function finalizeMeeting(id) {
  try {
    await finalizeAudio(store.dirOf(id));
    const durationSec = await probeDuration(store.audioPath(id));
    await store.update(id, { status: 'ready', durationSec, error: null });
  } catch (err) {
    await store.update(id, { status: 'error', error: err.message }).catch(() => {});
  }
  notify('meetings:changed');
}

async function resetInterruptedTranscripts() {
  for (const m of await store.list()) {
    if (m.transcript?.status === 'queued' || m.transcript?.status === 'running') {
      await store.update(m.id, {
        transcript: store.hasTranscript(m.id)
          ? { status: 'done', error: null }
          : { status: 'error', error: 'A transcrição foi interrompida porque o app foi fechado. Clique em Transcrever para tentar de novo.' },
      });
    }
  }
}

async function finalizeInterruptedRecordings() {
  for (const m of await store.list()) {
    if (m.status === 'recording' || m.status === 'finalizing') await finalizeMeeting(m.id);
  }
}

// ---------------------------------------------------------------- exportar

async function transcriptText(id) {
  const m = await store.get(id);
  if (!m?.segments) throw new Error('Esta reunião ainda não foi transcrita.');
  const when = new Date(m.createdAt).toLocaleString('pt-BR');
  return `${m.title}\n${when} · duração ${formatTimestamp(m.durationSec)}\n\n${transcriptToText(m.segments)}\n`;
}

async function exportTranscript(id) {
  const m = await store.getMeta(id);
  const text = await transcriptText(id);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Exportar transcrição',
    defaultPath: path.join(app.getPath('documents'), `${safeName(m.title)} - transcrição.txt`),
    filters: [
      { name: 'Texto', extensions: ['txt'] },
      { name: 'Markdown', extensions: ['md'] },
    ],
  });
  if (canceled || !filePath) return false;
  await fs.promises.writeFile(filePath, text, 'utf8');
  return true;
}

async function exportAudio(id) {
  const m = await store.getMeta(id);
  const src = store.audioPath(id);
  if (!fs.existsSync(src)) throw new Error('O áudio desta reunião ainda não está disponível.');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Exportar áudio da reunião',
    defaultPath: path.join(app.getPath('documents'), `${safeName(m.title)}.m4a`),
    filters: [
      { name: 'Áudio M4A', extensions: ['m4a'] },
      { name: 'Áudio MP3', extensions: ['mp3'] },
    ],
  });
  if (canceled || !filePath) return false;
  await exportAudioFile(src, filePath);
  return true;
}
