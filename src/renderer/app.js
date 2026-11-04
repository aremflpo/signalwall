import mpegts from 'mpegts.js';

const state = {
  sources: [],
  settings: { columns: 2 },
  streamBaseUrl: '',
  ffmpeg: { ok: false },
  players: new Map(),
  focusedId: null,
  audibleId: null,
  editingId: null,
  multiviews: [],
  activeMultiviewId: null,
  draggedSourceId: null,
  justDragged: false,
  compatibilityFallbacks: new Set(),
};

const elements = {
  grid: document.querySelector('#video-grid'),
  empty: document.querySelector('#empty-state'),
  sourceList: document.querySelector('#source-list'),
  sourceCount: document.querySelector('#source-count'),
  wallSummary: document.querySelector('#wall-summary'),
  multiviewSelect: document.querySelector('#multiview-select'),
  saveState: document.querySelector('#save-state'),
  newWall: document.querySelector('#new-wall-button'),
  saveWall: document.querySelector('#save-wall-button'),
  importWall: document.querySelector('#import-wall-button'),
  exportWall: document.querySelector('#export-wall-button'),
  multiviewDialog: document.querySelector('#multiview-dialog'),
  multiviewForm: document.querySelector('#multiview-form'),
  multiviewName: document.querySelector('#multiview-name'),
  multiviewFormError: document.querySelector('#multiview-form-error'),
  addSource: document.querySelector('#add-source-button'),
  emptyAdd: document.querySelector('#empty-add-button'),
  sourceDialog: document.querySelector('#source-dialog'),
  sourceDialogTitle: document.querySelector('#source-dialog-title'),
  sourceForm: document.querySelector('#source-form'),
  sourceFormError: document.querySelector('#source-form-error'),
  sourceName: document.querySelector('#source-name'),
  sourceUrl: document.querySelector('#source-url'),
  sourceLatency: document.querySelector('#source-latency'),
  sourceProfile: document.querySelector('#source-profile'),
  deleteSource: document.querySelector('#delete-source-button'),
  startAll: document.querySelector('#start-all-button'),
  stopAll: document.querySelector('#stop-all-button'),
  settingsButton: document.querySelector('#settings-button'),
  settingsDialog: document.querySelector('#settings-dialog'),
  chooseFfmpeg: document.querySelector('#choose-ffmpeg-button'),
  ffmpegDot: document.querySelector('#ffmpeg-dot'),
  ffmpegLabel: document.querySelector('#ffmpeg-label'),
  ffmpegDetail: document.querySelector('#ffmpeg-detail'),
  ndiInfo: document.querySelector('#ndi-info-button'),
  toastRegion: document.querySelector('#toast-region'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusLabel(runtime) {
  const labels = {
    stopped: 'Detenida',
    connecting: 'Conectando',
    live: 'En vivo',
    reconnecting: runtime.retryIn ? `Reintento · ${runtime.retryIn}s` : 'Reconectando',
  };
  return labels[runtime.status] || runtime.status;
}

function showToast(message, kind = 'normal') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  setTimeout(() => toast.remove(), 4000);
}

function renderSystemStatus() {
  elements.ffmpegDot.className = `system-dot ${state.ffmpeg.ok ? 'ok' : 'error'}`;
  elements.ffmpegLabel.textContent = state.ffmpeg.ok ? 'FFmpeg disponible' : 'FFmpeg no encontrado';
  elements.ffmpegDetail.textContent = state.ffmpeg.ok
    ? state.ffmpeg.version
    : state.ffmpeg.error || 'No se encontró ffmpeg.exe en la ruta configurada.';
}

function activeMultiview() {
  return state.multiviews.find((view) => view.id === state.activeMultiviewId)
    || state.multiviews[0];
}

function replaceMultiview(multiview) {
  const index = state.multiviews.findIndex((view) => view.id === multiview.id);
  if (index >= 0) state.multiviews[index] = multiview;
  else state.multiviews.push(multiview);
  state.activeMultiviewId = multiview.id;
  state.settings.columns = multiview.gridSize;
}

function renderMultiviewPicker() {
  elements.multiviewSelect.innerHTML = state.multiviews.map((view) => `
    <option value="${view.id}"${view.id === state.activeMultiviewId ? ' selected' : ''}>${escapeHtml(view.name)}</option>
  `).join('');
}

function renderLayoutPicker() {
  const gridSize = activeMultiview()?.gridSize || state.settings.columns || 2;
  elements.grid.style.setProperty('--grid-size', gridSize);
  elements.grid.dataset.size = gridSize;
  for (const button of document.querySelectorAll('[data-columns]')) {
    button.classList.toggle('active', Number(button.dataset.columns) === Number(gridSize));
  }
}

function renderSources() {
  const multiview = activeMultiview();
  elements.sourceCount.textContent = state.sources.length;
  elements.empty.classList.toggle('hidden', state.sources.length > 0);
  elements.sourceList.innerHTML = state.sources.map((source) => {
    const slotIndex = multiview?.slots.indexOf(source.id) ?? -1;
    return `
    <div class="source-item" draggable="true" data-source-id="${source.id}" title="Arrastrar ${escapeHtml(source.name)}">
      <span class="status-indicator ${source.runtime.status}"></span>
      <span class="source-copy">
        <strong>${escapeHtml(source.name)}</strong>
        <small>${escapeHtml(source.type)} · ${statusLabel(source.runtime)}${slotIndex >= 0 ? ` <span class="slot-badge">SLOT ${String(slotIndex + 1).padStart(2, '0')}</span>` : ''}</small>
      </span>
      <button class="source-menu" type="button" data-action="edit" aria-label="Editar">•••</button>
    </div>
  `;
  }).join('');
}

function destroyPlayer(id) {
  const entry = state.players.get(id);
  if (!entry) return;
  clearTimeout(entry.recoveryTimer);
  clearTimeout(entry.decodeTimer);
  try {
    entry.player.pause();
    entry.player.unload();
    entry.player.detachMediaElement();
    entry.player.destroy();
  } catch {
    // El reproductor puede haber cerrado su MediaSource antes de este ciclo.
  }
  state.players.delete(id);
}

function playbackMessage(id, message, isError = false) {
  const tile = document.querySelector(`[data-tile-id="${id}"]`);
  if (!tile) return;
  tile.querySelector('.no-signal-mark').textContent = message;
  tile.querySelector('.tile-error').textContent = isError ? message : '';
}

async function fallbackToBalanced(source) {
  if (source.profile !== 'copy' || state.compatibilityFallbacks.has(source.id)) return;
  state.compatibilityFallbacks.add(source.id);
  playbackMessage(source.id, 'Reparando compatibilidad…');
  showToast(`${source.name}: la copia directa no entregó un cuadro válido. Cambiando a Equilibrado.`);

  try {
    const saved = await window.signalWall.updateSource(source.id, {
      ...source,
      profile: 'balanced',
    });
    const index = state.sources.findIndex((item) => item.id === source.id);
    if (index >= 0) state.sources[index] = saved;
    destroyPlayer(source.id);
    renderSources();
    renderGrid();
  } catch (error) {
    playbackMessage(source.id, `No se pudo activar compatibilidad: ${error.message}`, true);
  }
}

function setupPlayer(source) {
  if (state.players.has(source.id) || source.runtime.status === 'stopped') return;
  const video = document.querySelector(`[data-tile-id="${source.id}"] video`);
  if (!video) return;

  if (!mpegts.getFeatureList().mseLivePlayback) {
    showToast('Este equipo no ofrece reproducción MSE en vivo.', 'error');
    return;
  }

  const player = mpegts.createPlayer({
    type: 'mpegts',
    isLive: true,
    cors: true,
    url: `${state.streamBaseUrl}/stream/${source.id}`,
  }, {
    enableWorkerForMSE: false,
    enableStashBuffer: false,
    stashInitialSize: 128,
    lazyLoad: false,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 15,
    autoCleanupMinBackwardDuration: 5,
    liveBufferLatencyChasing: true,
    liveBufferLatencyMaxLatency: 1.5,
    liveBufferLatencyMinRemain: 0.25,
  });

  const entry = { player, recoveryTimer: null, decodeTimer: null };
  state.players.set(source.id, entry);
  video.muted = state.audibleId !== source.id;
  const markPlaying = () => {
    const tile = document.querySelector(`[data-tile-id="${source.id}"]`);
    tile?.classList.add('playing');
    if (tile) tile.querySelector('.tile-error').textContent = '';
    clearTimeout(entry.decodeTimer);
  };
  video.addEventListener('playing', markPlaying);
  video.addEventListener('loadeddata', markPlaying);
  player.attachMediaElement(video);
  player.load();
  player.play().catch(() => {});
  entry.decodeTimer = setTimeout(() => {
    if (video.videoWidth > 0 || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (source.profile === 'copy') {
      fallbackToBalanced(source);
    } else {
      playbackMessage(source.id, 'Señal recibida, pero todavía no hay un cuadro decodificable', true);
    }
  }, 7000);

  player.on(mpegts.Events.ERROR, (type, detail) => {
    playbackMessage(source.id, `Reproductor: ${detail || type || 'error de video'}`, true);
    clearTimeout(entry.recoveryTimer);
    entry.recoveryTimer = setTimeout(() => {
      const current = state.sources.find((item) => item.id === source.id);
      if (current && ['connecting', 'live'].includes(current.runtime.status)) {
        destroyPlayer(source.id);
        setupPlayer(current);
      }
    }, 2500);
  });
}

function createTile(source, slotIndex) {
  const tile = document.createElement('article');
  tile.className = `video-tile ${source.runtime.status}`;
  tile.dataset.tileId = source.id;
  tile.dataset.slotIndex = slotIndex;
  tile.draggable = true;
  tile.innerHTML = `
    <video autoplay playsinline muted></video>
    <div class="no-signal"><span class="no-signal-mark">${source.runtime.status === 'live' ? 'Recibiendo · esperando video' : statusLabel(source.runtime)}</span></div>
    <div class="tile-top">
      <div class="tile-name">
        <span class="status-indicator ${source.runtime.status}"></span>
        <strong>${escapeHtml(source.name)}</strong>
      </div>
      <span class="protocol-badge">${escapeHtml(source.type)}</span>
    </div>
    <div class="tile-bottom">
      <div>
        <div class="tile-stats">${source.runtime.bitrateKbps ? `${source.runtime.bitrateKbps} kb/s` : statusLabel(source.runtime)}</div>
      </div>
      <div class="tile-actions">
        <button class="tile-button" type="button" data-action="audio" title="Escuchar audio">◖))</button>
        <button class="tile-button" type="button" data-action="toggle" title="Iniciar o detener">${source.runtime.status === 'stopped' ? '▶' : '■'}</button>
        <button class="tile-button" type="button" data-action="unassign" title="Quitar del multiview">×</button>
        <button class="tile-button" type="button" data-action="edit" title="Editar">•••</button>
      </div>
    </div>
    <div class="tile-error"></div>
  `;
  elements.grid.append(tile);
  if (source.runtime.status !== 'stopped') setupPlayer(source);
}

function createEmptyTile(slotIndex) {
  const tile = document.createElement('div');
  tile.className = 'empty-tile';
  tile.dataset.slotIndex = slotIndex;
  tile.setAttribute('aria-label', `Espacio ${slotIndex + 1} sin fuente`);
  tile.innerHTML = `<em>Soltar señal</em><span>${String(slotIndex + 1).padStart(2, '0')}</span>`;
  elements.grid.append(tile);
}

function renderGrid() {
  for (const id of state.players.keys()) destroyPlayer(id);
  elements.grid.innerHTML = '';
  const multiview = activeMultiview();
  if (!multiview) return;
  for (let slotIndex = 0; slotIndex < multiview.slots.length; slotIndex += 1) {
    const source = state.sources.find((item) => item.id === multiview.slots[slotIndex]);
    if (source) createTile(source, slotIndex);
    else createEmptyTile(slotIndex);
  }
  updateSummary();
}

function renderAll() {
  renderSystemStatus();
  renderMultiviewPicker();
  renderLayoutPicker();
  renderSources();
  renderGrid();
}

function updateSummary() {
  const live = state.sources.filter((source) => source.runtime.status === 'live').length;
  const active = state.sources.filter((source) => source.runtime.status !== 'stopped').length;
  const multiview = activeMultiview();
  const assigned = multiview?.slots.filter(Boolean).length || 0;
  const size = multiview?.gridSize || 2;
  elements.wallSummary.textContent = `${size}×${size} · ${assigned} asignadas · ${live} en vivo · ${active} activas`;
}

async function persistActiveMultiview({ notify = false } = {}) {
  const multiview = activeMultiview();
  if (!multiview) return null;
  elements.saveState.textContent = 'Guardando…';
  elements.saveState.classList.add('saving');
  try {
    const saved = await window.signalWall.saveMultiview(multiview);
    replaceMultiview(saved);
    elements.saveState.textContent = 'Guardado';
    elements.saveState.classList.remove('saving');
    if (notify) showToast(`“${saved.name}” guardado.`);
    return saved;
  } catch (error) {
    elements.saveState.textContent = 'Error al guardar';
    elements.saveState.classList.remove('saving');
    showToast(error.message, 'error');
    return null;
  }
}

async function assignSource(sourceId, targetIndex) {
  const multiview = activeMultiview();
  const source = state.sources.find((item) => item.id === sourceId);
  if (!multiview || !source) return;
  const index = Number(targetIndex);
  if (!Number.isInteger(index) || index < 0 || index >= multiview.slots.length) return;

  const slots = [...multiview.slots];
  const originIndex = slots.indexOf(sourceId);
  const displaced = slots[index];
  slots[index] = sourceId;
  if (originIndex >= 0 && originIndex !== index) slots[originIndex] = displaced || null;
  replaceMultiview({ ...multiview, slots, updatedAt: new Date().toISOString() });
  renderSources();
  renderGrid();
  await persistActiveMultiview();
  if (source.runtime.status === 'stopped' && state.ffmpeg.ok) {
    await window.signalWall.startSource(source.id);
  }
}

async function unassignSource(sourceId) {
  const multiview = activeMultiview();
  if (!multiview || !multiview.slots.includes(sourceId)) return;
  const slots = multiview.slots.map((id) => (id === sourceId ? null : id));
  replaceMultiview({ ...multiview, slots, updatedAt: new Date().toISOString() });
  renderSources();
  renderGrid();
  await persistActiveMultiview();
}

function clearDragState() {
  document.querySelectorAll('.dragging, .drop-target').forEach((element) => {
    element.classList.remove('dragging', 'drop-target');
  });
  elements.grid.classList.remove('is-dragging');
  state.draggedSourceId = null;
}

function updateRuntime(status) {
  const source = state.sources.find((item) => item.id === status.id);
  if (!source) return;
  const previousStatus = source.runtime.status;
  source.runtime = status;

  const sidebarItem = document.querySelector(`.source-item[data-source-id="${status.id}"]`);
  if (sidebarItem) {
    sidebarItem.querySelector('.status-indicator').className = `status-indicator ${status.status}`;
    const slotIndex = activeMultiview()?.slots.indexOf(source.id) ?? -1;
    sidebarItem.querySelector('small').innerHTML = `${escapeHtml(source.type)} · ${escapeHtml(statusLabel(status))}${slotIndex >= 0 ? ` <span class="slot-badge">SLOT ${String(slotIndex + 1).padStart(2, '0')}</span>` : ''}`;
  }

  const tile = document.querySelector(`[data-tile-id="${status.id}"]`);
  if (tile) {
    tile.classList.remove('stopped', 'connecting', 'live', 'reconnecting');
    tile.classList.add(status.status);
    tile.classList.toggle('focused', state.focusedId === status.id);
    tile.querySelector('.status-indicator').className = `status-indicator ${status.status}`;
    if (!tile.classList.contains('playing')) {
      tile.querySelector('.no-signal-mark').textContent = status.status === 'live'
        ? 'Recibiendo · esperando video'
        : statusLabel(status);
    }
    tile.querySelector('.tile-stats').textContent = status.bitrateKbps ? `${status.bitrateKbps} kb/s` : statusLabel(status);
    tile.querySelector('[data-action="toggle"]').textContent = status.status === 'stopped' ? '▶' : '■';
    tile.querySelector('.tile-error').textContent = status.lastError || '';
  }

  if (status.status === 'stopped' || status.status === 'reconnecting') {
    destroyPlayer(status.id);
  } else if (previousStatus !== status.status || !state.players.has(status.id)) {
    setupPlayer(source);
  }
  updateSummary();
}

function openSourceDialog(source = null) {
  state.editingId = source?.id || null;
  elements.sourceDialogTitle.textContent = source ? 'Editar fuente' : 'Nueva fuente';
  elements.sourceName.value = source?.name || '';
  elements.sourceUrl.value = source?.url || '';
  elements.sourceLatency.value = source?.latency || 120;
  elements.sourceProfile.value = source?.profile || 'balanced';
  elements.deleteSource.classList.toggle('hidden', !source);
  elements.sourceFormError.textContent = '';
  elements.sourceDialog.showModal();
  setTimeout(() => (source ? elements.sourceName : elements.sourceUrl).focus(), 0);
}

async function saveSource(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    elements.sourceDialog.close();
    return;
  }
  if (!elements.sourceForm.reportValidity()) return;
  const input = {
    name: elements.sourceName.value,
    url: elements.sourceUrl.value,
    latency: elements.sourceLatency.value,
    profile: elements.sourceProfile.value,
  };

  try {
    const saved = state.editingId
      ? await window.signalWall.updateSource(state.editingId, input)
      : await window.signalWall.addSource(input);
    const index = state.sources.findIndex((source) => source.id === saved.id);
    if (index >= 0) state.sources[index] = saved;
    else state.sources.push(saved);
    elements.sourceDialog.close();
    renderSources();
    renderGrid();
    showToast(state.editingId ? 'Fuente actualizada.' : 'Fuente agregada. Arrástrala desde la biblioteca al muro.');
  } catch (error) {
    elements.sourceFormError.textContent = error.message;
  }
}

async function toggleSource(source) {
  try {
    if (!state.ffmpeg.ok) {
      elements.settingsDialog.showModal();
      throw new Error('Selecciona una instalación válida de FFmpeg para iniciar señales.');
    }
    if (source.runtime.status === 'stopped') await window.signalWall.startSource(source.id);
    else await window.signalWall.stopSource(source.id);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function toggleAudio(id) {
  state.audibleId = state.audibleId === id ? null : id;
  for (const source of state.sources) {
    const video = document.querySelector(`[data-tile-id="${source.id}"] video`);
    const button = document.querySelector(`[data-tile-id="${source.id}"] [data-action="audio"]`);
    if (video) {
      video.muted = state.audibleId !== source.id;
      if (!video.muted) video.play().catch(() => {});
    }
    button?.classList.toggle('audio-on', state.audibleId === source.id);
  }
}

function toggleFocus(id) {
  state.focusedId = state.focusedId === id ? null : id;
  elements.grid.classList.toggle('has-focus', Boolean(state.focusedId));
  for (const tile of elements.grid.children) {
    tile.classList.toggle('focused', tile.dataset.tileId === state.focusedId);
  }
}

elements.addSource.addEventListener('click', () => openSourceDialog());
elements.emptyAdd.addEventListener('click', () => openSourceDialog());
elements.sourceForm.addEventListener('submit', saveSource);
elements.deleteSource.addEventListener('click', async () => {
  if (!state.editingId) return;
  const source = state.sources.find((item) => item.id === state.editingId);
  if (!source || !window.confirm(`¿Eliminar “${source.name}”?`)) return;
  try {
    await window.signalWall.removeSource(source.id);
    destroyPlayer(source.id);
    state.sources = state.sources.filter((item) => item.id !== source.id);
    state.multiviews = state.multiviews.map((view) => ({
      ...view,
      slots: view.slots.map((id) => (id === source.id ? null : id)),
    }));
    elements.sourceDialog.close();
    renderSources();
    renderGrid();
    showToast('Fuente eliminada.');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

elements.sourceList.addEventListener('click', (event) => {
  if (state.justDragged) return;
  const item = event.target.closest('[data-source-id]');
  const source = state.sources.find((entry) => entry.id === item?.dataset.sourceId);
  if (source) openSourceDialog(source);
});

elements.grid.addEventListener('click', async (event) => {
  const tile = event.target.closest('[data-tile-id]');
  const action = event.target.closest('[data-action]')?.dataset.action;
  const source = state.sources.find((entry) => entry.id === tile?.dataset.tileId);
  if (!source || !action) return;
  if (action === 'toggle') await toggleSource(source);
  if (action === 'edit') openSourceDialog(source);
  if (action === 'audio') toggleAudio(source.id);
  if (action === 'unassign') await unassignSource(source.id);
});

elements.grid.addEventListener('dblclick', (event) => {
  const tile = event.target.closest('[data-tile-id]');
  if (tile) toggleFocus(tile.dataset.tileId);
});

document.querySelector('.layout-picker').addEventListener('click', async (event) => {
  const columns = Number(event.target.closest('[data-columns]')?.dataset.columns);
  if (!columns) return;
  const previousAssignments = activeMultiview().slots.filter(Boolean).length;
  const resized = await window.signalWall.setColumns(columns);
  replaceMultiview(resized);
  const currentAssignments = resized.slots.filter(Boolean).length;
  renderLayoutPicker();
  renderSources();
  renderGrid();
  if (currentAssignments < previousAssignments) {
    showToast('Las señales fuera del nuevo tamaño regresaron a la biblioteca.');
  }
});

elements.sourceList.addEventListener('dragstart', (event) => {
  const item = event.target.closest('[data-source-id]');
  if (!item || event.target.closest('button')) {
    event.preventDefault();
    return;
  }
  state.draggedSourceId = item.dataset.sourceId;
  item.classList.add('dragging');
  elements.grid.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', state.draggedSourceId);
});

elements.grid.addEventListener('dragstart', (event) => {
  const tile = event.target.closest('[data-tile-id]');
  if (!tile || event.target.closest('button')) {
    event.preventDefault();
    return;
  }
  state.draggedSourceId = tile.dataset.tileId;
  tile.classList.add('dragging');
  elements.grid.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', state.draggedSourceId);
});

elements.grid.addEventListener('dragover', (event) => {
  if (!state.draggedSourceId) return;
  const slot = event.target.closest('[data-slot-index]');
  if (!slot) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  elements.grid.querySelectorAll('.drop-target').forEach((element) => element.classList.remove('drop-target'));
  slot.classList.add('drop-target');
});

elements.grid.addEventListener('drop', async (event) => {
  const slot = event.target.closest('[data-slot-index]');
  const sourceId = state.draggedSourceId || event.dataTransfer.getData('text/plain');
  event.preventDefault();
  clearDragState();
  state.justDragged = true;
  setTimeout(() => { state.justDragged = false; }, 0);
  if (slot && sourceId) await assignSource(sourceId, Number(slot.dataset.slotIndex));
});

elements.sourceList.addEventListener('dragover', (event) => {
  if (!state.draggedSourceId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  elements.sourceList.classList.add('drop-target');
});

elements.sourceList.addEventListener('dragleave', (event) => {
  if (!elements.sourceList.contains(event.relatedTarget)) elements.sourceList.classList.remove('drop-target');
});

elements.sourceList.addEventListener('drop', async (event) => {
  const sourceId = state.draggedSourceId || event.dataTransfer.getData('text/plain');
  event.preventDefault();
  clearDragState();
  state.justDragged = true;
  setTimeout(() => { state.justDragged = false; }, 0);
  if (sourceId) await unassignSource(sourceId);
});

document.addEventListener('dragend', () => {
  state.justDragged = true;
  clearDragState();
  setTimeout(() => { state.justDragged = false; }, 0);
});

elements.multiviewSelect.addEventListener('change', async () => {
  try {
    const multiview = await window.signalWall.activateMultiview(elements.multiviewSelect.value);
    replaceMultiview(multiview);
    renderLayoutPicker();
    renderSources();
    renderGrid();
  } catch (error) {
    showToast(error.message, 'error');
  }
});

function openMultiviewDialog() {
  elements.multiviewName.value = `Multiview ${state.multiviews.length + 1}`;
  elements.multiviewFormError.textContent = '';
  const gridSize = activeMultiview()?.gridSize || 2;
  const sizeOption = elements.multiviewForm.querySelector(`[name="gridSize"][value="${gridSize}"]`);
  if (sizeOption) sizeOption.checked = true;
  elements.multiviewDialog.showModal();
  setTimeout(() => elements.multiviewName.select(), 0);
}

async function createNewMultiview(event) {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    elements.multiviewDialog.close();
    return;
  }
  if (!elements.multiviewForm.reportValidity()) return;

  const gridSize = Number(new FormData(elements.multiviewForm).get('gridSize')) || 2;
  try {
    const multiview = await window.signalWall.createMultiview(elements.multiviewName.value, gridSize);
    replaceMultiview(multiview);
    elements.multiviewDialog.close();
    renderMultiviewPicker();
    renderLayoutPicker();
    renderSources();
    renderGrid();
    showToast(`“${multiview.name}” creado. Arrastra señales para diseñarlo.`);
  } catch (error) {
    elements.multiviewFormError.textContent = error.message;
  }
}

elements.newWall.addEventListener('click', openMultiviewDialog);
elements.multiviewForm.addEventListener('submit', createNewMultiview);

elements.saveWall.addEventListener('click', () => persistActiveMultiview({ notify: true }));

elements.exportWall.addEventListener('click', async () => {
  try {
    const saved = await persistActiveMultiview();
    if (!saved) return;
    const result = await window.signalWall.exportMultiview(saved.id);
    if (!result.canceled) {
      showToast(`${saved.gridSize}×${saved.gridSize} exportado con ${result.sourceCount} señal${result.sourceCount === 1 ? '' : 'es'} y sus posiciones.`);
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
});

elements.importWall.addEventListener('click', async () => {
  try {
    const result = await window.signalWall.importMultiview();
    if (result.canceled) return;
    state.sources = result.state.sources;
    state.multiviews = result.state.multiviews;
    state.activeMultiviewId = result.state.activeMultiviewId;
    state.settings = result.state.settings;
    state.ffmpeg = result.state.ffmpeg;
    state.streamBaseUrl = result.state.streamBaseUrl;
    renderAll();
    const imported = activeMultiview();
    const assigned = imported.slots.filter(Boolean).length;
    showToast(`“${imported.name}” importado: ${imported.gridSize}×${imported.gridSize}, ${assigned} señal${assigned === 1 ? '' : 'es'} en sus posiciones.`);
  } catch (error) {
    showToast(error.message, 'error');
  }
});

elements.startAll.addEventListener('click', async () => {
  if (!state.ffmpeg.ok) {
    elements.settingsDialog.showModal();
    showToast('Selecciona una instalación válida de FFmpeg.', 'error');
    return;
  }
  await window.signalWall.startAll();
});

elements.stopAll.addEventListener('click', () => window.signalWall.stopAll());
elements.settingsButton.addEventListener('click', () => elements.settingsDialog.showModal());
elements.chooseFfmpeg.addEventListener('click', async () => {
  try {
    const result = await window.signalWall.chooseFfmpeg();
    if (result) {
      state.ffmpeg = result;
      renderSystemStatus();
      showToast('FFmpeg configurado correctamente.');
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
});
elements.ndiInfo.addEventListener('click', () => window.signalWall.openExternal('https://docs.ndi.video/all/developing-with-ndi/sdk'));

window.addEventListener('beforeunload', () => {
  for (const id of state.players.keys()) destroyPlayer(id);
});

async function init() {
  try {
    const initial = await window.signalWall.getState();
    Object.assign(state, initial);
    window.signalWall.onStatus(updateRuntime);
    window.signalWall.onStateReplaced((replacement) => {
      state.sources = replacement.sources;
      state.multiviews = replacement.multiviews;
      state.activeMultiviewId = replacement.activeMultiviewId;
      state.settings = replacement.settings;
      state.ffmpeg = replacement.ffmpeg;
      state.streamBaseUrl = replacement.streamBaseUrl;
      renderAll();
      showToast(`“${activeMultiview().name}” abierto desde archivo.`);
    });
    renderAll();
    for (const message of initial.migrations || []) showToast(message);
  } catch (error) {
    showToast(`No se pudo iniciar la aplicación: ${error.message}`, 'error');
  }
}

init();
