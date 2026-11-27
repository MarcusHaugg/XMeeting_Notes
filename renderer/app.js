/* global MNRecorder */
(() => {
  const api = window.api;
  const $ = (sel) => document.querySelector(sel);

  // ------------------------------------------------------------ utilidades
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pad = (n) => String(n).padStart(2, '0');

  function fmtClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  }

  function fmtDuration(sec) {
    if (!sec) return '—';
    if (sec < 60) return `${Math.round(sec)} s`;
    const m = Math.round(sec / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Hoje';
    if (d.toDateString() === yesterday.toDateString()) return 'Ontem';
    return d.toLocaleDateString('pt-BR', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
    });
  }

  const timeLabel = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  // ------------------------------------------------------------ estado
  const state = {
    meetings: [],
    selectedId: null,
    meeting: null,
    tab: 'notes',
    filter: '',
    settings: null,
    user: null, // { email, name, domain } de quem está logado
    ai: null, // { account, domain, company, keys: { gemini, openai, claude } (final de cada chave), providers }
    aiOptions: null, // opções de transcrição/resumo e se estão disponíveis (main.js: aiOptions)
    agenda: { connected: null, events: [], error: null, loading: false }, // Google Agenda
    recording: null, // { id, startedAt, capture, stopping }
    starting: false,
    progress: {}, // id -> { stage, progress, etaSec }
  };
  let tickTimer = null;
  let notesTimer = null;
  let pendingNotes = null; // { id, notes }

  function toast(message, kind = 'info', timeout = 6000) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    el.title = 'Clique para fechar';
    el.addEventListener('click', () => el.remove());
    $('#toasts').append(el);
    if (timeout) setTimeout(() => el.remove(), timeout);
  }

  // ------------------------------------------------------------ lista
  async function loadList() {
    state.meetings = await api.meetings.list();
    renderList();
  }

  function renderList() {
    const q = state.filter.trim().toLowerCase();
    const items = state.meetings.filter((m) => !q || m.title.toLowerCase().includes(q));
    if (items.length === 0) {
      $('#list').innerHTML = `<p class="list-empty">${q ? 'Nada encontrado.' : 'Nenhuma reunião ainda.'}</p>`;
      return;
    }
    let html = '';
    let lastDay = null;
    for (const m of items) {
      const day = dayLabel(m.createdAt);
      if (day !== lastDay) {
        html += `<div class="list-day">${esc(day)}</div>`;
        lastDay = day;
      }
      const live = state.recording?.id === m.id;
      const t = m.transcript?.status;
      const s = m.summary?.status;
      const badge = live
        ? '<span class="badge live">gravando</span>'
        : t === 'queued' || t === 'running'
          ? '<span class="badge busy">transcrevendo</span>'
          : s === 'running'
            ? '<span class="badge busy">resumindo</span>'
            : s === 'done'
              ? '<span class="badge ok">resumida</span>'
              : t === 'done'
                ? '<span class="badge ok">transcrita</span>'
                : m.status === 'error'
                  ? '<span class="badge err">erro</span>'
                  : '';
      html += `<button class="list-item${m.id === state.selectedId ? ' active' : ''}" data-id="${esc(m.id)}">
          <span class="li-title">${esc(m.title)}</span>
          <span class="li-meta">${esc(timeLabel(m.createdAt))}${live ? '' : ` · ${esc(fmtDuration(m.durationSec))}`} ${badge}</span>
        </button>`;
    }
    $('#list').innerHTML = html;
  }

  // ------------------------------------------------------------ agenda (tela inicial)
  const TIPS = `<ul class="tips">
      <li>Use fones de ouvido, para a sua voz não se misturar com a dos outros.</li>
      <li>Teams, Meet e Zoom devem usar os dispositivos de som padrão do sistema.</li>
      <li>Avise os participantes de que a reunião está sendo gravada.</li>
    </ul>`;
  const LINK_LABEL = { meet: 'Google Meet', teams: 'Teams', zoom: 'Zoom', link: 'Chamada' };

  async function loadAgenda({ refresh = false } = {}) {
    if (!state.user) return;
    state.agenda.loading = true;
    if (!state.selectedId) renderAgenda();
    try {
      const { connected, events } = await api.calendar.list({ refresh });
      state.agenda = { ...state.agenda, connected, events, error: null };
    } catch (err) {
      state.agenda.error = err.message;
    } finally {
      state.agenda.loading = false;
      if (!state.selectedId) renderAgenda();
    }
  }

  function agendaDayLabel(iso) {
    const d = new Date(iso);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return 'Amanhã';
    return dayLabel(iso);
  }

  function renderEvent(ev) {
    const now = Date.now();
    const start = Date.parse(ev.start);
    const end = Date.parse(ev.end);
    const live = !ev.allDay && start - 5 * 60_000 <= now && now < end;
    const past = !ev.allDay && end <= now;
    const others = ev.attendees.filter((a) => !a.self).length;
    const meta = [
      ev.link ? `<span class="ev-badge">${esc(LINK_LABEL[ev.link.kind] ?? 'Chamada')}</span>` : '',
      others ? `${others} participante${others > 1 ? 's' : ''}` : '',
      ev.organizer && others ? `organizado por ${esc(ev.organizer)}` : '',
    ].filter(Boolean);
    const canRecord = !past && !ev.allDay && !state.recording;
    return `<div class="event${live ? ' now' : ''}${past ? ' past' : ''}">
        <div class="ev-time">${ev.allDay ? 'Dia todo' : `${esc(timeLabel(ev.start))}<br><span>${esc(timeLabel(ev.end))}</span>`}</div>
        <div class="ev-body">
          <div class="ev-title" title="${esc(ev.title)}">${esc(ev.title)}</div>
          <div class="ev-meta">${meta.join('<span>·</span>')}</div>
        </div>
        <div class="ev-actions">
          ${ev.link && !past ? `<button class="btn small" data-action="calendar-join" data-event="${esc(ev.id)}">Entrar</button>` : ''}
          ${canRecord ? `<button class="btn small${live ? ' primary' : ''}" data-action="calendar-record" data-event="${esc(ev.id)}">Gravar</button>` : ''}
        </div>
      </div>`;
  }

  function renderAgenda() {
    renderNav();
    const a = state.agenda;
    let body;
    if (a.connected === null && a.loading) {
      body = '<p class="muted">Carregando a agenda...</p>';
    } else if (a.connected === false) {
      body = `<div class="card center">
          ${a.error ? `<div class="notice">${esc(a.error)}</div>` : ''}
          <div class="card-title">Conecte sua Google Agenda</div>
          <p class="card-sub">Veja as reuniões do dia, grave com um clique (o título e os participantes já vêm preenchidos)
            e receba um aviso quando a reunião começar. O XMeeting só lê a agenda: não altera nada.</p>
          <div class="actions"><button class="btn primary" data-action="calendar-connect">Conectar Google Agenda</button></div>
        </div>`;
    } else {
      const days = new Map();
      for (const ev of a.events) {
        const key = agendaDayLabel(ev.start);
        if (!days.has(key)) days.set(key, []);
        days.get(key).push(ev);
      }
      body = a.error ? `<div class="notice">${esc(a.error)}</div>` : '';
      body += days.size
        ? [...days].map(([day, evs]) => `<div class="agenda-day">${esc(day)}</div>${evs.map(renderEvent).join('')}`).join('')
        : '<div class="card center"><p class="muted">Nenhuma reunião na sua agenda nos próximos 7 dias.</p></div>';
    }
    $('#main').innerHTML = `<section class="agenda">
        <header class="agenda-head">
          <h1>Agenda</h1>
          <span class="spacer"></span>
          ${a.connected ? `<button class="btn small" data-action="agenda-refresh"${a.loading ? ' disabled' : ''}>${a.loading ? 'Atualizando...' : 'Atualizar'}</button>` : ''}
        </header>
        <p class="muted small">Sem compromisso na agenda? Clique em <strong>Nova reunião</strong> quando entrar na chamada.</p>
        ${body}
        ${TIPS}
      </section>`;
  }

  function renderNav() {
    $('#open-agenda').classList.toggle('active', !state.selectedId);
  }

  // ------------------------------------------------------------ reunião aberta
  async function openMeeting(id) {
    await flushNotes();
    state.selectedId = id;
    state.meeting = id ? await api.meetings.get(id) : null;
    if (state.recording?.id === id) state.tab = 'notes';
    renderMeeting();
    renderList();
  }

  function renderMeeting() {
    const main = $('#main');
    const m = state.meeting;
    renderNav();
    if (!m) {
      renderAgenda();
      return;
    }
    main.innerHTML = `
      <article class="meeting">
        <header class="meeting-head">
          <input id="m-title" class="title-input" maxlength="200" aria-label="Título da reunião">
          <div class="meta-row">
            <span id="m-meta" class="muted"></span>
            <span class="spacer"></span>
            <button class="link-btn" data-action="open-folder">Abrir pasta</button>
            <button class="link-btn danger" data-action="delete">Excluir</button>
          </div>
          <div id="m-people" class="people" hidden></div>
          <div id="player" class="player" hidden></div>
        </header>
        <div class="tabs" role="tablist">
          <button role="tab" id="tab-btn-notes" data-tab="notes">Anotações</button>
          <button role="tab" id="tab-btn-transcript" data-tab="transcript">Transcrição</button>
          <button role="tab" id="tab-btn-summary" data-tab="summary">Resumo</button>
        </div>
        <section id="tab-notes" class="tab-panel" role="tabpanel">
          <textarea id="m-notes" class="notes" placeholder="Escreva suas anotações aqui. Elas são salvas automaticamente."></textarea>
        </section>
        <section id="tab-transcript" class="tab-panel" role="tabpanel" hidden></section>
        <section id="tab-summary" class="tab-panel" role="tabpanel" hidden></section>
      </article>`;

    $('#m-title').value = m.title;
    $('#m-title').addEventListener('change', saveTitle);
    $('#m-title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
    });
    $('#m-notes').value = m.notes || '';
    $('#m-notes').addEventListener('input', scheduleNotesSave);
    $('#m-notes').addEventListener('blur', flushNotes);

    renderMeta();
    renderTabs();
    renderPlayer();
    renderTranscriptPanel();
    renderSummaryPanel();
  }

  async function refreshMeeting() {
    if (!state.selectedId) return;
    const m = await api.meetings.get(state.selectedId).catch(() => null);
    if (!m) {
      state.selectedId = null;
      state.meeting = null;
      renderMeeting();
      return;
    }
    const firstRender = !$('#m-title');
    state.meeting = { ...m, notes: pendingNotes?.id === m.id ? pendingNotes.notes : m.notes };
    if (firstRender) return renderMeeting();
    if (document.activeElement !== $('#m-title')) $('#m-title').value = m.title;
    renderMeta();
    renderTabs();
    renderPlayer();
    renderTranscriptPanel();
    renderSummaryPanel();
  }

  function renderMeta() {
    const el = $('#m-meta');
    if (!el) return;
    const m = state.meeting;
    const live = state.recording?.id === m.id;
    const length = live ? 'gravando agora' : m.status === 'finalizing' ? 'salvando o áudio...' : fmtDuration(m.durationSec);
    el.textContent = [dayLabel(m.createdAt), timeLabel(m.createdAt), length, m.hasSystemAudio ? 'microfone + áudio do sistema' : 'só microfone'].join(' · ');
    const people = (m.calendarEvent?.attendees ?? []).filter((a) => !a.self).map((a) => a.name);
    const pe = $('#m-people');
    pe.hidden = people.length === 0;
    pe.textContent = people.length
      ? `Da Google Agenda · com ${people.slice(0, 6).join(', ')}${people.length > 6 ? ` e mais ${people.length - 6}` : ''}`
      : '';
  }

  function renderTabs() {
    const m = state.meeting;
    for (const name of ['notes', 'transcript', 'summary']) {
      const btn = $(`#tab-btn-${name}`);
      if (!btn) return;
      btn.setAttribute('aria-selected', String(state.tab === name));
      $(`#tab-${name}`).hidden = state.tab !== name;
    }
    const t = m.transcript?.status;
    const s = m.summary?.status;
    $('#tab-btn-transcript').textContent = t === 'done' ? 'Transcrição ✓' : t === 'queued' || t === 'running' ? 'Transcrição…' : 'Transcrição';
    $('#tab-btn-summary').textContent = s === 'done' ? 'Resumo ✓' : s === 'running' ? 'Resumo…' : 'Resumo';
  }

  function renderPlayer() {
    const el = $('#player');
    if (!el) return;
    const m = state.meeting;
    if (!m.audioUrl) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    const existing = el.querySelector('audio');
    if (existing && existing.dataset.src === m.audioUrl) return; // não interrompe quem está ouvindo
    el.innerHTML = '<audio controls preload="metadata"></audio><button class="btn small" data-action="export-audio">Exportar áudio</button>';
    const audio = el.querySelector('audio');
    audio.dataset.src = m.audioUrl;
    audio.src = m.audioUrl;
  }

  function renderTranscriptPanel() {
    const el = $('#tab-transcript');
    if (!el) return;
    const m = state.meeting;
    const t = m.transcript ?? {};

    if (state.recording?.id === m.id || m.status === 'recording') {
      el.innerHTML = '<div class="card center"><p class="muted">A transcrição fica disponível quando a gravação terminar.</p></div>';
      return;
    }
    if (m.status === 'finalizing') {
      el.innerHTML = '<div class="card center"><p class="muted">Salvando o áudio da reunião...</p></div>';
      return;
    }
    if (m.status === 'error') {
      el.innerHTML = `<div class="card"><div class="notice">Não foi possível salvar o áudio desta reunião: ${esc(m.error)}</div></div>`;
      return;
    }

    if (t.status === 'queued' || t.status === 'running') {
      const p = state.progress[m.id] ?? {};
      const pct = p.progress != null ? Math.round(p.progress * 100) : null;
      const stage = p.stage ?? (t.status === 'queued' ? 'Na fila...' : 'Transcrevendo...');
      const sub = [pct != null ? `${pct}%` : '', p.etaSec != null ? `faltam ~${fmtDuration(p.etaSec)}` : ''].filter(Boolean).join(' · ');
      el.innerHTML = `<div class="card">
          <div class="card-title">${esc(stage)}</div>
          <div class="progress"><i></i></div>
          <div class="card-sub">${esc(sub)}</div>
          <p class="hint">Você pode continuar usando o app (ou gravar outra reunião) enquanto isso.</p>
          <button class="btn" data-action="cancel-transcript">Cancelar</button>
        </div>`;
      const bar = el.querySelector('.progress i');
      if (pct == null) bar.parentElement.classList.add('indeterminate');
      else bar.style.width = `${pct}%`;
      return;
    }

    if (t.status === 'done' && m.segments) {
      const model = t.engineLabel ?? (t.engine === 'gemini' ? 'Gemini' : t.model ? 'Whisper (versão antiga)' : '');
      const rows = m.segments
        .map(
          (s) => `<div class="seg ${s.track === 'mic' ? 'me' : 'them'}">
            <button class="ts" data-t="${s.start}" title="Ouvir a partir daqui">${fmtClock(s.start)}</button>
            <div class="seg-body"><span class="speaker">${esc(s.speaker)}</span><p>${esc(s.text)}</p></div>
          </div>`
        )
        .join('');
      el.innerHTML = `<div class="toolbar">
          <span class="muted small">${m.segments.length} falas${model ? ` · ${esc(model)}` : ''}</span>
          <span class="spacer"></span>
          <button class="btn small" data-action="copy-transcript">Copiar</button>
          <button class="btn small" data-action="export-transcript">Exportar .txt</button>
          <button class="btn small" data-action="retranscribe">Transcrever de novo</button>
        </div>
        <div class="transcript">${rows || '<p class="muted">Nenhuma fala foi detectada no áudio.</p>'}</div>`;
      return;
    }

    const engine = state.settings.transcriber;
    const opt = state.aiOptions?.transcribers.find((o) => o.key === engine);
    const firstDownload = opt?.model && !opt.model.ready ? `Na primeira vez, baixa o modelo de transcrição (${opt.model.downloadMb} MB).` : '';
    el.innerHTML = `<div class="card center">
        ${t.status === 'error' ? `<div class="notice">${esc(t.error)}</div>` : ''}
        ${opt?.problem ? `<div class="notice">${esc(opt.problem)}</div>` : ''}
        <div class="card-title">Transcrever a reunião inteira</div>
        <p class="card-sub">Converte todo o áudio em texto, separando <strong>Você</strong> (microfone) e os
          <strong>Outros</strong> (áudio da chamada). Cada fala vem com o horário.</p>
        <p class="hint">Opção: <strong>${esc(opt?.label ?? engine)}</strong>. ${esc(ENGINE_INFO[engine] ?? '')} ${esc(firstDownload)}
          <button class="link-btn inline" data-action="open-settings">trocar</button></p>
        <div class="actions">
          <button class="btn primary" data-action="transcribe" ${opt?.problem ? 'disabled' : ''}>Transcrever</button>
          <button class="btn" data-action="transcribe-and-summarize" ${opt?.problem ? 'disabled' : ''}>Transcrever e resumir</button>
        </div>
      </div>`;
  }

  function renderSummaryPanel() {
    const el = $('#tab-summary');
    if (!el) return;
    const m = state.meeting;
    const s = m.summary ?? {};
    const t = m.transcript?.status;

    if (state.recording?.id === m.id || m.status === 'recording' || m.status === 'finalizing') {
      el.innerHTML = '<div class="card center"><p class="muted">O resumo fica disponível depois que a reunião for transcrita.</p></div>';
      return;
    }
    if (s.status === 'running') {
      el.innerHTML = `<div class="card">
          <div class="card-title">Gerando o resumo...</div>
          <div class="progress indeterminate"><i></i></div>
          <p class="hint">Costuma levar menos de um minuto.</p>
        </div>`;
      return;
    }
    if (s.status === 'done' && m.summaryData) {
      const d = m.summaryData;
      const list = (items) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
      const actions = d.action_items
        .map((a) => {
          const who = [a.owner, a.due].filter(Boolean).join(' · ');
          return `<li>${esc(a.task)}${who ? ` <span class="who">— ${esc(who)}</span>` : ''}</li>`;
        })
        .join('');
      const stale = m.transcript?.finishedAt && s.finishedAt && m.transcript.finishedAt > s.finishedAt;
      el.innerHTML = `<div class="toolbar">
          <span class="muted small">Gerado por ${esc(s.provider ?? 'Gemini')}${s.finishedAt ? ` em ${esc(new Date(s.finishedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}` : ''}</span>
          <span class="spacer"></span>
          <button class="btn small" data-action="copy-summary">Copiar</button>
          <button class="btn small" data-action="resummarize">Resumir de novo</button>
        </div>
        ${stale ? '<div class="notice">A transcrição mudou depois deste resumo. Clique em Resumir de novo para atualizar.</div>' : ''}
        <div class="summary">
          <section><h3>Resumo</h3><p>${esc(d.summary)}</p></section>
          ${d.decisions.length ? `<section><h3>Decisões</h3>${list(d.decisions)}</section>` : ''}
          ${actions ? `<section><h3>Próximos passos</h3><ul>${actions}</ul></section>` : ''}
          ${
            d.topics.length
              ? `<section><h3>Tópicos</h3>${d.topics.map((tp) => `<h4>${esc(tp.title)}</h4>${list(tp.points)}`).join('')}</section>`
              : ''
          }
        </div>`;
      return;
    }

    if (state.aiOptions && !state.aiOptions.currentSummarizer) {
      el.innerHTML = `<div class="card center">
          <div class="card-title">Escolha quem faz o resumo</div>
          <p class="card-sub">Para resumir, conecte uma chave de IA (Gemini, OpenAI ou Claude) em Configurações, ou instale o
            Ollama para resumir no seu computador, sem custo.</p>
          <div class="actions"><button class="btn primary" data-action="open-settings">Abrir Configurações</button></div>
        </div>`;
      return;
    }
    const error = s.status === 'error' ? `<div class="notice">${esc(s.error)}</div>` : '';
    if (t !== 'done') {
      const busy = t === 'queued' || t === 'running';
      el.innerHTML = `<div class="card center">
          ${error}
          <div class="card-title">Resumo da reunião</div>
          <p class="card-sub">O resumo é feito a partir da transcrição: resumo, decisões, próximos passos e tópicos.</p>
          <div class="actions">
            ${
              busy
                ? '<p class="hint">A transcrição está em andamento. Depois, é só clicar em Resumir aqui.</p>'
                : '<button class="btn primary" data-action="transcribe-and-summarize">Transcrever e resumir</button>'
            }
          </div>
        </div>`;
      return;
    }
    el.innerHTML = `<div class="card center">
        ${error}
        <div class="card-title">Resumir a reunião</div>
        <p class="card-sub">Lê a transcrição e as suas anotações e devolve resumo, decisões, próximos passos com responsáveis
          e os tópicos discutidos.</p>
        <p class="hint">Vai usar: <strong>${esc(state.aiOptions?.currentSummarizer ?? '')}</strong>
          <button class="link-btn inline" data-action="open-settings">trocar</button></p>
        <div class="actions"><button class="btn primary" data-action="summarize">Resumir</button></div>
      </div>`;
  }

  // ------------------------------------------------------------ anotações e título
  function scheduleNotesSave() {
    pendingNotes = { id: state.selectedId, notes: $('#m-notes').value };
    clearTimeout(notesTimer);
    notesTimer = setTimeout(flushNotes, 700);
  }

  async function flushNotes() {
    clearTimeout(notesTimer);
    const pending = pendingNotes;
    pendingNotes = null;
    if (!pending) return;
    try {
      await api.meetings.update(pending.id, { notes: pending.notes });
      if (state.meeting?.id === pending.id) state.meeting.notes = pending.notes;
    } catch (err) {
      toast(`Não consegui salvar as anotações: ${err.message}`, 'error', 0);
    }
  }

  async function saveTitle() {
    const id = state.selectedId;
    try {
      const meta = await api.meetings.update(id, { title: $('#m-title').value });
      if (state.meeting?.id === id) {
        state.meeting.title = meta.title;
        $('#m-title').value = meta.title;
      }
      await loadList();
    } catch (err) {
      toast(`Não consegui salvar o título: ${err.message}`, 'error', 0);
    }
  }

  // ------------------------------------------------------------ gravação
  function updateNewButton() {
    const btn = $('#new-meeting');
    const busy = Boolean(state.recording) || state.starting;
    btn.disabled = busy;
    btn.innerHTML = state.recording
      ? '<span class="rec-dot"></span> Gravando...'
      : state.starting
        ? 'Iniciando...'
        : '<span class="plus">+</span> Nova reunião';
  }

  /** eventId (opcional): compromisso da Google Agenda; o título e os participantes vêm dele. */
  async function startRecording(eventId = null) {
    if (state.recording || state.starting) return;
    state.starting = true;
    updateNewButton();
    let capture = null;
    try {
      capture = await MNRecorder.startCapture();
      const meta = await api.recording.start({ hasSystemAudio: capture.hasSystemAudio, eventId });
      capture.start((track, bytes) => api.recording.chunk(meta.id, track, bytes));
      state.recording = { id: meta.id, startedAt: Date.now(), capture, stopping: false };

      capture.onSystemEnded(() =>
        toast('O áudio do sistema parou de ser capturado (o dispositivo de som mudou?). O microfone continua gravando.', 'warn', 0)
      );
      if (!capture.hasSystemAudio) toast('Gravando só o microfone: não consegui capturar o áudio do sistema.', 'warn', 0);
      if (!capture.hasMic) toast('Gravando só o áudio do sistema: o microfone não está disponível.', 'warn', 0);

      document.title = '● Gravando — XMeeting Notes';
      tickTimer = setInterval(tick, 120);
      state.tab = 'notes';
      renderRecBar();
      await loadList();
      await openMeeting(meta.id);
      $('#m-notes')?.focus();
    } catch (err) {
      if (capture) await capture.stop().catch(() => {});
      state.recording = null;
      toast(err.message, 'error', 0);
    } finally {
      state.starting = false;
      updateNewButton();
    }
  }

  async function stopRecording() {
    const r = state.recording;
    if (!r || r.stopping) return;
    r.stopping = true;
    const stopBtn = $('#rec-bar [data-rec="stop"]');
    if (stopBtn) {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Salvando...';
    }
    await flushNotes();
    try {
      await r.capture.stop();
    } catch (err) {
      console.error(err);
    }
    clearInterval(tickTimer);
    try {
      await api.recording.stop(r.id);
    } catch (err) {
      toast(`Erro ao salvar a gravação: ${err.message}`, 'error', 0);
    }
    state.recording = null;
    document.title = 'XMeeting Notes';
    renderRecBar();
    updateNewButton();
    await loadList();
    if (state.selectedId === r.id) await refreshMeeting();
    if (!state.selectedId) renderAgenda(); // libera de novo os botões "Gravar"
    toast('Reunião salva. Para ter o texto e o resumo, abra a aba Transcrição ou Resumo.');
    if (!state.user) showLogin('Sua sessão terminou. Entre de novo para transcrever e resumir.');
  }

  function renderRecBar() {
    const bar = $('#rec-bar');
    const r = state.recording;
    if (!r) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    const meter = (name, label) =>
      r.capture.trackNames.includes(name)
        ? `<span class="meter" title="${label}"><span class="meter-label">${label}</span><span class="meter-bar"><i data-level="${name}"></i></span></span>`
        : `<span class="meter off">${label}: sem áudio</span>`;
    bar.innerHTML = `
      <span class="rec-dot"></span>
      <span class="rec-time" id="rec-time">00:00</span>
      ${meter('mic', 'Você')}
      ${meter('system', 'Outros')}
      <span id="rec-hint" class="rec-hint" hidden>sem som do sistema: o Windows está no mudo?</span>
      <button class="btn small" data-rec="open">Abrir notas</button>
      <button class="btn small stop" data-rec="stop">■ Parar</button>`;
    bar.hidden = false;
  }

  function tick() {
    const r = state.recording;
    if (!r) return;
    const time = $('#rec-time');
    if (time) time.textContent = fmtClock((Date.now() - r.startedAt) / 1000);
    const levels = r.capture.levels();
    for (const [name, level] of Object.entries(levels)) {
      const el = document.querySelector(`[data-level="${name}"]`);
      if (el) el.style.width = `${Math.min(100, Math.sqrt(level) * 260)}%`;
    }
    // Com o Windows no mudo, o áudio do sistema chega como silêncio absoluto: avisa em vez de gravar metade da reunião.
    if ((levels.system ?? 0) > 0.0005) r.systemSignalSeen = true;
    const hint = $('#rec-hint');
    if (hint) hint.hidden = !(r.capture.hasSystemAudio && !r.systemSignalSeen && Date.now() - r.startedAt > 20_000);
  }

  // ------------------------------------------------------------ configurações
  // ------------------------------------------------------------ configurações: transcrição, resumo, chaves
  const ENGINE_INFO = {
    'local-fast': 'No seu computador, sem custo e sem enviar nada. Transcreve 1 h de reunião em poucos minutos. Pode errar mais nomes e palavras difíceis.',
    'local-quality':
      'No seu computador, sem custo e sem enviar nada. Erra menos, mas demora bem mais: cerca de metade da duração da reunião num computador recente, e mais em computadores antigos. Recomendado quando a precisão importa.',
    gemini: 'Na nuvem do Google: rápida e precisa, e pode separar os participantes da chamada. Só os trechos com fala são enviados, e apagados de lá depois.',
    openai: 'Na nuvem da OpenAI: rápida e precisa. Só os trechos com fala são enviados. Custa cerca de US$ 0,27 por hora de reunião, na conta da chave.',
  };
  const KEY_INFO = {
    gemini: {
      placeholder: 'Cole a chave do Gemini',
      link: 'Criar chave no Google AI Studio ↗',
      note: 'Transcreve e resume. Há uma cota gratuita (nela o Google pode usar o conteúdo enviado). O plano pessoal Google AI Pro inclui US$ 10 por mês de crédito de API.',
    },
    openai: {
      placeholder: 'Cole a chave da OpenAI (sk-...)',
      link: 'Criar chave na OpenAI ↗',
      note: 'Transcreve e resume. A assinatura do ChatGPT não inclui a API: o uso é pago à parte, com créditos na conta da OpenAI.',
    },
    claude: {
      placeholder: 'Cole a chave do Claude (sk-ant-...)',
      link: 'Criar chave no Console da Anthropic ↗',
      note: 'Só resume: a API do Claude não recebe áudio. O Claude Pro não inclui a API; os planos Max e Team incluem créditos mensais, resgatados em claude.ai, em Configurações > Faturamento.',
    },
  };

  async function refreshAi() {
    [state.ai, state.aiOptions] = await Promise.all([api.ai.status(), api.ai.options()]);
    if ($('#settings').open) renderAiSettings();
    if (state.meeting) {
      renderTranscriptPanel();
      renderSummaryPanel();
    }
  }

  function fillSettings() {
    const s = state.settings;
    $('#set-language').innerHTML = Object.entries(s.languages)
      .map(([key, label]) => `<option value="${key}">${esc(label)}</option>`)
      .join('');
    $('#set-language').value = s.language;
    $('#set-notify').checked = Boolean(s.notifyMeetings);
    api.settings.loginItem().then(({ available, enabled }) => {
      $('#set-login-row').hidden = !available; // só no app instalado (Windows e macOS)
      $('#set-login').checked = enabled;
    });
    $('#set-account').textContent = state.user?.email ?? '';
    $('#set-account-type').textContent = state.user?.domain ? `conta empresarial · ${state.user.domain}` : 'conta pessoal';
    renderAiSettings();
    refreshAi(); // atualiza as opções (Ollama aberto, modelos baixados) com a janela aberta
  }

  function renderAiSettings() {
    const s = state.settings;
    const opts = state.aiOptions;
    const ai = state.ai;
    if (!opts || !ai) return;

    // Transcrição: as quatro opções, cada uma com o seu aviso
    $('#set-transcribers').innerHTML = opts.transcribers
      .map((t) => {
        const status = t.model
          ? t.model.ready
            ? '<div class="choice-status ok">Pronto no computador</div>'
            : `<div class="choice-status">Na primeira vez, baixa o modelo (${t.model.downloadMb} MB)</div>`
          : t.problem
            ? '<div class="choice-status warn">Precisa da chave em "Chaves de IA", abaixo</div>'
            : '<div class="choice-status ok">Chave conectada</div>';
        const diarize =
          t.key === 'gemini'
            ? `<label class="check"><input type="checkbox" data-setting="diarize" ${s.diarize ? 'checked' : ''}>
                 <span>Separar os participantes da chamada (experimental: com 3 ou mais pessoas pode trocar quem falou)</span></label>`
            : '';
        return `<label class="choice${t.problem ? ' disabled' : ''}">
            <input type="radio" name="transcriber" value="${t.key}" ${s.transcriber === t.key ? 'checked' : ''} ${t.problem ? 'disabled' : ''}>
            <span>
              <div class="choice-title">${esc(t.label)}${t.key === 'local-fast' ? ' <span class="badge">padrão</span>' : ''}</div>
              <div class="choice-desc">${esc(ENGINE_INFO[t.key] ?? '')}</div>
              ${status}${diarize}
            </span>
          </label>`;
      })
      .join('');

    // Resumo
    $('#set-summarizer').innerHTML = opts.summarizers
      .map((o) => `<option value="${o.key}" ${o.available || o.key === 'auto' ? '' : 'disabled'}>${esc(o.label)}${o.available || o.key === 'auto' ? '' : ' (indisponível)'}</option>`)
      .join('');
    $('#set-summarizer').value = s.summarizer;
    $('#set-summarizer-hint').textContent = opts.currentSummarizer
      ? `Vai resumir com: ${opts.currentSummarizer}.${s.summarizer === 'auto' ? ' No Automático, usa a primeira disponível: plano da empresa, Gemini, Claude, OpenAI e, por último, o Ollama.' : ''}`
      : 'Nenhuma IA disponível para resumir: conecte uma chave abaixo ou instale o Ollama.';
    $('#set-ollama-row').hidden = opts.ollamaModels.length === 0;
    $('#set-ollama-model').innerHTML = opts.ollamaModels.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    if (opts.ollamaModels.length) $('#set-ollama-model').value = opts.ollamaModels.includes(s.ollamaModel) ? s.ollamaModel : opts.ollamaModels[0];

    // Chaves de IA
    $('#set-company').hidden = !ai.company;
    $('#set-company').textContent = ai.company
      ? `Sua conta faz parte do plano da empresa (${ai.domain}): o Gemini já está liberado, sem chave.`
      : '';
    $('#set-keys').innerHTML = Object.entries(ai.providers)
      .map(([key, p]) => {
        const hint = ai.keys[key];
        const info = KEY_INFO[key];
        return `<div class="key-item" data-provider="${key}">
            <div class="key-head">
              <strong>${esc(p.label)}</strong>
              <span class="spacer"></span>
              ${hint ? `<span class="badge ok">conectada ${esc(hint)}</span><button type="button" class="btn small" data-key-remove>Remover</button>` : ''}
            </div>
            ${
              hint
                ? ''
                : `<div class="key-row"><input class="key-input" type="password" autocomplete="off" spellcheck="false" data-key-input placeholder="${esc(info.placeholder)}">
                   <button type="button" class="btn small primary" data-key-save>Conectar</button></div>`
            }
            <div class="notice small" data-key-error hidden></div>
            <p class="hint">${esc(info.note)} <button type="button" class="link-btn inline" data-open-page="${key}">${esc(info.link)}</button></p>
          </div>`;
      })
      .join('');
  }

  async function saveKey(provider) {
    const item = $(`#set-keys [data-provider="${provider}"]`);
    const btn = item.querySelector('[data-key-save]');
    const error = item.querySelector('[data-key-error]');
    btn.disabled = true;
    btn.textContent = 'Conferindo...';
    error.hidden = true;
    try {
      await api.ai.setKey(provider, item.querySelector('[data-key-input]').value);
      await refreshAi();
      toast(`Chave do ${state.ai.providers[provider].label} conectada.`);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Conectar';
    }
  }

  async function settingsClick(e) {
    const page = e.target.closest('[data-open-page]');
    if (page) return api.ai.openPage(page.dataset.openPage);
    const item = e.target.closest('[data-provider]');
    if (!item) return;
    const provider = item.dataset.provider;
    if (e.target.closest('[data-key-save]')) return saveKey(provider);
    if (e.target.closest('[data-key-remove]')) {
      if (!confirm(`Remover a chave do ${state.ai.providers[provider].label} deste computador?`)) return;
      await api.ai.removeKey(provider);
      await refreshAi();
    }
  }

  async function settingsChange(e) {
    const t = e.target;
    if (t.name === 'transcriber') await changeSetting({ transcriber: t.value });
    else if (t.dataset.setting === 'diarize') await changeSetting({ diarize: t.checked });
    else if (t.id === 'set-summarizer') await changeSetting({ summarizer: t.value });
    else if (t.id === 'set-ollama-model') await changeSetting({ ollamaModel: t.value });
    else return;
    await refreshAi();
  }

  async function changeSetting(patch) {
    try {
      state.settings = await api.settings.set(patch);
    } catch (err) {
      toast(err.message, 'error', 0);
    }
  }

  // ------------------------------------------------------------ login
  function showLogin(error = null) {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-btn').hidden = false;
    $('#login-btn').disabled = false;
    $('#login-wait').hidden = true;
    $('#login-error').hidden = !error;
    $('#login-error').textContent = error ?? '';
  }

  async function showApp(user) {
    state.user = user;
    await refreshAi();
    $('#account-label').textContent = user.email;
    $('#login').hidden = true;
    $('#app').hidden = false;
    updateNewButton();
    await loadList();
    renderMeeting();
    loadAgenda();
  }

  async function doLogin() {
    $('#login-btn').disabled = true;
    $('#login-error').hidden = true;
    $('#login-wait').hidden = false;
    try {
      const user = await api.auth.login();
      await showApp(user);
    } catch (err) {
      showLogin(err.message === 'Login cancelado.' ? null : err.message);
    }
  }

  async function doLogout() {
    if (!confirm('Sair da conta? As reuniões gravadas continuam neste computador.')) return;
    try {
      await api.auth.logout();
      $('#settings').close();
    } catch (err) {
      toast(err.message, 'error', 0);
    }
  }

  // ------------------------------------------------------------ eventos da interface
  $('#new-meeting').addEventListener('click', () => startRecording()); // sem passar o clique como eventId
  $('#search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderList();
  });
  $('#list').addEventListener('click', (e) => {
    const item = e.target.closest('.list-item');
    if (item) openMeeting(item.dataset.id);
  });
  $('#open-settings').addEventListener('click', () => {
    fillSettings();
    $('#settings').showModal();
  });
  $('#set-language').addEventListener('change', (e) => changeSetting({ language: e.target.value }));
  $('#set-notify').addEventListener('change', (e) => changeSetting({ notifyMeetings: e.target.checked }));
  $('#set-login').addEventListener('change', async (e) => {
    const { enabled } = await api.settings.setLoginItem(e.target.checked);
    e.target.checked = enabled;
  });
  $('#open-agenda').addEventListener('click', async () => {
    await flushNotes();
    state.selectedId = null;
    state.meeting = null;
    renderMeeting();
    renderList();
    loadAgenda();
  });
  // A agenda se atualiza sozinha a cada 5 min enquanto está na tela.
  setInterval(() => {
    if (state.user && !state.selectedId) loadAgenda();
  }, 5 * 60_000);
  $('#open-data').addEventListener('click', () => api.openDataFolder());
  $('#logout').addEventListener('click', doLogout);
  $('#settings').addEventListener('click', settingsClick);
  $('#settings').addEventListener('change', settingsChange);
  $('#settings').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('[data-key-input]')) return;
    e.preventDefault(); // não fecha o diálogo
    saveKey(e.target.closest('[data-provider]').dataset.provider);
  });
  $('#login-btn').addEventListener('click', doLogin);
  $('#login-cancel').addEventListener('click', () => api.auth.cancel());

  $('#rec-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rec]');
    if (!btn || !state.recording) return;
    if (btn.dataset.rec === 'stop') stopRecording();
    if (btn.dataset.rec === 'open') {
      state.tab = 'notes';
      openMeeting(state.recording.id);
    }
  });

  $('#main').addEventListener('click', async (e) => {
    const ts = e.target.closest('.ts');
    if (ts) {
      const audio = $('#player audio');
      if (audio) {
        audio.currentTime = Number(ts.dataset.t);
        audio.play();
      }
      return;
    }
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      state.tab = tab.dataset.tab;
      renderTabs();
      return;
    }
    const btn = e.target.closest('[data-action]');
    const m = state.meeting;
    if (btn?.dataset.action.startsWith('calendar-') || btn?.dataset.action === 'agenda-refresh') {
      try {
        switch (btn.dataset.action) {
          case 'calendar-connect':
            btn.disabled = true;
            btn.textContent = 'Conclua no navegador...';
            await api.calendar.connect();
            state.user = (await api.auth.get()).user ?? state.user;
            await loadAgenda({ refresh: true });
            break;
          case 'agenda-refresh':
            await loadAgenda({ refresh: true });
            break;
          case 'calendar-join':
            await api.calendar.join(btn.dataset.event);
            break;
          case 'calendar-record':
            await startRecording(btn.dataset.event);
            break;
        }
      } catch (err) {
        toast(err.message === 'Login cancelado.' ? 'A conexão com a agenda foi cancelada.' : err.message, 'error', 0);
        if (!state.selectedId) renderAgenda();
      }
      return;
    }
    if (!btn || !m) return;
    try {
      switch (btn.dataset.action) {
        case 'transcribe':
          delete state.progress[m.id];
          await api.transcript.start(m.id);
          break;
        case 'transcribe-and-summarize':
          delete state.progress[m.id];
          await api.transcript.start(m.id, { thenSummarize: true });
          break;
        case 'retranscribe':
          if (!confirm('Transcrever de novo? A transcrição atual é substituída quando a nova terminar.')) return;
          delete state.progress[m.id];
          await api.transcript.start(m.id);
          break;
        case 'summarize':
          await api.summary.start(m.id);
          break;
        case 'resummarize':
          if (!confirm('Resumir de novo? O resumo atual é substituído pelo novo.')) return;
          await api.summary.start(m.id);
          break;
        case 'copy-summary':
          await api.summary.copy(m.id);
          toast('Resumo copiado.');
          break;
        case 'open-settings':
          fillSettings();
          $('#settings').showModal();
          break;
        case 'cancel-transcript':
          await api.transcript.cancel(m.id);
          break;
        case 'copy-transcript':
          await api.transcript.copy(m.id);
          toast('Transcrição copiada.');
          break;
        case 'export-transcript':
          if (await api.transcript.export(m.id)) toast('Transcrição exportada.');
          break;
        case 'export-audio':
          if (await api.exportAudio(m.id)) toast('Áudio exportado.');
          break;
        case 'open-folder':
          await api.openFolder(m.id);
          break;
        case 'delete':
          if (!confirm(`Excluir "${m.title}"?\n\nO áudio, a transcrição e as anotações serão apagados. Não dá para desfazer.`)) return;
          await api.meetings.remove(m.id);
          state.selectedId = null;
          state.meeting = null;
          renderMeeting();
          await loadList();
          break;
      }
    } catch (err) {
      toast(err.message, 'error', 0);
    }
  });

  // ------------------------------------------------------------ eventos do processo principal
  api.on('meetings:changed', async () => {
    await loadList();
    await refreshMeeting();
  });
  api.on('transcript:progress', (p) => {
    state.progress[p.id] = { ...(state.progress[p.id] ?? {}), ...p };
    if (p.id === state.selectedId && ['queued', 'running'].includes(state.meeting?.transcript?.status)) renderTranscriptPanel();
  });
  api.on('transcript:done', ({ id }) => {
    delete state.progress[id];
    const m = state.meetings.find((x) => x.id === id);
    toast(`Transcrição pronta${m ? `: ${m.title}` : ''}.`);
  });
  api.on('transcript:error', ({ id, error }) => {
    delete state.progress[id];
    toast(`A transcrição falhou: ${error}`, 'error', 0);
  });
  api.on('summary:done', ({ id }) => {
    const m = state.meetings.find((x) => x.id === id);
    toast(`Resumo pronto${m ? `: ${m.title}` : ''}.`);
  });
  api.on('summary:error', ({ error }) => toast(`O resumo falhou: ${error}`, 'error', 0));
  api.on('auth:changed', (user) => {
    if (user) return;
    state.user = null;
    // Sessão encerrada no meio de uma gravação: a gravação continua e é salva normalmente.
    if (state.recording) toast('Sua sessão do Google expirou. Termine a gravação e entre de novo.', 'warn', 0);
    else showLogin('Sua sessão terminou. Entre de novo para continuar.');
  });
  api.on('recording:force-stop', () => stopRecording());

  // Chamados pelo processo principal "como um clique" (aviso de reunião, ícone da barra):
  // o Chromium só libera a captura do áudio do sistema com um gesto do usuário.
  window.__record = async (eventId) => {
    await ready;
    if (state.user) await startRecording(eventId ?? null);
  };
  window.__stop = async () => {
    await ready;
    await stopRecording();
  };

  window.addEventListener('beforeunload', () => {
    if (pendingNotes) flushNotes();
  });

  // ------------------------------------------------------------ início
  async function init() {
    state.settings = await api.settings.get();
    const auth = await api.auth.get();
    if (auth.problem) {
      showLogin(`O app não está configurado. ${auth.problem}`);
      $('#login-btn').hidden = true;
      return;
    }
    if (auth.user) await showApp(auth.user);
    else showLogin();
  }
  const ready = init().catch((err) => toast(`Erro ao iniciar: ${err.message}`, 'error', 0));

  // Usados pela automação de desenvolvimento (electron/dev.js)
  window.__open = async (id, tab) => {
    await ready;
    state.tab = tab;
    await openMeeting(id);
  };
  window.__settings = async () => {
    await ready;
    fillSettings();
    $('#settings').showModal();
  };
  window.__selftest = async (seconds) => {
    await ready;
    await startRecording();
    const r = state.recording;
    if (!r) return null;
    const info = { id: r.id, hasSystemAudio: r.capture.hasSystemAudio, systemError: r.capture.systemError, micError: r.capture.micError };
    // Pico de volume por segundo, para ver se cada trilha recebeu som de verdade.
    const perSecond = { mic: [], system: [] };
    const sampler = setInterval(() => {
      const sec = Math.floor((Date.now() - r.startedAt) / 1000);
      for (const [name, level] of Object.entries(r.capture.levels())) {
        perSecond[name][sec] = Math.max(perSecond[name][sec] ?? 0, Number(level.toFixed(3)));
      }
    }, 100);
    // Bipe curto tocado pelo próprio app aos 3 s: sai no dispositivo padrão e deve aparecer em "system".
    setTimeout(() => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.08;
      osc.frequency.value = 660;
      osc.connect(gain).connect(ctx.destination);
      osc.onended = () => ctx.close();
      osc.start();
      osc.stop(ctx.currentTime + 1.5);
    }, 3000);
    const stopProbe = r.capture.startRawSystemProbe();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    clearInterval(sampler);
    info.rawSystemBytes = stopProbe ? await stopProbe() : null;
    info.systemDiagnostics = r.capture.systemDiagnostics();
    info.perSecond = perSecond;
    await stopRecording();
    return info;
  };
})();
