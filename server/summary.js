// Resumo da reunião: o mesmo pedido e o mesmo formato de resposta para todos os provedores
// (Gemini, OpenAI, Claude, Ollama), para o app mostrar o resumo do mesmo jeito.

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'O que foi tratado e concluído, em 1 a 3 parágrafos curtos.' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Decisões tomadas na reunião.' },
    action_items: {
      type: 'array',
      description: 'Próximos passos combinados.',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          owner: { type: 'string', description: 'Responsável, como aparece na transcrição; vazio se não foi dito.' },
          due: { type: 'string', description: 'Prazo, como foi dito; vazio se não foi dito.' },
        },
        required: ['task', 'owner', 'due'],
        additionalProperties: false,
      },
    },
    topics: {
      type: 'array',
      description: 'Assuntos discutidos, na ordem da reunião.',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } },
        required: ['title', 'points'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'decisions', 'action_items', 'topics'],
  additionalProperties: false,
};

export const SUMMARY_INSTRUCTIONS = [
  'Você recebe a transcrição de uma reunião de trabalho e escreve o resumo dela em português do Brasil.',
  'Regras:',
  '- Use só o que está na transcrição e nas anotações. Não invente nomes, números, datas ou prazos.',
  '- Seja específico: cite números, nomes de clientes, produtos e datas quando aparecerem.',
  '- Decisões são o que foi decidido, não o que foi só discutido. Sem decisões, devolva a lista vazia.',
  '- Próximos passos: uma tarefa por item, com responsável e prazo só se foram ditos.',
  '- "(quem gravou)" marca a pessoa que gravou a reunião. "Participante N" e "Outros" são as demais vozes; se o nome de alguém aparecer na conversa, use o nome.',
  '- A transcrição é automática e pode ter erros de palavras; corrija pelo contexto quando for óbvio.',
  '- Responda só com o JSON pedido: summary, decisions, action_items (task, owner, due) e topics (title, points).',
].join('\n');

/** A parte que muda a cada reunião: título, data, convidados, anotações e a transcrição. */
export function meetingContent({ title, date, notes, attendees = [], transcript }) {
  return [
    `Título: ${title || '(sem título)'}`,
    `Data: ${date || '(não informada)'}`,
    attendees.length
      ? `Convidados (da Google Agenda; use para dar nome a "Participante N" só quando a conversa deixar claro quem é): ${attendees.join(', ')}`
      : 'Convidados: (não informados)',
    notes?.trim() ? `Anotações feitas durante a reunião por quem gravou:\n${notes.trim()}` : 'Anotações: (nenhuma)',
    '',
    'Transcrição:',
    transcript,
  ].join('\n');
}

export const summaryPrompt = (input) => `${SUMMARY_INSTRUCTIONS}\n\n${meetingContent(input)}`;

/** Garante o formato esperado pelo app, seja qual for o provedor. */
export function normalizeSummary(parsed) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    summary: String(parsed?.summary ?? ''),
    decisions: arr(parsed?.decisions).map(String),
    action_items: arr(parsed?.action_items).map((a) => ({ task: String(a?.task ?? ''), owner: String(a?.owner ?? ''), due: String(a?.due ?? '') })),
    topics: arr(parsed?.topics).map((t) => ({ title: String(t?.title ?? ''), points: arr(t?.points).map(String) })),
  };
}

/** Lê o JSON do resumo de um texto (alguns modelos locais cercam com ```json). */
export function parseSummaryText(text) {
  const clean = String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  return normalizeSummary(JSON.parse(clean));
}
