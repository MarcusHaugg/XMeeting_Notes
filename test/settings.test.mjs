import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getSettings, initSettings, updateSettings } from '../electron/settings.js';

test('padrões, migração do idioma antigo e opções booleanas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-settings-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ language: 'pt', transcriber: 'invalido' }));
  initSettings(dir);
  const s = getSettings();
  assert.equal(s.language, 'pt-BR', 'idioma da versão com Whisper migra');
  assert.equal(s.transcriber, 'local-fast', 'valor inválido volta ao padrão');
  assert.equal(s.autoRecordMeetings, false, 'gravar sozinho vem desligado');
  updateSettings({ autoRecordMeetings: true });
  initSettings(dir);
  assert.equal(getSettings().autoRecordMeetings, true, 'fica salvo');
  assert.throws(() => updateSettings({ summarizer: 'nada' }), /inválida/);
  fs.rmSync(dir, { recursive: true, force: true });
});
