import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSummary, parseSummaryText } from '../server/summary.js';

test('parseSummaryText aceita JSON com cerca de código', () => {
  const s = parseSummaryText('```json\n{"summary":"ok","decisions":["d1"],"action_items":[{"task":"t","owner":"Ana"}],"topics":[]}\n```');
  assert.equal(s.summary, 'ok');
  assert.deepEqual(s.decisions, ['d1']);
  assert.deepEqual(s.action_items, [{ task: 't', owner: 'Ana', due: '' }]);
});

test('normalizeSummary completa campos faltando', () => {
  assert.deepEqual(normalizeSummary({}), { summary: '', decisions: [], action_items: [], topics: [] });
});
