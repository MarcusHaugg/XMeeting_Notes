// Chamadas à API do Gemini (Gemini Developer API, endpoint "interactions").
// Usado por dois lados, cada um com a sua chave:
//   - o servidor do XMeeting, com a chave da empresa (contas do domínio da empresa);
//   - o próprio app, com a chave do Gemini do usuário (qualquer outra conta).
// Formatos conforme a documentação de novembro de 2026:
//   transcrição: https://aistudio.google.com/docs/transcribe
//   arquivos:    https://aistudio.google.com/docs/files
//   JSON:        https://aistudio.google.com/docs/structured-output
// A documentação mostra dois formatos de resposta (steps[].content[] e outputs[]):
// a leitura abaixo aceita os dois. Rode server/try-gemini.js para ver a resposta crua.
import { HttpError } from './errors.js';
import { parseSummaryText, SUMMARY_SCHEMA, summaryPrompt } from './summary.js';

const API = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com'; // trocável só para testes
const API_REVISION = process.env.GEMINI_API_REVISION || '2026-05-20';

export const MODELS = {
  transcribe: process.env.TRANSCRIBE_MODEL || 'gemini-3.5-transcribe',
  summary: process.env.SUMMARY_MODEL || 'gemini-3.8-flash',
};

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

const withTimeout = (signal, ms) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

// Na cota gratuita o Gemini limita os pedidos por minuto (resposta 429): espera e tenta de novo.
const RETRY_WAITS_MS = [5_000, 15_000, 30_000, 60_000];

async function request(pathname, { apiKey, method = 'POST', headers = {}, body, timeoutMs = 10 * 60_000, signal } = {}) {
  if (!apiKey) throw new HttpError(500, 'Chave do Gemini não configurada.');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + pathname, {
      method,
      headers: { 'x-goog-api-key': apiKey, ...headers },
      body,
      signal: withTimeout(signal, timeoutMs),
    });
    if (res.status !== 429 || attempt >= RETRY_WAITS_MS.length) return res;
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    await res.body?.cancel();
    await sleep(retryAfter > 0 ? Math.min(retryAfter, 120_000) : RETRY_WAITS_MS[attempt], signal);
  }
}

async function readJson(res, what) {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data?.error?.message || text.slice(0, 300) || res.statusText;
    if (res.status === 429) {
      throw new HttpError(429, `Limite de uso do Gemini atingido nesta chave. Tente mais tarde ou use uma chave com faturamento. (${detail})`);
    }
    if (res.status === 400 && /api key/i.test(detail)) throw new HttpError(401, 'A chave do Gemini é inválida.');
    if (res.status === 403) throw new HttpError(403, `A chave do Gemini não tem permissão para isso: ${detail}`);
    throw new HttpError(502, `${what} (${res.status}): ${detail}`);
  }
  return data;
}

/** Confere se a chave funciona (sem gastar nada): lista os modelos disponíveis para ela. */
export async function checkApiKey(apiKey) {
  let res;
  try {
    res = await request('/v1beta/models?pageSize=1', { apiKey, method: 'GET', timeoutMs: 20_000 });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, 'Sem conexão com o Google. Verifique a internet.');
  }
  await readJson(res, 'O Google recusou a chave');
}

// ------------------------------------------------------------------ arquivos

async function uploadFile(bytes, mimeType, displayName, { apiKey, signal }) {
  const start = await request('/upload/v1beta/files', {
    apiKey,
    signal,
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
    timeoutMs: 60_000,
  });
  if (!start.ok) await readJson(start, 'Falha ao iniciar o envio do áudio ao Gemini');
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new HttpError(502, 'O Gemini não devolveu o endereço de envio do áudio.');

  const done = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: bytes,
    signal: withTimeout(signal, 5 * 60_000),
  });
  let file = (await readJson(done, 'Falha ao enviar o áudio ao Gemini')).file;
  if (!file?.uri || !file?.name) throw new HttpError(502, 'O Gemini não devolveu o arquivo enviado.');

  // Arquivos grandes podem ficar um tempo em processamento antes de poderem ser usados.
  const deadline = Date.now() + 2 * 60_000;
  while (file.state && file.state !== 'ACTIVE') {
    if (file.state === 'FAILED') throw new HttpError(502, 'O Gemini não conseguiu processar o áudio enviado.');
    if (Date.now() > deadline) throw new HttpError(504, 'O Gemini demorou demais para processar o áudio.');
    await sleep(2000, signal);
    file = await readJson(await request(`/v1beta/${file.name}`, { apiKey, signal, method: 'GET', timeoutMs: 30_000 }), 'Falha ao consultar o áudio');
  }
  return file;
}

// Os arquivos somem sozinhos em 48 h, mas o áudio de reunião não deve ficar lá nem esse tempo.
async function deleteFile(name, apiKey) {
  try {
    await request(`/v1beta/${name}`, { apiKey, method: 'DELETE', timeoutMs: 30_000 });
  } catch (err) {
    console.warn(`Não consegui apagar ${name} no Gemini:`, err.message);
  }
}

// ------------------------------------------------------------------ interactions

const RUNNING = new Set(['in_progress', 'queued', 'running', 'pending', 'processing']);

async function interact(body, { apiKey, signal, revision }) {
  const headers = { 'Content-Type': 'application/json', ...(revision ? { 'Api-Revision': API_REVISION } : {}) };
  let data = await readJson(
    await request('/v1beta/interactions', { apiKey, signal, headers, body: JSON.stringify(body), timeoutMs: 15 * 60_000 }),
    'O Gemini recusou o pedido'
  );

  const deadline = Date.now() + 20 * 60_000;
  while (RUNNING.has(String(data.status || '').toLowerCase())) {
    if (Date.now() > deadline) throw new HttpError(504, 'O Gemini demorou demais para responder.');
    await sleep(3000, signal);
    const id = String(data.id || '');
    const path = id.startsWith('interactions/') ? id : `interactions/${id}`;
    data = await readJson(
      await request(`/v1beta/${path}`, {
        apiKey,
        signal,
        method: 'GET',
        headers: revision ? { 'Api-Revision': API_REVISION } : {},
        timeoutMs: 60_000,
      }),
      'Falha ao consultar o Gemini'
    );
  }

  const status = String(data.status || 'completed').toLowerCase();
  if (status !== 'completed') {
    const why = data.error?.message ? `: ${data.error.message}` : '';
    throw new HttpError(502, `O Gemini não concluiu o pedido (status ${data.status})${why}.`);
  }
  return data;
}

/** Itens de saída do modelo, nos dois formatos que a documentação mostra. */
function outputItems(data) {
  const items = [...(data.outputs ?? [])];
  for (const step of data.steps ?? []) {
    if (step.type && !/output/i.test(step.type)) continue; // pula a entrada do usuário
    items.push(...(step.content ?? []));
  }
  return items.filter((c) => typeof c?.text === 'string' && (!c.type || c.type === 'text'));
}

function outputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  return outputItems(data)
    .map((c) => c.text)
    .join('');
}

const usageOf = (data) => data.usage ?? data.usage_metadata ?? data.usageMetadata ?? null;

/** "0.100s", 0.1 ou { seconds, nanos } → segundos. */
function toSeconds(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const m = /^(-?\d+(?:\.\d+)?)s?$/.exec(value.trim());
    return m ? Number(m[1]) : NaN;
  }
  if (value && typeof value === 'object') return Number(value.seconds ?? 0) + Number(value.nanos ?? 0) / 1e9;
  return NaN;
}

// ------------------------------------------------------------------ transcrição

/**
 * Transcreve um trecho de áudio (até 30 min: limite do modelo com horário por palavra).
 * Devolve o texto e cada palavra com horário (segundos dentro do trecho) e falante.
 */
export async function transcribeAudio(audio, { apiKey, signal, mimeType = 'audio/mp3', language = '', diarize = false, raw = false } = {}) {
  const file = await uploadFile(audio, mimeType, `xmeeting-${Date.now()}`, { apiKey, signal });
  try {
    const mode = { type: 'verbatim', timestamp_granularities: ['word'] };
    if (diarize) mode.diarization_mode = 'speaker';
    const model = MODELS.transcribe.startsWith('models/') ? MODELS.transcribe : `models/${MODELS.transcribe}`;
    const data = await interact(
      {
        model,
        input: [{ type: 'file', file_uri: file.uri }],
        generation_config: {
          transcription_config: { language_codes: language ? [language] : [], mode },
        },
      },
      { apiKey, signal, revision: false } // os exemplos de transcrição não mandam Api-Revision
    );

    const words = outputItems(data)
      .flatMap((c) => c.annotations ?? [])
      .filter((a) => !a.type || a.type === 'word_info')
      .map((a) => ({
        text: String(a.text ?? '').trim(),
        speaker: a.speaker ?? null,
        start: toSeconds(a.start_offset),
        end: toSeconds(a.end_offset),
      }))
      .filter((w) => w.text);

    return { text: outputText(data), words, model: MODELS.transcribe, usage: usageOf(data), ...(raw ? { raw: data } : {}) };
  } finally {
    await deleteFile(file.name, apiKey);
  }
}

// ------------------------------------------------------------------ resumo

export async function summarizeTranscript(input, { apiKey, signal } = {}) {
  const data = await interact(
    {
      model: MODELS.summary,
      input: summaryPrompt(input),
      response_format: { type: 'text', mime_type: 'application/json', schema: SUMMARY_SCHEMA },
    },
    { apiKey, signal, revision: true }
  );
  let summary;
  try {
    summary = parseSummaryText(outputText(data));
  } catch {
    throw new HttpError(502, 'O Gemini devolveu um resumo em formato inesperado. Tente de novo.');
  }
  return { summary, model: MODELS.summary, usage: usageOf(data) };
}
