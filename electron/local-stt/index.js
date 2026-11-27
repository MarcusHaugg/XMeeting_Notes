// Transcrição no computador: baixa o modelo na primeira vez e roda o worker num processo separado.
import { utilityProcess } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES, ensureModel, modelPaths } from './models.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');

// Deixa núcleos livres para a chamada e para o app: no máximo 4 linhas de execução.
const THREADS = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));

/**
 * files: [{ track, speaker, path }]. engine: 'fast' | 'quality'.
 * Devolve [{ track, speaker, segments: [{ start, end, text }] }].
 */
export async function transcribeLocally({ files, engine, language, signal, onProgress }) {
  if (!ENGINES[engine]) throw new Error('Opção de transcrição desconhecida.');
  await ensureModel(engine, {
    signal,
    onProgress: (p) =>
      onProgress?.({ stage: `Baixando o modelo "${ENGINES[engine].label}" (${ENGINES[engine].downloadMb} MB, só na primeira vez)...`, progress: p }),
  });
  if (signal?.aborted) throw new Error('Cancelada.');

  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(WORKER, [], { serviceName: 'XMeeting Notes - Transcricao', stdio: 'pipe' });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
      child.kill();
    };
    const onAbort = () => finish(reject, new Error('Cancelada.'));
    signal?.addEventListener('abort', onAbort);

    child.stdout?.on('data', (d) => process.stdout.write(d));
    child.stderr?.on('data', (d) => process.stderr.write(d));
    child.on('spawn', () => {
      // Prioridade baixa: a chamada (Teams/Meet/Zoom) e o app continuam fluidos.
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* sem permissão para mudar a prioridade: segue normal */
      }
      child.postMessage({ type: 'run', files, model: modelPaths(engine), language, numThreads: THREADS });
    });
    child.on('message', (msg) => {
      if (msg?.type === 'progress') onProgress?.(msg);
      else if (msg?.type === 'result') finish(resolve, msg.tracks);
      else if (msg?.type === 'error') finish(reject, new Error(msg.message));
    });
    child.on('exit', (code) => finish(reject, new Error(`O processo de transcrição parou inesperadamente (código ${code}).`)));
  });
}
