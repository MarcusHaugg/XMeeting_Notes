// Núcleo da transcrição, sem dependência do Electron: usado pelo processo de
// transcrição do app e por scripts de teste/medição.
import { decodePcm } from './media.js';
import { cleanText, planWindows, windowFrames, windowPartIndex, windowTimeMapper, windowToFloat32 } from './speech.js';

export async function loadModel({ modelId, cacheDir, dtype = 'q8', onStatus }) {
  const { pipeline, env } = await import('@huggingface/transformers');
  if (cacheDir) env.cacheDir = cacheDir;
  return pipeline('automatic-speech-recognition', modelId, {
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total > 5e6) onStatus?.(`Baixando o modelo (só na primeira vez)... ${Math.round(p.progress)}%`);
    },
  });
}

/** Decodifica as trilhas e planeja as janelas (barato; serve para calcular o progresso). */
export async function prepareTracks(files) {
  const tracks = [];
  for (const f of files) {
    const pcm = await decodePcm(f.path);
    tracks.push({ ...f, pcm, windows: planWindows(pcm) });
  }
  return tracks;
}

export const speechFrames = (track) => track.windows.reduce((sum, w) => sum + windowFrames(w), 0);

const SENTENCE_END = /[.?!…]$/;
const MAX_WORDS_PER_SEGMENT = 40;

/**
 * Agrupa as palavras (com horário) em falas. Uma fala nova começa quando a palavra
 * vem de outro trecho colado (ou seja, outro momento da reunião), depois de uma pausa,
 * ou no fim de uma frase já longa. Assim "Você" e "Outros" ficam na ordem certa.
 */
function wordsToSegments(words, parts, toReal) {
  const segments = [];
  let current = null;
  for (const w of words) {
    const [ws, we] = w.timestamp ?? [];
    if (ws == null) continue;
    const part = windowPartIndex(parts, ws);
    const start = toReal(ws);
    const end = toReal(we ?? ws);
    const startsNew =
      !current ||
      part !== current.part ||
      start - current.end > 1.0 ||
      (SENTENCE_END.test(current.text) && current.words >= 12) ||
      current.words >= MAX_WORDS_PER_SEGMENT;
    if (startsNew) {
      current = { part, start, end, text: w.text, words: 1 };
      segments.push(current);
    } else {
      // Palavras novas já vêm com espaço na frente; pedaços como "-feira" não.
      current.text += w.text;
      current.end = end;
      current.words++;
    }
  }
  return segments.map(({ start, end, text }) => ({ start, end: Math.max(start, end), text: cleanText(text) })).filter((s) => s.text);
}

/**
 * Transcreve uma trilha janela por janela. Usa o horário de cada palavra quando o
 * modelo oferece (separa as falas com precisão); senão, o horário de cada frase.
 */
export async function transcribeTrack(asr, track, { language, numBeams = 1, onWindow } = {}) {
  const base = {
    task: 'transcribe',
    num_beams: numBeams,
    max_new_tokens: 380, // uma janela de 28 s cabe com folga; limita loops em ruído
    ...(language && language !== 'auto' ? { language } : {}),
  };
  const segments = [];
  let failed = 0;
  let lastError = null;
  let wordLevel = asr.__wordLevel ?? true;

  for (const parts of track.windows) {
    const toReal = windowTimeMapper(parts);
    const durationSec = (windowFrames(parts) * 30) / 1000;
    const audio = windowToFloat32(track.pcm, parts);
    try {
      if (wordLevel) {
        try {
          const out = await asr(audio, { ...base, return_timestamps: 'word' });
          segments.push(...wordsToSegments(out?.chunks ?? [], parts, toReal));
          onWindow?.(windowFrames(parts));
          continue;
        } catch (err) {
          if (!/cross attentions/i.test(err?.message ?? '')) throw err;
          wordLevel = asr.__wordLevel = false; // este modelo não tem horário por palavra
        }
      }
      const out = await asr(audio, { ...base, return_timestamps: true });
      const chunks = out?.chunks?.length ? out.chunks : [{ timestamp: [0, null], text: out?.text }];
      for (const c of chunks) {
        const text = cleanText(c.text);
        if (!text) continue;
        const start = toReal(c.timestamp?.[0] ?? 0);
        const end = toReal(c.timestamp?.[1] ?? durationSec);
        segments.push({ start, end: Math.max(start, end), text });
      }
    } catch (err) {
      // Uma janela problemática não pode derrubar a reunião inteira.
      failed++;
      lastError = err;
      console.warn(`Janela ${track.track} em ${toReal(0).toFixed(1)}s ignorada:`, err?.message);
    }
    onWindow?.(windowFrames(parts));
  }
  if (track.windows.length > 0 && failed === track.windows.length) throw lastError;
  return segments;
}
