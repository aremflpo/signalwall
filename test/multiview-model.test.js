const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assignSourceToSlot,
  createMultiview,
  makeExportPayload,
  resizeMultiview,
  unassignSource,
  validateImportPayload,
} = require('../src/multiview-model');

const validIds = new Set(['a', 'b', 'c']);

test('crea una matriz con espacios fijos y elimina duplicados', () => {
  const view = createMultiview({ id: 'wall', gridSize: 2, slots: ['a', 'a', 'missing', 'b'] }, validIds);
  assert.deepEqual(view.slots, ['a', null, null, 'b']);
});

test('mueve y permuta señales entre espacios', () => {
  const view = createMultiview({ id: 'wall', gridSize: 2, slots: ['a', 'b', null, null] }, validIds);
  const swapped = assignSourceToSlot(view, 'a', 1, validIds);
  assert.deepEqual(swapped.slots, ['b', 'a', null, null]);
  const moved = assignSourceToSlot(swapped, 'c', 3, validIds);
  assert.deepEqual(moved.slots, ['b', 'a', null, 'c']);
  assert.deepEqual(unassignSource(moved, 'a', validIds).slots, ['b', null, null, 'c']);
});

test('al reducir la matriz conserva sólo los espacios visibles', () => {
  const view = createMultiview({ id: 'wall', gridSize: 3, slots: ['a', 'b', 'c', null, null, null, null, null, null] }, validIds);
  assert.deepEqual(resizeMultiview(view, 1, validIds).slots, ['a']);
});

test('exporta exactamente el layout y sólo sus señales asignadas', () => {
  const view = createMultiview({ id: 'wall', name: 'Control', gridSize: 2, slots: ['a', null, 'b', null] }, validIds);
  const payload = makeExportPayload(view, [
    { id: 'a', name: 'A', type: 'SRT', url: 'srt://127.0.0.1:1', latency: 120, profile: 'balanced' },
    { id: 'b', name: 'B', type: 'RTMP', url: 'rtmp://example/live', latency: 120, profile: 'balanced' },
    { id: 'c', name: 'C', type: 'SRT', url: 'srt://127.0.0.1:3', latency: 120, profile: 'balanced' },
  ]);
  assert.equal(payload.sources.length, 2);
  assert.deepEqual(payload.sources.map((source) => source.id), ['a', 'b']);
  assert.equal(payload.multiview.gridSize, 2);
  assert.deepEqual(payload.multiview.slots, ['a', null, 'b', null]);
  assert.equal(validateImportPayload(payload), payload);
  assert.throws(() => validateImportPayload({ format: 'other', version: 1 }), /compatible/i);
  assert.throws(() => validateImportPayload({ ...payload, multiview: { ...payload.multiview, slots: ['a'] } }), /espacios/i);
});
