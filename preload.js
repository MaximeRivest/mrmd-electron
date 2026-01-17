/**
 * Preload script - IPC bridge between main and renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Recent files/venvs
  getRecent: () => ipcRenderer.invoke('get-recent'),

  // File scanning
  scanFiles: (searchDir) => ipcRenderer.invoke('scan-files', { searchDir }),
  onFilesUpdate: (callback) => {
    ipcRenderer.on('files-update', (event, data) => callback(data));
  },

  // Venv discovery
  discoverVenvs: (projectDir) => ipcRenderer.invoke('discover-venvs', { projectDir }),
  onVenvFound: (callback) => {
    ipcRenderer.on('venv-found', (event, data) => callback(data));
  },
  onVenvScanDone: (callback) => {
    ipcRenderer.on('venv-scan-done', () => callback());
  },

  // File info
  readPreview: (filePath, lines) => ipcRenderer.invoke('read-preview', { filePath, lines }),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', { filePath }),

  // Python management
  installMrmdPython: (venvPath) => ipcRenderer.invoke('install-mrmd-python', { venvPath }),
  startPython: (venvPath, forceNew = false) => ipcRenderer.invoke('start-python', { venvPath, forceNew }),

  // Runtime management
  listRuntimes: () => ipcRenderer.invoke('list-runtimes'),
  killRuntime: (runtimeId) => ipcRenderer.invoke('kill-runtime', { runtimeId }),
  attachRuntime: (runtimeId) => ipcRenderer.invoke('attach-runtime', { runtimeId }),

  // Open file
  openFile: (filePath) => ipcRenderer.invoke('open-file', { filePath }),

  // AI server
  getAi: () => ipcRenderer.invoke('get-ai'),

  // ==========================================================================
  // DATA LOSS PREVENTION
  // ==========================================================================
  // Added after investigating unexplained data loss on 2026-01-16.
  // When sync server crashes, the renderer MUST be notified immediately
  // so it can warn the user and attempt to save a local backup.
  // ==========================================================================

  /**
   * Register callback for when sync server dies unexpectedly.
   * CRITICAL: This is the primary safeguard against silent data loss.
   * The callback receives: { projectDir, exitCode, signal, timestamp, reason }
   */
  onSyncServerDied: (callback) => {
    ipcRenderer.on('sync-server-died', (event, data) => callback(data));
  },
});
