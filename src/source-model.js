const { randomUUID } = require('node:crypto');

const SUPPORTED_PROTOCOLS = new Set(['srt:', 'rtmp:', 'rtmps:']);

function parseStreamUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('La URL de la fuente es obligatoria.');
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('La URL de la fuente no es válida.');
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('El protocolo debe ser SRT, RTMP o RTMPS.');
  }

  if (!parsed.hostname) {
    throw new Error('La URL debe incluir un host.');
  }

  return parsed;
}

function redactStreamUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = '••••••';
    return parsed.toString();
  } catch {
    return value;
  }
}

function normalizeSource(input, existingId) {
  const parsed = parseStreamUrl(input.url);
  const protocol = parsed.protocol.replace(':', '').toUpperCase();
  const latency = Number(input.latency);
  const profile = ['copy', 'balanced', 'performance'].includes(input.profile)
    ? input.profile
    : 'balanced';

  return {
    id: existingId || randomUUID(),
    name: String(input.name || `${protocol} ${parsed.hostname}`).trim().slice(0, 80),
    type: protocol,
    url: parsed.toString(),
    latency: Number.isFinite(latency) ? Math.min(8000, Math.max(20, Math.round(latency))) : 120,
    profile,
  };
}

module.exports = {
  SUPPORTED_PROTOCOLS,
  normalizeSource,
  parseStreamUrl,
  redactStreamUrl,
};
