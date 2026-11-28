import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toMeeting } from '../electron/calendar.js';

test('toMeeting: link do Meet, participantes sem salas e dia inteiro', () => {
  const m = toMeeting({
    id: 'e1', summary: 'Alinhamento', hangoutLink: 'https://meet.google.com/abc-defg-hij',
    start: { dateTime: '2026-12-01T14:00:00-03:00' }, end: { dateTime: '2026-12-01T15:00:00-03:00' },
    attendees: [{ email: 'eu@x.com', self: true, responseStatus: 'accepted' }, { email: 'sala@resource.calendar.google.com', resource: true }, { email: 'ana@x.com', displayName: 'Ana' }],
  });
  assert.equal(m.title, 'Alinhamento');
  assert.equal(m.allDay, false);
  assert.equal(m.link?.kind, 'meet');
  assert.deepEqual(m.attendees.map((a) => a.name), ['eu@x.com', 'Ana']);
  assert.equal(toMeeting({ id: 'e2', summary: 'Feriado', start: { date: '2026-12-25' }, end: { date: '2026-12-26' } }).allDay, true);
});
