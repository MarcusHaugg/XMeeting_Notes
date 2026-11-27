// Ponte segura entre a interface e o processo principal: só expõe estas funções.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (channel, ...args) => {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    // Remove o prefixo técnico "Error invoking remote method ..."
    throw new Error(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
};

const EVENTS = new Set([
  'meetings:changed',
  'transcript:progress',
  'transcript:done',
  'transcript:error',
  'summary:done',
  'summary:error',
  'auth:changed',
  'recording:force-stop',
]);

contextBridge.exposeInMainWorld('api', {
  platform: process.platform, // 'win32' | 'darwin' | 'linux'
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    loginItem: () => invoke('app:login-item'),
    setLoginItem: (enabled) => invoke('app:set-login-item', enabled),
    version: () => invoke('app:version'),
  },
  auth: {
    get: () => invoke('auth:get'),
    login: () => invoke('auth:login'),
    cancel: () => invoke('auth:cancel'),
    logout: () => invoke('auth:logout'),
  },
  calendar: {
    list: (options) => invoke('calendar:list', options),
    connect: () => invoke('calendar:connect'),
    join: (eventId) => invoke('calendar:join', eventId),
  },
  ai: {
    status: () => invoke('ai:status'),
    options: () => invoke('ai:options'),
    setKey: (provider, key) => invoke('ai:set-key', provider, key),
    removeKey: (provider) => invoke('ai:remove-key', provider),
    openPage: (provider) => invoke('ai:open-page', provider),
  },
  meetings: {
    list: () => invoke('meetings:list'),
    get: (id) => invoke('meetings:get', id),
    update: (id, patch) => invoke('meetings:update', id, patch),
    remove: (id) => invoke('meetings:remove', id),
  },
  recording: {
    start: (info) => invoke('rec:start', info),
    chunk: (id, track, bytes) => ipcRenderer.send('rec:chunk', id, track, bytes),
    stop: (id) => invoke('rec:stop', id),
  },
  transcript: {
    start: (id, options) => invoke('transcript:start', id, options),
    cancel: (id) => invoke('transcript:cancel', id),
    copy: (id) => invoke('transcript:copy', id),
    export: (id) => invoke('transcript:export', id),
  },
  summary: {
    start: (id) => invoke('summary:start', id),
    copy: (id) => invoke('summary:copy', id),
  },
  exportAudio: (id) => invoke('audio:export', id),
  openFolder: (id) => invoke('folder:open', id),
  openDataFolder: () => invoke('folder:open-data'),
  on: (channel, callback) => {
    if (!EVENTS.has(channel)) throw new Error(`Evento desconhecido: ${channel}`);
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
