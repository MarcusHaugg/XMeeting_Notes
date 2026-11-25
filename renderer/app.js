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
      const badge = live
        ? '<span class="badge live">gravando</span>'
        : t === 'done'
          ? '<span class="badge ok">transcrita</span>'
          : t === 'queued' || t === 'running'
            ? '<span class="badge busy">transcrevendo</span>'
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

  // ------------------------------------------------------------ reunião aberta
  const EMPTY = `<div class="empty">
      <svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-2.07A7 7 0 0 0 19 12h-2Z"/></svg>
      <h1>Grave sua próxima reunião</h1>
      <p>Quando entrar na chamada (Teams, Meet, Zoom...), clique em <strong>Nova reunião</strong>.
        O app grava o seu microfone e o som da chamada, e você pode tomar notas enquanto isso.</p>
      <p>Depois, se quiser, transcreva a reunião inteira: roda no seu PC e nada é enviado para a internet.</p>
      <ul class="tips">
        <li>Use fones de ouvido, para a sua voz não se misturar com a dos outros.</li>
        <li>Teams, Meet e Zoom devem usar os dispositivos de som padrão do Windows.</li>
      </ul>
    </div>`;

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
    if (!m) {
      main.innerHTML = EMPTY;
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
          <div id="player" class="player" hidden></div>
        </header>
        <div class="tabs" role="tablist">
          <button role="tab" id="tab-btn-notes" data-tab="notes">Anotações</button>
          <button role="tab" id="tab-btn-transcript" data-tab="transcript">Transcrição</button>
        </div>
        <section id="tab-notes" class="tab-panel" role="tabpanel">
          <textarea id="m-notes" class="notes" placeholder="Escreva suas anotações aqui. Elas são salvas automaticamente."></textarea>
        </section>
        <section id="tab-transcript" class="tab-panel" role="tabpanel" hidden></section>
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
  }

  function renderMeta() {
    const el = $('#m-meta');
    if (!el) return;
    const m = state.meeting;
    const live = state.recording?.id === m.id;
    const length = live ? 'gravando agora' : m.status === 'finalizing' ? 'salvando o áudio...' : fmtDuration(m.durationSec);
    el.textContent = [dayLabel(m.createdAt), timeLabel(m.createdAt), length, m.hasSystemAudio ? 'microfone + áudio do sistema' : 'só microfone'].join(' · ');
  }

  function renderTabs() {
    const m = state.meeting;
    for (const name of ['notes', 'transcript']) {
      const btn = $(`#tab-btn-${name}`);
      if (!btn) return;
      btn.setAttribute('aria-selected', String(state.tab === name));
      $(`#tab-${name}`).hidden = state.tab !== name;
    }
    const t = m.transcript?.status;
    $('#tab-btn-transcript').textContent = t === 'done' ? 'Transcrição ✓' : t === 'queued' || t === 'running' ? 'Transcrição…' : 'Transcrição';
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
      const model = state.settings?.models?.[t.model]?.label ?? t.model ?? '';
      const rows = m.segments
        .map(
          (s) => `<div class="seg ${s.track === 'mic' ? 'me' : 'them'}">
            <button class="ts" data-t="${s.start}" title="Ouvir a partir daqui">${fmtClock(s.start)}</button>
            <div class="seg-body"><span class="speaker">${esc(s.speaker)}</span><p>${esc(s.text)}</p></div>
          </div>`
        )
        .join('');
      el.innerHTML = `<div class="toolbar">
          <span class="muted small">${m.segments.length} falas${model ? ` · modelo ${esc(model)}` : ''}</span>
          <span class="spacer"></span>
          <button class="btn small" data-action="copy-transcript">Copiar</button>
          <button class="btn small" data-action="export-transcript">Exportar .txt</button>
          <button class="btn small" data-action="retranscribe">Transcrever de novo</button>
        </div>
        <div class="transcript">${rows || '<p class="muted">Nenhuma fala foi detectada no áudio.</p>'}</div>`;
      return;
    }

    const info = state.settings.models[state.settings.model];
    const estimate = Math.max(1, Math.round((m.durationSec * 0.75 * info.factor) / 60));
    el.innerHTML = `<div class="card center">
        ${t.status === 'error' ? `<div class="notice">${esc(t.error)}</div>` : ''}
        <div class="card-title">Transcrever a reunião inteira</div>
        <p class="card-sub">Converte todo o áudio em texto, separando <strong>Você</strong> (microfone) e
          <strong>Outros</strong> (áudio do sistema). Roda no seu PC: nada é enviado para a internet.</p>
        <p class="hint">Estimativa: cerca de ${estimate} min com o modelo ${esc(info.label)}.</p>
        <button class="btn primary" data-action="transcribe">Transcrever</button>
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

  async function startRecording() {
    if (state.recording || state.starting) return;
    state.starting = true;
    updateNewButton();
    let capture = null;
    try {
      capture = await MNRecorder.startCapture();
      const meta = await api.recording.start({ hasSystemAudio: capture.hasSystemAudio });
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
    toast('Reunião salva. Para ter o texto completo, abra a aba Transcrição.');
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
  function fillSettings() {
    const s = state.settings;
    $('#set-model').innerHTML = Object.entries(s.models)
      .map(([key, m]) => `<option value="${key}">${esc(m.label)}${key === 'turbo' ? ' (recomendado)' : ''}</option>`)
      .join('');
    $('#set-model').value = s.model;
    $('#set-language').innerHTML = Object.entries(s.languages)
      .map(([key, label]) => `<option value="${key}">${esc(label)}</option>`)
      .join('');
    $('#set-language').value = s.language;
  }

  async function changeSetting(patch) {
    try {
      state.settings = await api.settings.set(patch);
      if (state.meeting) renderTranscriptPanel();
    } catch (err) {
      toast(err.message, 'error', 0);
    }
  }

  // ------------------------------------------------------------ eventos da interface
  $('#new-meeting').addEventListener('click', startRecording);
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
  $('#set-model').addEventListener('change', (e) => changeSetting({ model: e.target.value }));
  $('#set-language').addEventListener('change', (e) => changeSetting({ language: e.target.value }));
  $('#open-data').addEventListener('click', () => api.openDataFolder());

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
    if (!btn || !m) return;
    try {
      switch (btn.dataset.action) {
        case 'transcribe':
          delete state.progress[m.id];
          await api.transcript.start(m.id);
          break;
        case 'retranscribe':
          if (!confirm('Transcrever de novo? A transcrição atual é substituída quando a nova terminar.')) return;
          delete state.progress[m.id];
          await api.transcript.start(m.id);
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
  api.on('recording:force-stop', () => stopRecording());

  window.addEventListener('beforeunload', () => {
    if (pendingNotes) flushNotes();
  });

  // ------------------------------------------------------------ início
  async function init() {
    state.settings = await api.settings.get();
    updateNewButton();
    await loadList();
    renderMeeting();
  }
  const ready = init().catch((err) => toast(`Erro ao iniciar: ${err.message}`, 'error', 0));

  // Usados pela automação de desenvolvimento (electron/dev.js)
  window.__open = async (id, tab) => {
    await ready;
    state.tab = tab;
    await openMeeting(id);
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
