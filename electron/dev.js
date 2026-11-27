// Automação para desenvolvimento (só carregada com --selftest, --demo ou --screenshot).
//   --selftest=N     grava N segundos de verdade (microfone + sistema) e transcreve (precisa de login)
//   --demo=ID        processa uma reunião já existente na pasta de dados
//   --no-transcribe  pula a transcrição
//   --screenshot=DIR salva capturas de tela da interface (sozinho: só a tela inicial;
//                    com --open=ID: as abas de transcrição e resumo dessa reunião)
//   --settings       com --screenshot: captura também a janela de Configurações
//   --fake-user=EMAIL  só com --screenshot: mostra a interface logada, sem sessão real
//                    (@gmail.com = conta pessoal; outro domínio = conta empresarial), com uma
//                    agenda de exemplo; --fake-no-calendar mostra a agenda ainda não conectada
//   --check-update   com --screenshot: procura atualização antes das capturas (só no app empacotado)
//   --auto-record-test com --screenshot e --fake-user: liga "gravar sozinho" e confere que a reunião
//                    falsa que começa em 20 s é gravada sem clique; depois para
//   --keep           não apaga a reunião de teste no final
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { transcriptToText } from './speech.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(id, isDone, interval = 500) {
  let meta = await store.getMeta(id);
  while (!isDone(meta)) {
    await sleep(interval);
    meta = await store.getMeta(id);
  }
  return meta;
}

export async function run({ app, win, transcriber, setQuitting }) {
  const has = (name) => app.commandLine.hasSwitch(name);
  const value = (name) => app.commandLine.getSwitchValue(name);
  const shotDir = value('screenshot') || null;
  const demo = has('demo');

  if (win.webContents.isLoadingMainFrame()) await new Promise((r) => win.webContents.once('did-finish-load', r));

  const shot = async (name) => {
    if (!shotDir) return;
    await sleep(700);
    const image = await win.webContents.capturePage();
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(shotDir, name), image.toPNG());
    console.log(`[dev] captura de tela: ${name}`);
  };

  if (has('auto-record-test')) {
    const { updateSettings } = await import('./settings.js');
    updateSettings({ autoRecordMeetings: true });
    win.hide(); // como no dia a dia: app só no ícone da barra, janela fechada
    console.log('[dev] gravar sozinho ligado, janela escondida; esperando a reunião começar...');
    const started = Date.now();
    let rec = null;
    while (!rec && Date.now() - started < 90_000) {
      await sleep(1000);
      rec = (await store.list()).find((m) => m.status === 'recording');
    }
    if (!rec) throw new Error('não começou a gravar sozinho');
    console.log(`[dev] começou sozinho em ${((Date.now() - started) / 1000).toFixed(0)}s: "${rec.title}" janela visível=${win.isVisible()}`);
    await sleep(4000);
    win.show();
    await shot('gravando-sozinho.png');
    await win.webContents.executeJavaScript('window.__stop()', true);
    const meta = await waitFor(rec.id, (m) => m && m.status !== 'recording' && m.status !== 'finalizing');
    console.log(`[dev] parado: status=${meta.status} duração=${meta.durationSec}s evento=${meta.calendarEvent?.title ?? '-'} participantes=${(meta.calendarEvent?.attendees ?? []).length}`);
    if (!has('keep')) await store.remove(rec.id);
    setQuitting();
    app.exit(0);
    return;
  }

  if (!demo && !has('selftest')) {
    if (has('check-update')) {
      const { checkForUpdate } = await import('./updater.js');
      console.log('[dev] atualização:', JSON.stringify(await checkForUpdate()));
    }
    const open = value('open');
    if (open) {
      for (const tab of ['transcript', 'summary']) {
        await win.webContents.executeJavaScript(`window.__open(${JSON.stringify(open)}, ${JSON.stringify(tab)})`);
        await shot(`reuniao-${tab}.png`);
      }
    } else {
      await shot('inicio.png');
    }
    if (has('settings')) {
      await win.webContents.executeJavaScript('window.__settings()');
      await shot('configuracoes.png');
      await win.webContents.executeJavaScript("document.querySelector('#settings').scrollTop = 620");
      await shot('configuracoes-2.png');
      await win.webContents.executeJavaScript("document.querySelector('#settings').scrollTop = 99999");
      await shot('configuracoes-3.png');
    }
    setQuitting();
    app.exit(0);
    return;
  }

  let id;
  if (demo) {
    id = value('demo');
  } else {
    const seconds = Number(value('selftest')) || 20;
    console.log(`[selftest] gravando por ${seconds}s...`);
    const pending = win.webContents.executeJavaScript(`window.__selftest(${seconds})`, true);
    await sleep(Math.max(1000, (seconds - 3) * 1000)); // perto do fim, quando os avisos já apareceram
    await shot('gravando.png');
    const info = await pending;
    console.log('[selftest] captura:', JSON.stringify(info));
    id = info?.id;
    if (!id) throw new Error('a gravação não começou');
  }

  let meta = await waitFor(id, (m) => m && m.status !== 'recording' && m.status !== 'finalizing');
  console.log(`[dev] status=${meta.status} ${meta.error ?? ''} duração=${meta.durationSec}s áudioDoSistema=${meta.hasSystemAudio}`);
  for (const f of ['mic.webm', 'system.webm', 'audio.m4a']) {
    const p = path.join(store.dirOf(id), f);
    console.log(`[dev]   ${f}: ${fs.existsSync(p) ? `${(fs.statSync(p).size / 1024).toFixed(1)} KB` : 'não existe'}`);
  }

  if (meta.status === 'ready' && !has('no-transcribe')) {
    const t0 = Date.now();
    await transcriber.enqueue(id);
    meta = await waitFor(id, (m) => ['done', 'error'].includes(m.transcript?.status), 1000);
    const segments = (await store.get(id)).segments ?? [];
    console.log(`[dev] transcrição=${meta.transcript.status} em ${((Date.now() - t0) / 1000).toFixed(1)}s, ${segments.length} falas ${meta.transcript.error ?? ''}`);
    // Só imprime o texto no modo demo (áudio sintético); no autoteste o microfone pode ter captado o ambiente.
    if (demo && segments.length) console.log(transcriptToText(segments));
  }

  if (shotDir) {
    await win.webContents.executeJavaScript(`window.__open(${JSON.stringify(id)}, 'transcript')`);
    await shot('reuniao-transcricao.png');
    await win.webContents.executeJavaScript(`window.__open(${JSON.stringify(id)}, 'notes')`);
    await shot('reuniao-anotacoes.png');
  }

  if (!has('keep')) await store.remove(id);
  setQuitting();
  app.exit(0);
}
