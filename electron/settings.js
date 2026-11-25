import fs from 'node:fs';
import path from 'node:path';

// factor = segundos de processamento por segundo de fala, medido numa reunião real
// num i5-1235U sem placa de vídeo (janelas coladas + horário por palavra).
// Os dois modelos têm horário por palavra, que separa as falas na ordem certa.
export const MODELS = {
  turbo: { id: 'onnx-community/whisper-large-v3-turbo_timestamped', label: 'Máxima precisão', factor: 1.6, downloadMb: 1035 },
  small: { id: 'Xenova/whisper-small', label: 'Rápido', factor: 0.9, downloadMb: 240 },
};

export const LANGUAGES = {
  pt: 'Português',
  en: 'Inglês',
  es: 'Espanhol',
  auto: 'Detectar automaticamente',
};

const DEFAULTS = { model: 'turbo', language: 'pt' };

let file = null;
let current = { ...DEFAULTS };

export function initSettings(userData) {
  file = path.join(userData, 'settings.json');
  try {
    current = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    current = { ...DEFAULTS };
  }
  if (!MODELS[current.model]) current.model = DEFAULTS.model;
  if (!LANGUAGES[current.language]) current.language = DEFAULTS.language;
}

export function getSettings() {
  return { ...current, models: MODELS, languages: LANGUAGES };
}

export function updateSettings(patch = {}) {
  if (patch.model !== undefined) {
    if (!MODELS[patch.model]) throw new Error('Modelo inválido.');
    current.model = patch.model;
  }
  if (patch.language !== undefined) {
    if (!LANGUAGES[patch.language]) throw new Error('Idioma inválido.');
    current.language = patch.language;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: current.model, language: current.language }, null, 2));
  return getSettings();
}
