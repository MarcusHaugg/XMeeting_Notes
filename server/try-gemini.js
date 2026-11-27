// Teste direto com o Gemini, sem o app e sem login. Mostra a resposta crua para conferir
// se o formato bate com o que gemini.js espera.
//
//   node --env-file=server/.env server/try-gemini.js transcribe <audio.mp3> [--diarize] [--language=pt-BR]
//   node --env-file=server/.env server/try-gemini.js summarize <transcricao.txt>
//
// Para gerar um MP3 de teste a partir de uma reunião gravada (até 25 min):
//   "$(node -p "require('ffmpeg-static')")" -i system.webm -t 600 -ac 1 -ar 16000 -b:a 32k teste.mp3
import { readFile } from 'node:fs/promises';
import { summarizeTranscript, transcribeAudio } from './gemini.js';

const [command, file, ...flags] = process.argv.slice(2);
const flag = (name) => flags.find((f) => f === `--${name}` || f.startsWith(`--${name}=`));
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error('GEMINI_API_KEY não definido (server/.env ou variável de ambiente).');
  process.exit(1);
}
if (!file || !['transcribe', 'summarize'].includes(command)) {
  console.error('Uso: try-gemini.js transcribe <audio.mp3> [--diarize] [--language=pt-BR] | summarize <transcricao.txt>');
  process.exit(1);
}

const started = Date.now();
if (command === 'transcribe') {
  const language = flag('language')?.split('=')[1] ?? 'pt-BR';
  const result = await transcribeAudio(await readFile(file), { apiKey, language, diarize: Boolean(flag('diarize')), raw: true });
  console.log('--- resposta crua do Gemini ---');
  console.log(JSON.stringify(result.raw, null, 2).slice(0, 6000));
  console.log('--- interpretado ---');
  console.log(`texto: ${result.text.length} caracteres`);
  console.log(`palavras com horário: ${result.words.length}`);
  console.log('primeiras palavras:', result.words.slice(0, 10));
  console.log('uso:', JSON.stringify(result.usage));
} else {
  const transcript = await readFile(file, 'utf8');
  const result = await summarizeTranscript({ title: 'Teste', date: new Date().toLocaleDateString('pt-BR'), notes: '', transcript }, { apiKey });
  console.log(JSON.stringify(result, null, 2));
}
console.log(`levou ${((Date.now() - started) / 1000).toFixed(1)} s`);
