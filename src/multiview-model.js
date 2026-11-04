const { randomUUID } = require('node:crypto');

const MIN_GRID_SIZE = 1;
const MAX_GRID_SIZE = 4;
const EXPORT_FORMAT = 'signal-wall-multiview';
const EXPORT_VERSION = 1;

function clampGridSize(value) {
  return Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, Number(value) || 2));
}

function cleanName(value, fallback = 'Muro principal') {
  return String(value || fallback).trim().slice(0, 80) || fallback;
}

function normalizeSlots(slots, gridSize, validSourceIds = null) {
  const capacity = gridSize * gridSize;
  const result = Array(capacity).fill(null);
  const seen = new Set();

  for (let index = 0; index < capacity; index += 1) {
    const sourceId = typeof slots?.[index] === 'string' ? slots[index] : null;
    if (!sourceId || seen.has(sourceId)) continue;
    if (validSourceIds && !validSourceIds.has(sourceId)) continue;
    result[index] = sourceId;
    seen.add(sourceId);
  }
  return result;
}

function createMultiview(input = {}, validSourceIds = null) {
  const gridSize = clampGridSize(input.gridSize);
  return {
    id: String(input.id || randomUUID()),
    name: cleanName(input.name),
    gridSize,
    slots: normalizeSlots(input.slots, gridSize, validSourceIds),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function resizeMultiview(multiview, gridSize, validSourceIds = null) {
  return createMultiview({ ...multiview, gridSize, updatedAt: new Date().toISOString() }, validSourceIds);
}

function assignSourceToSlot(multiview, sourceId, targetIndex, validSourceIds = null) {
  const normalized = createMultiview(multiview, validSourceIds);
  const index = Number(targetIndex);
  if (!Number.isInteger(index) || index < 0 || index >= normalized.slots.length) {
    throw new Error('El espacio del multiview no es válido.');
  }
  if (validSourceIds && !validSourceIds.has(sourceId)) {
    throw new Error('La fuente no existe.');
  }

  const originIndex = normalized.slots.indexOf(sourceId);
  const displaced = normalized.slots[index];
  normalized.slots[index] = sourceId;
  if (originIndex >= 0 && originIndex !== index) {
    normalized.slots[originIndex] = displaced || null;
  }
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

function unassignSource(multiview, sourceId, validSourceIds = null) {
  const normalized = createMultiview(multiview, validSourceIds);
  normalized.slots = normalized.slots.map((id) => (id === sourceId ? null : id));
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

function makeExportPayload(multiview, sources) {
  const assignedIds = new Set(multiview.slots.filter(Boolean));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    multiview: {
      name: multiview.name,
      gridSize: multiview.gridSize,
      slots: [...multiview.slots],
    },
    sources: sources.filter(({ id }) => assignedIds.has(id)).map(({ id, name, type, url, latency, profile }) => ({
      id, name, type, url, latency, profile,
    })),
  };
}

function validateImportPayload(payload) {
  if (!payload || payload.format !== EXPORT_FORMAT || payload.version !== EXPORT_VERSION) {
    throw new Error('El archivo no es un multiview compatible de Signal Wall.');
  }
  if (!payload.multiview || !Array.isArray(payload.multiview.slots) || !Array.isArray(payload.sources)) {
    throw new Error('El archivo del multiview está incompleto.');
  }
  if (payload.sources.length > 64) throw new Error('El archivo contiene demasiadas fuentes.');
  const gridSize = Number(payload.multiview.gridSize);
  if (!Number.isInteger(gridSize) || gridSize < MIN_GRID_SIZE || gridSize > MAX_GRID_SIZE) {
    throw new Error('El archivo contiene un tamaño de layout no válido.');
  }
  if (payload.multiview.slots.length !== gridSize * gridSize) {
    throw new Error('El archivo no contiene todos los espacios del layout.');
  }
  const sourceIds = new Set();
  for (const source of payload.sources) {
    if (!source || typeof source.id !== 'string' || !source.id || sourceIds.has(source.id)) {
      throw new Error('El archivo contiene identificadores de señal no válidos.');
    }
    sourceIds.add(source.id);
  }
  for (const sourceId of payload.multiview.slots) {
    if (sourceId !== null && (!sourceIds.has(sourceId) || typeof sourceId !== 'string')) {
      throw new Error('El archivo contiene una señal que no existe en su biblioteca.');
    }
  }
  return payload;
}

module.exports = {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  assignSourceToSlot,
  clampGridSize,
  createMultiview,
  makeExportPayload,
  normalizeSlots,
  resizeMultiview,
  unassignSource,
  validateImportPayload,
};
