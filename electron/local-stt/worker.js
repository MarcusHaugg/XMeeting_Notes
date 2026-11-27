// Transcrição no computador (sherpa-onnx). Roda num processo separado e com prioridade baixa,
// para não travar o app nem a chamada. Nada sai do computador.
//
// Para cada trilha: decodifica (ffmpeg) → detecta a fala (Silero VAD) → corta em trechos de até
// 28 s → transcreve cada trecho (Parakeet na opção Rápida, Whisper turbo na Máxima qualidade).
import { createRequire } from 'node:module';
import { decodePcm } from '../media.js';
import { cleanText } from '../speech.js';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const RATE = 16000;
const MAX_SEGMENT = 28 * RATE; // o Whisper aceita até 30 s por vez
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

function recognizer({ engine, encoder, decoder, joiner, tokens }, language, numThreads) {
  if (engine === 'fast') {
    return new sherpa.OfflineRecognizer({
      modelConfig: { transducer: { encoder, decoder, joiner }, tokens, modelType: 'nemo_transducer', numThreads },
    });
  }
  return new sherpa.OfflineRecognizer({
    modelConfig: {
      whisper: { encoder, decoder, language: language === 'auto' ? '' : language.split('-')[0], task: 'transcribe' },
      tokens,
      numThreads,
    },
  });
}

function decodeText(rec, samples, engine) {
  const stream = rec.createStream();
  // O padrão do Whisper (6 tokens/s) às vezes corta o fim de fala rápida. 8 dá folga; valores
  // maiores não melhoraram o texto nos testes e deixaram tudo até 2,7x mais lento.
  if (engine === 'quality') stream.setOption('max_tokens_per_second', '8');
  stream.acceptWaveform({ samples, sampleRate: RATE });
  rec.decode(stream);
  return cleanText(rec.getResult(stream).text);
}

// O Whisper às vezes encerra cedo um trecho longo com várias vozes (ex.: "É isso." para 20 s de
// conversa). Se vier pouco texto para a duração, transcreve as duas metades e fica com o mais completo.
function transcribeSegment(rec, samples, engine) {
  const text = decodeText(rec, samples, engine);
  const seconds = samples.length / RATE;
  const words = text ? text.split(/\s+/).length : 0;
  if (engine !== 'quality' || seconds < 8 || words / seconds >= 0.8) return text;
  const half = Math.floor(samples.length / 2);
  const retry = [decodeText(rec, samples.subarray(0, half), engine), decodeText(rec, samples.subarray(half), engine)].filter(Boolean).join(' ');
  return retry.split(/\s+/).length > words ? retry : text;
}

/** Trechos com fala de uma trilha: [{ start (s), samples }], cada um com até 28 s. */
function speechSegments(samples, vadModel) {
  const vad = new sherpa.Vad(
    {
      sileroVad: { model: vadModel, threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 512 },
      sampleRate: RATE,
      numThreads: 1,
    },
    60
  );
  const out = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front(false);
      const segSamples = Float32Array.from(seg.samples);
      // O VAD às vezes entrega trechos maiores que o pedido: corta em pedaços de 28 s.
      for (let o = 0; o < segSamples.length; o += MAX_SEGMENT) {
        out.push({ start: seg.start / RATE + o / RATE, samples: segSamples.subarray(o, o + MAX_SEGMENT) });
      }
      vad.pop();
    }
  };
  for (let i = 0; i + 512 <= samples.length; i += 512) {
    vad.acceptWaveform(samples.subarray(i, i + 512));
    drain();
  }
  vad.flush();
  drain();
  return out;
}

async function run({ files, model, language, numThreads }) {
  const status = (stage, progress = null, etaSec = null) => send({ type: 'progress', stage, progress, etaSec });

  // 1) Prepara todas as trilhas (rápido) para saber o total de fala e mostrar o progresso.
  status('Preparando o áudio...');
  const tracks = [];
  for (const f of files) {
    const pcm = await decodePcm(f.path);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
    tracks.push({ ...f, segments: speechSegments(samples, model.vad) });
  }
  const total = tracks.reduce((sum, t) => sum + t.segments.reduce((s, seg) => s + seg.samples.length, 0), 0);
  if (total === 0) return tracks.map(({ track, speaker }) => ({ track, speaker, segments: [] }));

  // 2) Transcreve trecho por trecho.
  status('Carregando o modelo de transcrição...');
  const rec = recognizer(model, language, numThreads);
  const started = Date.now();
  let done = 0;
  const result = [];
  for (const t of tracks) {
    const segments = [];
    for (const seg of t.segments) {
      const text = transcribeSegment(rec, seg.samples, model.engine);
      if (text) segments.push({ start: seg.start, end: seg.start + seg.samples.length / RATE, text });

      done += seg.samples.length;
      const progress = done / total;
      const elapsed = (Date.now() - started) / 1000;
      status(`Transcrevendo "${t.speaker}"...`, progress, progress > 0.03 ? Math.round((elapsed * (1 - progress)) / progress) : null);
    }
    result.push({ track: t.track, speaker: t.speaker, segments });
    t.segments = null; // libera memória antes da próxima trilha
  }
  return result;
}
