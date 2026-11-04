const { spawn, spawnSync } = require('node:child_process');

function buildInputArgs(source) {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-fflags', 'nobuffer+discardcorrupt',
    '-flags', 'low_delay',
    '-analyzeduration', '1000000',
    '-probesize', '1000000',
    '-rw_timeout', '5000000',
  ];

  if (source.type === 'SRT') {
    args.push(
      '-connect_timeout', '5000',
      '-latency', String(source.latency * 1000),
    );
  }

  return [...args, '-i', source.url];
}

function buildOutputArgs(source) {
  const common = [
    '-map', '0:v:0',
    '-map', '0:a:0?',
  ];

  if (source.profile === 'copy') {
    common.push(
      '-c:v', 'copy',
      '-bsf:v', 'dump_extra=freq=keyframe',
      '-c:a', 'copy',
    );
  } else {
    const scale = source.profile === 'performance'
      ? 'scale=w=640:h=-2:force_original_aspect_ratio=decrease,fps=20'
      : 'scale=w=960:h=-2:force_original_aspect_ratio=decrease,fps=25';

    common.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', 'main',
      '-pix_fmt', 'yuv420p',
      '-x264-params', 'repeat-headers=1:scenecut=0',
      '-vf', scale,
      '-g', source.profile === 'performance' ? '20' : '25',
      '-keyint_min', source.profile === 'performance' ? '20' : '25',
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '48000',
      '-ac', '2',
    );
  }

  common.push(
    '-avoid_negative_ts', 'make_zero',
    '-f', 'mpegts',
    '-mpegts_flags', '+resend_headers+pat_pmt_at_frames',
    '-pat_period', '0.1',
    '-muxdelay', '0',
    '-muxpreload', '0',
    'pipe:1',
  );

  return common;
}

function buildFfmpegArgs(source) {
  return [...buildInputArgs(source), ...buildOutputArgs(source)];
}

function checkFfmpeg(ffmpegPath) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-version'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000,
  });

  if (result.error) {
    return { ok: false, error: result.error.message };
  }

  return {
    ok: result.status === 0,
    version: String(result.stdout || '').split(/\r?\n/)[0],
    error: result.status === 0 ? null : String(result.stderr || '').trim(),
  };
}

function spawnFfmpeg(ffmpegPath, source) {
  return spawn(ffmpegPath, buildFfmpegArgs(source), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

module.exports = {
  buildFfmpegArgs,
  buildInputArgs,
  buildOutputArgs,
  checkFfmpeg,
  spawnFfmpeg,
};
