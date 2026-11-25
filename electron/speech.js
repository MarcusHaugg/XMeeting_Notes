// Funções puras de áudio/texto usadas pela transcrição (sem dependência do Electron).

export const SAMPLE_RATE = 16000; // PCM Int16 mono, o formato que o Whisper espera
export const FRAME = 480; // 30 ms

const sec = (s) => Math.round((s * 1000) / 30); // segundos → frames de 30 ms

const MIN_SPEECH_FRAMES = sec(0.25);
const MERGE_GAP_FRAMES = sec(1.2); // pausas naturais de até ~1,2 s ficam como estão
const PAD_FRAMES = sec(0.4); // folga generosa: não corta o começo/fim das palavras
const MAX_WINDOW_FRAMES = sec(28); // o Whisper enxerga 30 s por vez
const SPLIT_SEARCH_FRAMES = sec(6); // corta falas longas no ponto mais silencioso dos últimos ~6 s
// Silêncio inserido entre trechos colados. Fica em 0: testado com 1 s, o silêncio digital
// puro fez o Whisper alucinar ("de um vídeo de um vídeo...") e entrar em loop.
const GAP_FRAMES = 0;

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
 * Planeja as janelas enviadas ao Whisper (mesma técnica do faster-whisper):
 * os silêncios longos são removidos e os trechos de fala são colados, formando
 * janelas de até ~28 s cheias de fala contínua. O Whisper acerta muito mais com a
 * frase inteira do que com pedacinhos de 1-2 s, não "inventa" texto no silêncio, e
 * como cada chamada custa o mesmo que 30 s de áudio, menos janelas = mais rapidez.
 * Devolve [[[inicio, fim], ...], ...]: cada janela é uma lista de trechos (em frames).
 */
export function planWindows(pcm) {
  const rms = frameRms(pcm);
  if (rms.length === 0) return [];

  // 1) Falas longas demais para uma janela são quebradas no ponto mais silencioso.
  const parts = [];
  for (const [a, b] of speechRegions(rms)) {
    let s = a;
    while (b - s > MAX_WINDOW_FRAMES) {
      let cut = s + MAX_WINDOW_FRAMES;
      let best = Infinity;
      for (let f = s + MAX_WINDOW_FRAMES - SPLIT_SEARCH_FRAMES; f <= s + MAX_WINDOW_FRAMES; f++) {
        if (rms[f] < best) {
          best = rms[f];
          cut = f;
        }
      }
      parts.push([s, cut]);
      s = cut;
    }
    parts.push([s, b]);
  }

  // 2) Trechos consecutivos são colados (com 1 s de silêncio entre eles) até encher ~28 s.
  const windows = [];
  let current = [];
  let length = 0;
  for (const [a, b] of parts) {
    const added = (current.length ? GAP_FRAMES : 0) + (b - a);
    if (current.length && length + added > MAX_WINDOW_FRAMES) {
      windows.push(current);
      current = [];
      length = 0;
    }
    length += (current.length ? GAP_FRAMES : 0) + (b - a);
    current.push([a, b]);
  }
  if (current.length) windows.push(current);
  return windows;
}

/** Tamanho da janela colada, em frames (trechos + silêncios inseridos). */
export const windowFrames = (parts) => parts.reduce((sum, [a, b]) => sum + (b - a), 0) + GAP_FRAMES * Math.max(0, parts.length - 1);

/** Em qual trecho colado (índice) cai um horário da janela, em segundos. */
export function windowPartIndex(parts, seconds) {
  const f = (seconds * SAMPLE_RATE) / FRAME;
  let cum = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) cum += GAP_FRAMES;
    cum += parts[i][1] - parts[i][0];
    if (f < cum) return i;
  }
  return parts.length - 1;
}

/** Converte um horário dentro da janela colada para o horário real da reunião (segundos). */
export function windowTimeMapper(parts) {
  const offsets = [];
  let cum = 0;
  parts.forEach(([a, b], i) => {
    if (i > 0) cum += GAP_FRAMES;
    offsets.push({ cum, a, len: b - a });
    cum += b - a;
  });
  const toSec = (frame) => (frame * FRAME) / SAMPLE_RATE;
  return (seconds) => {
    const f = Math.max(0, Math.min(cum, (seconds * SAMPLE_RATE) / FRAME));
    for (let i = offsets.length - 1; i >= 0; i--) {
      const o = offsets[i];
      if (f < o.cum) continue;
      const within = f - o.cum;
      if (within <= o.len) return toSec(o.a + within);
      // Caiu no silêncio inserido: vai para o trecho mais próximo.
      const next = offsets[i + 1];
      return toSec(next && within - o.len > GAP_FRAMES / 2 ? next.a : o.a + o.len);
    }
    return toSec(offsets[0].a);
  };
}

/** Monta o áudio Float32 de uma janela (trechos colados) e sobe o volume de falas baixas. */
export function windowToFloat32(pcm, parts) {
  let peak = 0;
  for (const [a, b] of parts) {
    for (let i = a * FRAME; i < b * FRAME; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  }
  const p = peak / 32768;
  const gain = p > 0 && p < 0.3 ? Math.min(8, 0.5 / p) : 1;
  const out = new Float32Array(windowFrames(parts) * FRAME); // já começa zerado (silêncio)
  let o = 0;
  parts.forEach(([a, b], idx) => {
    if (idx > 0) o += GAP_FRAMES * FRAME;
    for (let i = a * FRAME; i < b * FRAME; i++) out[o++] = (pcm[i] / 32768) * gain;
  });
  return out;
}

const normWords = (words) => words.join(' ').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');

// Em ruído, o Whisper às vezes entra em loop ("oito, oito, oito, ..."). Uma palavra ou
// frase curta repetida 4+ vezes seguidas vira uma ocorrência só. Repetições naturais
// ("não, não") ficam intactas.
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
  if (/amara\.org/i.test(text)) return ''; // alucinação clássica do Whisper em português
  return text;
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

/** Junta as trilhas (Você / Outros) numa conversa só, em ordem de tempo. */
export function mergeTranscript(tracks) {
  const system = tracks.find((t) => t.track === 'system')?.segments ?? [];
  const all = [];
  for (const t of tracks) {
    for (const s of t.segments) {
      if (t.track === 'mic' && isEcho(s, system)) continue;
      all.push({ ...s, track: t.track, speaker: t.speaker });
    }
  }
  all.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const s of all) {
    const last = merged.at(-1);
    if (last && last.track === s.track && s.start - last.end < 2 && s.end - last.start < 60) {
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
