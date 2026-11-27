// Backend do XMeeting para o plano da empresa: confere o login (só contas dos domínios da
// empresa) e fala com o Gemini com a chave da empresa, que fica só aqui, nunca no computador
// dos usuários. Contas de fora usam a própria chave do Gemini direto do app.
//
//   npm run server            (na raiz do projeto, lê server/.env)
//
// Rotas (todas, menos /health, exigem "Authorization: Bearer <ID token do Google>"):
//   GET  /health
//   GET  /v1/me
//   POST /v1/transcribe?language=pt-BR&diarize=1   corpo: áudio (audio/mpeg), até 30 min
//   POST /v1/summarize                             corpo: JSON { title, date, notes, transcript }
import { appendFile } from 'node:fs/promises';
import http from 'node:http';
import { authConfigProblem, COMPANY_DOMAINS, verifyUser } from './auth.js';
import { HttpError } from './errors.js';
import { MODELS, summarizeTranscript, transcribeAudio } from './gemini.js';

const PORT = Number(process.env.PORT) || 8080;
const API_KEY = process.env.GEMINI_API_KEY || '';
const USAGE_LOG = process.env.USAGE_LOG || '';
const MAX_AUDIO_BYTES = 60 * 1024 * 1024; // 25 min em MP3 32 kbps dá ~6 MB
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const AUDIO_TYPES = { 'audio/mpeg': 'audio/mp3', 'audio/mp3': 'audio/mp3', 'audio/ogg': 'audio/ogg', 'audio/webm': 'audio/webm', 'audio/wav': 'audio/wav' };
const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

const problems = [API_KEY ? null : 'GEMINI_API_KEY não definido.', authConfigProblem()].filter(Boolean);
if (problems.length) {
  console.error(`Configuração incompleta (veja server/.env.example):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(new HttpError(413, 'Arquivo grande demais.'));
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Arquivo grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Consumo por usuário: uma linha por chamada. No Cloud Run, o console.log vai para o Cloud Logging.
async function logUsage(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(`[uso] ${line}`);
  if (USAGE_LOG) await appendFile(USAGE_LOG, line + '\n').catch((err) => console.warn('Não consegui gravar o log de uso:', err.message));
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, models: MODELS });

  const user = await verifyUser(req.headers.authorization);

  if (req.method === 'GET' && url.pathname === '/v1/me') return send(res, 200, user);

  if (req.method === 'POST' && url.pathname === '/v1/transcribe') {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const mimeType = AUDIO_TYPES[type];
    if (!mimeType) throw new HttpError(415, 'Formato de áudio não aceito.');
    const language = url.searchParams.get('language') || '';
    if (language && !LANGUAGE_RE.test(language)) throw new HttpError(400, 'Idioma inválido.');
    const audio = await readBody(req, MAX_AUDIO_BYTES);
    if (audio.length === 0) throw new HttpError(400, 'Nenhum áudio recebido.');

    const started = Date.now();
    const result = await transcribeAudio(audio, { apiKey: API_KEY, mimeType, language, diarize: url.searchParams.get('diarize') === '1' });
    await logUsage({
      email: user.email,
      kind: 'transcribe',
      model: result.model,
      audioSeconds: Number(req.headers['x-audio-seconds']) || null,
      bytes: audio.length,
      ms: Date.now() - started,
      usage: result.usage,
    });
    return send(res, 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/v1/summarize') {
    let body;
    try {
      body = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8'));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'Pedido inválido.');
    }
    const transcript = typeof body?.transcript === 'string' ? body.transcript : '';
    if (!transcript.trim()) throw new HttpError(400, 'A transcrição está vazia.');
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

    const started = Date.now();
    const result = await summarizeTranscript(
      {
        title: str(body.title, 300),
        date: str(body.date, 100),
        notes: str(body.notes, 100_000),
        attendees: (Array.isArray(body.attendees) ? body.attendees : []).slice(0, 200).map((a) => str(a, 200)).filter(Boolean),
        transcript,
      },
      { apiKey: API_KEY }
    );
    await logUsage({ email: user.email, kind: 'summarize', model: result.model, chars: transcript.length, ms: Date.now() - started, usage: result.usage });
    return send(res, 200, result);
  }

  throw new HttpError(404, 'Rota não encontrada.');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : err?.name === 'TimeoutError' ? 504 : 500;
    if (status >= 500) console.error(`[erro] ${req.method} ${req.url}:`, err);
    const message =
      err instanceof HttpError ? err.message : status === 504 ? 'O Gemini demorou demais para responder.' : 'Erro interno no servidor do XMeeting.';
    if (!res.headersSent) send(res, status, { error: message });
    else res.end();
  });
});

// Transcrever 25 min de áudio pode levar alguns minutos: sem limite de tempo por pedido.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(PORT, () =>
  console.log(
    `XMeeting backend em http://localhost:${PORT} (transcrição: ${MODELS.transcribe}, resumo: ${MODELS.summary}, plano da empresa: ${COMPANY_DOMAINS.join(', ')})`
  )
);
