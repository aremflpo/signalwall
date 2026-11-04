const { EventEmitter } = require('node:events');
const { spawnFfmpeg } = require('./ffmpeg');
const { redactStreamUrl } = require('./source-model');

function emptyRuntime() {
  return {
    status: 'stopped',
    clients: 0,
    bitrateKbps: 0,
    bytes: 0,
    retryIn: 0,
    lastError: null,
  };
}

class StreamManager extends EventEmitter {
  constructor({ getSources, getFfmpegPath }) {
    super();
    this.getSources = getSources;
    this.getFfmpegPath = getFfmpegPath;
    this.streams = new Map();
  }

  getSource(id) {
    return this.getSources().find((source) => source.id === id);
  }

  ensureRuntime(id) {
    if (!this.streams.has(id)) {
      this.streams.set(id, {
        ...emptyRuntime(),
        desired: false,
        process: null,
        retryTimer: null,
        retryAttempt: 0,
        clientsSet: new Set(),
        lastBytes: 0,
        lastStatsAt: Date.now(),
        liveSince: 0,
      });
    }
    return this.streams.get(id);
  }

  publicRuntime(id) {
    const runtime = this.streams.get(id);
    if (!runtime) return emptyRuntime();
    return {
      status: runtime.status,
      clients: runtime.clientsSet.size,
      bitrateKbps: runtime.bitrateKbps,
      bytes: runtime.bytes,
      retryIn: runtime.retryIn,
      lastError: runtime.lastError,
    };
  }

  emitStatus(id) {
    this.emit('status', { id, ...this.publicRuntime(id) });
  }

  start(id) {
    const source = this.getSource(id);
    if (!source) throw new Error('La fuente no existe.');

    const runtime = this.ensureRuntime(id);
    runtime.desired = true;
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;

    if (runtime.process) return this.publicRuntime(id);

    runtime.status = 'connecting';
    runtime.retryIn = 0;
    runtime.lastError = null;
    this.emitStatus(id);

    const child = spawnFfmpeg(this.getFfmpegPath(), source);
    runtime.process = child;
    runtime.lastBytes = runtime.bytes;
    runtime.lastStatsAt = Date.now();
    let stderrBuffer = '';

    child.stdout.on('data', (chunk) => {
      if (runtime.process !== child) return;

      runtime.bytes += chunk.length;
      if (runtime.status !== 'live') {
        runtime.status = 'live';
        runtime.liveSince = Date.now();
        runtime.retryAttempt = 0;
        this.emitStatus(id);
      }

      const now = Date.now();
      if (now - runtime.lastStatsAt >= 1000) {
        const deltaBytes = runtime.bytes - runtime.lastBytes;
        runtime.bitrateKbps = Math.round((deltaBytes * 8) / (now - runtime.lastStatsAt));
        runtime.lastBytes = runtime.bytes;
        runtime.lastStatsAt = now;
        this.emitStatus(id);
      }

      for (const response of runtime.clientsSet) {
        if (!response.destroyed && !response.writableEnded) {
          response.write(chunk);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString('utf8')}`.slice(-6000);
    });

    child.on('error', (error) => {
      runtime.lastError = this.sanitizeError(error.message, source);
    });

    child.on('close', (code, signal) => {
      if (runtime.process !== child) return;
      runtime.process = null;
      runtime.bitrateKbps = 0;

      for (const response of runtime.clientsSet) {
        if (!response.writableEnded) response.end();
      }
      runtime.clientsSet.clear();

      if (!runtime.desired) {
        runtime.status = 'stopped';
        runtime.retryIn = 0;
        this.emitStatus(id);
        return;
      }

      const detail = stderrBuffer.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' · ');
      runtime.lastError = this.sanitizeError(
        detail || `FFmpeg terminó (${signal || code || 'sin detalle'}).`,
        source,
      );
      this.scheduleRetry(id);
    });

    return this.publicRuntime(id);
  }

  sanitizeError(message, source) {
    return String(message || 'Error desconocido')
      .replaceAll(source.url, redactStreamUrl(source.url))
      .replace(/(srt|rtmps?):\/\/[^\s]+/gi, (value) => redactStreamUrl(value))
      .slice(0, 500);
  }

  scheduleRetry(id) {
    const runtime = this.ensureRuntime(id);
    runtime.retryAttempt += 1;
    const delaySeconds = Math.min(15, 2 ** Math.min(runtime.retryAttempt - 1, 4));
    runtime.status = 'reconnecting';
    runtime.retryIn = delaySeconds;
    this.emitStatus(id);

    const tick = () => {
      if (!runtime.desired) return;
      runtime.retryIn -= 1;
      if (runtime.retryIn <= 0) {
        runtime.retryTimer = null;
        this.start(id);
      } else {
        this.emitStatus(id);
        runtime.retryTimer = setTimeout(tick, 1000);
      }
    };
    runtime.retryTimer = setTimeout(tick, 1000);
  }

  stop(id) {
    const runtime = this.ensureRuntime(id);
    runtime.desired = false;
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
    runtime.retryIn = 0;

    for (const response of runtime.clientsSet) {
      if (!response.writableEnded) response.end();
    }
    runtime.clientsSet.clear();

    if (runtime.process) {
      const child = runtime.process;
      runtime.process = null;
      child.kill('SIGTERM');
    }

    runtime.status = 'stopped';
    runtime.bitrateKbps = 0;
    this.emitStatus(id);
    return this.publicRuntime(id);
  }

  remove(id) {
    this.stop(id);
    this.streams.delete(id);
  }

  attachClient(id, response) {
    const source = this.getSource(id);
    if (!source) return false;
    const runtime = this.ensureRuntime(id);
    runtime.clientsSet.add(response);
    this.emitStatus(id);

    response.on('close', () => {
      runtime.clientsSet.delete(response);
      this.emitStatus(id);
    });

    if (!runtime.desired) this.start(id);
    return true;
  }

  stopAll() {
    for (const source of this.getSources()) this.stop(source.id);
  }
}

module.exports = { StreamManager, emptyRuntime };
