// Confere o login: o app manda o ID token do Google de quem está logado. Este servidor usa a
// chave do Gemini da empresa, então só atende contas dos domínios da empresa (COMPANY_DOMAINS).
// Qualquer outra conta usa a própria chave do Gemini direto do app e nunca passa por aqui.
import { HttpError } from './errors.js';

const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
const list = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const CLIENT_IDS = list(process.env.GOOGLE_CLIENT_IDS);
export const COMPANY_DOMAINS = list(process.env.COMPANY_DOMAINS);

export function authConfigProblem() {
  if (CLIENT_IDS.length === 0) return 'GOOGLE_CLIENT_IDS não definido (ID do cliente OAuth do app).';
  if (COMPANY_DOMAINS.length === 0) return 'COMPANY_DOMAINS não definido (domínios cujo uso este servidor paga).';
  return null;
}

// Evita consultar o Google a cada pedido: um token válido fica guardado por até 5 min.
const cache = new Map();

export async function verifyUser(authorization) {
  const match = /^Bearer\s+(.+)$/i.exec(authorization || '');
  if (!match) throw new HttpError(401, 'Faça login para continuar.');
  const token = match[1].trim();

  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;

  let info;
  try {
    const res = await fetch(TOKENINFO + encodeURIComponent(token), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new HttpError(401, 'Sua sessão expirou. Entre de novo no XMeeting.');
    info = await res.json();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, 'Não consegui validar o login com o Google. Tente de novo.');
  }

  if (!CLIENT_IDS.includes(String(info.aud).toLowerCase())) throw new HttpError(401, 'Este login não foi feito pelo XMeeting.');
  if (String(info.email_verified) !== 'true') throw new HttpError(401, 'O e-mail desta conta Google não está verificado.');
  if (!COMPANY_DOMAINS.includes(String(info.hd || '').toLowerCase())) {
    throw new HttpError(403, 'Esta conta não faz parte do plano da empresa. Use sua própria chave do Gemini em Configurações.');
  }
  const exp = Number(info.exp) * 1000;
  if (!exp || exp < Date.now()) throw new HttpError(401, 'Sua sessão expirou. Entre de novo no XMeeting.');

  const user = { email: info.email, name: info.name || info.email, domain: info.hd };
  if (cache.size > 1000) cache.clear();
  cache.set(token, { user, until: Math.min(exp, Date.now() + 5 * 60_000) });
  return user;
}
