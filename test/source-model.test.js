const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSource, parseStreamUrl, redactStreamUrl } = require('../src/source-model');

test('acepta SRT, RTMP y RTMPS', () => {
  assert.equal(parseStreamUrl('srt://127.0.0.1:9000').protocol, 'srt:');
  assert.equal(parseStreamUrl('rtmp://example.com/live/key').protocol, 'rtmp:');
  assert.equal(parseStreamUrl('rtmps://example.com/live/key').protocol, 'rtmps:');
});

test('rechaza protocolos no soportados', () => {
  assert.throws(() => parseStreamUrl('https://example.com/video'), /protocolo/i);
  assert.throws(() => parseStreamUrl('not-a-url'), /válida/i);
});

test('normaliza límites y perfil', () => {
  const source = normalizeSource({
    name: '',
    url: 'srt://10.0.0.1:9000',
    latency: 99999,
    profile: 'unknown',
  }, 'fixed-id');

  assert.equal(source.id, 'fixed-id');
  assert.equal(source.type, 'SRT');
  assert.equal(source.latency, 8000);
  assert.equal(source.profile, 'balanced');
  assert.match(source.name, /^SRT/);
});

test('oculta contraseñas en URLs', () => {
  const redacted = redactStreamUrl('rtmp://user:secret@example.com/live/key');
  assert.doesNotMatch(redacted, /secret/);
  assert.match(redacted, /%E2%80%A2/);
});
