const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { spawnFfmpeg } = require('../src/ffmpeg');

async function main() {
  const configPath = path.join(process.env.APPDATA || '', 'signal-wall', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const source = config.sources?.[0];
  if (!source) throw new Error('No hay una fuente configurada para verificar.');

  const ffmpegPath = config.settings?.ffmpegPath || 'ffmpeg';
  const receiver = spawnFfmpeg(ffmpegPath, { ...source, profile: 'balanced' });
  const decoder = spawn(ffmpegPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-f', 'mpegts', '-i', 'pipe:0',
    '-map', '0:v:0', '-frames:v', '1',
    '-f', 'null', '-',
  ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });

  receiver.stdout.pipe(decoder.stdin);
  let decoderError = '';
  decoder.stderr.on('data', (chunk) => { decoderError += chunk.toString('utf8'); });

  const timeout = setTimeout(() => {
    decoder.kill('SIGTERM');
    receiver.kill('SIGTERM');
  }, 15000);

  const code = await new Promise((resolve) => decoder.once('close', resolve));
  clearTimeout(timeout);
  receiver.kill('SIGTERM');
  if (code !== 0) throw new Error(decoderError.trim() || 'No se decodificó ningún cuadro antes del timeout.');
  console.log(`Video decodificado correctamente con perfil Equilibrado (${source.type}).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
