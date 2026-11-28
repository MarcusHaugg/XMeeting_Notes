# XMeeting Notes

App de desktop (Electron) que grava reuniões em duas trilhas (microfone = "Você", som do sistema =
"Outros"), salva o áudio completo, transcreve e resume. O README.md explica o produto para pessoas;
este arquivo é o guia de trabalho no código.

## Como trabalhar com o Marcus

- Responda em português do Brasil, direto e informal. Ele não é especialista em Google Cloud/GitHub:
  passos manuais vão numerados, com o link exato e o texto dos botões.
- **Commit pode; push e publicação só com o OK dele.** O terminal do Claude não tem credencial do
  GitHub: quem roda `git push` é ele, no terminal dele (token com permissão `repo` + `workflow`).
- Não tire uma função que ele já aprovou só porque surgiu uma restrição nova. Proponha como manter.
- Nunca faça commit de `app-config.json`, `server/.env` nem de chaves. `dist/` e `site-pages/` ficam
  fora do git deste repositório.
- Commits em português, com o corpo explicando o porquê e terminando com a linha `Co-Authored-By`.

## Duas versões, um código só

| | Versão da BI | Versão aberta |
|---|---|---|
| Branch local | `main` | `aberto` (= `main` + 2 diferenças) |
| Repositório (público) | `origin` = MarcusHaugg/XMeeting_Notes | `aberto` = MarcusHaugg/XMeeting_Notes_Aberto |
| Login Google | Projeto `xmeeting-notes` (org da BI), público **Interno** | Projeto `xmeeting-notes-516100` (conta pessoal), **Externo, publicado sem verificação** |
| Onde baixa | Releases do repositório + pasta "build-XMeeting" no Drive da BI | https://marcushaugg.github.io (botões leem a última Release) |

Diferenças da branch `aberto`: `RELEASES_REPO` em `electron/updater.js` e `build.publish.repo` no
`package.json` apontam para `XMeeting_Notes_Aberto`; o título do README. Ao levar mudanças da BI para
a aberta: `git switch aberto && git merge main`, conferindo que essas duas linhas continuam iguais.

O site fica em `site-pages/` (repositório próprio `marcushaugg.github.io`, GitHub Pages): página
inicial, `privacidade.html` (exigida pelo Google para publicar) e a tag de verificação do Search Console.

## Publicar uma versão

1. Subir `version` no `package.json` (`npm version X.Y.Z --no-git-tag-version`), commit, `npm test`.
2. BI: `git tag -a vX.Y.Z -m "XMeeting Notes X.Y.Z"` → Marcus roda `git push origin main vX.Y.Z`.
3. Aberta: `git switch aberto && git merge main` → Marcus roda
   `git push aberto aberto:main` e `git push aberto aberto:refs/tags/vX.Y.Z` (a tag local `vX.Y.Z` é da BI).
4. O GitHub Actions (`.github/workflows/build.yml`) roda os testes, gera Windows/macOS/Linux e, numa tag,
   publica uma Release só depois dos 3. Ele falha se a tag ≠ `version` ou se `RELEASES_REPO` ≠ `build.publish`.
5. Acompanhar sem credencial (os repositórios são públicos):
   `curl -s https://api.github.com/repos/MarcusHaugg/<repo>/actions/runs?per_page=3`.
6. BI: copiar `.exe`, `.dmg` e `linux-x86_64.AppImage` da Release para uma pasta nova
   "XMeeting Notes X.Y.Z - instaladores" (subpastas Windows/Mac/Linux) em "build-XMeeting" no Drive.
   O conector do Drive só sobe arquivos de até 10 MB: o Marcus arrasta os instaladores.

Variáveis do Actions em cada repositório: `XMEETING_GOOGLE_CLIENT_ID` (variável) e
`XMEETING_GOOGLE_CLIENT_SECRET` (segredo); `XMEETING_BACKEND_URL` e `XMEETING_COMPANY_DOMAINS` só
quando o servidor da empresa existir (hoje vazios: se preencher sem servidor, contas da BI quebram).

## Mapa do código

- `electron/main.js`: janela, IPC, gravação (escreve os pedaços a cada segundo), agenda, avisos, ícone.
- `electron/auth.js`: login Google (navegador + PKCE + loopback); a permissão da agenda é pedida à parte.
- `electron/calendar.js`: Google Agenda; `startMeetingWatcher` confere a cada 30 s (lista de até 1 min)
  e avisa de 1 min antes a 5 min depois do início, para reuniões com link ou 2+ participantes.
- `electron/popup.js`: avisos. **No macOS usa janela própria**: o macOS descarta em silêncio as
  notificações de apps sem assinatura da Apple. Nos outros sistemas, notificação nativa.
- `electron/updater.js`: atualização automática (Windows/AppImage instalam; macOS e .deb só avisam).
- `electron/ai.js` + `electron/providers/`: chaves por conta (cifradas, `gemini-keys.bin`), quem
  transcreve e quem resume. "Automático" = Gemini → Claude → OpenAI → Ollama. Claude não aceita áudio.
- `electron/local-stt/`: transcrição no computador (sherpa-onnx; Rápida = Parakeet v3, Máxima
  qualidade = Whisper turbo), modelos baixados no 1º uso em `userData/models/stt`.
- `electron/transcriber.js`, `summarizer.js`, `speech.js` (VAD, junção das trilhas), `media.js` (ffmpeg),
  `store.js` (pasta `meetings/<id>/`), `settings.js`, `tray.js`, `dev.js` (automação de testes).
- `renderer/`: interface (`app.js`, `recorder.js` captura as trilhas). `server/`: backend do plano da
  empresa (Gemini com a chave da BI), ainda não publicado.

## Testar

- `npm test`: testes do Node em `test/` (o módulo `electron` é trocado por `test/electron-stub.mjs`).
- App com dados separados e sem login real (não mexe no app instalado):
  `LOCALAPPDATA=<pasta> XMEETING_GOOGLE_CLIENT_ID=teste npx electron . --screenshot=<pasta> --fake-user=fulano@gmail.com`
  mais `--settings` (capturas das Configurações), `--open=<id>`, `--auto-record-test` (reunião falsa
  começando em 20 s com a janela escondida), `--notify-test` (aviso + clique simulado),
  `--check-update` (só no app empacotado). Ponha `{"loginItemConfigured":true}` no `settings.json`
  da pasta de teste para um app empacotado não se registrar para abrir ao ligar o Mac.
- Mudança que depende de assinatura/empacotamento (avisos, atualização) se testa no app empacotado:
  `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir --publish never`.

## Armadilhas deste ambiente

- O Bash do Claude roda em sandbox: arquivos gravados **fora da pasta do projeto** (Downloads,
  /Applications, até a pasta temporária) podem parecer existir e sumir. Para algo que o Marcus precisa
  ver, grave dentro do projeto (ex.: `dist/`) ou rode sem sandbox, e confirme com ele.
- macOS: o app não tem assinatura da Apple. A cada instalação/atualização, liberar em Ajustes →
  Privacidade e Segurança → Abrir Mesmo Assim, ou `xattr -dr com.apple.quarantine "/Applications/XMeeting Notes.app"`.
- O conector do Google Drive do Claude precisa estar na conta da BI (já esteve na da Univates).

## Pendências conhecidas

- Transcrição no computador nunca rodou num Windows/Linux real.
- Versão aberta: verificação do Google (tira o aviso "app não verificado" e o limite de 100 pessoas na agenda).
- Ideias aprovadas para depois: servidor MCP para usar as reuniões no Claude Desktop; assinatura da Apple.
