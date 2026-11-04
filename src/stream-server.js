const http = require('node:http');

class StreamServer {
  constructor(streamManager) {
    this.streamManager = streamManager;
    this.server = null;
    this.port = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        response.setHeader('X-Content-Type-Options', 'nosniff');

        if (request.url === '/health') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ok: true }));
          return;
        }

        const match = request.url?.match(/^\/stream\/([a-f0-9-]+)$/i);
        if (!match || !this.streamManager.getSource(match[1])) {
          response.writeHead(404);
          response.end('Not found');
          return;
        }

        response.writeHead(200, {
          'Content-Type': 'video/mp2t',
          Connection: 'keep-alive',
          'Transfer-Encoding': 'chunked',
        });

        this.streamManager.attachClient(match[1], response);
      });

      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.baseUrl());
      });
    });
  }

  baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }
}

module.exports = { StreamServer };
