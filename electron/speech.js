// Funções puras de áudio/texto usadas pela transcrição (sem dependência do Electron).

export const SAMPLE_RATE = 16000; // PCM Int16 mono
export const FRAME = 480; // 30 ms

const sec = (s) => Math.round((s * 1000) / 30); // segundos → frames de 30 ms

const MIN_SPEECH_FRAMES = sec(0.25);
const MERGE_GAP_FRAMES = sec(1.2); // pausas naturais de até ~1,2 s ficam como estão
const PAD_FRAMES = sec(0.4); // folga generosa: não corta o começo/fim das palavras
// O Gemini Transcribe aceita até 30 min por pedido com horário por palavra; acima disso
// descarta o resto sem avisar. 25 min deixa margem.
export const MAX_CHUNK_SECONDS = 25 * 60;

function frameRms(pcm) {
  const n = Math.floor(pcm.length / FRAME);
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const o = f * FRAME;
    for (let i = 0; i < FRAME; i++) {
      const v = pcm[o + i] / 32768;
      sum += v * v;
    }
    rms[f] = Math.sqrt(sum / FRAME);
  }
  return rms;
}

/** Trechos com voz (detecção por energia), já com folga nas pontas. Em frames. */
function speechRegions(rms) {
  const n = rms.length;
  const sorted = Float32Array.from(rms).sort();
  const noiseFloor = sorted[Math.floor(n * 0.1)] || 0;
  const threshold = Math.max(noiseFloor * 3, 0.006);

  const runs = [];
  let start = -1;
  for (let f = 0; f <= n; f++) {
    const loud = f < n && rms[f] > threshold;
    if (loud && start < 0) start = f;
    if (!loud && start >= 0) {
      const last = runs.at(-1);
      if (last && start - last[1] <= MERGE_GAP_FRAMES) last[1] = f;
      else runs.push([start, f]);
      start = -1;
    }
  }

  const regions = [];
  for (const [a, b] of runs) {
    if (b - a < MIN_SPEECH_FRAMES) continue;
    const s = Math.max(0, a - PAD_FRAMES);
    const e = Math.min(n, b + PAD_FRAMES);
    const last = regions.at(-1);
    if (last && s <= last[1]) last[1] = e;
    else regions.push([s, e]);
  }
  return regions;
}

/**
 * Planeja as partes enviadas ao Gemini: os silêncios longos são removidos (não se paga
 * por eles) e os trechos com fala são colados em partes de até MAX_CHUNK_SECONDS.
 * Devolve [[[inicio, fim], ...], ...]: cada parte é uma lista de trechos (em frames).
 */
export function planChunks(pcm, maxSeconds = MAX_CHUNK_SECONDS) {
  const rms = frameRms(pcm);
  if (rms.length === 0) return [];
  const max = sec(maxSeconds);
  const chunks = [];
  let current = [];
  let length = 0;
  for (const region of speechRegions(rms)) {
    let [a, b] = region;
    while (a < b) {
      if (length >= max) {
        chunks.push(current);
        current = [];
        length = 0;
      }
      const take = Math.min(b - a, max - length);
      current.push([a, a + take]);
      length += take;
      a += take;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Duração da parte colada, em frames. */
export const windowFrames = (parts) => parts.reduce((sum, [a, b]) => sum + (b - a), 0);

/** Duração da parte colada, em segundos. */
export const chunkSeconds = (parts) => (windowFrames(parts) * FRAME) / SAMPLE_RATE;

/** Em qual trecho colado (índice) cai um horário da parte, em segundos. */
export function windowPartIndex(parts, seconds) {
  const f = (seconds * SAMPLE_RATE) / FRAME;
  let cum = 0;
  for (let i = 0; i < parts.length; i++) {
    cum += parts[i][1] - parts[i][0];
    if (f < cum) return i;
  }
  return parts.length - 1;
}

/** Converte um horário dentro da parte colada para o horário real da reunião (segundos). */
export function windowTimeMapper(parts) {
  const offsets = [];
  let cum = 0;
  for (const [a, b] of parts) {
    offsets.push({ cum, a, len: b - a });
    cum += b - a;
  }
  const toSec = (frame) => (frame * FRAME) / SAMPLE_RATE;
  return (seconds) => {
    const f = Math.max(0, Math.min(cum, (seconds * SAMPLE_RATE) / FRAME));
    for (let i = offsets.length - 1; i >= 0; i--) {
      const o = offsets[i];
      if (f >= o.cum) return toSec(o.a + Math.min(f - o.cum, o.len));
    }
    return toSec(offsets[0]?.a ?? 0);
  };
}

/** Monta o áudio de uma parte (trechos colados) e sobe o volume de falas baixas. */
export function chunkPcm(pcm, parts) {
  let peak = 0;
  for (const [a, b] of parts) {
    for (let i = a * FRAME; i < b * FRAME && i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  }
  const p = peak / 32768;
  const gain = p > 0 && p < 0.3 ? Math.min(8, 0.5 / p) : 1;
  const out = new Int16Array(windowFrames(parts) * FRAME);
  let o = 0;
  for (const [a, b] of parts) {
    for (let i = a * FRAME; i < b * FRAME; i++) {
      out[o++] = Math.max(-32768, Math.min(32767, Math.round((pcm[i] ?? 0) * gain)));
    }
  }
  return out;
}

const normWords = (words) => words.join(' ').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');

// Em ruído, modelos de transcrição às vezes entram em loop ("oito, oito, oito, ...").
// Uma palavra ou frase curta repetida 4+ vezes seguidas vira uma ocorrência só.
// Repetições naturais ("não, não") ficam intactas.
export function collapseRepeats(text) {
  const words = text.split(' ');
  const out = [];
  let i = 0;
  while (i < words.length) {
    let skipped = false;
    for (let n = 1; n <= 6 && !skipped; n++) {
      if (i + n * 4 > words.length) break;
      const unit = normWords(words.slice(i, i + n));
      if (!unit) continue;
      let reps = 1;
      while (i + (reps + 1) * n <= words.length && normWords(words.slice(i + reps * n, i + (reps + 1) * n)) === unit) reps++;
      if (reps >= 4) {
        out.push(...words.slice(i, i + n));
        i += reps * n;
        skipped = true;
      }
    }
    if (!skipped) out.push(words[i++]);
  }
  return out.join(' ');
}

export function cleanText(raw) {
  const text = collapseRepeats((raw || '').replace(/\s+/g, ' ').trim());
  if (!/\p{L}/u.test(text)) return ''; // só pontuação/símbolos
  return text;
}

const SENTENCE_END = /[.?!…]$/;
const MAX_WORDS_PER_SEGMENT = 40;

/**
 * Agrupa as palavras (com horário dentro da parte) em falas, já no horário real da reunião.
 * Uma fala nova começa quando muda o falante, quando a palavra vem de outro trecho colado
 * (outro momento da reunião), depois de uma pausa ou no fim de uma frase já longa.
 */
export function wordsToSegments(words, parts) {
  const toReal = windowTimeMapper(parts);
  const segments = [];
  let current = null;
  for (const w of words) {
    if (!Number.isFinite(w.start)) continue;
    const part = windowPartIndex(parts, w.start);
    const start = toReal(w.start);
    const end = toReal(Number.isFinite(w.end) ? w.end : w.start);
    const speakerId = w.speaker ?? null;
    const startsNew =
      !current ||
      part !== current.part ||
      speakerId !== current.speakerId ||
      start - current.end > 1.0 ||
      (SENTENCE_END.test(current.text) && current.words >= 12) ||
      current.words >= MAX_WORDS_PER_SEGMENT;
    if (startsNew) {
      current = { part, speakerId, start, end, text: w.text, words: 1 };
      segments.push(current);
    } else {
      current.text += ' ' + w.text;
      current.end = end;
      current.words++;
    }
  }
  return segments
    .map(({ speakerId, start, end, text }) => ({ speakerId, start, end: Math.max(start, end), text: cleanText(text) }))
    .filter((s) => s.text);
}

function wordSet(text) {
  const plain = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return new Set(plain.match(/[a-z0-9]+/g) ?? []);
}

// Sem fone de ouvido, o microfone também capta a fala dos outros saindo da caixa de som.
// Eco = mesmas palavras NO MESMO MOMENTO. Uma resposta que repete palavras ("É pra enganar
// o chefe" → "Sem enganar o chefe") vem depois, sem sobreposição, e não pode ser descartada.
function isEcho(micSeg, systemSegs) {
  const words = wordSet(micSeg.text);
  if (words.size < 3) return false;
  const micDuration = Math.max(0.3, micSeg.end - micSeg.start);
  for (const s of systemSegs) {
    const overlap = Math.min(micSeg.end, s.end) - Math.max(micSeg.start, s.start);
    if (overlap < micDuration * 0.5) continue;
    const other = wordSet(s.text);
    let common = 0;
    for (const w of words) if (other.has(w)) common++;
    if (common / words.size >= 0.8) return true;
  }
  return false;
}

/**
 * Junta as trilhas (Você / Outros) numa conversa só, em ordem de tempo.
 * Cada fala pode trazer o próprio falante (ex.: "Participante 2"); senão vale o da trilha.
 */
export function mergeTranscript(tracks) {
  const system = tracks.find((t) => t.track === 'system')?.segments ?? [];
  const all = [];
  for (const t of tracks) {
    for (const s of t.segments) {
      if (t.track === 'mic' && isEcho(s, system)) continue;
      all.push({ start: s.start, end: s.end, text: s.text, track: t.track, speaker: s.speaker ?? t.speaker });
    }
  }
  all.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const s of all) {
    const last = merged.at(-1);
    if (last && last.track === s.track && last.speaker === s.speaker && s.start - last.end < 2 && s.end - last.start < 60) {
      last.text += ' ' + s.text;
      last.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

export function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

export function transcriptToText(segments) {
  return segments.map((s) => `[${formatTimestamp(s.start)}] ${s.speaker}: ${s.text}`).join('\n\n');
}

export function summaryToText(summary) {
  const lines = [];
  if (summary.summary) lines.push('RESUMO', summary.summary, '');
  if (summary.decisions?.length) lines.push('DECISÕES', ...summary.decisions.map((d) => `- ${d}`), '');
  if (summary.action_items?.length) {
    lines.push('PRÓXIMOS PASSOS');
    for (const a of summary.action_items) {
      const extra = [a.owner, a.due].filter(Boolean).join(', ');
      lines.push(`- ${a.task}${extra ? ` (${extra})` : ''}`);
    }
    lines.push('');
  }
  if (summary.topics?.length) {
    lines.push('TÓPICOS');
    for (const t of summary.topics) lines.push(`${t.title}`, ...t.points.map((p) => `- ${p}`));
  }
  return lines.join('\n').trim();
}
