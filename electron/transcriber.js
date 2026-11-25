// Fila de transcrição (uma por vez) e controle do processo do Whisper.
import { utilityProcess } from 'electron';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { getSettings, MODELS } from './settings.js';
import { mergeTranscript } from './speech.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'transcribe-worker.js');
const TRACKS = [
  ['mic', 'Você'],
  ['system', 'Outros'],
];

export class Transcriber {
  constructor({ cacheDir, notify }) {
    this.cacheDir = cacheDir;
    this.notify = notify;
    this.queue = [];
    this.current = null;
  }

  get busy() {
    return Boolean(this.current) || this.queue.length > 0;
  }

  isActive(id) {
    return this.current?.id === id || this.queue.includes(id);
  }

  async enqueue(id) {
    if (this.isActive(id)) return;
    const meta = await store.getMeta(id);
    if (!meta) throw new Error('Reunião não encontrada.');
    if (meta.status !== 'ready') throw new Error('O áudio desta reunião ainda não está pronto.');
    this.queue.push(id);
    await store.update(id, { transcript: { status: 'queued', error: null } });
    this.notify('meetings:changed');
    this.next();
  }

  async cancel(id) {
    const i = this.queue.indexOf(id);
    if (i >= 0) {
      this.queue.splice(i, 1);
      await this.restore(id);
      this.notify('meetings:changed');
    } else if (this.current?.id === id) {
      this.current.cancelled = true;
      this.current.child?.kill();
    }
  }

  // Ao cancelar, volta para a transcrição anterior (se havia) ou para "não transcrita".
  async restore(id) {
    await store.update(id, { transcript: { status: store.hasTranscript(id) ? 'done' : null, error: null } });
  }

  next() {
    if (this.current || this.queue.length === 0) return;
    this.current = { id: this.queue.shift(), child: null, cancelled: false };
    this.run(this.current).finally(() => {
      this.current = null;
      this.next();
    });
  }

  async run(job) {
    const { id } = job;
    try {
      const { model, language } = getSettings();
      const files = TRACKS.map(([track, speaker]) => ({ track, speaker, path: store.trackPath(id, track) })).filter(
        (f) => existsSync(f.path) && statSync(f.path).size > 0
      );
      if (files.length === 0) throw new Error('Não encontrei o áudio gravado desta reunião.');

      await store.update(id, { transcript: { status: 'running', error: null, model, language, startedAt: new Date().toISOString() } });
      this.notify('meetings:changed');

      const m = MODELS[model];
      const tracks = await this.runWorker(job, {
        files,
        modelId: m.id,
        dtype: m.dtype ?? 'q8',
        numBeams: m.beams ?? 1,
        language,
        cacheDir: this.cacheDir,
      });
      await store.saveTranscript(id, mergeTranscript(tracks));
      await store.update(id, { transcript: { status: 'done', error: null, finishedAt: new Date().toISOString() } });
      this.notify('transcript:done', { id });
    } catch (err) {
      if (job.cancelled) {
        await this.restore(id).catch(() => {});
      } else {
        await store.update(id, { transcript: { status: 'error', error: err.message } }).catch(() => {});
        this.notify('transcript:error', { id, error: err.message });
      }
    }
    this.notify('meetings:changed');
  }

  runWorker(job, payload) {
    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(WORKER, [], { serviceName: 'XMeeting Notes - Transcricao', stdio: 'pipe' });
      job.child = child;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
        child.kill();
      };

      child.stdout?.on('data', (d) => process.stdout.write(d));
      child.stderr?.on('data', (d) => process.stderr.write(d));
      child.on('spawn', () => {
        // Prioridade baixa: a chamada (Teams/Meet/Zoom) e o app continuam fluidos.
        try {
          os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          /* sem permissão para mudar a prioridade: segue normal */
        }
        child.postMessage({ type: 'run', ...payload });
      });
      child.on('message', (msg) => {
        if (msg?.type === 'status' || msg?.type === 'progress') this.notify('transcript:progress', { id: job.id, ...msg });
        else if (msg?.type === 'result') finish(resolve, msg.tracks);
        else if (msg?.type === 'error') finish(reject, new Error(msg.message));
      });
      child.on('exit', (code) =>
        finish(reject, new Error(job.cancelled ? 'Cancelada.' : `O processo de transcrição parou inesperadamente (código ${code}).`))
      );
    });
  }
}
