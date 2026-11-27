import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeTheme, Notification, powerSaveBlocker, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import {
  aiStatus,
  forgetKeysOf,
  initAi,
  listOllamaModels,
  OLLAMA_DOWNLOAD_URL,
  PROVIDERS,
  removeProviderKey,
  resolveSummarizer,
  setProviderKey,
  SUMMARIZERS,
  TRANSCRIBERS,
  transcriberProblem,
} from './ai.js';
import { initModels, modelsStatus } from './local-stt/models.js';
import { cancelLogin, currentUser, initAuth, login, logout, useFakeUserForScreenshots } from './auth.js';
import { calendarConnected, clearCalendarCache, listEvents, startMeetingWatcher, useFakeCalendarForScreenshots } from './calendar.js';
import { canOpenAtLogin, createTray, hasTray, opensAtLogin, refreshTray, setOpenAtLogin, startedAtLogin } from './tray.js';
import { checkForUpdate, initUpdater, installUpdate, updateState } from './updater.js';
import { configProblem } from './config.js';
import { exportAudioFile, finalizeAudio, probeDuration } from './media.js';
import { Summarizer } from './summarizer.js';
import { Transcriber } from './transcriber.js';
import { getSettings, initSettings, updateSettings } from './settings.js';
import { formatTimestamp, summaryToText, transcriptToText } from './speech.js';

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
let summarizer = null;

const notify = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) || 'reuniao';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusWindow());
  app.on('activate', () => focusWindow()); // macOS: clique no ícone do Dock
  // Cmd+Q, "Sair" do Dock, desligar o computador: confirma se houver gravação em andamento.
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    requestQuit();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start);
}

async function start() {
  const userData = app.getPath('userData');
  store.initStore(userData);
  initSettings(userData);
  await initAuth(userData, { onChange: (user) => notify('auth:changed', user) });
  await initAi(userData);
  initModels(userData);
  if (app.commandLine.hasSwitch('screenshot') && app.commandLine.hasSwitch('fake-user')) {
    const calendar = !app.commandLine.hasSwitch('fake-no-calendar');
    useFakeUserForScreenshots(app.commandLine.getSwitchValue('fake-user'), { calendar });
    if (calendar) useFakeCalendarForScreenshots({ meetingNow: app.commandLine.hasSwitch('auto-record-test') });
  }
  startMeetingWatcher({
    enabled: () => (getSettings().notifyMeetings || getSettings().autoRecordMeetings) && !recording,
    onStarting: announceMeeting,
  });
  summarizer = new Summarizer({ notify });
  transcriber = new Transcriber({
    notify,
    onDone: (id, { thenSummarize }) => {
      if (thenSummarize) summarizer.start(id).catch((err) => notify('summary:error', { id, error: err.message }));
    },
  });

  setupPermissions();
  registerIpc();
  await resetInterruptedJobs();
  createWindow({ hidden: startedAtLogin() });
  createTray({
    open: focusWindow,
    record: () => recordFromOutside(null),
    stop: () => runInWindow('window.__stop()'),
    quit: requestQuit,
    isRecording: () => Boolean(recording),
    update: updateState,
    installUpdate: applyUpdate,
  });
  initUpdater({
    onChange: (state) => {
      notify('update:changed', state);
      refreshTray();
    },
    canInstallNow: () => {
      if (recording) return 'Pare a gravação antes de atualizar. A atualização também é instalada quando você fechar o app.';
      if (transcriber?.busy || summarizer?.running.size) return 'Espere a transcrição ou o resumo terminar para reiniciar e atualizar.';
      return null;
    },
    beforeInstall: () => (quitting = true),
    install: applyUpdate,
  });
  // Na primeira vez no app instalado, já abre junto com o computador (dá para desligar no menu do ícone).
  if (canOpenAtLogin() && !getSettings().loginItemConfigured) {
    setOpenAtLogin(true);
    updateSettings({ loginItemConfigured: true });
  }
  finalizeInterruptedRecordings(); // em segundo plano
  // Apaga o Whisper (até 1 GB) baixado pelas versões anteriores, que não é mais usado.
  // Os modelos atuais ficam em models/stt e não são tocados.
  for (const old of ['onnx-community', 'Xenova']) {
    fs.promises.rm(path.join(userData, 'models', old), { recursive: true, force: true }).catch(() => {});
  }

  if (['selftest', 'demo', 'screenshot'].some((s) => app.commandLine.hasSwitch(s))) {
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

function createWindow({ hidden = false } = {}) {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    show: !hidden, // aberto pelo sistema no login: começa só no ícone da barra
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

// Fechar a janela só esconde o app: ele continua no ícone da barra (gravando, se estiver) para
// avisar das reuniões da agenda. Sem ícone (alguns Linux), fechar é sair, como antes.
function onWindowClose(event) {
  if (quitting) return;
  event.preventDefault();
  if (!hasTray()) {
    requestQuit();
    return;
  }
  win.hide();
  if (!getSettings().trayHintShown && Notification.isSupported()) {
    updateSettings({ trayHintShown: true });
    new Notification({
      title: 'O XMeeting continua aberto',
      body: recording
        ? 'A gravação continua. Abra pelo ícone na barra para parar.'
        : 'Ele fica no ícone da barra para avisar quando suas reuniões começarem. Para fechar de vez, use "Sair" no menu do ícone.',
    }).show();
  }
}

/** Reiniciar e atualizar (aviso, menu do ícone ou interface). Se não der agora, explica o porquê. */
async function applyUpdate() {
  const result = await installUpdate();
  if (!result.ok && result.reason) {
    focusWindow();
    dialog.showMessageBox(win, { type: 'info', title: 'XMeeting Notes', message: 'Ainda não dá para atualizar', detail: result.reason });
  }
  return result;
}

/** Sair de verdade (menu do ícone, Cmd+Q): confirma se há gravação, transcrição ou resumo em andamento. */
function requestQuit() {
  if (quitting) return;
  const recordingNow = Boolean(recording);
  if (!recordingNow && !transcriber?.busy && !summarizer?.running.size) {
    quitting = true;
    app.quit();
    return;
  }
  focusWindow();
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    title: 'XMeeting Notes',
    buttons: ['Cancelar', recordingNow ? 'Parar gravação e sair' : 'Sair mesmo assim'],
    defaultId: 0,
    cancelId: 0,
    message: recordingNow ? 'Uma reunião está sendo gravada.' : 'Uma transcrição ou um resumo está em andamento.',
    detail: recordingNow
      ? 'Ao sair, a gravação é encerrada e o áudio gravado até agora fica salvo.'
      : 'O processo será interrompido. Você pode pedir de novo depois.',
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
  handle('app:login-item', () => ({ available: canOpenAtLogin(), enabled: opensAtLogin() }));
  handle('app:set-login-item', (enabled) => ({ available: canOpenAtLogin(), enabled: setOpenAtLogin(enabled) }));

  handle('update:get', () => updateState());
  handle('update:check', () => checkForUpdate());
  handle('update:install', () => installUpdate());

  handle('auth:get', () => ({ user: currentUser(), problem: configProblem() }));
  handle('ai:status', () => aiStatus());
  handle('ai:options', () => aiOptions());
  handle('ai:set-key', (provider, key) => setProviderKey(provider, key));
  handle('ai:remove-key', (provider) => removeProviderKey(provider));
  handle('ai:open-page', (provider) => {
    const url = provider === 'ollama' ? OLLAMA_DOWNLOAD_URL : PROVIDERS[provider]?.keysUrl;
    if (url) return shell.openExternal(url);
  });
  handle('auth:login', async () => {
    const user = await login();
    focusWindow(); // volta do navegador para o app
    return user;
  });
  handle('auth:cancel', () => cancelLogin());
  handle('auth:logout', async () => {
    if (recording) throw new Error('Pare a gravação antes de sair da conta.');
    await forgetKeysOf(); // as chaves de IA são da conta que está saindo
    clearCalendarCache();
    await logout();
  });

  handle('calendar:list', async ({ refresh = false } = {}) => listEvents({ days: 7, maxAgeMs: refresh ? 0 : 60_000 }));
  // Conectar a agenda = fazer o login de novo, agora com a permissão da agenda marcada.
  handle('calendar:connect', async () => {
    if (recording) throw new Error('Pare a gravação antes de conectar a agenda.');
    clearCalendarCache();
    await login();
    focusWindow();
    return { connected: calendarConnected() };
  });
  handle('calendar:join', async (eventId) => {
    const ev = await findEvent(eventId);
    if (!ev?.link || !/^https:\/\//.test(ev.link.url)) throw new Error('Este compromisso não tem link de chamada.');
    await shell.openExternal(ev.link.url);
  });

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
    if (summarizer.isActive(id)) throw new Error('Espere o resumo terminar antes de excluir esta reunião.');
    await store.remove(id);
  });

  handle('rec:start', startRecording);
  ipcMain.on('rec:chunk', (_event, id, track, data) => writeChunk(id, track, data));
  handle('rec:stop', stopRecording);

  handle('transcript:start', (id, options = {}) => {
    requireLogin();
    return transcriber.enqueue(id, { thenSummarize: Boolean(options.thenSummarize) });
  });
  handle('transcript:cancel', (id) => transcriber.cancel(id));
  handle('transcript:copy', async (id) => clipboard.writeText(await transcriptText(id)));
  handle('transcript:export', exportTranscript);

  handle('summary:start', (id) => {
    requireLogin();
    return summarizer.start(id);
  });
  handle('summary:copy', async (id) => {
    const m = await store.get(id);
    if (!m?.summaryData) throw new Error('Esta reunião ainda não foi resumida.');
    clipboard.writeText(`${m.title}\n${new Date(m.createdAt).toLocaleString('pt-BR')}\n\n${summaryToText(m.summaryData)}\n`);
  });

  handle('audio:export', exportAudio);
  handle('folder:open', (id) => shell.openPath(store.dirOf(id)));
  handle('folder:open-data', () => shell.openPath(app.getPath('userData')));
}

/** O que a tela de Configurações mostra: opções de transcrição e de resumo, e se estão disponíveis. */
async function aiOptions() {
  const { summarizer, ollamaModel } = getSettings();
  const models = modelsStatus();
  const ollamaModels = await listOllamaModels();
  const transcribers = Object.entries(TRANSCRIBERS).map(([key, t]) => ({
    key,
    label: t.label,
    problem: transcriberProblem(key),
    model: key === 'local-fast' ? models.fast : key === 'local-quality' ? models.quality : null,
  }));
  const summarizers = [];
  for (const [key, s] of Object.entries(SUMMARIZERS)) {
    summarizers.push({ key, label: s.label, available: Boolean(await resolveSummarizer(key, ollamaModel)) });
  }
  const current = await resolveSummarizer(summarizer, ollamaModel);
  return { transcribers, summarizers, currentSummarizer: current?.label ?? null, ollamaModels: ollamaModels.map((m) => m.name) };
}

function requireLogin() {
  if (!currentUser()) throw new Error('Entre com sua conta Google para continuar.');
}

function focusWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
}

// Roda código na interface como se fosse um clique da pessoa: o Chromium só libera a captura do
// áudio do sistema (getDisplayMedia) com um gesto do usuário. Sem isso, gravar a partir da
// notificação ou do ícone da barra pegaria só o microfone.
function runInWindow(code) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return win.webContents.executeJavaScript(code, true).catch((err) => console.warn('Falha ao acionar a interface:', err.message));
}

function recordFromOutside(eventId) {
  focusWindow();
  if (!recording) runInWindow(`window.__record(${JSON.stringify(eventId ?? null)})`);
}

// ---------------------------------------------------------------- agenda

async function findEvent(eventId) {
  if (!eventId) return null;
  const { events } = await listEvents({ days: 7, maxAgeMs: 10 * 60_000 });
  return events.find((e) => e.id === eventId) ?? null;
}

// Uma reunião da agenda começou. Com "gravar sozinho" ligado, começa a gravar sem tirar o foco da
// tela (a pessoa pode estar entrando na chamada); parar continua sendo manual. Senão, só avisa:
// clicar no aviso abre o app e começa a gravar.
async function announceMeeting(ev) {
  const notify = (title, body, onClick) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    if (onClick) n.on('click', onClick);
    n.show();
  };
  if (getSettings().autoRecordMeetings && currentUser() && !recording) {
    await runInWindow(`window.__record(${JSON.stringify(ev.id)})`);
    if (recording) {
      notify(`Gravando: ${ev.title}`, 'O XMeeting começou a gravar sozinho. Avise os participantes. Clique para abrir ou parar.', focusWindow);
      return;
    }
    notify('Não consegui começar a gravar', `${ev.title}\nClique para tentar de novo.`, () => recordFromOutside(ev.id));
    return;
  }
  if (getSettings().notifyMeetings) notify('Sua reunião está começando', `${ev.title}\nClique para gravar no XMeeting.`, () => recordFromOutside(ev.id));
}

// ---------------------------------------------------------------- gravação

async function startRecording({ hasSystemAudio, eventId } = {}) {
  requireLogin();
  if (recording) throw new Error('Já existe uma gravação em andamento.');
  const event = await findEvent(eventId).catch(() => null); // sem internet: grava sem os dados da agenda
  const meta = await store.create({ hasSystemAudio, event });
  recording = { id: meta.id, streams: {}, blocker: powerSaveBlocker.start('prevent-app-suspension') };
  refreshTray();
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
  refreshTray();
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

async function resetInterruptedJobs() {
  for (const m of await store.list()) {
    if (m.transcript?.status === 'queued' || m.transcript?.status === 'running') {
      await store.update(m.id, {
        transcript: store.hasTranscript(m.id)
          ? { status: 'done', error: null }
          : { status: 'error', error: 'A transcrição foi interrompida porque o app foi fechado. Clique em Transcrever para tentar de novo.' },
      });
    }
    if (m.summary?.status === 'running') {
      await store.update(m.id, {
        summary: store.hasSummary(m.id)
          ? { status: 'done', error: null }
          : { status: 'error', error: 'O resumo foi interrompido porque o app foi fechado. Clique em Resumir para tentar de novo.' },
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
