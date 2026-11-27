// Resumo da reunião: manda a transcrição (e as anotações) ao provedor escolhido em Configurações
// (Gemini, OpenAI, Claude ou Ollama), que devolve resumo, decisões, próximos passos e tópicos.
// Não depende de transcrever de novo.
import * as store from './store.js';
import { NO_SUMMARIZER, resolveSummarizer, summarize } from './ai.js';
import { currentUser } from './auth.js';
import { getSettings } from './settings.js';
import { formatTimestamp } from './speech.js';

export class Summarizer {
  constructor({ notify }) {
    this.notify = notify;
    this.running = new Set();
  }

  isActive(id) {
    return this.running.has(id);
  }

  async start(id) {
    if (this.running.has(id)) return;
    const { summarizer, ollamaModel } = getSettings();
    if (!(await resolveSummarizer(summarizer, ollamaModel))) throw new Error(NO_SUMMARIZER);
    const m = await store.get(id);
    if (!m) throw new Error('Reunião não encontrada.');
    if (!m.segments?.length) throw new Error('Transcreva a reunião antes de resumir.');

    this.running.add(id);
    await store.update(id, { summary: { status: 'running', error: null } });
    this.notify('meetings:changed');
    this.run(m).finally(() => {
      this.running.delete(id);
      this.notify('meetings:changed');
    });
  }

  async run(m) {
    try {
      const { summarizer, ollamaModel } = getSettings();
      const me = currentUser()?.name ? `${currentUser().name} (quem gravou)` : 'Você (quem gravou)';
      const transcript = m.segments.map((s) => `[${formatTimestamp(s.start)}] ${s.speaker === 'Você' ? me : s.speaker}: ${s.text}`).join('\n');
      const result = await summarize(
        {
          title: m.title,
          date: new Date(m.createdAt).toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' }),
          notes: m.notes || '',
          attendees: (m.calendarEvent?.attendees ?? []).map((a) => (a.self ? `${a.name} (quem gravou)` : a.name)),
          transcript,
        },
        { choice: summarizer, ollamaModel }
      );
      await store.saveSummary(m.id, result.summary);
      await store.update(m.id, {
        summary: { status: 'done', error: null, model: result.model, provider: result.provider, finishedAt: new Date().toISOString() },
      });
      this.notify('summary:done', { id: m.id });
    } catch (err) {
      await store.update(m.id, { summary: { status: 'error', error: err.message } }).catch(() => {});
      this.notify('summary:error', { id: m.id, error: err.message });
    }
  }
}
