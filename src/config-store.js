const fs = require('node:fs');
const path = require('node:path');
const { createMultiview } = require('./multiview-model');

class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.migrations = [];
    const defaultMultiview = createMultiview({ name: 'Muro principal', gridSize: 2 });
    this.data = {
      schemaVersion: 3,
      sources: [],
      multiviews: [defaultMultiview],
      activeMultiviewId: defaultMultiview.id,
      settings: {
        columns: 2,
        ffmpegPath: 'ffmpeg',
      },
    };
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const needsCompatibilityMigration = Number(saved.schemaVersion || 1) < 2;
      const sources = Array.isArray(saved.sources) ? saved.sources : [];
      const validSourceIds = new Set(sources.map((source) => source.id));

      if (needsCompatibilityMigration) {
        let migratedSources = 0;
        for (const source of sources) {
          if (source.profile === 'copy') {
            source.profile = 'balanced';
            migratedSources += 1;
          }
        }
        if (migratedSources > 0) {
          this.migrations.push(
            `${migratedSources} fuente${migratedSources === 1 ? '' : 's'} cambió al perfil Equilibrado para evitar video negro.`,
          );
        }
      }

      let multiviews;
      if (Number(saved.schemaVersion || 1) < 3 || !Array.isArray(saved.multiviews)) {
        const gridSize = Math.min(4, Math.max(1, Number(saved.settings?.columns) || 2));
        const slots = Array(gridSize * gridSize).fill(null);
        sources.slice(0, slots.length).forEach((source, index) => { slots[index] = source.id; });
        multiviews = [createMultiview({ name: 'Muro principal', gridSize, slots }, validSourceIds)];
        this.migrations.push('El muro anterior se convirtió en un multiview guardado.');
      } else {
        multiviews = saved.multiviews.map((view) => createMultiview(view, validSourceIds));
        if (multiviews.length === 0) multiviews.push(createMultiview());
      }

      const activeMultiviewId = multiviews.some((view) => view.id === saved.activeMultiviewId)
        ? saved.activeMultiviewId
        : multiviews[0].id;

      this.data = {
        schemaVersion: 3,
        sources,
        multiviews,
        activeMultiviewId,
        settings: { ...this.data.settings, ...(saved.settings || {}) },
      };
      this.data.settings.columns = multiviews.find((view) => view.id === activeMultiviewId).gridSize;
      if (Number(saved.schemaVersion || 1) < 3) this.save();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('No se pudo leer la configuración:', error);
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    const retryableErrors = new Set(['EACCES', 'EBUSY', 'EPERM']);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.renameSync(tempPath, this.filePath);
        return;
      } catch (error) {
        if (!retryableErrors.has(error.code) || attempt === 4) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  }
}

module.exports = { ConfigStore };
