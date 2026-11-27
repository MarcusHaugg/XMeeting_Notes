// Google Agenda: lê os compromissos da agenda principal de quem está logado (permissão só de
// leitura), acha o link da chamada (Meet, Teams, Zoom) e avisa quando uma reunião começa.
// A API do Google Calendar não tem custo no nível padrão.
// https://developers.google.com/workspace/calendar/api/v3/reference/events/list
import { CALENDAR_SCOPE, currentUser, dropScope, getAccessToken, hasScope, invalidateAccessToken } from './auth.js';

const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const SKIP_TYPES = new Set(['outOfOffice', 'focusTime', 'workingLocation', 'birthday']);
const LINK_PATTERNS = [
  ['meet', /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\S*/i],
  ['teams', /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s<>"]+/i],
  ['zoom', /https:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my|w)\/[^\s<>"]+/i],
];

export class CalendarError extends Error {}

export const calendarConnected = () => Boolean(currentUser()) && (fake !== null || hasScope(CALENDAR_SCOPE));

function findLink(ev) {
  const candidates = [
    ev.hangoutLink,
    ...(ev.conferenceData?.entryPoints ?? []).filter((e) => e.entryPointType === 'video').map((e) => e.uri),
    ev.location,
    ev.description,
  ].filter(Boolean);
  for (const text of candidates) {
    for (const [kind, re] of LINK_PATTERNS) {
      const m = String(text).match(re);
      if (m) return { kind, url: m[0].replace(/[).,;]+$/, '') };
    }
  }
  const video = ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  return video && /^https:\/\//.test(video) ? { kind: 'link', url: video } : null;
}

// Eventos de dia inteiro vêm como "2026-11-26" (sem hora). new Date() leria como meia-noite UTC,
// que no Brasil cai no dia anterior: vira meia-noite local.
function localDay(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toISOString() : date;
}

/** Converte um evento da API no formato usado pelo app. */
export function toMeeting(ev) {
  const allDay = !ev.start?.dateTime;
  const attendees = (ev.attendees ?? [])
    .filter((a) => !a.resource) // salas de reunião
    .map((a) => ({ name: a.displayName || a.email, email: a.email, self: Boolean(a.self), response: a.responseStatus }));
  return {
    id: ev.id,
    title: ev.summary?.trim() || '(sem título)',
    start: ev.start?.dateTime ?? localDay(ev.start?.date),
    end: ev.end?.dateTime ?? localDay(ev.end?.date),
    allDay,
    link: findLink(ev),
    attendees,
    organizer: ev.organizer?.displayName || ev.organizer?.email || null,
    htmlLink: ev.htmlLink ?? null,
  };
}

function keep(ev) {
  if (ev.status === 'cancelled' || SKIP_TYPES.has(ev.eventType)) return false;
  const me = ev.attendees?.find((a) => a.self);
  return me?.responseStatus !== 'declined';
}

let cache = { at: 0, days: 0, events: [] };
let fake = null;

async function request(url, retry = true) {
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new CalendarError('Sem conexão com o Google Agenda. Verifique a internet.');
  }
  if (res.status === 401 && retry) {
    invalidateAccessToken();
    return request(url, false);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const reason = data?.error?.errors?.[0]?.reason || data?.error?.details?.[0]?.reason || '';
  const message = data?.error?.message || '';
  if (res.status === 403 && /insufficient|scope/i.test(reason + message)) {
    dropScope(CALENDAR_SCOPE); // a permissão foi retirada: mostra "Conectar Google Agenda" de novo
    throw new CalendarError('O XMeeting não tem mais permissão para ver sua agenda. Conecte a Google Agenda de novo.');
  }
  if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(reason + message)) {
    throw new CalendarError('A API do Google Agenda não está ativada no projeto do Google Cloud do XMeeting.');
  }
  throw new CalendarError(`O Google Agenda respondeu com erro (${res.status})${message ? `: ${message}` : ''}.`);
}

/** Compromissos de hoje até `days` dias à frente, em ordem de início. */
export async function listEvents({ days = 7, maxAgeMs = 60_000 } = {}) {
  if (!calendarConnected()) return { connected: false, events: [] };
  if (fake) return { connected: true, events: fake };
  if (cache.days >= days && Date.now() - cache.at < maxAgeMs) return { connected: true, events: cache.events };

  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + days);
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const data = await request(`${EVENTS_URL}?${params}`);
  const events = (data.items ?? []).filter(keep).map(toMeeting);
  cache = { at: Date.now(), days, events };
  return { connected: true, events };
}

export function clearCalendarCache() {
  cache = { at: 0, days: 0, events: [] };
}

/** Só para capturas de tela no desenvolvimento: compromissos de exemplo, sem chamar o Google. */
export function useFakeCalendarForScreenshots({ meetingNow = false } = {}) {
  const at = (dayOffset, h, m) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const people = (...names) => names.map((name, i) => ({ name, email: `${name.toLowerCase().split(' ')[0]}@exemplo.com`, self: i === 0 }));
  fake = [
    { id: 'f1', title: 'Daily do time de produto', start: at(0, 9, 30), end: at(0, 9, 45), allDay: false, link: { kind: 'meet', url: 'https://meet.google.com/abc-defg-hij' }, attendees: people('Você', 'Ana Souza', 'Bruno Lima', 'Carla Dias') },
    { id: 'f2', title: 'Proposta para o cliente Alfa', start: at(0, 14, 0), end: at(0, 15, 0), allDay: false, link: { kind: 'teams', url: 'https://teams.microsoft.com/l/meetup-join/x' }, attendees: people('Você', 'Diego Alfa') },
    { id: 'f3', title: 'Almoço', start: at(0, 12, 0), end: at(0, 13, 0), allDay: false, link: null, attendees: [] },
    { id: 'f4', title: 'Revisão de custos', start: at(1, 10, 0), end: at(1, 11, 0), allDay: false, link: { kind: 'zoom', url: 'https://empresa.zoom.us/j/123' }, attendees: people('Você', 'Eva Rocha', 'Fábio Melo') },
  ];
  if (meetingNow) {
    const now = Date.now();
    fake.push({ id: 'f0', title: 'Reunião de teste agora', start: new Date(now + 20_000).toISOString(), end: new Date(now + 30 * 60_000).toISOString(), allDay: false, link: { kind: 'meet', url: 'https://meet.google.com/xyz-test' }, attendees: people('Você', 'Ana Souza') });
  }
  fake.sort((a, b) => a.start.localeCompare(b.start));
}

// ---------------------------------------------------------------- aviso de início

let watcher = null;
const notified = new Set();

/**
 * A cada 30 s confere se alguma reunião (com link ou participantes) começa agora e chama
 * onStarting(evento) uma vez por reunião. A lista é atualizada a cada 5 min.
 */
export function startMeetingWatcher({ onStarting, enabled }) {
  clearInterval(watcher);
  watcher = setInterval(async () => {
    if (!enabled() || !calendarConnected()) return;
    try {
      const { events } = await listEvents({ days: 1, maxAgeMs: 5 * 60_000 });
      const now = Date.now();
      for (const ev of events) {
        if (ev.allDay || (!ev.link && ev.attendees.length < 2)) continue;
        const start = Date.parse(ev.start);
        const key = `${ev.id}@${ev.start}`;
        if (start - now > 60_000 || now - start > 2 * 60_000 || notified.has(key)) continue;
        notified.add(key);
        onStarting(ev);
      }
    } catch {
      /* sem internet ou sem permissão: tenta de novo no próximo ciclo */
    }
  }, 30_000);
}
