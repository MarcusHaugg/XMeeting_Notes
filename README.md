# XMeeting Notes

Gravador de reuniões gratuito e 100% local para **Windows, macOS e Linux**. Inspirado nas funções
do Granola: você entra na reunião, clica em **Nova reunião**, toma notas enquanto ela acontece e,
depois, tem o **áudio inteiro** e, se quiser, a **transcrição completa**.

A gravação e a transcrição acontecem no seu computador. A internet só é usada uma vez, para
baixar o modelo de transcrição.

## Instalar

Os instaladores são gerados automaticamente pelo GitHub Actions (aba **Actions** → última execução →
**Artifacts**), ou localmente com `npm run dist` no próprio sistema.

| Sistema | Arquivo | Observações |
|---|---|---|
| Windows 10/11 | `XMeeting-Notes-<versão>-win-x64.exe` | Instala para o seu usuário (sem admin) e cria atalho na Área de Trabalho. O Windows pode avisar "editor desconhecido": clique em **Mais informações → Executar assim mesmo**. |
| macOS 14.2+ (Apple Silicon) | `XMeeting-Notes-<versão>-mac-arm64.dmg` | O app não é assinado pela Apple. Na primeira vez: clique com o botão direito no app → **Abrir**. Se aparecer "danificado", rode `xattr -cr "/Applications/XMeeting Notes.app"`. Na primeira gravação, permita **Microfone** e **Gravação de áudio do sistema**. |
| Linux (x64) | `.AppImage` ou `.deb` | AppImage: `chmod +x` e execute (pode precisar do pacote `libfuse2`). `.deb`: `sudo apt install ./arquivo.deb`. |

## Como usar

1. Entre na chamada (Teams, Meet, Zoom...).
2. Clique em **Nova reunião**. O app grava duas trilhas:
   - **Você**: o seu microfone;
   - **Outros**: tudo que sai no som do computador (a voz dos participantes).
3. Escreva suas anotações enquanto isso (salvam sozinhas). Pode minimizar a janela.
4. Clique em **Parar**. O áudio completo fica disponível na hora (player + **Exportar áudio** em .m4a ou .mp3).
5. Quando quiser o texto, abra a aba **Transcrição** e clique em **Transcrever**.
   Cada fala aparece com o horário (clique para ouvir aquele trecho). Dá para **Copiar** ou **Exportar .txt**.

Configurações: qualidade da transcrição e idioma das reuniões.

| Qualidade | Modelo | 1 h de reunião* | Download (uma vez) |
|---|---|---|---|
| **Máxima precisão** (padrão) | Whisper large-v3-turbo | ~70 min | 1 GB |
| **Rápido** | Whisper small | ~40 min | 240 MB |

\* Medido num notebook i5-1235U sem placa de vídeo. A transcrição roda em segundo plano, com
prioridade baixa: dá para continuar usando o computador (e até gravar outra reunião).

## Como funciona

```
Microfone ──────┐
                ├─► gravação (.webm, salva a cada segundo) ─► áudio completo (audio.m4a)
Som do sistema ─┘                                                │
                                                                 ▼  (ao clicar em Transcrever)
     detecta a fala ─► cola os trechos em janelas de ~28 s ─► Whisper local (horário por palavra)
                                                                 ▼
                              falas de "Você" e "Outros" intercaladas na ordem certa
```

- **Electron**: app de desktop. Som do sistema: loopback no Windows, CoreAudio no macOS 14.2+,
  monitor do PulseAudio/PipeWire no Linux.
- **ffmpeg**: junta as trilhas no áudio final e prepara o áudio para a transcrição.
- **Whisper** (via transformers.js): transcrição local, num processo separado.
  O silêncio longo é removido e as falas são coladas em janelas de ~28 s, porque o Whisper erra
  muito com pedacinhos de 1-2 s. O horário de cada palavra devolve cada fala ao seu momento real.

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
models/                        modelos do Whisper
```

## Dicas e limitações

- **Use fones de ouvido.** Sem eles, o microfone também capta a voz dos outros saindo da caixa de som
  (o app descarta ecos óbvios, mas o resultado fica melhor com fone).
- **O som do sistema não pode estar no mudo**: no mudo, o sistema entrega silêncio para a gravação.
  O app avisa se o áudio do sistema ficar zerado por 20 s.
- A chamada deve usar o **dispositivo de som padrão** do sistema; senão, só um lado é gravado.
- Só separa **Você** e **Outros**: não identifica cada participante.
- macOS e Linux ainda não foram testados em máquina real. No Linux, a captura do som do sistema
  depende do PulseAudio/PipeWire; o microfone funciona sempre.
- Avise os participantes de que a reunião está sendo gravada.

## Desenvolvimento

```
npm install
npm start                                        # abre o app em modo desenvolvimento
npm run dist                                     # gera o instalador do sistema atual (pasta dist/)
npm run selftest                                 # grava 30 s de verdade, monta o áudio e transcreve
npx electron . --demo=<id> --screenshot=<pasta>  # processa uma reunião existente e tira capturas de tela
```

Estrutura: `electron/` (processo principal, gravação, ffmpeg, transcrição) e `renderer/` (interface).

## Próximos passos

- Resumo no estilo Granola (decidir: IA local embutida, offline, ou resumo extrativo).
- Assinatura de código (remove os avisos de "editor desconhecido" no Windows e no macOS).
- Transcrição mais rápida (whisper.cpp / aceleração por GPU).
