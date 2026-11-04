const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { ConfigStore } = require('./config-store');
const { checkFfmpeg } = require('./ffmpeg');
const { normalizeSource } = require('./source-model');
const { StreamManager } = require('./stream-manager');
const { StreamServer } = require('./stream-server');
const {
  createMultiview,
  makeExportPayload,
  resizeMultiview,
  unassignSource,
  validateImportPayload,
} = require('./multiview-model');

let mainWindow;
let store;
let streamManager;
let streamServer;
let pendingImportPath = null;

const isSmokeTest = process.argv.includes('--smoke-test');
if (isSmokeTest) {
  app.setPath('userData', path.resolve(process.cwd(), 'work', 'smoke-profile'));
}

function multiviewPathFromArgs(argv) {
  return argv.find((argument) => typeof argument === 'string' && argument.toLowerCase().endsWith('.signalwall')) || null;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', async (_event, argv) => {
    const filePath = multiviewPathFromArgs(argv);
    if (filePath && store) {
      try {
        const nextState = await importMultiviewFile(filePath);
        mainWindow?.webContents.send('app:state-replaced', nextState);
      } catch (error) {
        dialog.showErrorBox('No se pudo abrir el multiview', error.message);
      }
    } else if (filePath) {
      pendingImportPath = filePath;
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    backgroundColor: '#070906',
    title: 'Signal Wall',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const smokeDirectory = path.resolve(process.cwd(), 'work', 'smoke');
        await fs.mkdir(smokeDirectory, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 800));
        const gridCapture = await mainWindow.webContents.capturePage();
        await fs.writeFile(path.join(smokeDirectory, 'grid-2x2.png'), gridCapture.toPNG());
        await mainWindow.webContents.executeJavaScript(`(() => {
          const source = document.querySelector('[data-source-id="00000000-0000-4000-8000-000000000003"]');
          const target = document.querySelector('[data-slot-index="3"]');
          const transfer = new DataTransfer();
          source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
          target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const draggedCapture = await mainWindow.webContents.capturePage();
        await fs.writeFile(path.join(smokeDirectory, 'grid-dragged.png'), draggedCapture.toPNG());
        await mainWindow.webContents.executeJavaScript("document.querySelector('[data-columns=\"3\"]').click()");
        await new Promise((resolve) => setTimeout(resolve, 250));
        const grid3Capture = await mainWindow.webContents.capturePage();
        await fs.writeFile(path.join(smokeDirectory, 'grid-3x3.png'), grid3Capture.toPNG());
        await mainWindow.webContents.executeJavaScript("document.querySelector('[data-columns=\"4\"]').click()");
        await new Promise((resolve) => setTimeout(resolve, 250));
        const grid4Capture = await mainWindow.webContents.capturePage();
        await fs.writeFile(path.join(smokeDirectory, 'grid-4x4.png'), grid4Capture.toPNG());
        await mainWindow.webContents.executeJavaScript("document.querySelector('#new-wall-button').click()");
        await new Promise((resolve) => setTimeout(resolve, 200));
        const newWallDialogCapture = await mainWindow.webContents.capturePage();
        await fs.writeFile(path.join(smokeDirectory, 'new-wall-dialog.png'), newWallDialogCapture.toPNG());
        await mainWindow.webContents.executeJavaScript(`(() => {
          document.querySelector('#multiview-name').value = 'Muro secundario';
          document.querySelector('[name="gridSize"][value="2"]').checked = true;
          const form = document.querySelector('#multiview-form');
          form.requestSubmit(form.querySelector('button[value="default"]'));
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await mainWindow.webContents.executeJavaScript(`(() => {
          const selected = document.querySelector('#multiview-select option:checked');
          const slots = document.querySelectorAll('#video-grid [data-slot-index]');
          if (selected?.textContent !== 'Muro secundario' || slots.length !== 4) {
            throw new Error('El nuevo multiview no conservó su nombre o layout 2x2.');
          }
        })()`);
        const newWallCapture = await mainWindow.webContents.capturePage();
        await fs.writeFile(path.join(smokeDirectory, 'new-wall-created.png'), newWallCapture.toPNG());
        await mainWindow.webContents.executeJavaScript("document.querySelector('#add-source-button').click()");
        await new Promise((resolve) => setTimeout(resolve, 250));
        const dialogCapture = await mainWindow.webContents.capturePage();
        await fs.writeFile(path.join(smokeDirectory, 'source-dialog.png'), dialogCapture.toPNG());
        console.log(`Smoke captures: ${smokeDirectory}`);
        app.quit();
      } catch (error) {
        console.error('Smoke test failed:', error);
        app.exitCode = 1;
        app.quit();
      }
    });
  }
}

function sourceState(source) {
  return { ...source, runtime: streamManager.publicRuntime(source.id) };
}

function activeMultiview() {
  return store.data.multiviews.find((view) => view.id === store.data.activeMultiviewId)
    || store.data.multiviews[0];
}

function appState() {
  return {
    sources: store.data.sources.map(sourceState),
    multiviews: store.data.multiviews,
    activeMultiviewId: store.data.activeMultiviewId,
    settings: store.data.settings,
    ffmpeg: checkFfmpeg(store.data.settings.ffmpegPath),
    streamBaseUrl: streamServer.baseUrl(),
    migrations: store.migrations,
  };
}

function uniqueMultiviewName(requested) {
  const existing = new Set(store.data.multiviews.map((view) => view.name.toLocaleLowerCase()));
  const base = String(requested || 'Multiview importado').trim().slice(0, 70) || 'Multiview importado';
  if (!existing.has(base.toLocaleLowerCase())) return base;
  let suffix = 2;
  while (existing.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

async function importMultiviewFile(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > 2 * 1024 * 1024) throw new Error('El archivo es demasiado grande para ser un multiview.');
  const payload = validateImportPayload(JSON.parse(await fs.readFile(filePath, 'utf8')));

  const idMap = new Map();
  for (const imported of payload.sources) {
    if (typeof imported.id !== 'string' || imported.id.length > 100) {
      throw new Error('El archivo contiene una fuente sin identificador válido.');
    }
    const normalized = normalizeSource(imported);
    const existing = store.data.sources.find((source) => source.url === normalized.url);
    const source = existing || normalized;
    if (!existing) store.data.sources.push(source);
    idMap.set(imported.id, source.id);
  }

  const importedSlots = payload.multiview.slots.map((sourceId) => idMap.get(sourceId) || null);
  const multiview = createMultiview({
    name: uniqueMultiviewName(payload.multiview.name),
    gridSize: payload.multiview.gridSize,
    slots: importedSlots,
  }, new Set(store.data.sources.map((source) => source.id)));
  store.data.multiviews.push(multiview);
  store.data.activeMultiviewId = multiview.id;
  store.data.settings.columns = multiview.gridSize;
  store.save();
  return appState();
}

function registerIpc() {
  ipcMain.handle('app:get-state', () => appState());

  ipcMain.handle('source:add', (_event, input) => {
    const source = normalizeSource(input);
    store.data.sources.push(source);
    store.save();
    return sourceState(source);
  });

  ipcMain.handle('source:update', (_event, id, input) => {
    const index = store.data.sources.findIndex((source) => source.id === id);
    if (index < 0) throw new Error('La fuente no existe.');
    const wasRunning = streamManager.publicRuntime(id).status !== 'stopped';
    streamManager.stop(id);
    store.data.sources[index] = normalizeSource(input, id);
    store.save();
    if (wasRunning) streamManager.start(id);
    return sourceState(store.data.sources[index]);
  });

  ipcMain.handle('source:remove', (_event, id) => {
    streamManager.remove(id);
    store.data.sources = store.data.sources.filter((source) => source.id !== id);
    store.data.multiviews = store.data.multiviews.map((view) => unassignSource(view, id));
    store.save();
    return true;
  });

  ipcMain.handle('source:start', (_event, id) => streamManager.start(id));
  ipcMain.handle('source:stop', (_event, id) => streamManager.stop(id));
  ipcMain.handle('source:start-all', () => {
    const assignedIds = new Set(activeMultiview().slots.filter(Boolean));
    for (const source of store.data.sources) {
      if (assignedIds.has(source.id)) streamManager.start(source.id);
    }
    return true;
  });
  ipcMain.handle('source:stop-all', () => {
    streamManager.stopAll();
    return true;
  });

  ipcMain.handle('settings:set-columns', (_event, value) => {
    const columns = Math.min(4, Math.max(1, Number(value) || 2));
    const index = store.data.multiviews.findIndex((view) => view.id === store.data.activeMultiviewId);
    store.data.multiviews[index] = resizeMultiview(
      store.data.multiviews[index],
      columns,
      new Set(store.data.sources.map((source) => source.id)),
    );
    store.data.settings.columns = columns;
    store.save();
    return store.data.multiviews[index];
  });

  ipcMain.handle('multiview:save', (_event, input) => {
    const index = store.data.multiviews.findIndex((view) => view.id === input.id);
    if (index < 0) throw new Error('El multiview no existe.');
    store.data.multiviews[index] = createMultiview(
      { ...input, id: store.data.multiviews[index].id },
      new Set(store.data.sources.map((source) => source.id)),
    );
    store.data.settings.columns = store.data.multiviews[index].gridSize;
    store.save();
    return store.data.multiviews[index];
  });

  ipcMain.handle('multiview:create', (_event, name, gridSize) => {
    const multiview = createMultiview({ name: uniqueMultiviewName(name), gridSize });
    store.data.multiviews.push(multiview);
    store.data.activeMultiviewId = multiview.id;
    store.data.settings.columns = multiview.gridSize;
    store.save();
    return multiview;
  });

  ipcMain.handle('multiview:activate', (_event, id) => {
    const multiview = store.data.multiviews.find((view) => view.id === id);
    if (!multiview) throw new Error('El multiview no existe.');
    store.data.activeMultiviewId = id;
    store.data.settings.columns = multiview.gridSize;
    store.save();
    return multiview;
  });

  ipcMain.handle('multiview:export', async (_event, id) => {
    const multiview = store.data.multiviews.find((view) => view.id === id);
    if (!multiview) throw new Error('El multiview no existe.');
    const warning = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Exportar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Exportar multiview',
      message: 'El archivo incluirá las URLs de las señales.',
      detail: 'Si una URL contiene usuario, contraseña, stream key o passphrase, esa información viajará dentro del archivo. Compártelo sólo con personas de confianza.',
    });
    if (warning.response !== 0) return { canceled: true };

    const safeName = multiview.name.replace(/[^a-z0-9áéíóúüñ _-]/gi, '').trim() || 'multiview';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar multiview',
      defaultPath: `${safeName}.signalwall`,
      filters: [{ name: 'Signal Wall Multiview', extensions: ['signalwall'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const payload = makeExportPayload(multiview, store.data.sources);
    const exportPath = result.filePath.toLowerCase().endsWith('.signalwall')
      ? result.filePath
      : `${result.filePath}.signalwall`;
    await fs.writeFile(exportPath, JSON.stringify(payload, null, 2), 'utf8');
    return {
      canceled: false,
      filePath: exportPath,
      gridSize: multiview.gridSize,
      sourceCount: payload.sources.length,
    };
  });

  ipcMain.handle('multiview:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Importar multiview',
      properties: ['openFile'],
      filters: [{ name: 'Signal Wall Multiview', extensions: ['signalwall', 'json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, state: await importMultiviewFile(result.filePaths[0]) };
  });

  ipcMain.handle('settings:choose-ffmpeg', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar ffmpeg.exe',
      properties: ['openFile'],
      filters: [{ name: 'FFmpeg', extensions: ['exe'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const validation = checkFfmpeg(result.filePaths[0]);
    if (!validation.ok) throw new Error('El ejecutable seleccionado no es una instalación válida de FFmpeg.');
    store.data.settings.ffmpegPath = result.filePaths[0];
    store.save();
    return validation;
  });

  ipcMain.handle('app:open-external', (_event, url) => {
    const allowed = new URL(url);
    if (!['https:', 'http:'].includes(allowed.protocol)) throw new Error('Enlace no permitido.');
    return shell.openExternal(allowed.toString());
  });
}

app.whenReady().then(async () => {
  store = new ConfigStore(path.join(app.getPath('userData'), 'config.json'));
  if (isSmokeTest) {
    const smokeSources = [
      { id: '00000000-0000-4000-8000-000000000001', name: 'Cámara 1', type: 'SRT', url: 'srt://127.0.0.1:9101', latency: 120, profile: 'balanced' },
      { id: '00000000-0000-4000-8000-000000000002', name: 'Cámara 2', type: 'RTMP', url: 'rtmp://127.0.0.1/live/2', latency: 120, profile: 'balanced' },
      { id: '00000000-0000-4000-8000-000000000003', name: 'Cámara 3', type: 'SRT', url: 'srt://127.0.0.1:9103', latency: 120, profile: 'balanced' },
    ];
    const smokeMultiview = createMultiview({
      id: '00000000-0000-4000-8000-000000000010',
      name: 'Muro principal',
      gridSize: 2,
      slots: [smokeSources[0].id, smokeSources[1].id, smokeSources[2].id, null],
    }, new Set(smokeSources.map((source) => source.id)));
    store.data = {
      schemaVersion: 3,
      sources: smokeSources,
      multiviews: [smokeMultiview],
      activeMultiviewId: smokeMultiview.id,
      settings: { columns: 2, ffmpegPath: 'ffmpeg' },
    };
  }
  streamManager = new StreamManager({
    getSources: () => store.data.sources,
    getFfmpegPath: () => store.data.settings.ffmpegPath,
  });
  streamServer = new StreamServer(streamManager);
  await streamServer.start();

  streamManager.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stream:status', status);
    }
  });

  registerIpc();
  const launchImportPath = pendingImportPath || multiviewPathFromArgs(process.argv);
  if (launchImportPath && !isSmokeTest) {
    try {
      await importMultiviewFile(launchImportPath);
    } catch (error) {
      dialog.showErrorBox('No se pudo abrir el multiview', error.message);
    }
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  streamManager?.stopAll();
  streamServer?.close();
});
