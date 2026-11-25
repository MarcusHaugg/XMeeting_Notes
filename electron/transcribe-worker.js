// Roda num processo separado (utilityProcess) para não travar o app nem a chamada.
// Nada sai do computador: o Whisper roda localmente.
import { loadModel, prepareTracks, speechFrames, transcribeTrack } from './whisper.js';

const port = process.parentPort;
const send = (msg) => port.postMessage(msg);

port.on('message', async ({ data }) => {
  if (data?.type !== 'run') return;
  try {
    send({ type: 'result', tracks: await run(data) });
  } catch (err) {
    send({ type: 'error', message: err?.message || String(err) });
  }
});

async function run({ files, modelId, dtype, numBeams, language, cacheDir }) {
  const status = (stage) => send({ type: 'status', stage, progress: null, etaSec: null });

  status('Preparando o áudio...');
  const tracks = await prepareTracks(files);
  const total = tracks.reduce((sum, t) => sum + speechFrames(t), 0);
  if (total === 0) return tracks.map(({ track, speaker }) => ({ track, speaker, segments: [] }));

  status('Carregando o modelo de transcrição...');
  const asr = await loadModel({ modelId, dtype, cacheDir, onStatus: status });

  const started = Date.now();
  let done = 0;
  const result = [];
  for (const t of tracks) {
    send({ type: 'progress', stage: `Transcrevendo "${t.speaker}"...`, progress: done / total, etaSec: null });
    const segments = await transcribeTrack(asr, t, {
      language,
      numBeams,
      onWindow: (frames) => {
        done += frames;
        const progress = done / total;
        const elapsed = (Date.now() - started) / 1000;
        send({
          type: 'progress',
          stage: `Transcrevendo "${t.speaker}"...`,
          progress,
          etaSec: progress > 0.03 ? Math.round((elapsed * (1 - progress)) / progress) : null,
        });
      },
    });
    result.push({ track: t.track, speaker: t.speaker, segments });
    t.pcm = null; // libera memória antes da próxima trilha
  }
  return result;
}
