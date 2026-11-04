const net = require('node:net');
const { spawn } = require('node:child_process');
const { StreamManager } = require('../src/stream-manager');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForLive(manager, id, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manager.off('status', onStatus);
      reject(new Error('La fuente de prueba no llegó a estado live.'));
    }, timeoutMs);

    function onStatus(status) {
      if (status.id !== id || status.status !== 'live') return;
      clearTimeout(timeout);
      manager.off('status', onStatus);
      resolve(status);
    }
    manager.on('status', onStatus);
  });
}

async function main() {
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  const port = await freePort();
  const source = {
    id: 'smoke-srt',
    name: 'SRT smoke test',
    type: 'SRT',
    url: `srt://127.0.0.1:${port}?mode=caller`,
    latency: 80,
    profile: 'performance',
  };

  const sender = spawn(ffmpegPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-g', '25', '-c:a', 'aac', '-b:a', '64k',
    '-f', 'mpegts', `srt://127.0.0.1:${port}?mode=listener&latency=80000`,
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let senderError = '';
  sender.stderr.on('data', (chunk) => { senderError += chunk.toString('utf8'); });

  const manager = new StreamManager({
    getSources: () => [source],
    getFfmpegPath: () => ffmpegPath,
  });

  try {
    manager.start(source.id);
    await waitForLive(manager, source.id);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const runtime = manager.publicRuntime(source.id);
    if (runtime.bytes < 5000 || runtime.bitrateKbps <= 0) {
      throw new Error(`Flujo insuficiente: ${JSON.stringify(runtime)}`);
    }
    console.log(`SRT end-to-end OK · ${runtime.bitrateKbps} kb/s · ${runtime.bytes} bytes`);
  } finally {
    manager.stopAll();
    sender.kill('SIGTERM');
  }

  if (senderError.trim()) console.error(senderError.trim());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
