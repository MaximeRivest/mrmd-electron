/**
 * Preload script - IPC bridge between main and renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // System info
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),

  // System/app information
  system: {
    /**
     * Get system and app info including uv status
     * @returns {Promise<{appVersion, platform, arch, nodeVersion, pythonDeps, uv}>}
     */
    info: () => ipcRenderer.invoke('system:info'),

    /**
     * Ensure uv is installed (auto-install if missing)
     * @returns {Promise<{success, path?, version?, error?}>}
     */
    ensureUv: () => ipcRenderer.invoke('system:ensureUv'),
  },

  // Shell utilities (via IPC to main process)
  shell: {
    showItemInFolder: (fullPath) => ipcRenderer.invoke('shell:showItemInFolder', { fullPath }),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
    openPath: (fullPath) => ipcRenderer.invoke('shell:openPath', { fullPath }),
  },

  // Recent files/venvs
  getRecent: () => ipcRenderer.invoke('get-recent'),

  // File scanning (legacy - use file.scan for projects)
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

  // Python management (legacy - use session.* for projects)
  createVenv: (venvPath) => ipcRenderer.invoke('create-venv', { venvPath }),
  installMrmdPython: (venvPath) => ipcRenderer.invoke('install-mrmd-python', { venvPath }),
  startPython: (venvPath, forceNew = false) => ipcRenderer.invoke('start-python', { venvPath, forceNew }),

  // Runtime management (legacy)
  listRuntimes: () => ipcRenderer.invoke('list-runtimes'),
  killRuntime: (runtimeId) => ipcRenderer.invoke('kill-runtime', { runtimeId }),
  attachRuntime: (runtimeId) => ipcRenderer.invoke('attach-runtime', { runtimeId }),

  // Open file (legacy - use project.get + session.forDocument for projects)
  openFile: (filePath) => ipcRenderer.invoke('open-file', { filePath }),

  // AI server
  getAi: () => ipcRenderer.invoke('get-ai'),

  // ==========================================================================
  // PROJECT SERVICE API
  // ==========================================================================

  project: {
    /**
     * Get project info for a file path
     * @param {string} filePath - Absolute path to any file
     * @returns {Promise<ProjectInfo | null>}
     */
    get: (filePath) => ipcRenderer.invoke('project:get', { filePath }),

    /**
     * Create a new mrmd project
     * @param {string} targetPath - Where to create the project
     * @returns {Promise<ProjectInfo>}
     */
    create: (targetPath) => ipcRenderer.invoke('project:create', { targetPath }),

    /**
     * Get navigation tree for a project
     * @param {string} projectRoot - Project root path
     * @returns {Promise<NavNode[]>}
     */
    nav: (projectRoot) => ipcRenderer.invoke('project:nav', { projectRoot }),

    /**
     * Invalidate cached project info
     * @param {string} projectRoot - Project root path
     */
    invalidate: (projectRoot) => ipcRenderer.invoke('project:invalidate', { projectRoot }),

    /**
     * Watch project for file changes
     * @param {string} projectRoot - Project root path
     */
    watch: (projectRoot) => ipcRenderer.invoke('project:watch', { projectRoot }),

    /**
     * Stop watching project
     */
    unwatch: () => ipcRenderer.invoke('project:unwatch'),

    /**
     * Register callback for project file changes
     * @param {Function} callback - Called when files change
     */
    onChanged: (callback) => {
      ipcRenderer.removeAllListeners('project:changed');
      ipcRenderer.on('project:changed', (event, data) => callback(data));
    },
  },

  // ==========================================================================
  // SESSION SERVICE API
  // ==========================================================================

  session: {
    /**
     * List all running sessions
     * @returns {Promise<SessionInfo[]>}
     */
    list: () => ipcRenderer.invoke('session:list'),

    /**
     * Start a new session
     * @param {object} config - Session config { name, venv, cwd }
     * @returns {Promise<SessionInfo>}
     */
    start: (config) => ipcRenderer.invoke('session:start', { config }),

    /**
     * Stop a session
     * @param {string} sessionName - Session name to stop
     * @returns {Promise<boolean>}
     */
    stop: (sessionName) => ipcRenderer.invoke('session:stop', { sessionName }),

    /**
     * Restart a session
     * @param {string} sessionName - Session name to restart
     * @returns {Promise<SessionInfo>}
     */
    restart: (sessionName) => ipcRenderer.invoke('session:restart', { sessionName }),

    /**
     * Get or create session for a document
     * @param {string} documentPath - Path to document
     * @returns {Promise<SessionInfo | null>}
     */
    forDocument: (documentPath) => ipcRenderer.invoke('session:forDocument', { documentPath }),
  },

  // ==========================================================================
  // BASH SESSION SERVICE API
  // ==========================================================================

  bash: {
    /**
     * List all running bash sessions
     * @returns {Promise<SessionInfo[]>}
     */
    list: () => ipcRenderer.invoke('bash:list'),

    /**
     * Start a new bash session
     * @param {object} config - Session config { name, cwd }
     * @returns {Promise<SessionInfo>}
     */
    start: (config) => ipcRenderer.invoke('bash:start', { config }),

    /**
     * Stop a bash session
     * @param {string} sessionName - Session name to stop
     * @returns {Promise<boolean>}
     */
    stop: (sessionName) => ipcRenderer.invoke('bash:stop', { sessionName }),

    /**
     * Restart a bash session
     * @param {string} sessionName - Session name to restart
     * @returns {Promise<SessionInfo>}
     */
    restart: (sessionName) => ipcRenderer.invoke('bash:restart', { sessionName }),

    /**
     * Get or create bash session for a document
     * @param {string} documentPath - Path to document
     * @returns {Promise<SessionInfo | null>}
     */
    forDocument: (documentPath) => ipcRenderer.invoke('bash:forDocument', { documentPath }),
  },

  // ==========================================================================
  // JULIA SESSION SERVICE API
  // ==========================================================================

  julia: {
    /**
     * List all running Julia sessions
     * @returns {Promise<SessionInfo[]>}
     */
    list: () => ipcRenderer.invoke('julia:list'),

    /**
     * Start a new Julia session
     * @param {object} config - Session config { name, cwd }
     * @returns {Promise<SessionInfo>}
     */
    start: (config) => ipcRenderer.invoke('julia:start', { config }),

    /**
     * Stop a Julia session
     * @param {string} sessionName - Session name to stop
     * @returns {Promise<boolean>}
     */
    stop: (sessionName) => ipcRenderer.invoke('julia:stop', { sessionName }),

    /**
     * Restart a Julia session
     * @param {string} sessionName - Session name to restart
     * @returns {Promise<SessionInfo>}
     */
    restart: (sessionName) => ipcRenderer.invoke('julia:restart', { sessionName }),

    /**
     * Get or create Julia session for a document
     * @param {string} documentPath - Path to document
     * @returns {Promise<SessionInfo | null>}
     */
    forDocument: (documentPath) => ipcRenderer.invoke('julia:forDocument', { documentPath }),

    /**
     * Check if Julia is available on the system
     * @returns {Promise<boolean>}
     */
    isAvailable: () => ipcRenderer.invoke('julia:isAvailable'),
  },

  // ==========================================================================
  // PTY SESSION SERVICE API (for ```term blocks)
  // ==========================================================================

  pty: {
    /**
     * List all running PTY sessions
     * @returns {Promise<SessionInfo[]>}
     */
    list: () => ipcRenderer.invoke('pty:list'),

    /**
     * Start a new PTY session (mrmd-pty server)
     * @param {object} config - Session config { name, cwd, venv? }
     * @returns {Promise<SessionInfo>}
     */
    start: (config) => ipcRenderer.invoke('pty:start', { config }),

    /**
     * Stop a PTY session
     * @param {string} sessionName - Session name to stop
     * @returns {Promise<boolean>}
     */
    stop: (sessionName) => ipcRenderer.invoke('pty:stop', { sessionName }),

    /**
     * Restart a PTY session
     * @param {string} sessionName - Session name to restart
     * @returns {Promise<SessionInfo>}
     */
    restart: (sessionName) => ipcRenderer.invoke('pty:restart', { sessionName }),

    /**
     * Get or create PTY session for a document
     * Returns session info including wsUrl for WebSocket connection
     * @param {string} documentPath - Path to document
     * @returns {Promise<{name, cwd, venv?, wsUrl, port, alive, error?} | null>}
     */
    forDocument: (documentPath) => ipcRenderer.invoke('pty:forDocument', { documentPath }),
  },

  // ==========================================================================
  // NOTEBOOK (JUPYTER) API
  // ==========================================================================

  notebook: {
    /**
     * Convert a Jupyter notebook to markdown (deletes the .ipynb file)
     * @param {string} ipynbPath - Path to the .ipynb file
     * @returns {Promise<{ success, mdPath?, error? }>}
     */
    convert: (ipynbPath) => ipcRenderer.invoke('notebook:convert', { ipynbPath }),

    /**
     * Start syncing a notebook (creates shadow .md in .mrmd folder)
     * @param {string} ipynbPath - Path to the .ipynb file
     * @returns {Promise<{ success, shadowPath?, syncPort?, error? }>}
     */
    startSync: (ipynbPath) => ipcRenderer.invoke('notebook:startSync', { ipynbPath }),

    /**
     * Stop syncing a notebook
     * @param {string} ipynbPath - Path to the .ipynb file
     * @returns {Promise<{ success }>}
     */
    stopSync: (ipynbPath) => ipcRenderer.invoke('notebook:stopSync', { ipynbPath }),
  },

  // ==========================================================================
  // FILE SERVICE API
  // ==========================================================================

  file: {
    /**
     * Scan files in a directory
     * @param {string} root - Directory to scan
     * @param {object} options - { includeHidden, extensions, maxDepth }
     * @returns {Promise<string[]>}
     */
    scan: (root, options) => ipcRenderer.invoke('file:scan', { root, options }),

    /**
     * Create a file
     * @param {string} filePath - Absolute path
     * @param {string} content - File content
     */
    create: (filePath, content) => ipcRenderer.invoke('file:create', { filePath, content }),

    /**
     * Create a file within a project (handles FSML ordering)
     * @param {string} projectRoot - Project root
     * @param {string} relativePath - Desired relative path
     * @param {string} content - File content
     * @returns {Promise<{ success, path?, error? }>}
     */
    createInProject: (projectRoot, relativePath, content) =>
      ipcRenderer.invoke('file:createInProject', { projectRoot, relativePath, content }),

    /**
     * Move/rename a file (with automatic refactoring)
     * @param {string} projectRoot - Project root
     * @param {string} fromPath - Source relative path
     * @param {string} toPath - Destination relative path
     * @returns {Promise<{ movedFile, updatedFiles }>}
     */
    move: (projectRoot, fromPath, toPath) =>
      ipcRenderer.invoke('file:move', { projectRoot, fromPath, toPath }),

    /**
     * Reorder a file/folder (drag-drop with FSML ordering)
     * @param {string} projectRoot - Project root
     * @param {string} sourcePath - Source relative path
     * @param {string} targetPath - Target relative path (drop target)
     * @param {'before' | 'after' | 'inside'} position - Drop position
     * @returns {Promise<{ movedFile, updatedFiles }>}
     */
    reorder: (projectRoot, sourcePath, targetPath, position) =>
      ipcRenderer.invoke('file:reorder', { projectRoot, sourcePath, targetPath, position }),

    /**
     * Delete a file
     * @param {string} filePath - Absolute path
     */
    delete: (filePath) => ipcRenderer.invoke('file:delete', { filePath }),

    /**
     * Read a file
     * @param {string} filePath - Absolute path
     * @returns {Promise<{ success, content?, error? }>}
     */
    read: (filePath) => ipcRenderer.invoke('file:read', { filePath }),

    /**
     * Write a file
     * @param {string} filePath - Absolute path
     * @param {string} content - Content to write
     */
    write: (filePath, content) => ipcRenderer.invoke('file:write', { filePath, content }),
  },

  // ==========================================================================
  // ASSET SERVICE API
  // ==========================================================================

  asset: {
    /**
     * List all assets in a project
     * @param {string} projectRoot - Project root
     * @returns {Promise<AssetInfo[]>}
     */
    list: (projectRoot) => ipcRenderer.invoke('asset:list', { projectRoot }),

    /**
     * Save an asset (handles deduplication)
     * @param {string} projectRoot - Project root
     * @param {Uint8Array} file - File content
     * @param {string} filename - Desired filename
     * @returns {Promise<{ path, deduplicated }>}
     */
    save: (projectRoot, file, filename) =>
      ipcRenderer.invoke('asset:save', { projectRoot, file: Array.from(file), filename }),

    /**
     * Get relative path from document to asset
     * @param {string} assetPath - Asset path relative to _assets/
     * @param {string} documentPath - Document path relative to project root
     * @returns {Promise<string>}
     */
    relativePath: (assetPath, documentPath) =>
      ipcRenderer.invoke('asset:relativePath', { assetPath, documentPath }),

    /**
     * Find orphaned assets
     * @param {string} projectRoot - Project root
     * @returns {Promise<string[]>}
     */
    orphans: (projectRoot) => ipcRenderer.invoke('asset:orphans', { projectRoot }),

    /**
     * Delete an asset
     * @param {string} projectRoot - Project root
     * @param {string} assetPath - Asset path relative to _assets/
     */
    delete: (projectRoot, assetPath) =>
      ipcRenderer.invoke('asset:delete', { projectRoot, assetPath }),
  },

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
    // Remove any existing listeners to prevent duplicates
    ipcRenderer.removeAllListeners('sync-server-died');
    ipcRenderer.on('sync-server-died', (event, data) => callback(data));
  },
});
