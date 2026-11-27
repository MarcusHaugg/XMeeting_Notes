// OpenAI com a chave da própria pessoa (platform.openai.com; a assinatura do ChatGPT não inclui a API).
// Formatos conforme a documentação oficial de novembro de 2026:
//   transcrição: POST /v1/audio/transcriptions, modelo gpt-transcribe (devolve só o texto, sem
//   horários; por isso o app manda trechos curtos e usa o horário de cada trecho)
//   resumo: POST /v1/responses com text.format json_schema
import { meetingContent, normalizeSummary, SUMMARY_INSTRUCTIONS, SUMMARY_SCHEMA } from '../../server/summary.js';

const API = 'https://api.openai.com/v1';
export const OPENAI_MODELS = { transcribe: 'gpt-transcribe', summary: 'gpt-6.2-sol' };
export const OPENAI_KEYS_URL = 'https://platform.openai.com/api-keys';

const withTimeout = (signal, ms) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

async function call(pathname, { apiKey, method = 'POST', body, headers = {}, signal, timeoutMs = 5 * 60_000 }) {
  let res;
  try {
    res = await fetch(API + pathname, { method, body, headers: { Authorization: `Bearer ${apiKey}`, ...headers }, signal: withTimeout(signal, timeoutMs) });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('Sem conexão com a OpenAI. Verifique a internet.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const detail = data?.error?.message || res.statusText;
  if (res.status === 401) throw new Error('A chave da OpenAI é inválida.');
  if (res.status === 429) throw new Error(`A OpenAI recusou por limite de uso ou falta de crédito na conta da chave: ${detail}`);
  throw new Error(`A OpenAI respondeu com erro (${res.status}): ${detail}`);
}

export async function checkOpenAIKey(apiKey) {
  await call('/models', { apiKey, method: 'GET', timeoutMs: 20_000 });
}

/** Transcreve um trecho curto (MP3) e devolve só o texto. */
export async function transcribeOpenAI(mp3, { apiKey, language = '', signal }) {
  const form = new FormData();
  form.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'trecho.mp3');
  form.append('model', OPENAI_MODELS.transcribe);
  form.append('response_format', 'json');
  if (language) form.append('language', language.split('-')[0]); // ISO-639-1: pt-BR → pt
  const data = await call('/audio/transcriptions', { apiKey, body: form, signal });
  return { text: String(data.text ?? ''), model: OPENAI_MODELS.transcribe, usage: data.usage ?? null };
}

export async function summarizeOpenAI(input, { apiKey, signal }) {
  const data = await call('/responses', {
    apiKey,
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODELS.summary,
      input: [
        { role: 'developer', content: SUMMARY_INSTRUCTIONS }, // instruções fixas no início: aproveitam o cache
        { role: 'user', content: meetingContent(input) },
      ],
      text: { format: { type: 'json_schema', name: 'resumo_da_reuniao', schema: SUMMARY_SCHEMA, strict: true } },
      max_output_tokens: 16000,
    }),
  });
  const parts = (data.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
  if (parts.some((p) => p.type === 'refusal')) throw new Error('A OpenAI se recusou a resumir esta reunião.');
  const text = typeof data.output_text === 'string' ? data.output_text : parts.filter((p) => p.type === 'output_text').map((p) => p.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('A OpenAI devolveu um resumo em formato inesperado. Tente de novo.');
  }
  return { summary: normalizeSummary(parsed), model: OPENAI_MODELS.summary, usage: data.usage ?? null };
}
