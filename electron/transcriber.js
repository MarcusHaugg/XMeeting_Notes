// Fila de transcrição (uma reunião por vez), com a opção escolhida em Configurações:
//   - no computador (sherpa-onnx, local-stt/): "Rápida" ou "Máxima qualidade";
//   - na nuvem: Gemini (partes de até 25 min, com horário por palavra) ou OpenAI (trechos de
//     até 28 s, porque o modelo devolve só o texto; o horário vem de cada trecho).
// Nos dois casos só os trechos com fala são processados e cada fala volta ao horário real.
import { existsSync, statSync } from 'node:fs';
import * as store from './store.js';
import { parallelism, TRANSCRIBERS, transcriberProblem, transcribeChunk } from './ai.js';
import { transcribeLocally } from './local-stt/index.js';
import { decodePcm, encodeMp3 } from './media.js';
import { getSettings } from './settings.js';
import { chunkPcm, chunkSeconds, MAX_CHUNK_SECONDS, mergeTranscript, planChunks, wordsToSegments } from './speech.js';

const TRACKS = [
  ['mic', 'Você'],
  ['system', 'Outros'],
];

/** Usa o texto completo (com pontuação) quando ele bate palavra por palavra com os horários. */
function alignWords(result) {
  const words = result.words ?? [];
  const tokens = String(result.text ?? '')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length && tokens.length === words.length) return words.map((w, i) => ({ ...w, text: tokens[i] }));
  return words;
}

function speakerName(track, speakerId) {
  if (track === 'mic') return 'Você';
  if (!speakerId) return 'Outros';
  const n = String(speakerId).match(/\d+/)?.[0];
  return n ? `Participante ${n}` : 'Outros';
}

async function runPool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class Transcriber {
  constructor({ notify, onDone }) {
    this.notify = notify;
    this.onDone = onDone; // (id, { thenSummarize }) depois de uma transcrição bem-sucedida
    this.queue = []; // [{ id, thenSummarize }]
    this.current = null;
  }

  get busy() {
    return Boolean(this.current) || this.queue.length > 0;
  }

  isActive(id) {
    return this.current?.id === id || this.queue.some((q) => q.id === id);
  }

  async enqueue(id, { thenSummarize = false } = {}) {
    if (this.isActive(id)) return;
    const problem = transcriberProblem(getSettings().transcriber);
    if (problem) throw new Error(problem);
    const meta = await store.getMeta(id);
    if (!meta) throw new Error('Reunião não encontrada.');
    if (meta.status !== 'ready') throw new Error('O áudio desta reunião ainda não está pronto.');
    this.queue.push({ id, thenSummarize });
    await store.update(id, { transcript: { status: 'queued', error: null } });
    this.notify('meetings:changed');
    this.next();
  }

  async cancel(id) {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i >= 0) {
      this.queue.splice(i, 1);
      await this.restore(id);
      this.notify('meetings:changed');
    } else if (this.current?.id === id) {
      this.current.cancelled = true;
      this.current.abort.abort();
    }
  }

  // Ao cancelar, volta para a transcrição anterior (se havia) ou para "não transcrita".
  async restore(id) {
    await store.update(id, { transcript: { status: store.hasTranscript(id) ? 'done' : null, error: null } });
  }

  next() {
    if (this.current || this.queue.length === 0) return;
    const { id, thenSummarize } = this.queue.shift();
    this.current = { id, thenSummarize, cancelled: false, abort: new AbortController() };
    this.run(this.current).finally(() => {
      this.current = null;
      this.next();
    });
  }

  progress(id, stage, progress = null, etaSec = null) {
    this.notify('transcript:progress', { id, stage, progress, etaSec });
  }

  async run(job) {
    const { id, abort } = job;
    try {
      const { language, diarize, transcriber: engine } = getSettings();
      const problem = transcriberProblem(engine); // a chave pode ter sido removida enquanto esperava na fila
      if (problem) throw new Error(problem);
      const files = TRACKS.map(([track, speaker]) => ({ track, speaker, path: store.trackPath(id, track) })).filter(
        (f) => existsSync(f.path) && statSync(f.path).size > 0
      );
      if (files.length === 0) throw new Error('Não encontrei o áudio gravado desta reunião.');

      await store.update(id, {
        transcript: { status: 'running', error: null, engine, engineLabel: TRANSCRIBERS[engine].label, language, startedAt: new Date().toISOString() },
      });
      this.notify('meetings:changed');

      const local = engine === 'local-fast' || engine === 'local-quality';
      const tracks = local
        ? await transcribeLocally({
            files,
            engine: engine === 'local-fast' ? 'fast' : 'quality',
            language,
            signal: abort.signal,
            onProgress: (p) => this.progress(id, p.stage, p.progress, p.etaSec),
          })
        : await this.runCloud(job, { engine, files, language, diarize: engine === 'gemini' && diarize });
      if (job.cancelled) throw new Error('Cancelada.');

      await store.saveTranscript(id, mergeTranscript(tracks));
      await store.update(id, { transcript: { status: 'done', error: null, finishedAt: new Date().toISOString() } });
      this.notify('transcript:done', { id });
      this.onDone?.(id, { thenSummarize: job.thenSummarize });
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

  /** Nuvem (Gemini ou OpenAI): partes em MP3, enviadas em paralelo. */
  async runCloud(job, { engine, files, language, diarize }) {
    const { id, abort } = job;
    const maxSeconds = engine === 'openai' ? 28 : MAX_CHUNK_SECONDS;
    this.progress(id, 'Preparando o áudio...');
    const parts = [];
    for (const f of files) {
      const pcm = await decodePcm(f.path);
      for (const chunk of planChunks(pcm, maxSeconds)) {
        parts.push({ ...f, chunk, seconds: chunkSeconds(chunk), mp3: await encodeMp3(chunkPcm(pcm, chunk)) });
      }
      if (abort.signal.aborted) throw new Error('Cancelada.');
    }

    const totalSeconds = parts.reduce((sum, p) => sum + p.seconds, 0);
    let doneSeconds = 0;
    const segmentsByTrack = new Map(files.map((f) => [f.track, []]));
    const label = engine === 'openai' ? 'OpenAI' : 'Gemini';
    this.progress(id, parts.length ? `Enviando para ${label === 'OpenAI' ? 'a' : 'o'} ${label}...` : 'Nenhuma fala encontrada.', 0);

    await runPool(parts, parallelism(engine), async (p) => {
      if (abort.signal.aborted) return;
      const result = await transcribeChunk(engine, p.mp3, {
        language: language === 'auto' ? '' : language,
        diarize: diarize && p.track === 'system',
        seconds: p.seconds,
        signal: abort.signal,
      }).catch((err) => {
        abort.abort(); // uma parte falhou: não adianta seguir com as outras
        throw err;
      });

      let segments = wordsToSegments(alignWords(result), p.chunk);
      if (segments.length === 0 && result.text?.trim()) {
        // Sem horário por palavra (OpenAI): a parte inteira vira uma fala.
        segments = wordsToSegments([{ text: result.text, start: 0, end: p.seconds }], p.chunk);
      }
      segmentsByTrack.get(p.track).push(...segments.map((s) => ({ ...s, speaker: speakerName(p.track, s.speakerId) })));

      doneSeconds += p.seconds;
      this.progress(id, `Transcrevendo com ${label === 'OpenAI' ? 'a' : 'o'} ${label}...`, totalSeconds ? doneSeconds / totalSeconds : 1);
    });
    return files.map((f) => ({ track: f.track, speaker: f.speaker, segments: segmentsByTrack.get(f.track) }));
  }
}
