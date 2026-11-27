# XMeeting Notes

Gravador de reuniões para **Windows, macOS e Linux**, com login por qualquer conta Google.
Você entra na reunião, clica em **Nova reunião**, toma notas enquanto ela acontece e, depois, tem o
**áudio inteiro** salvo no computador, a **transcrição** (com o horário de cada fala) e o **resumo**
(decisões, próximos passos e tópicos).

O áudio completo da reunião fica sempre salvo no XMeeting. A transcrição e o resumo podem ser
feitos no próprio computador, de graça, ou pela IA que a pessoa já assina, com a chave dela:

| | No computador (grátis, nada sai da máquina) | Com a chave da pessoa |
|---|---|---|
| **Transcrição** | **Rápida** (Parakeet) ou **Máxima qualidade** (Whisper turbo) | Gemini ou OpenAI |
| **Resumo** | Ollama, se estiver instalado | Gemini, OpenAI ou Claude |

Cada conta Google consome só as próprias chaves, nunca as de outra pessoa nem as da empresa. Contas
do plano da empresa (domínio em `companyDomains`, ex.: bimachine.com.br) também podem usar o Gemini
da empresa, pelo servidor do XMeeting (`server/`).

Uma assinatura de chat (plano pago do Gemini, ChatGPT Plus, Claude Pro...) não dá acesso à API: as
chaves de API são cobradas à parte, por uso, na conta de quem criou a chave.

## Como usar

1. Clique em **Continuar com Google** e escolha sua conta. Na primeira vez, isso cria a sua conta do
   XMeeting vinculada à conta Google. O login abre no navegador e volta sozinho.
2. A tela inicial é a **Agenda**: as reuniões de hoje e dos próximos 7 dias da sua Google Agenda, com
   **Entrar** (abre a chamada) e **Gravar** (título e participantes já preenchidos). Quando uma reunião
   começa, o app avisa; clicar no aviso começa a gravar. O XMeeting só lê a agenda.
3. Entre na chamada (Teams, Meet, Zoom...) e clique em **Nova reunião**. O app grava duas trilhas:
   - **Você**: o seu microfone;
   - **Outros**: tudo que sai no som do computador (a voz dos participantes).
4. Escreva suas anotações enquanto isso (salvam sozinhas). Pode minimizar a janela.
5. Clique em **Parar**. O áudio completo fica disponível na hora (player + **Exportar áudio** em .m4a ou .mp3).
6. Na aba **Transcrição**, clique em **Transcrever** ou **Transcrever e resumir**. Cada fala aparece com o
   horário (clique para ouvir aquele trecho). Dá para **Copiar** ou **Exportar .txt**.
7. Na aba **Resumo**, clique em **Resumir** (ou **Resumir de novo**, sem transcrever outra vez).

Ao fechar a janela, o app continua no ícone da barra de tarefas (ou da barra de menus, no macOS), de
onde dá para gravar, parar e sair. No app instalado, ele abre junto com o computador (dá para
desligar no menu do ícone ou em Configurações).

### Configurações

- **Transcrição**: escolha quem transcreve.
  - **Rápida** (padrão): Parakeet v3, no computador. Uma reunião de 43 min levou cerca de 2 min num
    Mac M2. Pode errar mais nomes próprios e palavras estrangeiras.
  - **Máxima qualidade**: Whisper turbo, no computador. Mais lenta (2 a 3 vezes a duração da
    reunião num Mac M2), mas erra menos. É a indicada quando a qualidade importa.
  - **Gemini** ou **OpenAI**: na nuvem, com a sua chave. O Gemini também separa os participantes da
    chamada (Participante 1, 2...).
  - Os modelos do computador (cerca de 500 MB cada) são baixados só na primeira vez que forem usados.
- **Resumo**: **Automático** usa a primeira opção disponível, nesta ordem: Gemini (empresa ou chave
  própria), Claude, OpenAI e Ollama. Também dá para escolher uma delas.
- **Chaves de IA**: cole a chave do **Gemini** ([AI Studio](https://aistudio.google.com/apikey)),
  da **OpenAI** ([platform.openai.com](https://platform.openai.com/api-keys)) ou do **Claude**
  ([platform.claude.com](https://platform.claude.com)). O app testa a chave antes de salvar. O
  Claude só faz o resumo (a API dele não transcreve áudio).
- **Ollama**: instale pelo [ollama.com](https://ollama.com/download) e baixe um modelo (ex.:
  `ollama pull qwen3`). O app encontra os modelos instalados sozinho.
- **Idioma** das reuniões e **avisos** de reuniões da agenda.

## Como funciona

```
Microfone ──────┐
                ├─► gravação local (.webm, salva a cada segundo) ─► áudio completo (audio.m4a)
Som do sistema ─┘                                                │
                                                                 ▼  (ao clicar em Transcrever)
                          ┌─ no computador: detecta a fala (Silero) ─► trechos de até 28 s ─► Parakeet ou Whisper
          cada trilha ────┼─ Gemini: corta o silêncio ─► partes de até 25 min em MP3 ─► Gemini (chave própria ou servidor da empresa)
                          └─ OpenAI: corta o silêncio ─► trechos de até 28 s em MP3 ─► gpt-transcribe
                                                                 ▼
                       falas de "Você" e dos outros na ordem certa, com o horário real da reunião
                                                                 ▼  (ao clicar em Resumir)
                   transcrição + anotações + participantes ─► Gemini, Claude, OpenAI ou Ollama ─► resumo
```

- **Electron**: app de desktop. Som do sistema: loopback no Windows, CoreAudio no macOS 14.2+,
  monitor do PulseAudio/PipeWire no Linux.
- **Login**: OAuth do Google para apps de computador (navegador do sistema + PKCE). O token de login
  e as chaves de IA de cada conta ficam cifrados pelo sistema (Keychain no macOS, DPAPI no Windows);
  as chaves são apagadas ao sair da conta.
- **ffmpeg**: junta as trilhas no áudio final e prepara o áudio para a transcrição.
- **Transcrição no computador**: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), num processo
  separado com prioridade baixa (não trava o app nem a chamada). Modelos: Parakeet TDT 0.6B v3 (int8)
  na Rápida e Whisper large-v3 turbo (int8) na Máxima qualidade.
- **Na nuvem, só a fala é enviada**: o silêncio é cortado antes (não se paga por ele) e cada fala
  volta ao horário real da reunião.
- **Servidor** (`server/`, só o plano da empresa): confere o login, recusa contas fora de
  `COMPANY_DOMAINS`, manda o áudio ao Gemini com a chave da empresa, apaga o arquivo no Google
  depois e registra o consumo de cada usuário.
- **Modelos na nuvem**: Gemini `gemini-3.5-transcribe` e `gemini-3.8-flash`; OpenAI `gpt-transcribe`
  e `gpt-6.2-sol`; Claude `claude-opus-5-5`.

Custo estimado por hora de reunião, na conta dona da chave: Gemini cerca de US$ 0,33 a 0,52
(transcrição + resumo); transcrição pela OpenAI cerca de US$ 0,27. Na cota gratuita do Gemini não há
cobrança, mas há limites de uso e o Google pode usar o conteúdo para melhorar os produtos dele.
No computador não há custo.

## Configuração (uma vez)

### 1. Google Cloud (uma vez, por quem publica o app)

Login + Google Agenda não precisam de faturamento, servidor nem chave do Gemini:

1. Em [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate), crie um projeto.
2. Ative a [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
3. Em [Google Auth Platform](https://console.cloud.google.com/auth/overview), clique em **Começar**: nome do
   app, e-mail de suporte e público **Externo** (qualquer conta Google).
4. Em **Acesso a dados**, adicione a permissão `.../auth/calendar.events.readonly`.
5. Em **Público**, escolha **Tornar interno** se só contas da empresa vão usar (é o que está em uso:
   sem aviso de app não verificado, sem limite de usuários e sem login expirando). Para aceitar qualquer
   conta Google, deixe Externo: em **Teste**, adicione os e-mails de quem vai usar (até 100; o login expira
   a cada 7 dias); para publicar, preencha a página de **Branding** (página inicial e política de privacidade
   num domínio da empresa).
6. Em [Clientes](https://console.cloud.google.com/auth/clients), crie um cliente do tipo **App para
   computador** e copie o ID e o segredo para o `app-config.json`.

A leitura da agenda é uma permissão "sensível". Para abrir o app a qualquer pessoa (status **Em
produção**), o Google exige verificação: site público, política de privacidade no mesmo domínio,
domínio verificado e um vídeo de demonstração (até ~10 dias úteis). Sem ela, aparece um aviso de app
não verificado e o projeto fica limitado a 100 usuários no total.

Para transcrever e resumir pelo plano da empresa (opcional): ligue uma **conta de faturamento**, ative
a **Generative Language API**, crie uma **chave da API do Gemini** e configure o servidor (abaixo).

### 2. Servidor (só para o plano da empresa)

```
cp server/.env.example server/.env    # preencha GEMINI_API_KEY, GOOGLE_CLIENT_IDS e COMPANY_DOMAINS
npm run server                        # http://localhost:8080
```

Para conferir a resposta do Gemini antes de usar o app:

```
npm run try-gemini -- transcribe teste.mp3 --diarize
```

### 3. App

```
cp app-config.example.json app-config.json   # preencha googleClientId e googleClientSecret; backendUrl e
                                             # companyDomains só para o plano da empresa
npm install
npm start
```

`app-config.json` e `server/.env` ficam fora do git. Nos instaladores gerados pelo GitHub Actions,
o `app-config.json` é montado a partir das variáveis e segredos do repositório (veja
`.github/workflows/build.yml`): a variável `XMEETING_GOOGLE_CLIENT_ID` e o segredo
`XMEETING_GOOGLE_CLIENT_SECRET` (mais `XMEETING_BACKEND_URL` e `XMEETING_COMPANY_DOMAINS` quando o
servidor da empresa estiver no ar).

### 4. Publicar uma versão

```
# suba a "version" no package.json (ex.: 0.4.1) e faça o commit
git tag v0.4.1
git push origin main v0.4.1
```

O GitHub Actions gera os instaladores dos 3 sistemas e, quando todos ficam prontos, publica a versão
em **Releases** deste repositório. A tag precisa ser igual à versão do `package.json`, senão a
publicação para. O app instalado procura as versões novas ali, por isso o repositório precisa ser
**público** (Settings → General → Danger Zone → Change visibility). Se o repositório mudar de nome
ou de dono, mude `build.publish` no `package.json` e `RELEASES_REPO` em `electron/updater.js`.

A versão anterior à 0.4.0 (gravação + Whisper no computador, sem login) fica no branch `versao-0.2`.
Para gerar os instaladores dela: **Actions → Build XMeeting Notes → Run workflow**, escolhendo esse branch.

## Instalar

Baixe o instalador do seu sistema em
[github.com/MarcusHaugg/XMeeting_Notes/releases/latest](https://github.com/MarcusHaugg/XMeeting_Notes/releases/latest)
(ou na pasta do XMeeting no Google Drive da empresa). Só os arquivos da tabela abaixo; os "Source
code" que o GitHub adiciona não instalam nada. Para testar sem publicar: aba **Actions** → última
execução → **Artifacts**, ou `npm run dist` no próprio sistema.

| Sistema | Arquivo | Observações |
|---|---|---|
| Windows 10/11 | `XMeeting-Notes-<versão>-win-x64.exe` | Instala para o seu usuário (sem admin) e cria atalho na Área de Trabalho. O Windows pode avisar "editor desconhecido": clique em **Mais informações → Executar assim mesmo**. |
| macOS 14.2+ (Apple Silicon) | `XMeeting-Notes-<versão>-mac-arm64.dmg` | Arraste para **Aplicativos**. O app não é assinado pela Apple, então na primeira vez o macOS diz que não pôde verificá-lo: clique em **OK** (não em "Mover para o Lixo"), abra **Ajustes do Sistema → Privacidade e Segurança**, desça até "XMeeting Notes foi bloqueado" e clique em **Abrir Mesmo Assim**. Ou, no Terminal: `xattr -dr com.apple.quarantine "/Applications/XMeeting Notes.app"`. Na primeira gravação, permita **Microfone** e **Gravação de áudio do sistema**. |
| Linux (x64) | `.AppImage` ou `.deb` | AppImage: `chmod +x` e execute (pode precisar do pacote `libfuse2`). `.deb`: `sudo apt install ./arquivo.deb`. |

### Atualizações

O app instalado procura uma versão nova ao abrir e a cada 4 horas.

- **Windows e Linux (AppImage)**: baixa sozinho em segundo plano e instala quando você fecha o app
  ("Sair do XMeeting"), ou na hora, em **Reiniciar e atualizar** (aviso na barra lateral, menu do
  ícone ou Configurações). Durante uma gravação, ele espera.
- **macOS e Linux (.deb)**: avisa que há versão nova e abre a página para baixar; você instala por
  cima. O macOS só deixa um app se atualizar sozinho com a assinatura da Apple (conta de
  desenvolvedor, US$ 99 por ano).

Reuniões, anotações, chaves e configurações continuam no computador em qualquer atualização. Quem
tem uma versão anterior à 0.4.0 precisa instalar a 0.4.0 uma vez na mão: as versões antigas não
procuravam atualização.

## Onde ficam os arquivos

- Windows: `%LOCALAPPDATA%\XMeetingNotes` (fora do OneDrive de propósito)
- macOS: `~/Library/Application Support/XMeetingNotes`
- Linux: `~/.config/XMeetingNotes`

```
meetings/<id>/meta.json        título, data, anotações, status
meetings/<id>/mic.webm         sua trilha
meetings/<id>/system.webm      trilha dos outros
meetings/<id>/audio.m4a        áudio completo da reunião
meetings/<id>/transcript.json  transcrição
meetings/<id>/summary.json     resumo
session.bin                    login (cifrado pelo sistema)
gemini-keys.bin                chaves de IA de cada conta (cifrado pelo sistema)
models/stt/                    modelos de transcrição no computador (baixados no primeiro uso)
```

Ao abrir, a versão nova apaga o modelo do Whisper das versões anteriores (`models/onnx-community` e
`models/Xenova`, até 1 GB).

## Dicas e limitações

- **Use fones de ouvido.** Sem eles, o microfone também capta a voz dos outros saindo da caixa de som
  (o app descarta ecos óbvios, mas o resultado fica melhor com fone).
- **O som do sistema não pode estar no mudo**: no mudo, o sistema entrega silêncio para a gravação.
  O app avisa se o áudio do sistema ficar zerado por 20 s.
- A chamada deve usar o **dispositivo de som padrão** do sistema; senão, só um lado é gravado.
- O app sempre separa **você** (microfone) dos **outros** (som do computador). Separar cada participante
  da chamada só existe no Gemini e é experimental: com 3 ou mais pessoas, algumas falas podem ir para o
  participante errado, e a numeração pode recomeçar a cada 25 min de fala.
- A transcrição no computador usa bastante memória e processador. Em máquinas com 8 GB de RAM, feche
  outros programas pesados se ela ficar lenta.
- macOS e Linux ainda não foram testados em máquina real.
- Avise os participantes de que a reunião está sendo gravada.

## Desenvolvimento

```
npm start                                        # abre o app
npm run server                                   # servidor local (lê server/.env)
npm run try-gemini -- transcribe <audio.mp3>     # chama o Gemini direto e mostra a resposta crua
npm run dist                                     # gera o instalador do sistema atual (pasta dist/)
npm run selftest                                 # grava 30 s de verdade e transcreve (precisa de login)
npx electron . --screenshot=<pasta>              # captura a tela inicial
```

Estrutura: `electron/` (processo principal, login, gravação, ffmpeg, transcrição, resumo),
`renderer/` (interface) e `server/` (backend que fala com o Gemini).

## Próximos passos

- Separar os participantes da chamada também na transcrição no computador.
- Importar a transcrição e as anotações do Gemini do próprio Google Meet, quando existirem (sem custo de API).
- Publicar o servidor no Google Cloud Run e guardar o consumo por usuário num banco.
- Assinatura de código (remove os avisos de "editor desconhecido" no Windows e no macOS e permite a
  atualização sozinha no macOS).
