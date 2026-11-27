// Armazenamento das reuniões: uma pasta por reunião com meta.json, áudios e transcrição.
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
let root = null;

export function initStore(userData) {
  root = path.join(userData, 'meetings');
}

export const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);

export function dirOf(id) {
  if (!isValidId(id)) throw new Error('Identificador de reunião inválido.');
  return path.join(root, id);
}

export const trackPath = (id, track) => path.join(dirOf(id), `${track}.webm`);
export const audioPath = (id) => path.join(dirOf(id), 'audio.m4a');
const metaPath = (id) => path.join(dirOf(id), 'meta.json');
const transcriptPath = (id) => path.join(dirOf(id), 'transcript.json');
const summaryPath = (id) => path.join(dirOf(id), 'summary.json');

async function writeJsonAtomic(file, data) {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
  await fs.rename(`${file}.tmp`, file);
}

async function readMeta(id) {
  try {
    return JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

// Serializa alterações por reunião (anotações e transcrição podem salvar ao mesmo tempo).
const locks = new Map();
function withLock(id, fn) {
  const next = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}

/** event (opcional): compromisso da Google Agenda de onde a gravação foi iniciada. */
export async function create({ hasSystemAudio, event = null }) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
  await fs.mkdir(dirOf(id), { recursive: true });
  const calendarEvent = event
    ? {
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        link: event.link?.url ?? null,
        attendees: (event.attendees ?? []).slice(0, 200).map((a) => ({ name: a.name, email: a.email, self: Boolean(a.self) })),
      }
    : null;
  const meta = {
    id,
    calendarEvent,
    title: event?.title ? event.title.slice(0, 200) : `Reunião de ${p(d.getDate())}/${p(d.getMonth() + 1)} às ${p(d.getHours())}:${p(d.getMinutes())}`,
    createdAt: d.toISOString(),
    endedAt: null,
    durationSec: 0,
    status: 'recording', // recording → finalizing → ready | error
    hasSystemAudio: Boolean(hasSystemAudio),
    notes: '',
    error: null,
    transcript: { status: null }, // null | queued | running | done | error
    summary: { status: null }, // null | running | done | error
  };
  await writeJsonAtomic(metaPath(id), meta);
  return meta;
}

export const getMeta = (id) => readMeta(id);

export function update(id, patch) {
  return withLock(id, async () => {
    const meta = await readMeta(id);
    if (!meta) throw new Error('Reunião não encontrada.');
    const next = {
      ...meta,
      ...patch,
      transcript: { ...meta.transcript, ...(patch.transcript ?? {}) },
      summary: { ...(meta.summary ?? { status: null }), ...(patch.summary ?? {}) },
    };
    await writeJsonAtomic(metaPath(id), next);
    return next;
  });
}

export async function list() {
  let ids = [];
  try {
    ids = (await fs.readdir(root)).filter(isValidId);
  } catch {
    return [];
  }
  const metas = await Promise.all(ids.map(readMeta));
  return metas.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function get(id) {
  const meta = await readMeta(id);
  if (!meta) return null;
  let segments = null;
  try {
    segments = JSON.parse(await fs.readFile(transcriptPath(id), 'utf8'));
  } catch {
    /* ainda não transcrita */
  }
  let summaryData = null;
  try {
    summaryData = JSON.parse(await fs.readFile(summaryPath(id), 'utf8'));
  } catch {
    /* ainda não resumida */
  }
  let audioUrl = null;
  try {
    const st = await fs.stat(audioPath(id));
    audioUrl = `${pathToFileURL(audioPath(id)).href}?v=${Math.round(st.mtimeMs)}`;
  } catch {
    /* áudio ainda não finalizado */
  }
  return { ...meta, summary: meta.summary ?? { status: null }, segments, summaryData, audioUrl };
}

export const hasTranscript = (id) => existsSync(transcriptPath(id));
export const hasSummary = (id) => existsSync(summaryPath(id));

export async function saveTranscript(id, segments) {
  await writeJsonAtomic(transcriptPath(id), segments);
}

export async function saveSummary(id, summary) {
  await writeJsonAtomic(summaryPath(id), summary);
}

export async function remove(id) {
  await fs.rm(dirOf(id), { recursive: true, force: true });
}
