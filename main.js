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
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import net from 'net';
import os from 'os';
import { fileURLToPath } from 'url';

// Services
import { ProjectService, SessionService, FileService, AssetService } from './src/services/index.js';
import { Project } from 'mrmd-project';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// PATHS & CONFIG
// ============================================================================

const MRMD_PACKAGES = path.dirname(__dirname);
const CONFIG_DIR = path.join(os.homedir(), '.config', 'mrmd');
const RECENT_FILE = path.join(CONFIG_DIR, 'recent.json');
const RUNTIMES_DIR = path.join(os.homedir(), '.mrmd', 'runtimes');

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// ============================================================================
// SERVICES
// ============================================================================

const projectService = new ProjectService();
const sessionService = new SessionService();
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
    // Keep only last 50 items
    data.files = data.files.slice(0, 50);
    data.venvs = data.venvs.slice(0, 20);
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

function findFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      if (Date.now() - start > timeout) {
        reject(new Error(`Port ${port} not ready after ${timeout}ms`));
        return;
      }
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        setTimeout(check, 200);
      });
      socket.connect(port, '127.0.0.1');
    }
    check();
  });
}

function computeDirHash(dir) {
  return crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12);
}

// ============================================================================
// FILE DISCOVERY
// ============================================================================

function scanFiles(searchDir, callback) {
  // Use find (universally available)
  const proc = spawn('find', [
    searchDir,
    '-maxdepth', '6',
    '-type', 'f',
    '-name', '*.md',
    '-not', '-path', '*/node_modules/*',
    '-not', '-path', '*/.git/*',
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
  const systemPythonPaths = [
    '/usr/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',  // macOS Homebrew
  ];
  for (const pythonPath of systemPythonPaths) {
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

  // Phase 2: Conda environments
  const condaPaths = [
    path.join(os.homedir(), 'anaconda3', 'envs'),
    path.join(os.homedir(), 'miniconda3', 'envs'),
    path.join(os.homedir(), 'miniforge3', 'envs'),
    path.join(os.homedir(), '.conda', 'envs'),
  ];
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
    '-maxdepth', '4',
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

function getEnvInfo(envPath, envType) {
  let pythonVersion = null;
  let hasMrmdPython = false;
  let hasPython = false;
  let projectName = '';
  let name = '';

  try {
    hasPython = fs.existsSync(path.join(envPath, 'bin', 'python'));

    // Get Python version - try pyvenv.cfg first, then run python --version
    const pyvenvCfg = path.join(envPath, 'pyvenv.cfg');
    if (fs.existsSync(pyvenvCfg)) {
      const content = fs.readFileSync(pyvenvCfg, 'utf8');
      const match = content.match(/version\s*=\s*(\d+\.\d+)/);
      if (match) pythonVersion = match[1];
    }

    // Check if mrmd-python is installed
    hasMrmdPython = fs.existsSync(path.join(envPath, 'bin', 'mrmd-python'));

    // Set name based on environment type
    switch (envType) {
      case 'system':
        name = 'System Python';
        projectName = 'system';
        break;
      case 'conda':
        name = path.basename(envPath);
        projectName = 'conda';
        break;
      case 'pyenv':
        name = path.basename(envPath);
        projectName = 'pyenv';
        break;
      default: // venv
        name = path.basename(envPath);
        projectName = path.basename(path.dirname(envPath));
    }
  } catch (e) {
    // Ignore errors
  }

  return {
    path: envPath,
    pythonVersion,
    hasMrmdPython,
    hasPython,
    projectName,
    name,
    envType,
  };
}

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

  // DATA LOSS PREVENTION: Limit memory to 512MB to fail fast instead of
  // consuming all system memory and crashing unpredictably after hours.
  // Better to restart early than lose hours of work.
  const proc = spawn('node', [
    '--max-old-space-size=512',
    path.join(MRMD_PACKAGES, 'mrmd-sync/bin/cli.js'),
    '--port', port.toString(),
    '--i-know-what-i-am-doing',
    projectDir,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  const venvName = path.basename(venvPath);
  const projectName = path.basename(path.dirname(venvPath));
  let runtimeId = `${projectName}-${venvName}`.replace(/[^a-zA-Z0-9-]/g, '-');

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

async function installMrmdPython(venvPath) {
  console.log(`[python] Installing mrmd-python in ${venvPath} using uv...`);

  // Validate venv exists (check for python binary)
  const pythonPath = path.join(venvPath, 'bin', 'python');
  if (!fs.existsSync(pythonPath)) {
    throw new Error(`Python not found at ${pythonPath}. Is this a valid venv?`);
  }

  // Check for local development override (MRMD_PYTHON_DEV=/path/to/mrmd-python)
  const localDev = process.env.MRMD_PYTHON_DEV;
  const args = ['pip', 'install', '--python', pythonPath];

  if (localDev) {
    args.push('-e', localDev);
    console.log('[python] Installing from local:', localDev);
  } else {
    args.push('mrmd-python');
    console.log('[python] Installing from PyPI');
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('uv', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });

    proc.on('error', (e) => {
      reject(new Error(`Failed to run uv: ${e.message}. Is uv installed?`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        reject(new Error(`uv pip install failed (code ${code}): ${output.slice(-500)}`));
      }
    });
  });
}

// ============================================================================
// MONITOR
// ============================================================================

function startMonitor(docName, syncPort) {
  console.log(`[monitor] Starting for ${docName}...`);

  const proc = spawn('node', [
    path.join(MRMD_PACKAGES, 'mrmd-monitor/bin/cli.js'),
    '--doc', docName,
    `ws://127.0.0.1:${syncPort}`,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

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

  const proc = spawn('uv', [
    'run', '--project', path.join(MRMD_PACKAGES, 'mrmd-ai'),
    'mrmd-ai-server', '--port', port.toString(),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.join(MRMD_PACKAGES, 'mrmd-ai'),
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

// Get home directory
ipcMain.handle('get-home-dir', () => {
  return os.homedir();
});

// Shell utilities
ipcMain.handle('shell:showItemInFolder', (event, { fullPath }) => {
  shell.showItemInFolder(fullPath);
});

ipcMain.handle('shell:openExternal', async (event, { url }) => {
  await shell.openExternal(url);
});

// Get recent files and venvs
ipcMain.handle('get-recent', () => {
  return loadRecent();
});

// List running runtimes
ipcMain.handle('list-runtimes', () => {
  return { runtimes: listRuntimes() };
});

// Kill a runtime
ipcMain.handle('kill-runtime', (event, { runtimeId }) => {
  const success = killRuntime(runtimeId);
  return { success };
});

// Attach to existing runtime (just verify it's alive and return info)
ipcMain.handle('attach-runtime', (event, { runtimeId }) => {
  const runtimes = listRuntimes();
  const runtime = runtimes.find(r => r.id === runtimeId && r.alive);
  if (runtime) {
    return { success: true, port: runtime.port, url: runtime.url, venv: runtime.venv };
  }
  return { success: false, error: 'Runtime not found or not alive' };
});

// Scan for files
ipcMain.handle('scan-files', (event, { searchDir }) => {
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

// Install mrmd-python
ipcMain.handle('install-mrmd-python', async (event, { venvPath }) => {
  try {
    await installMrmdPython(venvPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Start Python runtime
ipcMain.handle('start-python', async (event, { venvPath, forceNew }) => {
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

// Open file
ipcMain.handle('open-file', async (event, { filePath }) => {
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
    width: 1000,
    height: 750,
    backgroundColor: '#0d1117',
    titleBarStyle: 'hiddenInset',
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

app.whenReady().then(() => {
  console.log('='.repeat(50));
  console.log('mrmd-electron starting...');
  console.log('='.repeat(50));

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

  for (const [, server] of syncServers) {
    if (server.owned && server.proc) {
      server.proc.kill('SIGTERM');
    }
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
