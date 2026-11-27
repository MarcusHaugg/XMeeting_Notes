import fs from 'node:fs';
import path from 'node:path';

// Idioma das reuniões (BCP-47). "auto" = o modelo detecta.
export const LANGUAGES = {
  'pt-BR': 'Português (Brasil)',
  'en-US': 'Inglês',
  'es-ES': 'Espanhol',
  auto: 'Detectar automaticamente',
};
const OLD_LANGUAGES = { pt: 'pt-BR', en: 'en-US', es: 'es-ES' }; // versões com Whisper

// Quem transcreve: no computador ("local-fast" = Rápida, "local-quality" = Máxima qualidade) ou na nuvem.
export const TRANSCRIBER_KEYS = ['local-fast', 'local-quality', 'gemini', 'openai'];
// Quem resume: "auto" escolhe o primeiro disponível (veja ai.js).
export const SUMMARIZER_KEYS = ['auto', 'gemini', 'openai', 'claude', 'ollama'];

// diarize: separar as vozes da trilha "Outros" em Participante 1, 2... (só no Gemini, experimental)
// notifyMeetings: avisar quando uma reunião da Google Agenda começar
// ollamaModel: modelo do Ollama para o resumo local ("" = o primeiro instalado)
// trayHintShown / loginItemConfigured: marcas internas (aviso do ícone já mostrado; "abrir ao
// ligar o computador" já configurado na primeira vez)
const DEFAULTS = {
  language: 'pt-BR',
  transcriber: 'local-fast',
  summarizer: 'auto',
  ollamaModel: '',
  diarize: true,
  notifyMeetings: true,
  trayHintShown: false,
  loginItemConfigured: false,
};
const BOOLEANS = ['diarize', 'notifyMeetings', 'trayHintShown', 'loginItemConfigured'];

let file = null;
let current = { ...DEFAULTS };

export function initSettings(userData) {
  file = path.join(userData, 'settings.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* primeira vez */
  }
  current = { ...DEFAULTS };
  for (const key of BOOLEANS) if (typeof saved[key] === 'boolean') current[key] = saved[key];
  const language = OLD_LANGUAGES[saved.language] ?? saved.language;
  if (LANGUAGES[language]) current.language = language;
  if (TRANSCRIBER_KEYS.includes(saved.transcriber)) current.transcriber = saved.transcriber;
  if (SUMMARIZER_KEYS.includes(saved.summarizer)) current.summarizer = saved.summarizer;
  if (typeof saved.ollamaModel === 'string') current.ollamaModel = saved.ollamaModel;
}

export function getSettings() {
  return { ...current, languages: LANGUAGES };
}

export function updateSettings(patch = {}) {
  if (patch.language !== undefined) {
    if (!LANGUAGES[patch.language]) throw new Error('Idioma inválido.');
    current.language = patch.language;
  }
  if (patch.transcriber !== undefined) {
    if (!TRANSCRIBER_KEYS.includes(patch.transcriber)) throw new Error('Opção de transcrição inválida.');
    current.transcriber = patch.transcriber;
  }
  if (patch.summarizer !== undefined) {
    if (!SUMMARIZER_KEYS.includes(patch.summarizer)) throw new Error('Opção de resumo inválida.');
    current.summarizer = patch.summarizer;
  }
  if (patch.ollamaModel !== undefined) current.ollamaModel = String(patch.ollamaModel).slice(0, 200);
  for (const key of BOOLEANS) if (patch[key] !== undefined) current[key] = Boolean(patch[key]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(current, null, 2));
  return getSettings();
}
