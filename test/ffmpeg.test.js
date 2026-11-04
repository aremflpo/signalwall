const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFfmpegArgs } = require('../src/ffmpeg');

const base = {
  id: '1',
  name: 'Test',
  type: 'SRT',
  url: 'srt://127.0.0.1:9000?mode=caller',
  latency: 120,
  profile: 'balanced',
};

test('construye una salida MPEG-TS de baja latencia', () => {
  const args = buildFfmpegArgs(base);
  assert.deepEqual(args.slice(-2), ['0', 'pipe:1']);
  assert.ok(args.includes('mpegts'));
  assert.ok(args.includes('libx264'));
  assert.equal(args[args.indexOf('-x264-params') + 1], 'repeat-headers=1:scenecut=0');
  assert.equal(args[args.indexOf('-mpegts_flags') + 1], '+resend_headers+pat_pmt_at_frames');
  assert.equal(args[args.indexOf('-latency') + 1], '120000');
  assert.equal(args[args.indexOf('-i') + 1], base.url);
});

test('el perfil copy evita transcodificar', () => {
  const args = buildFfmpegArgs({ ...base, type: 'RTMP', profile: 'copy' });
  const videoCodec = args[args.indexOf('-c:v') + 1];
  const audioCodec = args[args.indexOf('-c:a') + 1];
  assert.equal(videoCodec, 'copy');
  assert.equal(audioCodec, 'copy');
  assert.equal(args[args.indexOf('-bsf:v') + 1], 'dump_extra=freq=keyframe');
  assert.equal(args.includes('-latency'), false);
});
