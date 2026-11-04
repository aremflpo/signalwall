const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../src/config-store');

test('migra fuentes copy antiguas al perfil equilibrado', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-wall-config-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'config.json');
  fs.writeFileSync(filePath, JSON.stringify({
    sources: [{ id: 'old', name: 'Old', type: 'SRT', url: 'srt://127.0.0.1:9000', latency: 120, profile: 'copy' }],
    settings: { columns: 2, ffmpegPath: 'ffmpeg' },
  }));

  const store = new ConfigStore(filePath);
  assert.equal(store.data.schemaVersion, 3);
  assert.equal(store.data.sources[0].profile, 'balanced');
  assert.equal(store.migrations.length, 2);
  assert.equal(store.data.multiviews[0].slots[0], 'old');

  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.sources[0].profile, 'balanced');
});

test('respeta copy en configuraciones actuales', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-wall-config-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'config.json');
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 3,
    sources: [{ id: 'new', name: 'New', type: 'RTMP', url: 'rtmp://127.0.0.1/live', latency: 120, profile: 'copy' }],
    multiviews: [{ id: 'wall', name: 'Wall', gridSize: 3, slots: ['new'] }],
    activeMultiviewId: 'wall',
    settings: { columns: 3, ffmpegPath: 'ffmpeg' },
  }));

  const store = new ConfigStore(filePath);
  assert.equal(store.data.sources[0].profile, 'copy');
  assert.equal(store.migrations.length, 0);
});
