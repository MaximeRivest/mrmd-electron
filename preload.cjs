/**
 * Preload script - IPC bridge between main and renderer
 *
 * Unified runtime API: all languages go through electronAPI.runtime.*
 * No more per-language bash/r/julia/pty namespaces.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // System info
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),

  // System/app information
  system: {
    info: () => ipcRenderer.invoke('system:info'),
    ensureUv: () => ipcRenderer.invoke('system:ensureUv'),
  },

  // Shell utilities
  shell: {
    showItemInFolder: (fullPath) => ipcRenderer.invoke('shell:showItemInFolder', { fullPath }),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
    openPath: (fullPath) => ipcRenderer.invoke('shell:openPath', { fullPath }),
  },

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

  // Venv creation (still useful for setup flows)
  createVenv: (venvPath) => ipcRenderer.invoke('create-venv', { venvPath }),

  // Legacy Python setup flow (used by venv picker UI — will be migrated)
  installMrmdPython: (venvPath) => ipcRenderer.invoke('install-mrmd-python', { venvPath }),
  startPython: (venvPath, forceNew = false) => ipcRenderer.invoke('start-python', { venvPath, forceNew }),
  attachRuntime: (runtimeId) => ipcRenderer.invoke('attach-runtime', { runtimeId }),

  // Legacy file open (used by file picker UI — will be migrated)
  openFile: (filePath) => ipcRenderer.invoke('open-file', { filePath }),

  // Legacy runtime list (used by runtimes panel)
  listRuntimes: () => ipcRenderer.invoke('list-runtimes'),
  killRuntime: (runtimeId) => ipcRenderer.invoke('kill-runtime', { runtimeId }),

  // AI server
  getAi: () => ipcRenderer.invoke('get-ai'),

  // ==========================================================================
  // PROJECT SERVICE API
  // ==========================================================================

  project: {
    get: (filePath) => ipcRenderer.invoke('project:get', { filePath }),
    create: (targetPath) => ipcRenderer.invoke('project:create', { targetPath }),
    nav: (projectRoot) => ipcRenderer.invoke('project:nav', { projectRoot }),
    invalidate: (projectRoot) => ipcRenderer.invoke('project:invalidate', { projectRoot }),
    watch: (projectRoot) => ipcRenderer.invoke('project:watch', { projectRoot }),
    unwatch: () => ipcRenderer.invoke('project:unwatch'),
    onChanged: (callback) => {
      ipcRenderer.removeAllListeners('project:changed');
      ipcRenderer.on('project:changed', (event, data) => callback(data));
    },
  },

  // ==========================================================================
  // UNIFIED RUNTIME API — replaces bash/r/julia/pty/session namespaces
  // ==========================================================================

  runtime: {
    /**
     * List all running runtimes, optionally filtered by language.
     * @param {string} [language] — "python", "bash", "r", "julia", "pty"
     * @returns {Promise<Object[]>}
     */
    list: (language) => ipcRenderer.invoke('runtime:list', { language }),

    /**
     * Start a runtime.
     * @param {Object} config — { name, language, cwd, venv? }
     * @returns {Promise<Object>} — { name, port, url, pid, ... }
     */
    start: (config) => ipcRenderer.invoke('runtime:start', { config }),

    /**
     * Stop a runtime.
     * @param {string} sessionName
     * @returns {Promise<{success: boolean}>}
     */
    stop: (sessionName) => ipcRenderer.invoke('runtime:stop', { sessionName }),

    /**
     * Restart a runtime.
     * @param {string} sessionName
     * @returns {Promise<Object>}
     */
    restart: (sessionName) => ipcRenderer.invoke('runtime:restart', { sessionName }),

    /**
     * Get or create ALL runtimes for a document.
     * Returns { python: {...}, bash: {...}, r: {...}, julia: {...}, pty: {...} }
     * Each entry has: { name, port, url, alive, language, available, error? }
     *
     * @param {string} documentPath — absolute path to the document
     * @returns {Promise<Object<string, Object>>}
     */
    forDocument: (documentPath) => ipcRenderer.invoke('runtime:forDocument', { documentPath }),

    /**
     * Get or create a runtime for a document for a SPECIFIC language.
     * @param {string} documentPath
     * @param {string} language — "python", "bash", "r", "julia", "pty"
     * @returns {Promise<Object|null>}
     */
    forDocumentLanguage: (documentPath, language) =>
      ipcRenderer.invoke('runtime:forDocumentLanguage', { documentPath, language }),

    /**
     * Check if a language runtime is available on this system.
     * @param {string} language
     * @returns {Promise<{available: boolean, error?: string}>}
     */
    isAvailable: (language) => ipcRenderer.invoke('runtime:isAvailable', { language }),

    /**
     * List all supported runtime languages.
     * @returns {Promise<string[]>}
     */
    languages: () => ipcRenderer.invoke('runtime:languages'),
  },

  // ==========================================================================
  // NOTEBOOK (JUPYTER) API
  // ==========================================================================

  notebook: {
    convert: (ipynbPath) => ipcRenderer.invoke('notebook:convert', { ipynbPath }),
    startSync: (ipynbPath) => ipcRenderer.invoke('notebook:startSync', { ipynbPath }),
    stopSync: (ipynbPath) => ipcRenderer.invoke('notebook:stopSync', { ipynbPath }),
  },

  // ==========================================================================
  // FILE SERVICE API
  // ==========================================================================

  file: {
    scan: (root, options) => ipcRenderer.invoke('file:scan', { root, options }),
    create: (filePath, content) => ipcRenderer.invoke('file:create', { filePath, content }),
    createInProject: (projectRoot, relativePath, content) =>
      ipcRenderer.invoke('file:createInProject', { projectRoot, relativePath, content }),
    move: (projectRoot, fromPath, toPath) =>
      ipcRenderer.invoke('file:move', { projectRoot, fromPath, toPath }),
    reorder: (projectRoot, sourcePath, targetPath, position) =>
      ipcRenderer.invoke('file:reorder', { projectRoot, sourcePath, targetPath, position }),
    delete: (filePath) => ipcRenderer.invoke('file:delete', { filePath }),
    read: (filePath) => ipcRenderer.invoke('file:read', { filePath }),
    write: (filePath, content) => ipcRenderer.invoke('file:write', { filePath, content }),
  },

  // ==========================================================================
  // ASSET SERVICE API
  // ==========================================================================

  asset: {
    list: (projectRoot) => ipcRenderer.invoke('asset:list', { projectRoot }),
    save: (projectRoot, file, filename) =>
      ipcRenderer.invoke('asset:save', { projectRoot, file: Array.from(file), filename }),
    read: (projectRoot, assetPath) =>
      ipcRenderer.invoke('asset:read', { projectRoot, assetPath }),
    relativePath: (assetPath, documentPath) =>
      ipcRenderer.invoke('asset:relativePath', { assetPath, documentPath }),
    orphans: (projectRoot) => ipcRenderer.invoke('asset:orphans', { projectRoot }),
    delete: (projectRoot, assetPath) =>
      ipcRenderer.invoke('asset:delete', { projectRoot, assetPath }),
  },

  // ==========================================================================
  // SETTINGS SERVICE API
  // ==========================================================================

  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    get: (key, defaultValue) => ipcRenderer.invoke('settings:get', { key, defaultValue }),
    set: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
    update: (updates) => ipcRenderer.invoke('settings:update', { updates }),
    reset: () => ipcRenderer.invoke('settings:reset'),
    getApiKeys: (masked = true) => ipcRenderer.invoke('settings:getApiKeys', { masked }),
    setApiKey: (provider, key) => ipcRenderer.invoke('settings:setApiKey', { provider, key }),
    getApiKey: (provider) => ipcRenderer.invoke('settings:getApiKey', { provider }),
    getApiProviders: () => ipcRenderer.invoke('settings:getApiProviders'),
    hasApiKey: (provider) => ipcRenderer.invoke('settings:hasApiKey', { provider }),
    getQualityLevels: () => ipcRenderer.invoke('settings:getQualityLevels'),
    setQualityLevelModel: (level, model) =>
      ipcRenderer.invoke('settings:setQualityLevelModel', { level, model }),
    getCustomSections: () => ipcRenderer.invoke('settings:getCustomSections'),
    addCustomSection: (name) => ipcRenderer.invoke('settings:addCustomSection', { name }),
    removeCustomSection: (sectionId) =>
      ipcRenderer.invoke('settings:removeCustomSection', { sectionId }),
    addCustomCommand: (sectionId, command) =>
      ipcRenderer.invoke('settings:addCustomCommand', { sectionId, command }),
    updateCustomCommand: (sectionId, commandId, updates) =>
      ipcRenderer.invoke('settings:updateCustomCommand', { sectionId, commandId, updates }),
    removeCustomCommand: (sectionId, commandId) =>
      ipcRenderer.invoke('settings:removeCustomCommand', { sectionId, commandId }),
    getAllCustomCommands: () => ipcRenderer.invoke('settings:getAllCustomCommands'),
    getDefaults: () => ipcRenderer.invoke('settings:getDefaults'),
    setDefaults: (defaults) => ipcRenderer.invoke('settings:setDefaults', defaults),
    export: (includeKeys = false) => ipcRenderer.invoke('settings:export', { includeKeys }),
    import: (json, mergeKeys = false) =>
      ipcRenderer.invoke('settings:import', { json, mergeKeys }),
  },

  // ==========================================================================
  // VOICE API
  // ==========================================================================

  voice: {
    checkParakeet: (url) => ipcRenderer.invoke('voice:checkParakeet', { url }),
    transcribeParakeet: ({ audioBytes, mimeType, url }) =>
      ipcRenderer.invoke('voice:transcribeParakeet', { audioBytes, mimeType, url }),
  },

  // ==========================================================================
  // CLOUD AUTH + SYNC API
  // ==========================================================================

  cloud: {
    status: () => ipcRenderer.invoke('cloud:status'),
    signIn: () => ipcRenderer.invoke('cloud:signIn'),
    signOut: () => ipcRenderer.invoke('cloud:signOut'),
    validate: () => ipcRenderer.invoke('cloud:validate'),
    bridgeDoc: (projectDir, docName) => ipcRenderer.invoke('cloud:bridgeDoc', { projectDir, docName }),
    fetchAsset: (localProjectRoot, relativePath) => ipcRenderer.invoke('cloud:fetchAsset', { localProjectRoot, relativePath }),
  },

  // ==========================================================================
  // DATA LOSS PREVENTION
  // ==========================================================================

  onSyncServerDied: (callback) => {
    ipcRenderer.removeAllListeners('sync-server-died');
    ipcRenderer.on('sync-server-died', (event, data) => callback(data));
  },

  // ==========================================================================
  // FILE ASSOCIATION HANDLING
  // ==========================================================================

  onOpenWithFile: (callback) => {
    ipcRenderer.removeAllListeners('open-with-file');
    ipcRenderer.on('open-with-file', (event, data) => callback(data));
  },
});
