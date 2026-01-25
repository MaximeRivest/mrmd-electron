/**
 * mrmd-electron - Zen Markdown Editor
 *
 * Architecture:
 * - mrmd-sync: Per-project (watches file's directory)
 * - mrmd-python: Per-window (different venvs possible)
 * - mrmd-monitor: Per-file (one per open document)
 * - mrmd-ai: SHARED (stateless)
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn, execSync } from 'child_process';
import { createRequire } from 'module';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

// Services
import { ProjectService, SessionService, BashSessionService, PtySessionService, FileService, AssetService } from './src/services/index.js';
import { Project } from 'mrmd-project';

// Shared utilities and configuration
import { findFreePort, waitForPort } from './src/utils/index.js';
import { getEnvInfo, installMrmdPython, createVenv, ensureUv, getUvVersion } from './src/utils/index.js';
import {
  CONFIG_DIR,
  RECENT_FILE,
  RUNTIMES_DIR,
  DEFAULT_HOST,
  SYNC_SERVER_MEMORY_MB,
  FILE_SCAN_MAX_DEPTH,
  VENV_SCAN_MAX_DEPTH,
  MAX_RECENT_FILES,
  MAX_RECENT_VENVS,
  DIR_HASH_LENGTH,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_BACKGROUND_COLOR,
  SYSTEM_PYTHON_PATHS,
  CONDA_PATHS,
  APP_VERSION,
  PYTHON_DEPS,
} from './src/config.js';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create require for resolving package paths
const require = createRequire(import.meta.url);

// ============================================================================
// PACKAGE RESOLUTION
// ============================================================================

/**
 * Check if running as packaged app
 */
function isPackaged() {
  return app.isPackaged;
}

/**
 * Resolve the path to an mrmd package's CLI script
 *
 * In packaged mode: Returns path to pre-bundled single-file JS in extraResources
 * In dev mode: Returns path to source CLI in sibling directory
 *
 * @param {string} packageName - Package name (e.g., 'mrmd-sync')
 * @param {string} binPath - Relative path to binary within package (e.g., 'bin/cli.js')
 * @returns {string} Absolute path to the script
 */
function resolvePackageBin(packageName, binPath) {
  // PACKAGED: Use pre-bundled single-file JS from extraResources
  if (isPackaged()) {
    const bundlePath = path.join(process.resourcesPath, `${packageName}.bundle.cjs`);
    if (fs.existsSync(bundlePath)) {
      console.log(`[resolve] Using bundle for ${packageName}`);
      return bundlePath;
    }
    // Fallback to old-style extraResources (for backwards compat)
    const resourcePath = path.join(process.resourcesPath, packageName, binPath);
    if (fs.existsSync(resourcePath)) {
      console.log(`[resolve] Using extraResources for ${packageName}`);
      return resourcePath;
    }
    throw new Error(`Cannot resolve ${packageName}: bundle not found at ${bundlePath}`);
  }

  // DEV: Use sibling directory source directly
  const siblingPath = path.join(path.dirname(__dirname), packageName, binPath);
  if (fs.existsSync(siblingPath)) {
    console.log(`[resolve] Using sibling source for ${packageName} (dev mode)`);
    return siblingPath;
  }

  // Fallback: Try node_modules (for testing)
  try {
    const packageJson = require.resolve(`${packageName}/package.json`);
    const packageDir = path.dirname(packageJson);
    return path.join(packageDir, binPath);
  } catch (e) {
    throw new Error(`Cannot resolve ${packageName}: ${e.message}`);
  }
}

/**
 * Resolve the path to an mrmd package's directory
 *
 * @param {string} packageName - Package name (e.g., 'mrmd-ai')
 * @returns {string} Absolute path to the package directory
 */
function resolvePackageDir(packageName) {
  // 1. Check extraResources (packaged app)
  if (isPackaged()) {
    const resourcePath = path.join(process.resourcesPath, packageName);
    if (fs.existsSync(resourcePath)) {
      console.log(`[resolve] Using extraResources for ${packageName}`);
      return resourcePath;
    }
  }

  // 2. Try require.resolve (node_modules)
  try {
    const packageJson = require.resolve(`${packageName}/package.json`);
    return path.dirname(packageJson);
  } catch (e) {
    // 3. Fallback to sibling directory for development
    const siblingPath = path.join(path.dirname(__dirname), packageName);
    if (fs.existsSync(siblingPath)) {
      console.warn(`[resolve] Using sibling path for ${packageName} (development mode)`);
      return siblingPath;
    }
    throw new Error(`Cannot resolve ${packageName}: ${e.message}`);
  }
}

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// ============================================================================
// SERVICES
// ============================================================================

const projectService = new ProjectService();
const sessionService = new SessionService();
const bashSessionService = new BashSessionService();
const ptySessionService = new PtySessionService();
const fileService = new FileService(projectService);
const assetService = new AssetService(fileService);

// ============================================================================
// RECENT FILES/VENVS PERSISTENCE
// ============================================================================

function loadRecent() {
  try {
    if (fs.existsSync(RECENT_FILE)) {
      return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[recent] Failed to load:', e.message);
  }
  return { files: [], venvs: [] };
}

function saveRecent(data) {
  try {
    // Keep only last N items (from config)
    data.files = data.files.slice(0, MAX_RECENT_FILES);
    data.venvs = data.venvs.slice(0, MAX_RECENT_VENVS);
    fs.writeFileSync(RECENT_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('[recent] Failed to save:', e.message);
  }
}

function addRecentFile(filePath) {
  const data = loadRecent();
  // Remove if exists, add to front
  data.files = data.files.filter(f => f.path !== filePath);
  data.files.unshift({ path: filePath, opened: new Date().toISOString() });
  saveRecent(data);
}

function addRecentVenv(venvPath) {
  const data = loadRecent();
  data.venvs = data.venvs.filter(v => v.path !== venvPath);
  data.venvs.unshift({ path: venvPath, used: new Date().toISOString() });
  saveRecent(data);
}

// ============================================================================
// RUNTIME MANAGEMENT
// ============================================================================

function listRuntimes() {
  const runtimes = [];
  if (!fs.existsSync(RUNTIMES_DIR)) return runtimes;

  try {
    const files = fs.readdirSync(RUNTIMES_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const info = JSON.parse(fs.readFileSync(path.join(RUNTIMES_DIR, file), 'utf8'));
        // Check if process is alive
        if (info.pid) {
          try {
            process.kill(info.pid, 0); // Signal 0 = check if alive
            info.alive = true;
          } catch (e) {
            info.alive = false;
          }
        }
        runtimes.push(info);
      } catch (e) {
        // Skip invalid files
      }
    }
  } catch (e) {
    console.error('[runtimes] Error listing:', e.message);
  }
  return runtimes;
}

function killRuntime(runtimeId) {
  const runtimeFile = path.join(RUNTIMES_DIR, `${runtimeId}.json`);
  if (!fs.existsSync(runtimeFile)) return false;

  try {
    const info = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (info.pid) {
      try {
        process.kill(info.pid, 'SIGTERM');
        // Remove the file
        fs.unlinkSync(runtimeFile);
        return true;
      } catch (e) {
        // Process might already be dead, still clean up file
        fs.unlinkSync(runtimeFile);
        return true;
      }
    }
  } catch (e) {
    console.error('[runtimes] Error killing:', e.message);
  }
  return false;
}

// ============================================================================
// GIT ROOT DETECTION
// ============================================================================

function findGitRoot(startPath) {
  let dir = startPath;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

// ============================================================================
// UTILITIES
// ============================================================================

// Note: findFreePort and waitForPort are now imported from src/utils/network.js

function computeDirHash(dir) {
  return crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, DIR_HASH_LENGTH);
}

// ============================================================================
// FILE DISCOVERY
// ============================================================================

function scanFiles(searchDir, callback) {
  // Use find (universally available)
  // Find both .md and .ipynb files, excluding system folders
  const proc = spawn('find', [
    searchDir,
    '-maxdepth', String(FILE_SCAN_MAX_DEPTH),
    '-type', 'f',
    '(', '-name', '*.md', '-o', '-name', '*.ipynb', ')',
    '-not', '-path', '*/node_modules/*',
    '-not', '-path', '*/.git/*',
    '-not', '-path', '*/.mrmd/*',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let buffer = '';
  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        callback({ type: 'file', path: line.trim() });
      }
    }
  });

  proc.on('close', () => {
    if (buffer.trim()) {
      callback({ type: 'file', path: buffer.trim() });
    }
    callback({ type: 'done' });
  });

  proc.on('error', (e) => {
    console.error('[scan] find error:', e.message);
    callback({ type: 'error', error: e.message });
  });

  return proc;
}

// ============================================================================
// VENV DISCOVERY
// ============================================================================

function discoverVenvs(projectDir, callback) {
  const found = new Set();

  // Phase 0: System Python (always available)
  // Using paths from config
  for (const pythonPath of SYSTEM_PYTHON_PATHS) {
    if (fs.existsSync(pythonPath)) {
      const envPath = path.dirname(path.dirname(pythonPath)); // e.g., /usr
      if (!found.has(envPath)) {
        found.add(envPath);
        const info = getEnvInfo(envPath, 'system');
        callback({ type: 'venv', ...info, source: 'system' });
      }
      break; // Only add one system Python
    }
  }

  // Phase 1: Check obvious venv locations (instant)
  const obviousPaths = [
    path.join(projectDir, '.venv'),
    path.join(projectDir, 'venv'),
    path.join(projectDir, 'env'),
    path.join(path.dirname(projectDir), '.venv'),
  ];

  for (const p of obviousPaths) {
    if (fs.existsSync(path.join(p, 'bin', 'python'))) {
      found.add(p);
      const info = getEnvInfo(p, 'venv');
      callback({ type: 'venv', ...info, source: 'project' });
    }
  }

  // Phase 2: Conda environments (using paths from config)
  const condaPaths = CONDA_PATHS.map(p => path.join(os.homedir(), p));
  for (const condaEnvs of condaPaths) {
    if (fs.existsSync(condaEnvs)) {
      try {
        const envs = fs.readdirSync(condaEnvs);
        for (const env of envs) {
          const envPath = path.join(condaEnvs, env);
          if (!found.has(envPath) && fs.existsSync(path.join(envPath, 'bin', 'python'))) {
            found.add(envPath);
            const info = getEnvInfo(envPath, 'conda');
            callback({ type: 'venv', ...info, source: 'conda' });
          }
        }
      } catch (e) { /* ignore */ }
    }
  }

  // Phase 3: Pyenv versions
  const pyenvVersions = path.join(os.homedir(), '.pyenv', 'versions');
  if (fs.existsSync(pyenvVersions)) {
    try {
      const versions = fs.readdirSync(pyenvVersions);
      for (const ver of versions) {
        const envPath = path.join(pyenvVersions, ver);
        if (!found.has(envPath) && fs.existsSync(path.join(envPath, 'bin', 'python'))) {
          found.add(envPath);
          const info = getEnvInfo(envPath, 'pyenv');
          callback({ type: 'venv', ...info, source: 'pyenv' });
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Phase 4: Recent environments
  const recent = loadRecent();
  for (const v of recent.venvs) {
    if (!found.has(v.path) && fs.existsSync(path.join(v.path, 'bin', 'python'))) {
      found.add(v.path);
      const info = getEnvInfo(v.path, 'venv');
      callback({ type: 'venv', ...info, source: 'recent', used: v.used });
    }
  }

  // Phase 5: Background discovery using find (for venvs)
  const proc = spawn('find', [
    os.homedir(),
    '-maxdepth', String(VENV_SCAN_MAX_DEPTH),
    '-type', 'd',
    '(', '-name', '.venv', '-o', '-name', 'venv', '-o', '-name', 'env', ')',
    '-not', '-path', '*/node_modules/*',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let buffer = '';
  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const p = line.trim();
      if (p && !found.has(p) && fs.existsSync(path.join(p, 'bin', 'python'))) {
        found.add(p);
        const info = getEnvInfo(p, 'venv');
        callback({ type: 'venv', ...info, source: 'discovered' });
      }
    }
  });

  proc.on('close', () => {
    callback({ type: 'done' });
  });

  proc.on('error', (e) => {
    console.error('[venv] find error:', e.message);
    callback({ type: 'done' });
  });

  return proc;
}

// Note: getEnvInfo is now imported from src/utils/python.js

// Keep for backwards compatibility
function getVenvInfo(venvPath) {
  return getEnvInfo(venvPath, 'venv');
}

// ============================================================================
// SYNC SERVER MANAGEMENT
// ============================================================================

const syncServers = new Map();

// =============================================================================
// DATA LOSS PREVENTION
// =============================================================================
// Added after investigating unexplained data loss on 2026-01-16.
// The sync server (mrmd-sync) crashed with OOM, but the editor kept running,
// giving no indication that changes weren't being saved. User lost ~2.5 hours
// of work. These safeguards ensure users are immediately warned if sync fails.
// See: https://github.com/MaximeRivest/mrmd-electron/issues/1 (if created)
// =============================================================================

/**
 * Notify all windows that a sync server died unexpectedly.
 * This is CRITICAL for data loss prevention - users must know immediately
 * when their changes are no longer being saved.
 */
function notifySyncDied(projectDir, exitCode, signal) {
  const message = {
    projectDir,
    exitCode,
    signal,
    timestamp: new Date().toISOString(),
    reason: exitCode === null ? 'crashed (likely OOM)' : `exited with code ${exitCode}`,
  };

  console.error(`[sync] CRITICAL: Sync server died for ${projectDir}:`, message.reason);

  // Notify ALL windows - any of them might have the affected document open
  for (const win of windows) {
    try {
      const state = windowStates.get(win.id);
      if (!state || state.projectDir !== projectDir) continue;
      win.webContents.send('sync-server-died', message);
    } catch (e) {
      // Window might be destroyed
    }
  }
}

async function getSyncServer(projectDir) {
  const dirHash = computeDirHash(projectDir);

  if (syncServers.has(dirHash)) {
    const server = syncServers.get(dirHash);
    server.refCount++;
    console.log(`[sync] Reusing server for ${projectDir} on port ${server.port}`);
    return server;
  }

  // Check for existing server
  const syncStatePath = path.join(os.tmpdir(), `mrmd-sync-${dirHash}`, 'server.pid');
  try {
    if (fs.existsSync(syncStatePath)) {
      const pidData = JSON.parse(fs.readFileSync(syncStatePath, 'utf8'));
      try {
        process.kill(pidData.pid, 0);
        console.log(`[sync] Found existing server on port ${pidData.port}`);
        const server = { proc: null, port: pidData.port, dir: projectDir, refCount: 1, owned: false };
        syncServers.set(dirHash, server);
        return server;
      } catch {
        fs.unlinkSync(syncStatePath);
      }
    }
  } catch (e) {}

  const port = await findFreePort();
  console.log(`[sync] Starting server for ${projectDir} on port ${port}...`);

  // DATA LOSS PREVENTION: Limit memory to configured MB to fail fast instead of
  // consuming all system memory and crashing unpredictably after hours.
  // Better to restart early than lose hours of work.
  const syncCliPath = resolvePackageBin('mrmd-sync', 'bin/cli.js');
  const nodeArgs = [
    `--max-old-space-size=${SYNC_SERVER_MEMORY_MB}`,
    syncCliPath,
    '--port', port.toString(),
    '--i-know-what-i-am-doing',
    projectDir,
  ];
  const proc = isPackaged()
    ? spawn(process.execPath, nodeArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    : spawn('node', nodeArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.expectedExit = false;

  proc.stdout.on('data', (d) => console.log(`[sync:${port}]`, d.toString().trim()));
  proc.stderr.on('data', (d) => console.error(`[sync:${port}]`, d.toString().trim()));

  // DATA LOSS PREVENTION: Notify renderer immediately when sync dies
  proc.on('exit', (code, signal) => {
    console.log(`[sync:${port}] Exited with code ${code}, signal ${signal}`);
    console.log(`[sync:${port}] expectedExit=${proc.expectedExit}, will notify=${!proc.expectedExit}`);
    syncServers.delete(dirHash);

    // If this was an unexpected exit (not a local, intentional shutdown),
    // notify the UI even if the server exited cleanly.
    if (!proc.expectedExit) {
      notifySyncDied(projectDir, code, signal);
    }
  });

  await waitForPort(port);

  const server = { proc, port, dir: projectDir, refCount: 1, owned: true };
  syncServers.set(dirHash, server);
  return server;
}

function releaseSyncServer(projectDir) {
  const dirHash = computeDirHash(projectDir);
  const server = syncServers.get(dirHash);
  if (!server) return;

  server.refCount--;
  if (server.refCount <= 0 && server.owned && server.proc) {
    console.log(`[sync] Stopping server for ${projectDir}`);
    server.proc.expectedExit = true;
    server.proc.kill('SIGTERM');
    syncServers.delete(dirHash);
  }
}

// ============================================================================
// PYTHON RUNTIME
// ============================================================================

async function startPythonRuntime(venvPath, windowId, forceNew = false) {
  const port = await findFreePort();

  // Generate runtime ID from venv path (e.g., "notemrmd-venv" or "adaptersv2-venv")
  // Strip leading dots, sanitize, collapse dashes, strip leading/trailing dashes
  const venvName = path.basename(venvPath).replace(/^\.+/, '') || 'venv';
  const projectName = path.basename(path.dirname(venvPath)).replace(/^\.+/, '') || 'project';
  let runtimeId = `${projectName}-${venvName}`
    .replace(/[^a-zA-Z0-9-]/g, '-')  // Replace invalid chars with dash
    .replace(/-+/g, '-')              // Collapse multiple dashes
    .replace(/^-|-$/g, '');           // Strip leading/trailing dashes

  // Ensure we have a valid ID
  if (!runtimeId) runtimeId = 'python-runtime';

  const mrmdPythonPath = path.join(venvPath, 'bin', 'mrmd-python');

  if (!fs.existsSync(mrmdPythonPath)) {
    throw new Error('mrmd-python not installed in this venv');
  }

  // Check if this runtime is already running (and we're not forcing new)
  const existingRuntimes = listRuntimes();
  if (!forceNew) {
    const existing = existingRuntimes.find(r => r.id === runtimeId && r.alive);
    if (existing) {
      console.log(`[python:${windowId}] Attaching to existing runtime "${runtimeId}" on port ${existing.port}`);
      addRecentVenv(venvPath);
      return { proc: null, port: existing.port, runtimeId, reused: true };
    }
  } else {
    // Force new: add suffix to make unique
    const suffix = Date.now().toString(36).slice(-4);
    runtimeId = `${runtimeId}-${suffix}`;
  }

  console.log(`[python:${windowId}] Starting runtime "${runtimeId}" on port ${port}...`);

  const proc = spawn(mrmdPythonPath, [
    '--id', runtimeId,
    '--port', port.toString(),
    '--foreground'
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, VIRTUAL_ENV: venvPath },
  });

  proc.stdout.on('data', (d) => console.log(`[python:${windowId}]`, d.toString().trim()));
  proc.stderr.on('data', (d) => console.error(`[python:${windowId}]`, d.toString().trim()));

  await waitForPort(port);

  // Track as recent
  addRecentVenv(venvPath);

  return { proc, port, runtimeId };
}

// Note: installMrmdPython is now imported from src/utils/python.js

// ============================================================================
// MONITOR
// ============================================================================

function startMonitor(docName, syncPort) {
  console.log(`[monitor] Starting for ${docName}...`);

  const monitorCliPath = resolvePackageBin('mrmd-monitor', 'bin/cli.js');
  const nodeArgs = [
    monitorCliPath,
    '--doc', docName,
    `ws://${DEFAULT_HOST}:${syncPort}`,
  ];
  const proc = isPackaged()
    ? spawn(process.execPath, nodeArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    : spawn('node', nodeArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  proc.stdout.on('data', (d) => console.log(`[monitor:${docName}]`, d.toString().trim()));
  proc.stderr.on('data', (d) => console.error(`[monitor:${docName}]`, d.toString().trim()));

  return proc;
}

// ============================================================================
// AI SERVER
// ============================================================================

let aiServer = null;

async function ensureAiServer() {
  if (aiServer) return aiServer;

  const port = await findFreePort();
  console.log(`[ai] Starting on port ${port}...`);

  // mrmd-ai is a Python package - use 'uv tool run' which:
  // 1. Auto-installs the package in an isolated environment
  // 2. Runs the CLI without needing a local project directory
  const proc = spawn('uv', [
    'tool', 'run',
    '--from', `mrmd-ai${PYTHON_DEPS['mrmd-ai']}`,  // e.g. mrmd-ai>=0.1.0,<0.2
    'mrmd-ai-server',
    '--port', port.toString(),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (d) => console.log('[ai]', d.toString().trim()));
  proc.stderr.on('data', (d) => console.error('[ai]', d.toString().trim()));
  proc.on('exit', () => { aiServer = null; });

  await waitForPort(port);
  aiServer = { proc, port };
  return aiServer;
}


// ============================================================================
// WINDOW STATE
// ============================================================================

const windowStates = new Map();
const windows = new Set();

function cleanupWindow(windowId) {
  const state = windowStates.get(windowId);
  if (!state) return;

  if (state.python?.proc) {
    state.python.proc.kill('SIGTERM');
  }

  for (const [, proc] of state.monitors) {
    proc.kill('SIGTERM');
  }

  if (state.projectDir) {
    releaseSyncServer(state.projectDir);
  }

  // Kill any running scanners
  if (state.fileScanner) state.fileScanner.kill();
  if (state.venvScanner) state.venvScanner.kill();

  windowStates.delete(windowId);
}

// ============================================================================
// IPC HANDLERS
// ============================================================================

/**
 * Log a deprecation warning for legacy IPC handlers.
 * These handlers still work but users should migrate to the new service APIs.
 */
function logDeprecation(handler, replacement) {
  console.warn(`[DEPRECATED] '${handler}' is deprecated. Use '${replacement}' instead.`);
}

// Get home directory
ipcMain.handle('get-home-dir', () => {
  return os.homedir();
});

// Get system/app info
ipcMain.handle('system:info', async () => {
  const { findUv, getUvVersion } = await import('./src/utils/uv-installer.js');
  const uvPath = findUv();

  return {
    appVersion: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    pythonDeps: PYTHON_DEPS,
    uv: uvPath ? {
      installed: true,
      path: uvPath,
      version: getUvVersion(uvPath)
    } : {
      installed: false,
      path: null,
      version: null
    }
  };
});

// Ensure uv is installed (trigger auto-install from renderer)
ipcMain.handle('system:ensureUv', async () => {
  try {
    const uvPath = await ensureUv({
      onProgress: (stage, detail) => console.log(`[uv] ${stage}: ${detail}`)
    });
    const version = getUvVersion(uvPath);
    return { success: true, path: uvPath, version };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Shell utilities
ipcMain.handle('shell:showItemInFolder', (event, { fullPath }) => {
  shell.showItemInFolder(fullPath);
});

ipcMain.handle('shell:openExternal', async (event, { url }) => {
  await shell.openExternal(url);
});

ipcMain.handle('shell:openPath', async (event, { fullPath }) => {
  return await shell.openPath(fullPath);
});

// Get recent files and venvs
ipcMain.handle('get-recent', () => {
  return loadRecent();
});

// List running runtimes (LEGACY - use session:list for projects)
ipcMain.handle('list-runtimes', () => {
  logDeprecation('list-runtimes', 'session:list');
  return { runtimes: listRuntimes() };
});

// Kill a runtime (LEGACY - use session:stop for projects)
ipcMain.handle('kill-runtime', (event, { runtimeId }) => {
  logDeprecation('kill-runtime', 'session:stop');
  const success = killRuntime(runtimeId);
  return { success };
});

// Attach to existing runtime (LEGACY - use session:forDocument for projects)
ipcMain.handle('attach-runtime', (event, { runtimeId }) => {
  logDeprecation('attach-runtime', 'session:forDocument');
  const runtimes = listRuntimes();
  const runtime = runtimes.find(r => r.id === runtimeId && r.alive);
  if (runtime) {
    return { success: true, port: runtime.port, url: runtime.url, venv: runtime.venv };
  }
  return { success: false, error: 'Runtime not found or not alive' };
});

// Scan for files (LEGACY - use file:scan for projects)
ipcMain.handle('scan-files', (event, { searchDir }) => {
  logDeprecation('scan-files', 'file:scan');
  const windowId = BrowserWindow.fromWebContents(event.sender).id;
  let state = windowStates.get(windowId);
  if (!state) {
    state = { python: null, monitors: new Map(), projectDir: null };
    windowStates.set(windowId, state);
  }

  // Kill previous scanner
  if (state.fileScanner) state.fileScanner.kill();

  const files = [];
  state.fileScanner = scanFiles(searchDir || os.homedir(), (result) => {
    if (result.type === 'file') {
      files.push(result.path);
      // Send batch updates
      if (files.length % 50 === 0) {
        event.sender.send('files-update', { files: [...files] });
      }
    } else if (result.type === 'done') {
      event.sender.send('files-update', { files, done: true });
    }
  });

  return { started: true };
});

// Discover venvs
ipcMain.handle('discover-venvs', (event, { projectDir }) => {
  const windowId = BrowserWindow.fromWebContents(event.sender).id;
  let state = windowStates.get(windowId);
  if (!state) {
    state = { python: null, monitors: new Map(), projectDir: null };
    windowStates.set(windowId, state);
  }

  if (state.venvScanner) state.venvScanner.kill();

  state.venvScanner = discoverVenvs(projectDir || os.homedir(), (result) => {
    if (result.type === 'venv') {
      event.sender.send('venv-found', result);
    } else if (result.type === 'done') {
      event.sender.send('venv-scan-done');
    }
  });

  return { started: true };
});

// Read file preview
ipcMain.handle('read-preview', async (event, { filePath, lines = 30 }) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const preview = content.split('\n').slice(0, lines).join('\n');
    return { success: true, preview };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Get file info (for grouping)
ipcMain.handle('get-file-info', async (event, { filePath }) => {
  try {
    const stat = fs.statSync(filePath);
    const gitRoot = findGitRoot(path.dirname(filePath));
    return {
      success: true,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      gitRoot,
      projectName: gitRoot ? path.basename(gitRoot) : path.basename(path.dirname(filePath)),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Create a new virtual environment
ipcMain.handle('create-venv', async (event, { venvPath }) => {
  try {
    console.log('[main] Creating venv at:', venvPath);
    await createVenv(venvPath);
    console.log('[main] Venv created successfully');
    return { success: true };
  } catch (e) {
    console.error('[main] Failed to create venv:', e);
    return { success: false, error: e.message };
  }
});

// Install mrmd-python (LEGACY - session:start auto-installs for projects)
ipcMain.handle('install-mrmd-python', async (event, { venvPath }) => {
  logDeprecation('install-mrmd-python', 'session:start (auto-installs)');
  try {
    await installMrmdPython(venvPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Start Python runtime (LEGACY - use session:start for projects)
ipcMain.handle('start-python', async (event, { venvPath, forceNew }) => {
  logDeprecation('start-python', 'session:start');
  const windowId = BrowserWindow.fromWebContents(event.sender).id;

  try {
    const python = await startPythonRuntime(venvPath, windowId, forceNew);

    let state = windowStates.get(windowId);
    if (!state) {
      state = { python: null, monitors: new Map(), projectDir: null };
      windowStates.set(windowId, state);
    }

    state.python = python;

    return {
      success: true,
      port: python.port,
      runtimeId: python.runtimeId,
      reused: python.reused || false
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Open file (LEGACY - use project:get + session:forDocument for projects)
ipcMain.handle('open-file', async (event, { filePath }) => {
  logDeprecation('open-file', 'project:get + session:forDocument');
  const windowId = BrowserWindow.fromWebContents(event.sender).id;

  const projectDir = path.dirname(filePath);
  const fileName = path.basename(filePath, '.md');

  console.log(`[open] File: ${filePath}`);
  console.log(`[open] Project: ${projectDir}`);
  console.log(`[open] Doc: ${fileName}`);

  try {
    const sync = await getSyncServer(projectDir);

    let state = windowStates.get(windowId);
    if (!state) {
      state = { python: null, monitors: new Map(), projectDir: null };
      windowStates.set(windowId, state);
    }

    if (state.projectDir && state.projectDir !== projectDir) {
      releaseSyncServer(state.projectDir);
    }
    state.projectDir = projectDir;

    if (!state.monitors.has(fileName)) {
      const monitor = startMonitor(fileName, sync.port);
      state.monitors.set(fileName, monitor);
    }

    // Track as recent
    addRecentFile(filePath);

    return {
      success: true,
      syncPort: sync.port,
      docName: fileName,
      pythonPort: state.python?.port || null,
      projectDir,
    };
  } catch (e) {
    console.error('[open] Error:', e);
    return { success: false, error: e.message };
  }
});

// Get AI server
ipcMain.handle('get-ai', async () => {
  try {
    const ai = await ensureAiServer();
    return { success: true, port: ai.port };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ============================================================================
// NOTEBOOK (JUPYTER) IPC HANDLERS
// ============================================================================

// Active Jupyter bridges: ipynbPath -> { bridge, shadowPath, refCount }
const jupyterBridges = new Map();

// Convert notebook to markdown (deletes the .ipynb file)
ipcMain.handle('notebook:convert', async (event, { ipynbPath }) => {
  try {
    const { ipynbToMarkdown, parseIpynb } = await import('mrmd-jupyter-bridge');

    const content = fs.readFileSync(ipynbPath, 'utf8');
    const { notebook, error } = parseIpynb(content);

    if (error) {
      return { success: false, error: `Failed to parse notebook: ${error}` };
    }

    const markdown = ipynbToMarkdown(notebook);
    const mdPath = ipynbPath.replace(/\.ipynb$/, '.md');

    // Write markdown file
    fs.writeFileSync(mdPath, markdown, 'utf8');

    // Delete the notebook
    fs.unlinkSync(ipynbPath);

    console.log(`[notebook:convert] Converted ${ipynbPath} to ${mdPath}`);

    return { success: true, mdPath };
  } catch (e) {
    console.error('[notebook:convert] Error:', e);
    return { success: false, error: e.message };
  }
});

// Start notebook sync (creates shadow .md in .mrmd folder)
ipcMain.handle('notebook:startSync', async (event, { ipynbPath }) => {
  try {
    // Check if already synced
    if (jupyterBridges.has(ipynbPath)) {
      const entry = jupyterBridges.get(ipynbPath);
      entry.refCount++;
      console.log(`[notebook:startSync] Reusing bridge for ${ipynbPath}`);
      return { success: true, shadowPath: entry.shadowPath };
    }

    const { JupyterBridge } = await import('mrmd-jupyter-bridge');

    // Compute shadow path in .mrmd folder
    const dir = path.dirname(ipynbPath);
    const base = path.basename(ipynbPath, '.ipynb');
    const mrmdDir = path.join(dir, '.mrmd');
    const shadowPath = path.join(mrmdDir, `${base}.md`);

    // Ensure .mrmd directory exists
    if (!fs.existsSync(mrmdDir)) {
      fs.mkdirSync(mrmdDir, { recursive: true });
    }

    // Get or start sync server for the .mrmd folder
    // This must match where the editor opens the shadow file from
    const sync = await getSyncServer(mrmdDir);

    // Create and start the bridge
    const bridge = new JupyterBridge(
      `ws://127.0.0.1:${sync.port}`,
      ipynbPath,
      {
        name: 'jupyter-bridge',
        mdPath: shadowPath,
      }
    );

    await bridge.start();

    const entry = { bridge, shadowPath, refCount: 1 };
    jupyterBridges.set(ipynbPath, entry);

    console.log(`[notebook:startSync] Started bridge for ${ipynbPath} -> ${shadowPath}`);

    return { success: true, shadowPath, syncPort: sync.port };
  } catch (e) {
    console.error('[notebook:startSync] Error:', e);
    return { success: false, error: e.message };
  }
});

// Stop notebook sync
ipcMain.handle('notebook:stopSync', async (event, { ipynbPath }) => {
  const entry = jupyterBridges.get(ipynbPath);
  if (!entry) {
    return { success: true }; // Already stopped
  }

  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.bridge.stop();
    jupyterBridges.delete(ipynbPath);
    console.log(`[notebook:stopSync] Stopped bridge for ${ipynbPath}`);
  }

  return { success: true };
});

// ============================================================================
// BASH SESSION SERVICE IPC HANDLERS
// ============================================================================

// List all bash sessions
ipcMain.handle('bash:list', () => {
  return bashSessionService.list();
});

// Start bash session
ipcMain.handle('bash:start', async (event, { config }) => {
  try {
    return await bashSessionService.start(config);
  } catch (e) {
    console.error('[bash:start] Error:', e.message);
    throw e;
  }
});

// Stop bash session
ipcMain.handle('bash:stop', async (event, { sessionName }) => {
  return bashSessionService.stop(sessionName);
});

// Restart bash session
ipcMain.handle('bash:restart', async (event, { sessionName }) => {
  try {
    return await bashSessionService.restart(sessionName);
  } catch (e) {
    console.error('[bash:restart] Error:', e.message);
    throw e;
  }
});

// Get or create bash session for document
ipcMain.handle('bash:forDocument', async (event, { documentPath }) => {
  console.log('[bash:forDocument] Called with:', documentPath);
  try {
    const project = await projectService.getProject(documentPath);
    console.log('[bash:forDocument] Project:', project?.root);
    if (!project) {
      console.log('[bash:forDocument] No project found');
      return null;
    }

    // Parse frontmatter from document
    const content = fs.readFileSync(documentPath, 'utf8');
    const frontmatter = Project.parseFrontmatter(content);

    console.log('[bash:forDocument] Calling bashSessionService.getForDocument');
    const result = await bashSessionService.getForDocument(
      documentPath,
      project.config,
      frontmatter,
      project.root
    );
    console.log('[bash:forDocument] Result:', result);
    return result;
  } catch (e) {
    console.error('[bash:forDocument] Error:', e.message, e.stack);
    return null;
  }
});

// ============================================================================
// PTY SESSION SERVICE IPC HANDLERS (for ```term blocks)
// ============================================================================

// List all pty sessions
ipcMain.handle('pty:list', () => {
  return ptySessionService.list();
});

// Start pty session
ipcMain.handle('pty:start', async (event, { config }) => {
  try {
    return await ptySessionService.start(config);
  } catch (e) {
    console.error('[pty:start] Error:', e.message);
    return { error: e.message };
  }
});

// Stop pty session
ipcMain.handle('pty:stop', async (event, { sessionName }) => {
  return ptySessionService.stop(sessionName);
});

// Restart pty session
ipcMain.handle('pty:restart', async (event, { sessionName }) => {
  try {
    return await ptySessionService.restart(sessionName);
  } catch (e) {
    console.error('[pty:restart] Error:', e.message);
    return { error: e.message };
  }
});

// Get or create pty session for document
ipcMain.handle('pty:forDocument', async (event, { documentPath }) => {
  console.log('[pty:forDocument] Called with:', documentPath);
  try {
    const project = await projectService.getProject(documentPath);
    console.log('[pty:forDocument] Project:', project?.root);
    if (!project) {
      console.log('[pty:forDocument] No project found');
      return null;
    }

    // Parse frontmatter from document
    const content = fs.readFileSync(documentPath, 'utf8');
    const frontmatter = Project.parseFrontmatter(content);

    console.log('[pty:forDocument] Calling ptySessionService.getForDocument');
    const result = await ptySessionService.getForDocument(
      documentPath,
      project.config,
      frontmatter,
      project.root
    );
    console.log('[pty:forDocument] Result:', result);
    return result;
  } catch (e) {
    console.error('[pty:forDocument] Error:', e.message, e.stack);
    return null;
  }
});

// ============================================================================
// PROJECT SERVICE IPC HANDLERS
// ============================================================================

// Get project for a file
ipcMain.handle('project:get', async (event, { filePath }) => {
  try {
    return await projectService.getProject(filePath);
  } catch (e) {
    console.error('[project:get] Error:', e.message);
    return null;
  }
});

// Create new project
ipcMain.handle('project:create', async (event, { targetPath }) => {
  try {
    return await projectService.createProject(targetPath);
  } catch (e) {
    console.error('[project:create] Error:', e.message);
    throw e;
  }
});

// Get navigation tree
ipcMain.handle('project:nav', async (event, { projectRoot }) => {
  try {
    const project = await projectService.getProject(projectRoot);
    return project?.navTree || [];
  } catch (e) {
    console.error('[project:nav] Error:', e.message);
    return [];
  }
});

// Invalidate project cache
ipcMain.handle('project:invalidate', (event, { projectRoot }) => {
  projectService.invalidate(projectRoot);
  return { success: true };
});

// Watch project for file changes
const projectWatchers = new Map(); // windowId -> watcher

ipcMain.handle('project:watch', (event, { projectRoot }) => {
  const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
  if (!windowId) return { success: false };

  // Close existing watcher for this window
  if (projectWatchers.has(windowId)) {
    projectWatchers.get(windowId).close();
  }

  // Start new watcher
  const watcher = projectService.watch(projectRoot, () => {
    // Send event to renderer when files change
    const win = BrowserWindow.fromId(windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send('project:changed', { projectRoot });
    }
  });

  projectWatchers.set(windowId, watcher);
  console.log(`[project:watch] Watching ${projectRoot} for window ${windowId}`);

  return { success: true };
});

ipcMain.handle('project:unwatch', (event) => {
  const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
  if (windowId && projectWatchers.has(windowId)) {
    projectWatchers.get(windowId).close();
    projectWatchers.delete(windowId);
  }
  return { success: true };
});

// ============================================================================
// SESSION SERVICE IPC HANDLERS
// ============================================================================

// List all sessions
ipcMain.handle('session:list', () => {
  return sessionService.list();
});

// Start session
ipcMain.handle('session:start', async (event, { config }) => {
  try {
    return await sessionService.start(config);
  } catch (e) {
    console.error('[session:start] Error:', e.message);
    throw e;
  }
});

// Stop session
ipcMain.handle('session:stop', async (event, { sessionName }) => {
  return sessionService.stop(sessionName);
});

// Restart session
ipcMain.handle('session:restart', async (event, { sessionName }) => {
  try {
    return await sessionService.restart(sessionName);
  } catch (e) {
    console.error('[session:restart] Error:', e.message);
    throw e;
  }
});

// Get or create session for document
ipcMain.handle('session:forDocument', async (event, { documentPath }) => {
  try {
    const project = await projectService.getProject(documentPath);
    if (!project) return null;

    // Parse frontmatter from document
    const content = fs.readFileSync(documentPath, 'utf8');
    const frontmatter = Project.parseFrontmatter(content);

    return await sessionService.getForDocument(
      documentPath,
      project.config,
      frontmatter,
      project.root
    );
  } catch (e) {
    console.error('[session:forDocument] Error:', e.message);
    return null;
  }
});

// ============================================================================
// FILE SERVICE IPC HANDLERS
// ============================================================================

// Scan files in directory
ipcMain.handle('file:scan', async (event, { root, options }) => {
  try {
    return await fileService.scan(root, options);
  } catch (e) {
    console.error('[file:scan] Error:', e.message);
    return [];
  }
});

// Create file
ipcMain.handle('file:create', async (event, { filePath, content }) => {
  try {
    await fileService.createFile(filePath, content);
    return { success: true };
  } catch (e) {
    console.error('[file:create] Error:', e.message);
    return { success: false, error: e.message };
  }
});

// Create file in project (with FSML ordering)
ipcMain.handle('file:createInProject', async (event, { projectRoot, relativePath, content }) => {
  try {
    const actualPath = await fileService.createInProject(projectRoot, relativePath, content);
    return { success: true, path: actualPath };
  } catch (e) {
    console.error('[file:createInProject] Error:', e.message);
    return { success: false, error: e.message };
  }
});

// Move file (with refactoring)
ipcMain.handle('file:move', async (event, { projectRoot, fromPath, toPath }) => {
  try {
    return await fileService.move(projectRoot, fromPath, toPath);
  } catch (e) {
    console.error('[file:move] Error:', e.message);
    throw e;
  }
});

// Reorder file (drag-drop with FSML ordering)
ipcMain.handle('file:reorder', async (event, { projectRoot, sourcePath, targetPath, position }) => {
  try {
    return await fileService.reorder(projectRoot, sourcePath, targetPath, position);
  } catch (e) {
    console.error('[file:reorder] Error:', e.message);
    throw e;
  }
});

// Delete file
ipcMain.handle('file:delete', async (event, { filePath }) => {
  try {
    await fileService.delete(filePath);
    return { success: true };
  } catch (e) {
    console.error('[file:delete] Error:', e.message);
    return { success: false, error: e.message };
  }
});

// Read file
ipcMain.handle('file:read', async (event, { filePath }) => {
  try {
    const content = await fileService.read(filePath);
    return { success: true, content };
  } catch (e) {
    console.error('[file:read] Error:', e.message);
    return { success: false, error: e.message };
  }
});

// Write file
ipcMain.handle('file:write', async (event, { filePath, content }) => {
  try {
    await fileService.write(filePath, content);
    return { success: true };
  } catch (e) {
    console.error('[file:write] Error:', e.message);
    return { success: false, error: e.message };
  }
});

// ============================================================================
// ASSET SERVICE IPC HANDLERS
// ============================================================================

// List assets in project
ipcMain.handle('asset:list', async (event, { projectRoot }) => {
  try {
    return await assetService.list(projectRoot);
  } catch (e) {
    console.error('[asset:list] Error:', e.message);
    return [];
  }
});

// Save asset (with deduplication)
ipcMain.handle('asset:save', async (event, { projectRoot, file, filename }) => {
  try {
    // Convert from array/Uint8Array to Buffer
    const buffer = Buffer.from(file);
    return await assetService.save(projectRoot, buffer, filename);
  } catch (e) {
    console.error('[asset:save] Error:', e.message);
    throw e;
  }
});

// Get relative path from document to asset
ipcMain.handle('asset:relativePath', (event, { assetPath, documentPath }) => {
  return assetService.getRelativePath(assetPath, documentPath);
});

// Find orphaned assets
ipcMain.handle('asset:orphans', async (event, { projectRoot }) => {
  try {
    return await assetService.findOrphans(projectRoot);
  } catch (e) {
    console.error('[asset:orphans] Error:', e.message);
    return [];
  }
});

// Delete asset
ipcMain.handle('asset:delete', async (event, { projectRoot, assetPath }) => {
  try {
    await assetService.delete(projectRoot, assetPath);
    return { success: true };
  } catch (e) {
    console.error('[asset:delete] Error:', e.message);
    return { success: false, error: e.message };
  }
});

// ============================================================================
// WINDOW MANAGEMENT
// ============================================================================

function createWindow() {
  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    backgroundColor: DEFAULT_BACKGROUND_COLOR,
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  windows.add(win);

  win.on('closed', () => {
    windows.delete(win);
    cleanupWindow(win.id);
  });

  win.loadFile('index.html');
  return win;
}

// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(async () => {
  console.log('='.repeat(50));
  console.log(`mrmd-electron v${APP_VERSION} starting...`);
  console.log('='.repeat(50));

  // Ensure uv is installed (auto-install if missing)
  // This is done early so Python package installation is always fast
  try {
    console.log('[startup] Checking uv installation...');
    const uvPath = await ensureUv({
      onProgress: (stage, detail) => console.log(`[startup] uv ${stage}: ${detail}`)
    });
    const uvVersion = getUvVersion(uvPath);
    console.log(`[startup] uv ready: ${uvPath} (v${uvVersion})`);
  } catch (e) {
    console.error('[startup] WARNING: Failed to ensure uv:', e.message);
    console.error('[startup] Python package installation may be slower without uv');
  }

  // Log Python deps for this version
  console.log('[startup] Python dependencies:', Object.entries(PYTHON_DEPS).map(([k, v]) => `${k}${v}`).join(', '));

  createWindow();

  ensureAiServer().catch(e => console.error('[ai] Failed:', e.message));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  for (const [windowId] of windowStates) {
    cleanupWindow(windowId);
  }

  // Shutdown new session service
  sessionService.shutdown();

  if (aiServer?.proc) {
    aiServer.proc.kill('SIGTERM');
  }

  // Shutdown bash sessions
  bashSessionService.shutdown();

  // Shutdown Jupyter bridges
  for (const [ipynbPath, entry] of jupyterBridges) {
    console.log(`[cleanup] Stopping Jupyter bridge for ${ipynbPath}`);
    entry.bridge.stop();
  }
  jupyterBridges.clear();

  for (const [, server] of syncServers) {
    if (server.owned && server.proc) {
      server.proc.kill('SIGTERM');
    }
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
