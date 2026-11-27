// Ollama: resumo 100% local, se a pessoa tiver o Ollama instalado e rodando (ollama.com).
// O Ollama roda modelos de texto: serve para resumir, não para transcrever áudio.
import { meetingContent, parseSummaryText, SUMMARY_INSTRUCTIONS, SUMMARY_SCHEMA } from '../../server/summary.js';

const API = 'http://127.0.0.1:11434';
export const OLLAMA_URL = 'https://ollama.com/download';

/** Modelos instalados no Ollama; lista vazia se o Ollama não estiver rodando. */
export async function listOllamaModels() {
  try {
    const res = await fetch(`${API}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? []).map((m) => ({ name: m.name, sizeGb: Number(m.size ?? 0) / 1e9 }));
  } catch {
    return [];
  }
}

export async function summarizeOllama(input, { model, signal }) {
  const content = meetingContent(input);
  // O contexto padrão dos modelos locais é pequeno: sem isto o começo da reunião seria cortado.
  const numCtx = Math.min(131072, Math.max(8192, Math.ceil((content.length + SUMMARY_INSTRUCTIONS.length) / 3) + 4096));
  let res;
  try {
    res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: SUMMARY_SCHEMA,
        options: { num_ctx: numCtx, temperature: 0.2 },
        messages: [
          { role: 'system', content: SUMMARY_INSTRUCTIONS },
          { role: 'user', content },
        ],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) : AbortSignal.timeout(30 * 60_000),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('O Ollama não respondeu. Confira se ele está aberto no computador.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`O Ollama respondeu com erro: ${data.error || res.status}`);
  try {
    return { summary: parseSummaryText(data.message?.content), model: `ollama/${model}`, usage: null };
  } catch {
    throw new Error(`O modelo ${model} do Ollama devolveu um resumo em formato inesperado. Tente outro modelo.`);
  }
}
