// Configuração do app: cliente OAuth do Google, endereço do backend e domínios do plano da empresa.
// Vem de app-config.json (na raiz do projeto, fora do git) ou de variáveis de ambiente,
// que têm prioridade (úteis no desenvolvimento).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app-config.json');
let cached = null;

export function getConfig() {
  if (cached) return cached;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    /* sem arquivo: só variáveis de ambiente */
  }
  const pick = (env, key) => String(process.env[env] || file[key] || '').trim();
  cached = {
    googleClientId: pick('XMEETING_GOOGLE_CLIENT_ID', 'googleClientId'),
    // O Google exige o "segredo" também no cliente de computador, mas não o trata como sigiloso.
    googleClientSecret: pick('XMEETING_GOOGLE_CLIENT_SECRET', 'googleClientSecret'),
    // Servidor do plano da empresa: só contas dos domínios abaixo usam (e a empresa paga).
    backendUrl: pick('XMEETING_BACKEND_URL', 'backendUrl'),
    companyDomains: pick('XMEETING_COMPANY_DOMAINS', 'companyDomains')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  };
  return cached;
}

/** O que falta configurar, em texto para o usuário; null se está tudo certo. */
export function configProblem() {
  const c = getConfig();
  if (!c.googleClientId) return 'Falta configurar googleClientId em app-config.json.';
  if (c.companyDomains.length && !c.backendUrl) return 'companyDomains está configurado, mas falta backendUrl em app-config.json.';
  return null;
}
