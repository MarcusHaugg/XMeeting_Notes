// Modelos da transcrição no computador (sherpa-onnx, github.com/k2-fsa/sherpa-onnx). Baixados só
// na primeira vez que a pessoa usa cada opção, para a pasta de dados do app.
// Validados com uma reunião real em português (43 min, Mac M2): a opção Rápida transcreveu em
// ~2 min; a Máxima qualidade errou menos, mas levou ~metade da duração da reunião.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export const ENGINES = {
  fast: {
    label: 'Rápida',
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    url: `${BASE}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    downloadMb: 465,
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
  },
  quality: {
    label: 'Máxima qualidade',
    dir: 'sherpa-onnx-whisper-turbo',
    url: `${BASE}/asr-models/sherpa-onnx-whisper-turbo.tar.bz2`,
    downloadMb: 538,
    files: ['turbo-encoder.int8.onnx', 'turbo-decoder.int8.onnx', 'turbo-tokens.txt'],
  },
};
const VAD = { file: 'silero_vad.onnx', url: `${BASE}/asr-models/silero_vad.onnx` };

let root = null;
export function initModels(userData) {
  root = path.join(userData, 'models', 'stt');
}

const ready = (engine) => {
  const e = ENGINES[engine];
  return fs.existsSync(path.join(root, VAD.file)) && e.files.every((f) => fs.existsSync(path.join(root, e.dir, f)));
};

export function modelsStatus() {
  return Object.fromEntries(Object.entries(ENGINES).map(([key, e]) => [key, { label: e.label, ready: ready(key), downloadMb: e.downloadMb }]));
}

/** Caminhos dos arquivos que o processo de transcrição precisa. */
export function modelPaths(engine) {
  const e = ENGINES[engine];
  const p = (f) => path.join(root, e.dir, f);
  const vad = path.join(root, VAD.file);
  if (engine === 'fast') return { engine, vad, encoder: p('encoder.int8.onnx'), decoder: p('decoder.int8.onnx'), joiner: p('joiner.int8.onnx'), tokens: p('tokens.txt') };
  return { engine, vad, encoder: p('turbo-encoder.int8.onnx'), decoder: p('turbo-decoder.int8.onnx'), tokens: p('turbo-tokens.txt') };
}

async function download(url, dest, { signal, onProgress }) {
  const res = await fetch(url, { signal }).catch((err) => {
    if (signal?.aborted) throw err;
    throw new Error('Não consegui baixar o modelo de transcrição. Verifique a internet.');
  });
  if (!res.ok || !res.body) throw new Error(`Não consegui baixar o modelo de transcrição (erro ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const count = new Transform({
    transform(chunk, _enc, callback) {
      done += chunk.length;
      if (total) onProgress?.(done / total);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(dest), { signal });
}

// O Windows 10/11 e o macOS trazem o "tar" (bsdtar), que abre .tar.bz2; no Linux ele é padrão.
function extract(archive, into) {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    const proc = spawn(tar, ['-xjf', archive, '-C', into], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Não consegui abrir o modelo baixado: ${stderr.trim().slice(-200)}`))));
  });
}

let downloading = null;

/** Garante o modelo no disco. onProgress(0..1) durante o download. */
export async function ensureModel(engine, { signal, onProgress } = {}) {
  if (ready(engine)) return;
  // Um download por vez (duas transcrições na fila não baixam o mesmo modelo duas vezes).
  while (downloading) await downloading.catch(() => {});
  if (ready(engine)) return;
  downloading = (async () => {
    const e = ENGINES[engine];
    fs.mkdirSync(root, { recursive: true });
    const vad = path.join(root, VAD.file);
    if (!fs.existsSync(vad)) {
      await download(VAD.url, `${vad}.part`, { signal });
      fs.renameSync(`${vad}.part`, vad);
    }
    const archive = path.join(root, `${e.dir}.tar.bz2.part`);
    try {
      await download(e.url, archive, { signal, onProgress });
      onProgress?.(1);
      await extract(archive, root);
    } finally {
      fs.rmSync(archive, { force: true });
    }
    fs.rmSync(path.join(root, e.dir, 'test_wavs'), { recursive: true, force: true }); // exemplos do pacote
    if (!ready(engine)) throw new Error('O modelo baixado está incompleto. Tente de novo.');
  })();
  try {
    await downloading;
  } finally {
    downloading = null;
  }
}

/** Apaga um modelo baixado (para liberar espaço). */
export function removeModel(engine) {
  fs.rmSync(path.join(root, ENGINES[engine].dir), { recursive: true, force: true });
}
