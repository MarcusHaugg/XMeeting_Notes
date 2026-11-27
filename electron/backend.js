// Cliente do backend do XMeeting (pasta server/): manda o pedido com o login de quem usa o app.
import { getConfig } from './config.js';
import { getIdToken } from './auth.js';

export async function callBackend(pathname, { method = 'POST', body, headers = {}, signal, timeoutMs = 10 * 60_000 } = {}) {
  const { backendUrl } = getConfig();
  if (!backendUrl) throw new Error('Servidor do XMeeting não configurado (backendUrl em app-config.json).');
  const token = await getIdToken();
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];

  let res;
  try {
    res = await fetch(new URL(pathname, backendUrl), {
      method,
      body,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err?.name === 'TimeoutError') throw new Error('O servidor do XMeeting demorou demais para responder.');
    throw new Error('Sem conexão com o servidor do XMeeting. Verifique a internet.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `O servidor do XMeeting respondeu com erro (${res.status}).`);
  return data;
}
