// Quem transcreve e quem resume cada reunião, e com a chave de quem.
//
// Transcrição (escolha em Configurações):
//   - "Rápida" e "Máxima qualidade": no próprio computador (sherpa-onnx), sem custo, nada sai da máquina;
//   - Gemini: pelo plano da empresa (servidor do XMeeting) ou com a chave da pessoa;
//   - OpenAI: com a chave da pessoa.
// Resumo: Gemini, OpenAI, Claude (chaves da pessoa ou plano da empresa) ou Ollama no computador.
//
// Assinaturas (ChatGPT Plus, Claude Pro, Gemini do Workspace) não incluem a API: a pessoa usa uma
// chave de API da própria conta, e o consumo vai para essa conta, nunca para a da empresa.
import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { checkApiKey, summarizeTranscript, transcribeAudio } from '../server/gemini.js';
import { currentUser } from './auth.js';
import { callBackend } from './backend.js';
import { getConfig } from './config.js';
import { CLAUDE_KEYS_URL, checkClaudeKey, summarizeClaude } from './providers/claude.js';
import { listOllamaModels, OLLAMA_URL, summarizeOllama } from './providers/ollama.js';
import { checkOpenAIKey, OPENAI_KEYS_URL, summarizeOpenAI, transcribeOpenAI } from './providers/openai.js';

export const PROVIDERS = {
  gemini: { label: 'Gemini', keysUrl: 'https://aistudio.google.com/apikey', check: checkApiKey },
  openai: { label: 'OpenAI (ChatGPT)', keysUrl: OPENAI_KEYS_URL, check: checkOpenAIKey },
  claude: { label: 'Claude', keysUrl: CLAUDE_KEYS_URL, check: checkClaudeKey },
};
export const OLLAMA_DOWNLOAD_URL = OLLAMA_URL;

export const TRANSCRIBERS = {
  'local-fast': { label: 'Rápida (no computador)' },
  'local-quality': { label: 'Máxima qualidade (no computador)' },
  gemini: { label: 'Gemini' },
  openai: { label: 'OpenAI' },
};
export const SUMMARIZERS = {
  auto: { label: 'Automático' },
  gemini: { label: 'Gemini' },
  openai: { label: 'OpenAI (ChatGPT)' },
  claude: { label: 'Claude' },
  ollama: { label: 'Ollama (no computador)' },
};

let file = null;
let keys = {}; // e-mail da conta → { gemini, openai, claude }

export async function initAi(userData) {
  file = path.join(userData, 'gemini-keys.bin'); // nome antigo mantido: guarda as chaves de todos os provedores
  try {
    if (fs.existsSync(file) && (await safeStorage.isAsyncEncryptionAvailable())) {
      const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(file));
      const saved = JSON.parse(result) || {};
      // Versões anteriores guardavam só a chave do Gemini: { email: "chave" }.
      keys = Object.fromEntries(Object.entries(saved).map(([email, v]) => [email, typeof v === 'string' ? { gemini: v } : v]));
    }
  } catch (err) {
    console.warn('Chaves de IA salvas ilegíveis; será preciso conectar de novo:', err.message);
  }
}

// Cifrado pelo sistema (Keychain no macOS, DPAPI no Windows). Sem cofre (alguns Linux), as
// chaves valem só enquanto o app estiver aberto.
let writing = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(keys);
  writing = writing.then(async () => {
    try {
      if (await safeStorage.isAsyncEncryptionAvailable()) await fs.promises.writeFile(file, await safeStorage.encryptStringAsync(snapshot));
    } catch (err) {
      console.warn('Não consegui salvar as chaves de IA:', err.message);
    }
  });
  return writing;
}

const userKeys = () => keys[currentUser()?.email] ?? {};
const keyOf = (provider) => userKeys()[provider] ?? null;
const isCompany = () => {
  const user = currentUser();
  return Boolean(user?.domain && getConfig().companyDomains.includes(user.domain));
};
const hasGemini = () => isCompany() || Boolean(keyOf('gemini'));

/** Situação da conta: plano da empresa e quais chaves estão conectadas (só o final de cada uma). */
export function aiStatus() {
  const user = currentUser();
  const hints = Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, keyOf(p) ? `…${keyOf(p).slice(-4)}` : null]));
  return {
    account: user ? (user.domain ? 'workspace' : 'personal') : null,
    domain: user?.domain ?? null,
    company: isCompany(),
    keys: hints,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label }])),
  };
}

export async function setProviderKey(provider, rawKey) {
  const user = currentUser();
  if (!user) throw new Error('Entre com sua conta Google primeiro.');
  if (!PROVIDERS[provider]) throw new Error('Provedor de IA desconhecido.');
  const key = String(rawKey || '').trim();
  if (!/^[\w.-]{20,}$/.test(key)) throw new Error(`Isso não parece uma chave do ${PROVIDERS[provider].label}. Copie a chave inteira.`);
  await PROVIDERS[provider].check(key); // falha com uma mensagem clara se a chave não funcionar
  keys[user.email] = { ...userKeys(), [provider]: key };
  await persist();
  return aiStatus();
}

export async function removeProviderKey(provider, email = currentUser()?.email) {
  if (!email || !keys[email]?.[provider]) return aiStatus();
  delete keys[email][provider];
  await persist();
  return aiStatus();
}

/** Ao sair da conta: as chaves são de quem está saindo. */
export async function forgetKeysOf(email = currentUser()?.email) {
  if (!email || !keys[email]) return;
  delete keys[email];
  await persist();
}

// ---------------------------------------------------------------- transcrição

/** A opção escolhida pode ser usada agora? Devolve null se sim, ou o motivo. */
export function transcriberProblem(engine) {
  if (engine === 'local-fast' || engine === 'local-quality') return null;
  if (engine === 'gemini') return hasGemini() ? null : 'Para transcrever com o Gemini, conecte sua chave do Gemini em Configurações (ou escolha a transcrição no computador).';
  if (engine === 'openai') return keyOf('openai') ? null : 'Para transcrever com a OpenAI, conecte sua chave da OpenAI em Configurações (ou escolha a transcrição no computador).';
  return 'Opção de transcrição desconhecida.';
}

/** Partes enviadas ao mesmo tempo para a nuvem. Na cota gratuita do Gemini há limite por minuto. */
export const parallelism = (engine) => (engine === 'openai' ? 4 : isCompany() ? 3 : 1);

/** Uma parte (MP3) transcrita na nuvem: { text, words?, model }. */
export async function transcribeChunk(engine, mp3, { language, diarize, seconds, signal }) {
  if (engine === 'openai') return transcribeOpenAI(mp3, { apiKey: keyOf('openai'), language, signal });

  if (!isCompany()) return transcribeAudio(mp3, { apiKey: keyOf('gemini'), signal, mimeType: 'audio/mp3', language, diarize });
  const params = new URLSearchParams({ diarize: diarize ? '1' : '0' });
  if (language) params.set('language', language);
  return callBackend(`/v1/transcribe?${params}`, {
    body: mp3,
    headers: { 'Content-Type': 'audio/mpeg', 'X-Audio-Seconds': String(Math.round(seconds)) },
    signal,
    timeoutMs: 20 * 60_000,
  });
}

// ---------------------------------------------------------------- resumo

/**
 * Qual provedor vai resumir: o escolhido, ou no "Automático" o primeiro disponível
 * (plano da empresa → Gemini → Claude → OpenAI → Ollama). null se nenhum estiver disponível.
 */
export async function resolveSummarizer(choice, ollamaModel) {
  const ollama = async () => {
    const models = await listOllamaModels();
    const model = models.find((m) => m.name === ollamaModel)?.name ?? models[0]?.name;
    return model ? { provider: 'ollama', model, label: `Ollama (${model})` } : null;
  };
  const options = {
    gemini: () => (hasGemini() ? { provider: 'gemini', label: isCompany() ? 'Gemini (plano da empresa)' : 'Gemini' } : null),
    claude: () => (keyOf('claude') ? { provider: 'claude', label: 'Claude' } : null),
    openai: () => (keyOf('openai') ? { provider: 'openai', label: 'OpenAI' } : null),
    ollama,
  };
  if (choice !== 'auto') return (await options[choice]?.()) ?? null;
  for (const name of ['gemini', 'claude', 'openai', 'ollama']) {
    const found = await options[name]();
    if (found) return found;
  }
  return null;
}

export const NO_SUMMARIZER =
  'Para resumir, conecte uma chave de IA (Gemini, OpenAI ou Claude) em Configurações, ou instale o Ollama para resumir no computador.';

export async function summarize(input, { choice = 'auto', ollamaModel = '', signal } = {}) {
  const target = await resolveSummarizer(choice, ollamaModel);
  if (!target) throw new Error(choice === 'auto' ? NO_SUMMARIZER : `${SUMMARIZERS[choice]?.label ?? choice} não está disponível. ${NO_SUMMARIZER}`);
  let result;
  if (target.provider === 'claude') result = await summarizeClaude(input, { apiKey: keyOf('claude'), signal });
  else if (target.provider === 'openai') result = await summarizeOpenAI(input, { apiKey: keyOf('openai'), signal });
  else if (target.provider === 'ollama') result = await summarizeOllama(input, { model: target.model, signal });
  else if (!isCompany()) result = await summarizeTranscript(input, { apiKey: keyOf('gemini'), signal });
  else {
    result = await callBackend('/v1/summarize', {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      signal,
      timeoutMs: 5 * 60_000,
    });
  }
  return { ...result, provider: target.label };
}

export { listOllamaModels };
