import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanText, formatTimestamp, mergeTranscript, transcriptToText } from '../electron/speech.js';

test('cleanText junta espaços e descarta trechos sem letras', () => {
  assert.equal(cleanText('  Bom   dia,\n pessoal. '), 'Bom dia, pessoal.');
  assert.equal(cleanText(' ... !! '), '');
  assert.equal(cleanText(''), '');
});

test('formatTimestamp', () => {
  assert.equal(formatTimestamp(0), '00:00:00');
  assert.equal(formatTimestamp(3725.9), '01:02:05');
  assert.equal(formatTimestamp(-3), '00:00:00');
});

test('mergeTranscript intercala Você e Outros pela ordem do tempo', () => {
  const merged = mergeTranscript([
    { track: 'mic', speaker: 'Você', segments: [{ start: 1, end: 2, text: 'Bom dia.' }, { start: 20, end: 22, text: 'Combinado.' }] },
    { track: 'system', speaker: 'Outros', segments: [{ start: 5, end: 8, text: 'Oi, tudo certo?' }] },
  ]);
  assert.deepEqual(merged.map((s) => s.speaker), ['Você', 'Outros', 'Você']);
  assert.match(transcriptToText(merged), /Você: Bom dia\./);
});
