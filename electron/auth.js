// Login com qualquer conta Google, pessoal ou de empresa (OAuth 2.0 para apps de computador,
// com PKCE). O primeiro login cria a conta do XMeeting vinculada a ela. O domínio da conta
// (vazio em contas pessoais) decide se ela usa o plano da empresa ou a própria chave do Gemini.
// O Google não aceita login dentro de janelas do próprio app: o login abre no navegador
// padrão e volta para um endereço local (127.0.0.1, porta aleatória).
// https://developers.google.com/identity/protocols/oauth2/native-app
import { safeStorage, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getConfig } from './config.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const LOGIN_TIMEOUT_MS = 5 * 60_000;

// Identificação + leitura da Google Agenda. Apps de computador não podem pedir permissões aos
// poucos: tudo vai no login. Na tela do Google a pessoa pode desmarcar a agenda; por isso as
// permissões concedidas ficam guardadas (session.scopes) e a agenda pode ser conectada depois.
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const SCOPES = ['openid', 'email', 'profile', CALENDAR_SCOPE];

export class AuthError extends Error {}

let file = null;
let session = null; // { refreshToken, user, scopes, idToken, idTokenExp, accessToken, accessTokenExp }
let onChanged = () => {};
let pendingLogin = null;
let refreshing = null;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- sessão salva

export async function initAuth(userData, { onChange }) {
  file = path.join(userData, 'session.bin');
  onChanged = onChange;
  try {
    if (fs.existsSync(file) && (await safeStorage.isAsyncEncryptionAvailable())) {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(fs.readFileSync(file));
      const data = JSON.parse(result);
      if (data?.refreshToken && data?.user) session = { refreshToken: data.refreshToken, user: data.user, scopes: data.scopes ?? [] };
      if (session && shouldReEncrypt) persist();
    }
  } catch (err) {
    console.warn('Sessão salva ilegível; será preciso entrar de novo:', err.message);
  }
}

// O token de renovação fica cifrado pelo sistema (Keychain no macOS, DPAPI no Windows).
// Sem cofre disponível (alguns Linux), a sessão vale só enquanto o app estiver aberto.
// As gravações em disco ficam em fila para uma não atropelar a outra.
let writing = Promise.resolve();
function persist() {
  const snapshot = session?.refreshToken
    ? JSON.stringify({ refreshToken: session.refreshToken, user: session.user, scopes: session.scopes ?? [] })
    : null;
  const clear = !session;
  writing = writing.then(async () => {
    try {
      if (clear) await fs.promises.rm(file, { force: true });
      else if (snapshot && (await safeStorage.isAsyncEncryptionAvailable())) {
        await fs.promises.writeFile(file, await safeStorage.encryptStringAsync(snapshot));
      }
    } catch (err) {
      console.warn('Não consegui salvar a sessão:', err.message);
    }
  });
}

function setSession(next) {
  session = next;
  persist();
  onChanged(currentUser());
}

export const currentUser = () => session?.user ?? null;

/** A pessoa concedeu esta permissão no login? (ex.: CALENDAR_SCOPE) */
export const hasScope = (scope) => Boolean(session?.scopes?.includes(scope));

/**
 * Só para capturas de tela no desenvolvimento (--screenshot --fake-user=...): mostra a
 * interface logada sem sessão real. Não salva nada e não passa no backend, que exige
 * o token de verdade do Google.
 */
export function useFakeUserForScreenshots(email, { calendar = true } = {}) {
  const domain = email.split('@')[1]?.toLowerCase() ?? null;
  session = {
    refreshToken: null,
    scopes: calendar ? SCOPES : SCOPES.filter((s) => s !== CALENDAR_SCOPE),
    user: { email, name: email.split('@')[0], domain: domain === 'gmail.com' ? null : domain },
  };
}

// ---------------------------------------------------------------- login

function tokenRequest(params) {
  const { googleClientId, googleClientSecret } = getConfig();
  const body = new URLSearchParams({ client_id: googleClientId, ...(googleClientSecret ? { client_secret: googleClientSecret } : {}), ...params });
  return fetch(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(30_000) }).catch(() => {
    throw new Error('Sem conexão com o Google. Verifique a internet.');
  });
}

/** Guarda os tokens novos. Devolve true se as permissões concedidas mudaram. */
function applyTokens(t) {
  session.idToken = t.id_token || session.idToken;
  session.idTokenExp = (decodeJwt(session.idToken).exp ?? 0) * 1000;
  session.accessToken = t.access_token;
  session.accessTokenExp = Date.now() + (Number(t.expires_in) || 3600) * 1000;
  if (typeof t.scope !== 'string') return false;
  const scopes = t.scope.split(/\s+/).filter(Boolean).sort();
  const changed = scopes.join(' ') !== [...(session.scopes ?? [])].sort().join(' ');
  session.scopes = scopes;
  return changed;
}

const PAGE = (title, text) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>XMeeting Notes</title>
<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#1f2024">
<div style="text-align:center;max-width:420px"><h1 style="font-size:20px">${title}</h1><p>${text}</p></div></body></html>`;

/** Abre o login no navegador e espera a volta. Resolve com o usuário logado. */
export async function login() {
  const { googleClientId } = getConfig();
  if (!googleClientId) throw new Error('Login não configurado: falta googleClientId em app-config.json.');
  pendingLogin?.cancel();

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}`;

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('O login não foi concluído a tempo. Tente de novo.')), LOGIN_TIMEOUT_MS);
    function finish(err, value) {
      clearTimeout(timer);
      server.close();
      pendingLogin = null;
      if (err) reject(err);
      else resolve(value);
    }
    pendingLogin = { cancel: () => finish(new Error('Login cancelado.')) };

    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const html = (status, title, text) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE(title, text));
      if (url.searchParams.get('state') !== state) {
        html(400, 'Login inválido', 'Volte ao XMeeting e tente de novo.');
        return;
      }
      if (url.searchParams.get('error')) {
        html(200, 'Login cancelado', 'Você pode fechar esta aba.');
        finish(new Error(url.searchParams.get('error') === 'access_denied' ? 'Login cancelado.' : `O Google recusou o login (${url.searchParams.get('error')}).`));
        return;
      }
      html(200, 'Pronto!', 'Login concluído. Pode fechar esta aba e voltar ao XMeeting.');
      finish(null, url.searchParams.get('code'));
    });

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline', // traz o token de renovação: o login vale por muito tempo
      prompt: 'select_account consent',
    });
    shell.openExternal(`${AUTH_URL}?${params}`).catch((err) => finish(new Error(`Não consegui abrir o navegador: ${err.message}`)));
  });

  const res = await tokenRequest({ code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`O Google recusou o login: ${tokens.error_description || tokens.error || res.status}.`);

  const claims = decodeJwt(tokens.id_token);
  // "hd" só vem em contas de organizações (Google Workspace); em contas pessoais fica vazio.
  session = {
    refreshToken: tokens.refresh_token || null,
    scopes: [],
    user: { email: claims.email, name: claims.name || claims.email, domain: claims.hd ? String(claims.hd).toLowerCase() : null },
  };
  applyTokens(tokens);
  setSession(session);
  return currentUser();
}

export function cancelLogin() {
  pendingLogin?.cancel();
}

function revoke(token) {
  if (!token) return;
  fetch(`${REVOKE_URL}?${new URLSearchParams({ token })}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {});
}

export async function logout() {
  if (!session) return;
  revoke(session.refreshToken || session.accessToken);
  setSession(null);
}

// ---------------------------------------------------------------- tokens

async function refresh() {
  if (!session?.refreshToken) {
    setSession(null);
    throw new AuthError('Sua sessão expirou. Entre de novo.');
  }
  const res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (tokens.error === 'invalid_grant') {
      setSession(null); // acesso revogado ou expirado: volta para a tela de login
      throw new AuthError('Sua sessão expirou. Entre de novo.');
    }
    throw new Error(`Não consegui renovar o login: ${tokens.error_description || tokens.error || res.status}.`);
  }
  if (applyTokens(tokens)) persist(); // a pessoa tirou (ou deu) permissões pela conta Google
}

/** Esquece que uma permissão foi concedida (o Google respondeu que ela não vale mais). */
export function dropScope(scope) {
  if (!session?.scopes?.includes(scope)) return;
  session.scopes = session.scopes.filter((s) => s !== scope);
  persist();
}

async function ensureFresh(expKey) {
  if (!session) throw new AuthError('Faça login para continuar.');
  if (session[expKey] && session[expKey] - 60_000 > Date.now()) return;
  refreshing ??= refresh().finally(() => (refreshing = null));
  await refreshing;
}

/** ID token (JWT) de quem está logado: é o que o backend usa para saber quem pede. */
export async function getIdToken() {
  await ensureFresh('idTokenExp');
  return session.idToken;
}

/** Token de acesso às APIs do Google (Calendar, Meet) em nome do usuário. */
export async function getAccessToken() {
  await ensureFresh('accessTokenExp');
  return session.accessToken;
}

/** O Google recusou o token de acesso (401): o próximo pedido renova antes. */
export function invalidateAccessToken() {
  if (session) session.accessTokenExp = 0;
}
