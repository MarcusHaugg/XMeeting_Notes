// Claude (Anthropic) com a chave da própria pessoa, só para o resumo: a API do Claude aceita
// texto, imagem e PDF, mas não áudio, então não transcreve. A assinatura do claude.ai não paga a
// API; os planos Max, Ultra e Team incluem créditos mensais que a pessoa resgata em claude.ai
// (Configurações > Faturamento) para uma organização do Console, onde gera a chave.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { meetingContent, normalizeSummary, SUMMARY_INSTRUCTIONS } from '../../server/summary.js';

export const CLAUDE_MODEL = 'claude-opus-5-5';
export const CLAUDE_KEYS_URL = 'https://platform.claude.com';

const SummarySchema = z.object({
  summary: z.string(),
  decisions: z.array(z.string()),
  action_items: z.array(z.object({ task: z.string(), owner: z.string(), due: z.string() })),
  topics: z.array(z.object({ title: z.string(), points: z.array(z.string()) })),
});

const client = (apiKey) => new Anthropic({ apiKey, timeout: 10 * 60_000, maxRetries: 2 });

function explain(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('A chave do Claude é inválida.');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error('A chave do Claude não tem permissão para este modelo.');
  if (err instanceof Anthropic.RateLimitError) return new Error('Limite de uso do Claude atingido. Tente de novo em alguns minutos.');
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) {
    return new Error('A conta do Claude da chave está sem créditos de API. Compre créditos no Console ou resgate os do plano Max/Team.');
  }
  if (err instanceof Anthropic.APIConnectionError) return new Error('Sem conexão com o Claude. Verifique a internet.');
  if (err instanceof Anthropic.APIError) return new Error(`O Claude respondeu com erro (${err.status}): ${err.message}`);
  return err;
}

/** Confere a chave sem gastar tokens: consulta o modelo usado no resumo. */
export async function checkClaudeKey(apiKey) {
  try {
    await client(apiKey).models.retrieve(CLAUDE_MODEL);
  } catch (err) {
    throw explain(err);
  }
}

export async function summarizeClaude(input, { apiKey, signal }) {
  let response;
  try {
    response = await client(apiKey).beta.messages.parse(
      {
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        // Se o filtro de segurança recusar o pedido por engano, a API refaz com outro modelo.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: betaZodOutputFormat(SummarySchema) },
        system: SUMMARY_INSTRUCTIONS,
        messages: [{ role: 'user', content: meetingContent(input) }],
      },
      { signal }
    );
  } catch (err) {
    throw explain(err);
  }
  if (response.stop_reason === 'refusal') throw new Error('O Claude se recusou a resumir esta reunião.');
  if (response.stop_reason === 'max_tokens') throw new Error('O resumo ficou grande demais e foi cortado. Tente de novo.');
  if (!response.parsed_output) throw new Error('O Claude devolveu um resumo em formato inesperado. Tente de novo.');
  return { summary: normalizeSummary(response.parsed_output), model: response.model ?? CLAUDE_MODEL, usage: response.usage ?? null };
}
