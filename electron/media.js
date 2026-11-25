// Tudo que envolve ffmpeg: juntar as trilhas no áudio final, decodificar para o Whisper, exportar.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

// Num app empacotado o binário fica fora do .asar
export const FFMPEG = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

function runFfmpeg(args, { stdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { windowsHide: true });
    const chunks = [];
    let stderr = '';
    if (stdout) proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg falhou (código ${code}): ${stderr.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

// aresample=async preenche com silêncio qualquer buraco de tempo na gravação,
// mantendo as duas trilhas alinhadas com o relógio real da reunião.
const ALIGN = 'aresample=async=1:first_pts=0';

/** Junta microfone + sistema em um único arquivo audio.m4a (o "áudio inteiro" da reunião). */
export async function finalizeAudio(dir) {
  const inputs = [];
  for (const name of ['mic.webm', 'system.webm']) {
    try {
      if ((await fs.stat(path.join(dir, name))).size > 0) inputs.push(path.join(dir, name));
    } catch {
      /* trilha não gravada */
    }
  }
  if (inputs.length === 0) throw new Error('Nenhum áudio foi gravado.');

  const tmp = path.join(dir, 'audio.tmp.m4a');
  const args = inputs.flatMap((f) => ['-i', f]);
  if (inputs.length === 1) {
    args.push('-af', ALIGN);
  } else {
    args.push(
      '-filter_complex',
      `[0:a]${ALIGN}[a0];[1:a]${ALIGN}[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[out]`,
      '-map',
      '[out]'
    );
  }
  args.push('-ac', '1', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-y', tmp);
  await runFfmpeg(args);
  await fs.rename(tmp, path.join(dir, 'audio.m4a'));
}

/** Duração em segundos, lida do cabeçalho do arquivo. */
export function probeDuration(file) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', () => resolve(0));
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) : 0);
    });
  });
}

/** Decodifica uma trilha para PCM Int16 mono 16 kHz (entrada do Whisper). */
export async function decodePcm(file) {
  const buf = await runFfmpeg(['-i', file, '-af', ALIGN, '-ac', '1', '-ar', '16000', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], {
    stdout: true,
  });
  const bytes = buf.length - (buf.length % 2);
  if (buf.byteOffset % 2 === 0) return new Int16Array(buf.buffer, buf.byteOffset, bytes / 2);
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytes));
}

/** Exporta o áudio final: copia o .m4a ou converte para .mp3. */
export async function exportAudioFile(src, dest) {
  if (dest.toLowerCase().endsWith('.mp3')) {
    await runFfmpeg(['-i', src, '-c:a', 'libmp3lame', '-q:a', '4', '-y', dest]);
  } else {
    await fs.copyFile(src, dest);
  }
}
