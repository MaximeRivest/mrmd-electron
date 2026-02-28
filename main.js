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
import { WebSocket } from 'ws';

// Services
import { ProjectService, RuntimeService, FileService, AssetService, SettingsService } from './src/services/index.js';
import { Project } from 'mrmd-project';

// Shared utilities and configuration
import { findFreePort, waitForPort, isPortInUse } from './src/utils/index.js';
import { getEnvInfo, installMrmdPython, createVenv, ensureUv, getUvVersion } from './src/utils/index.js';
import { walkDir, findDirs, getVenvPython, getVenvExecutable, isProcessAlive, killProcessTree } from './src/utils/index.js';
import {
  CONFIG_DIR,
  RECENT_FILE,
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

// Suppress EPIPE errors on stdout/stderr.
// When launched from a desktop entry or systemd, the stdout pipe may close
// before the process exits, causing console.log to throw EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', (err) => {
      if (err.code === 'EPIPE') return; // Silently ignore
      throw err; // Re-throw non-EPIPE errors
    });
  }
}

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
const runtimeService = new RuntimeService();
const fileService = new FileService(projectService);
const assetService = new AssetService(fileService);
const settingsService = new SettingsService();

// ============================================================================
// CLOUD AUTH + SYNC
// ============================================================================

import { CloudAuth } from './src/cloud-auth.js';
import { CloudSync } from './src/cloud-sync.js';

const cloudAuth = new CloudAuth(settingsService);
let cloudSync = null; // Initialized after sign-in

// Machine Hub mode: keep background sync/runtime available even when no UI
// window is open. This turns the desktop into a headless collaboration host.
const MACHINE_HUB_MODE = !['0', 'false', 'off'].includes(
  String(process.env.MRMD_MACHINE_HUB || '').toLowerCase()
);
const MACHINE_HUB_ROOTS = (process.env.MRMD_MACHINE_HUB_ROOTS || path.join(os.homedir(), 'Projects'))
  .split(path.delimiter)
  .map((p) => p.trim())
  .filter(Boolean);
const MACHINE_HUB_SCAN_INTERVAL_MS = 30000;

// Machine identity for catalog + tunnel metadata
const MACHINE_ID = process.env.MRMD_MACHINE_ID || `${os.hostname()}-${os.userInfo().username}`;
const MACHINE_NAME = process.env.MRMD_MACHINE_NAME || os.hostname();

// Projects held by the machine hub (each adds one sync server ref)
const machineHubProjects = new Set();
let machineHubScanTimer = null;

/**
 * Start background cloud sync if signed in.
 * Called on app startup and after sign-in.
 */
async function startCloudSyncIfReady() {
  if (cloudSync) {
    await startMachineHubIfReady();
    return; // Already running
  }

  const token = cloudAuth.getToken();
  const user = cloudAuth.getUser();
  if (!token || !user) return;

  // Validate token is still good
  const validated = await cloudAuth.validate();
  if (!validated) return;

  cloudSync = new CloudSync({
    cloudUrl: cloudAuth.cloudUrl,
    token,
    userId: user.id,
    runtimeService, // Expose local runtimes to the web editor via tunnel
    onVoiceTranscribe: (req) => transcribeParakeetFromBase64(req),
  });

  console.log(`[cloud] Background sync ready for ${user.name || user.email}`);

  // Register any already-running sync servers (no eager doc bridging — on-demand)
  for (const [, server] of syncServers) {
    if (server.port && server.dir) {
      const projectName = path.basename(server.dir);
      cloudSync.bridgeProject(server.port, server.dir, projectName, []);
    }
  }

  // In Machine Hub mode, host all discovered projects even if they are not
  // currently open in the UI.
  await startMachineHubIfReady();
}

/**
 * Convert an absolute file path into an mrmd doc name.
 * Example: /project/docs/intro.qmd -> docs/intro
 */
function docNameFromPath(filePath, projectDir) {
  const rel = path.relative(projectDir, filePath).replace(/\\/g, '/');
  const normalized = rel.replace(/^\.\//, '');

  if (normalized.endsWith('.qmd')) return normalized.slice(0, -4);
  if (normalized.endsWith('.md')) return normalized.slice(0, -3);
  return normalized;
}

/**
 * Discover .md/.qmd document names in a project directory.
 */
function discoverDocNames(projectDir) {
  const docs = [];
  try {
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' ||
            entry.name === '.venv' || entry.name === '__pycache__') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.md') || entry.name.endsWith('.qmd')) {
          docs.push(docNameFromPath(full, projectDir));
        }
      }
    };
    walk(projectDir);
  } catch { /* ignore scan errors */ }
  return docs;
}

/** Discover projects for Machine Hub mode. */
function discoverMachineHubProjects() {
  const projects = new Set();

  for (const root of MACHINE_HUB_ROOTS) {
    let entries = [];
    try {
      if (!fs.existsSync(root)) continue;
      entries = fs.readdirSync(root, { withFileTypes: true });

      // Root itself may be a project
      if (fs.existsSync(path.join(root, 'mrmd.md'))) {
        projects.add(path.resolve(root));
      }
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      try {
        if (fs.existsSync(path.join(dir, 'mrmd.md'))) {
          projects.add(path.resolve(dir));
        }
      } catch { /* ignore */ }
    }
  }

  return [...projects];
}

/** Ensure all discovered Machine Hub projects have active sync + cloud bridges. */
async function ensureMachineHubProjectsRunning() {
  if (!MACHINE_HUB_MODE || !cloudSync) return;

  const projectDirs = discoverMachineHubProjects();
  const catalogEntries = [];

  for (const projectDir of projectDirs) {
    try {
      // Acquire one persistent ref for hub mode
      if (!machineHubProjects.has(projectDir)) {
        const server = await getSyncServer(projectDir);
        machineHubProjects.add(projectDir);
        console.log(`[hub] Hosting project: ${projectDir} (sync:${server.port})`);
      }

      // Register project with CloudSync (no eager doc bridging — on-demand only)
      const server = await getSyncServer(projectDir);
      const projectName = path.basename(projectDir);
      const docs = discoverDocNames(projectDir);
      cloudSync.bridgeProject(server.port, projectDir, projectName, []);
      releaseSyncServer(projectDir); // Balance the refresh acquire above

      // Collect catalog entries for this project
      for (const docName of docs) {
        catalogEntries.push({ project: projectName, docPath: docName });
      }
    } catch (err) {
      console.warn(`[hub] Failed to host ${projectDir}:`, err.message);
    }
  }

  // Push lightweight catalog to relay (no file content, just manifest)
  if (catalogEntries.length > 0) {
    cloudSync.pushCatalog(MACHINE_ID, {
      machineName: MACHINE_NAME,
      hostname: os.hostname(),
      capabilities: runtimeService.supportedLanguages?.() || [],
      entries: catalogEntries,
    }).catch(err => console.warn('[hub] Catalog push failed:', err.message));
  }
}

async function startMachineHubIfReady() {
  if (!MACHINE_HUB_MODE || !cloudSync) return;

  await ensureMachineHubProjectsRunning();

  if (!machineHubScanTimer) {
    machineHubScanTimer = setInterval(() => {
      ensureMachineHubProjectsRunning().catch((err) => {
        console.warn('[hub] Scan failed:', err.message);
      });
    }, MACHINE_HUB_SCAN_INTERVAL_MS);
  }

  console.log(`[hub] Machine Hub active (${MACHINE_HUB_ROOTS.join(', ')})`);
}

async function stopMachineHub() {
  if (machineHubScanTimer) {
    clearInterval(machineHubScanTimer);
    machineHubScanTimer = null;
  }

  for (const projectDir of [...machineHubProjects]) {
    try {
      releaseSyncServer(projectDir);
    } catch { /* ignore */ }
  }
  machineHubProjects.clear();
}

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
// RUNTIME MANAGEMENT (handled by RuntimeService)
// ============================================================================

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
  // Cross-platform file discovery using walkDir
  // Find both markdown-like docs and .ipynb files, excluding system folders
  const handle = walkDir(searchDir, {
    maxDepth: FILE_SCAN_MAX_DEPTH,
    extensions: ['.md', '.qmd', '.ipynb'],
    ignoreDirs: ['node_modules', '.git', '.mrmd'],
    onFile: (filePath) => {
      callback({ type: 'file', path: filePath });
    },
    onDir: (dirPath) => {
      callback({ type: 'dir', path: dirPath });
    },
    onDone: () => {
      callback({ type: 'done' });
    },
    onError: (e) => {
      console.error('[scan] error:', e.message);
      callback({ type: 'error', error: e.message });
    },
  });

  // walkDir now returns a cancellable handle
  return handle || { kill: () => {} };
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
    if (fs.existsSync(getVenvPython(p))) {
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
          if (!found.has(envPath) && fs.existsSync(getVenvPython(envPath))) {
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
        if (!found.has(envPath) && fs.existsSync(getVenvPython(envPath))) {
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
    if (!found.has(v.path) && fs.existsSync(getVenvPython(v.path))) {
      found.add(v.path);
      const info = getEnvInfo(v.path, 'venv');
      callback({ type: 'venv', ...info, source: 'recent', used: v.used });
    }
  }

  // Phase 5: Background discovery using cross-platform findDirs
  findDirs(os.homedir(), ['.venv', 'venv', 'env'], {
    maxDepth: VENV_SCAN_MAX_DEPTH,
    ignoreDirs: ['node_modules'],
    onFound: (p) => {
      if (!found.has(p) && fs.existsSync(getVenvPython(p))) {
        found.add(p);
        const info = getEnvInfo(p, 'venv');
        callback({ type: 'venv', ...info, source: 'discovered' });
      }
    },
    onDone: () => {
      callback({ type: 'done' });
    },
  });

  // Return an object with a kill method for compatibility
  return {
    kill: () => {
      // findDirs is async via setImmediate, can't really cancel
      // but this maintains API compatibility
    },
  };
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
      if (isProcessAlive(pidData.pid)) {
        // Verify the port is actually reachable (process could be zombie/different)
        const portAlive = await isPortInUse(pidData.port);
        if (portAlive) {
          console.log(`[sync] Found existing server on port ${pidData.port}`);
          const server = { proc: null, port: pidData.port, dir: projectDir, refCount: 1, owned: false };
          syncServers.set(dirHash, server);
          return server;
        } else {
          console.log(`[sync] PID ${pidData.pid} alive but port ${pidData.port} not listening, removing stale pid`);
          try { fs.unlinkSync(syncStatePath); } catch (e) {}
        }
      } else {
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
    // Machine-hosted projects can have hundreds of bridged docs.
    // Raise connection caps to avoid rejecting CloudSync bridges.
    '--max-connections', '1200',
    '--max-per-doc', '100',
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

  // Register project with cloud sync (no eager doc bridging — on-demand)
  if (cloudSync && port) {
    const projectName = path.basename(projectDir);
    cloudSync.bridgeProject(port, projectDir, projectName, []);
  }

  return server;
}

function releaseSyncServer(projectDir) {
  const dirHash = computeDirHash(projectDir);
  const server = syncServers.get(dirHash);
  if (!server) return;

  server.refCount--;
  if (server.refCount <= 0) {
    // Stop cloud bridges for this project once no windows reference it.
    if (cloudSync) {
      cloudSync.stopProject(projectDir).catch((err) => {
        console.warn(`[cloud] Failed to stop project bridge ${projectDir}:`, err.message);
      });
    }

    if (server.owned && server.proc) {
      console.log(`[sync] Stopping server for ${projectDir}`);
      server.proc.expectedExit = true;
      server.proc.kill('SIGTERM');
      syncServers.delete(dirHash);
    } else {
      syncServers.delete(dirHash);
    }
  }
}

// Python runtime spawning is now handled by RuntimeService.

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

  let proc;

  // Check if we have a local sibling package (development mode)
  const siblingPath = path.join(path.dirname(__dirname), 'mrmd-ai');
  const hasLocalPackage = !isPackaged() && fs.existsSync(path.join(siblingPath, 'pyproject.toml'));

  if (hasLocalPackage) {
    // DEV MODE: Use 'uv run --project' to run from local source
    // This ensures we always use the latest local code during development
    console.log(`[ai] Using local package: ${siblingPath}`);
    proc = spawn('uv', [
      'run', '--project', siblingPath,
      'mrmd-ai-server',
      '--port', port.toString(),
    ], {
      cwd: siblingPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    // PACKAGED MODE: Use 'uv tool run' to download/run from PyPI
    // This requires mrmd-ai to be published to PyPI for distribution
    console.log(`[ai] Using uv tool run (packaged mode)`);
    proc = spawn('uv', [
      'tool', 'run',
      '--from', `mrmd-ai${PYTHON_DEPS['mrmd-ai']}`,
      'mrmd-ai-server',
      '--port', port.toString(),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  proc.stdout.on('data', (d) => console.log('[ai]', d.toString().trim()));
  proc.stderr.on('data', (d) => console.error('[ai]', d.toString().trim()));
  proc.on('exit', () => { aiServer = null; });

  // AI server imports heavy libs (dspy, litellm) - needs 30s timeout
  await waitForPort(port, { timeout: 30000 });
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
  const scanToken = (state.fileScanToken || 0) + 1;
  state.fileScanToken = scanToken;
  const files = [];
  const dirs = [];
  let pendingFileChunk = [];
  let pendingDirChunk = [];
  const flushChunk = (done = false) => {
    if (!pendingFileChunk.length && !pendingDirChunk.length && !done) return;
    event.sender.send('files-update', {
      scanToken,
      filesChunk: pendingFileChunk,
      dirsChunk: pendingDirChunk,
      totalFiles: files.length,
      totalDirs: dirs.length,
      done,
    });
    pendingFileChunk = [];
    pendingDirChunk = [];
  };

  // Tell renderer to reset any stale scan state
  event.sender.send('files-update', { scanToken, reset: true, done: false, totalFiles: 0, totalDirs: 0 });

  state.fileScanner = scanFiles(searchDir || os.homedir(), (result) => {
    if (state.fileScanToken !== scanToken) return;

    if (result.type === 'file') {
      files.push(result.path);
      pendingFileChunk.push(result.path);
      // Stream small chunks to avoid O(n^2) payload copies while scanning
      if (pendingFileChunk.length >= 200) flushChunk(false);
    } else if (result.type === 'dir') {
      dirs.push(result.path);
      pendingDirChunk.push(result.path);
      if (pendingDirChunk.length >= 120) flushChunk(false);
    } else if (result.type === 'done') {
      flushChunk(true);
    } else if (result.type === 'error') {
      event.sender.send('files-update', { scanToken, error: result.error || 'scan failed', done: true });
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
    const maxBytes = 96 * 1024;
    const normalizedLines = Number.isFinite(lines) ? Math.max(1, Math.min(lines, 200)) : 30;
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
      if (bytesRead <= 0) return { success: true, preview: '' };

      const snippet = buffer.subarray(0, bytesRead);
      if (snippet.includes(0)) {
        return { success: true, preview: '[binary file]' };
      }

      const content = snippet.toString('utf8');
      const preview = content.split('\n').slice(0, normalizedLines).join('\n');
      return { success: true, preview };
    } finally {
      await fd.close();
    }
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

// Legacy Python handlers — thin wrappers for backwards compat with venv picker UI.
ipcMain.handle('install-mrmd-python', async (event, { venvPath }) => {
  try {
    await installMrmdPython(venvPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Legacy open-file handler
ipcMain.handle('open-file', async (event, { filePath }) => {
  const windowId = BrowserWindow.fromWebContents(event.sender).id;
  const projectDir = path.dirname(filePath);
  const docName = docNameFromPath(filePath, projectDir);

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

    if (!state.monitors.has(docName)) {
      const monitor = startMonitor(docName, sync.port);
      state.monitors.set(docName, monitor);
    }

    // Ensure this document is bridged if cloud sync is active.
    if (cloudSync) {
      cloudSync.bridgeDoc(projectDir, docName);
    }

    addRecentFile(filePath);

    return {
      success: true,
      syncPort: sync.port,
      docName,
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

// Per-language session IPC handlers removed.
// All runtime lifecycle is handled through the unified runtime:* API below.

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
// UNIFIED RUNTIME SERVICE IPC HANDLERS
// ============================================================================
// Single set of handlers for ALL languages (python, bash, r, julia, pty).
// The renderer calls runtime:forDocument ONCE and gets back every runtime
// the document needs.
// ============================================================================

// List all running runtimes (optionally filtered by language)
ipcMain.handle('runtime:list', (event, args) => {
  return runtimeService.list(args?.language);
});

// Start a runtime
ipcMain.handle('runtime:start', async (event, { config }) => {
  try {
    return await runtimeService.start(config);
  } catch (e) {
    console.error('[runtime:start] Error:', e.message);
    throw e;
  }
});

// Stop a runtime
ipcMain.handle('runtime:stop', async (event, { sessionName }) => {
  try {
    const winId = BrowserWindow.fromWebContents(event.sender)?.id;
    const senderUrl = event.sender?.getURL?.() || 'unknown';
    const stack = new Error().stack?.split('\n').slice(1, 6).join('\n');
    console.warn(`[runtime:ipc] stop requested for "${sessionName}" (window=${winId}, url=${senderUrl})\n${stack}`);
  } catch {}

  const success = await runtimeService.stop(sessionName);
  return { success };
});

// Restart a runtime
ipcMain.handle('runtime:restart', async (event, { sessionName }) => {
  try {
    try {
      const winId = BrowserWindow.fromWebContents(event.sender)?.id;
      const senderUrl = event.sender?.getURL?.() || 'unknown';
      const stack = new Error().stack?.split('\n').slice(1, 6).join('\n');
      console.warn(`[runtime:ipc] restart requested for "${sessionName}" (window=${winId}, url=${senderUrl})\n${stack}`);
    } catch {}
    return await runtimeService.restart(sessionName);
  } catch (e) {
    console.error('[runtime:restart] Error:', e.message);
    throw e;
  }
});

// Get or create ALL runtimes for a document (single call replaces 5 per-language calls)
ipcMain.handle('runtime:forDocument', async (event, { documentPath }) => {
  try {
    const project = await projectService.getProject(documentPath);
    if (!project) return null;

    // Read frontmatter from disk if file exists; for new/unsaved files, proceed without it.
    let frontmatter = null;
    try {
      const content = fs.readFileSync(documentPath, 'utf8');
      frontmatter = Project.parseFrontmatter(content);
    } catch (readErr) {
      if (readErr.code !== 'ENOENT') throw readErr;
      // File doesn't exist on disk yet (new file from sync) — use project config only
    }

    return await runtimeService.getForDocument(
      documentPath,
      project.config,
      frontmatter,
      project.root
    );
  } catch (e) {
    console.error('[runtime:forDocument] Error:', e.message);
    return null;
  }
});

// Get or create runtime for a document for a SPECIFIC language
ipcMain.handle('runtime:forDocumentLanguage', async (event, { documentPath, language }) => {
  try {
    const project = await projectService.getProject(documentPath);
    if (!project) return null;

    // Read frontmatter from disk if file exists; for new/unsaved files, proceed without it.
    let frontmatter = null;
    try {
      const content = fs.readFileSync(documentPath, 'utf8');
      frontmatter = Project.parseFrontmatter(content);
    } catch (readErr) {
      if (readErr.code !== 'ENOENT') throw readErr;
    }

    return await runtimeService.getForDocumentLanguage(
      language,
      documentPath,
      project.config,
      frontmatter,
      project.root
    );
  } catch (e) {
    console.error('[runtime:forDocumentLanguage] Error:', e.message);
    return null;
  }
});

// Check if a language is available
ipcMain.handle('runtime:isAvailable', (event, { language }) => {
  return runtimeService.isAvailable(language);
});

// List supported languages
ipcMain.handle('runtime:languages', () => {
  return runtimeService.supportedLanguages();
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

// Read asset bytes (for voice retranscription/history replay)
ipcMain.handle('asset:read', async (event, { projectRoot, assetPath }) => {
  try {
    const assetsRoot = path.resolve(projectRoot, '_assets');
    const fullPath = path.resolve(assetsRoot, assetPath || '');

    // Prevent path traversal outside _assets
    if (!fullPath.startsWith(assetsRoot + path.sep) && fullPath !== assetsRoot) {
      throw new Error('Invalid asset path');
    }

    const buffer = await fsPromises.readFile(fullPath);
    return { success: true, bytes: Array.from(buffer) };
  } catch (e) {
    console.error('[asset:read] Error:', e.message);
    return { success: false, error: e.message, bytes: [] };
  }
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
// VOICE TRANSCRIPTION HELPERS + IPC
// ============================================================================

function detectAudioExtension(mimeType = '') {
  const mt = String(mimeType || '').toLowerCase();
  if (mt.includes('ogg')) return 'ogg';
  if (mt.includes('mp4') || mt.includes('m4a')) return 'm4a';
  if (mt.includes('wav')) return 'wav';
  return 'webm';
}

function runFfmpegToPcm(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr?.on('data', (d) => { stderr += d.toString(); });

    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-500)}`));
      }
    });
  });
}

async function transcribeParakeetPcm(url, pcmBuffer, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let ws;
    let resolved = false;
    const segments = [];

    const done = (err, result) => {
      if (resolved) return;
      resolved = true;
      try { ws?.close(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(result);
    };

    const timer = setTimeout(() => {
      done(new Error('Parakeet transcription timeout'));
    }, timeoutMs);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      clearTimeout(timer);
      done(new Error(`Failed to connect to Parakeet: ${err.message}`));
      return;
    }

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString());
      } catch {
        return;
      }

      if (msg.type === 'ready') {
        ws.send(pcmBuffer);
        ws.send(JSON.stringify({ type: 'flush' }));
        return;
      }

      if (msg.type === 'segment') {
        segments.push({
          text: msg.text || '',
          confidence: msg.confidence || 0,
          duration: msg.duration || 0,
        });
        return;
      }

      if (msg.type === 'flushed') {
        clearTimeout(timer);
        done(null, {
          text: segments.map(s => s.text).join(' ').trim(),
          segments,
          duration: segments.reduce((n, s) => n + (s.duration || 0), 0),
        });
        return;
      }

      if (msg.type === 'error') {
        clearTimeout(timer);
        done(new Error(msg.message || 'Parakeet error'));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      done(new Error(`Parakeet WebSocket error: ${err.message}`));
    });

    ws.on('close', () => {
      if (!resolved) {
        clearTimeout(timer);
        done(new Error('Parakeet connection closed unexpectedly'));
      }
    });
  });
}

ipcMain.handle('voice:checkParakeet', async (event, { url }) => {
  if (!url) return { available: false, error: 'Missing URL' };

  return await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ available: false, error: 'Timeout' });
      try { ws.close(); } catch { /* ignore */ }
    }, 5000);

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      clearTimeout(timer);
      resolve({ available: false, error: err.message });
      return;
    }

    ws.on('message', (data) => {
      if (settled) return;
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
        if (msg.type === 'ready') {
          settled = true;
          clearTimeout(timer);
          resolve({ available: true });
          try { ws.close(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    });

    ws.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: false, error: err.message });
    });

    ws.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: false, error: 'Closed before ready' });
    });
  });
});

/**
 * Transcribe audio via Parakeet. Reusable by IPC handler and tunnel provider.
 * Accepts { audioBase64, mimeType, url } — base64 encoded audio.
 */
async function transcribeParakeetFromBase64({ audioBase64, mimeType, url }) {
  if (!url) throw new Error('Missing Parakeet URL');
  if (!audioBase64) throw new Error('Missing audio data');

  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
  } catch {
    throw new Error('ffmpeg is required for Parakeet transcription');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrmd-voice-'));
  const ext = detectAudioExtension(mimeType);
  const inputPath = path.join(tempDir, `input.${ext}`);
  const outputPath = path.join(tempDir, 'output.pcm');

  try {
    fs.writeFileSync(inputPath, Buffer.from(audioBase64, 'base64'));
    await runFfmpegToPcm(inputPath, outputPath);
    const pcm = fs.readFileSync(outputPath);
    return await transcribeParakeetPcm(url, pcm);
  } finally {
    try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
    try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    try { fs.rmdirSync(tempDir); } catch { /* ignore */ }
  }
}

ipcMain.handle('voice:transcribeParakeet', async (event, { audioBytes, mimeType, url }) => {
  if (!url) throw new Error('Missing Parakeet URL');
  if (!audioBytes || !audioBytes.length) throw new Error('Missing audio bytes');

  // Convert byte array to base64
  const audioBase64 = Buffer.from(audioBytes).toString('base64');
  return transcribeParakeetFromBase64({ audioBase64, mimeType, url });
});

// ============================================================================
// SETTINGS SERVICE IPC HANDLERS
// ============================================================================

// Get all settings
ipcMain.handle('settings:getAll', () => {
  return settingsService.getAll();
});

// Get a specific setting
ipcMain.handle('settings:get', (event, { key, defaultValue }) => {
  return settingsService.get(key, defaultValue);
});

// Set a specific setting
ipcMain.handle('settings:set', (event, { key, value }) => {
  return settingsService.set(key, value);
});

// Update multiple settings
ipcMain.handle('settings:update', (event, { updates }) => {
  return settingsService.update(updates);
});

// Reset to defaults
ipcMain.handle('settings:reset', () => {
  return settingsService.reset();
});

// Get API keys (masked by default)
ipcMain.handle('settings:getApiKeys', (event, { masked = true } = {}) => {
  return settingsService.getApiKeys(masked);
});

// Set an API key
ipcMain.handle('settings:setApiKey', (event, { provider, key }) => {
  return settingsService.setApiKey(provider, key);
});

// Get API key (unmasked) - for sending to AI server
ipcMain.handle('settings:getApiKey', (event, { provider }) => {
  return settingsService.getApiKey(provider);
});

// Get API providers metadata
ipcMain.handle('settings:getApiProviders', () => {
  return settingsService.getApiProviders();
});

// Check if provider has key
ipcMain.handle('settings:hasApiKey', (event, { provider }) => {
  return settingsService.hasApiKey(provider);
});

// Get quality levels
ipcMain.handle('settings:getQualityLevels', () => {
  return settingsService.getQualityLevels();
});

// Set quality level model
ipcMain.handle('settings:setQualityLevelModel', (event, { level, model }) => {
  return settingsService.setQualityLevelModel(level, model);
});

// Get custom sections
ipcMain.handle('settings:getCustomSections', () => {
  return settingsService.getCustomSections();
});

// Add custom section
ipcMain.handle('settings:addCustomSection', (event, { name }) => {
  return settingsService.addCustomSection(name);
});

// Remove custom section
ipcMain.handle('settings:removeCustomSection', (event, { sectionId }) => {
  return settingsService.removeCustomSection(sectionId);
});

// Add custom command
ipcMain.handle('settings:addCustomCommand', (event, { sectionId, command }) => {
  return settingsService.addCustomCommand(sectionId, command);
});

// Update custom command
ipcMain.handle('settings:updateCustomCommand', (event, { sectionId, commandId, updates }) => {
  return settingsService.updateCustomCommand(sectionId, commandId, updates);
});

// Remove custom command
ipcMain.handle('settings:removeCustomCommand', (event, { sectionId, commandId }) => {
  return settingsService.removeCustomCommand(sectionId, commandId);
});

// Get all custom commands (flat list)
ipcMain.handle('settings:getAllCustomCommands', () => {
  return settingsService.getAllCustomCommands();
});

// Get/set defaults
ipcMain.handle('settings:getDefaults', () => {
  return {
    juiceLevel: settingsService.getDefaultJuiceLevel(),
    reasoningLevel: settingsService.getDefaultReasoningLevel(),
  };
});

ipcMain.handle('settings:setDefaults', (event, { juiceLevel, reasoningLevel }) => {
  if (juiceLevel !== undefined) {
    settingsService.setDefaultJuiceLevel(juiceLevel);
  }
  if (reasoningLevel !== undefined) {
    settingsService.setDefaultReasoningLevel(reasoningLevel);
  }
  return { success: true };
});

// Export settings
ipcMain.handle('settings:export', (event, { includeKeys = false } = {}) => {
  return settingsService.export(includeKeys);
});

// Import settings
ipcMain.handle('settings:import', (event, { json, mergeKeys = false }) => {
  return settingsService.import(json, mergeKeys);
});

// ============================================================================
// FILE ASSOCIATION HANDLING
// ============================================================================
// When users set MRMD as their default .md app, the OS will:
// - macOS: Fire 'open-file' event (can happen before app is ready)
// - Windows/Linux: Pass file path in argv via 'second-instance' event
// ============================================================================

// Files queued to open before app was ready (macOS open-file before ready)
const pendingFilesToOpen = [];

/**
 * Send a file path to the renderer to be opened (like Ctrl+P selection)
 * @param {string} filePath - Absolute path to the file
 */
function sendFileToOpen(filePath) {
  // Validate it's a supported file type
  const ext = path.extname(filePath).toLowerCase();
  if (!['.md', '.qmd', '.markdown', '.mdown', '.mdx', '.ipynb'].includes(ext)) {
    console.log(`[open-with] Ignoring unsupported file: ${filePath}`);
    return;
  }

  // Check file exists
  if (!fs.existsSync(filePath)) {
    console.log(`[open-with] File does not exist: ${filePath}`);
    return;
  }

  // Find the first available window, or queue for later
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    console.log(`[open-with] Sending file to renderer: ${filePath}`);
    win.webContents.send('open-with-file', { filePath });
    win.focus();
  } else {
    // Queue for when window is ready
    console.log(`[open-with] Queueing file for later: ${filePath}`);
    pendingFilesToOpen.push(filePath);
  }
}

/**
 * Extract file path from command line arguments
 * On Windows/Linux, when a file is double-clicked, the path is passed as an argument
 * @param {string[]} argv - Command line arguments
 * @returns {string|null} - File path or null if not found
 */
function getFileFromArgv(argv) {
  // Skip the first arg (electron executable) and any flags
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    // Skip flags and Electron internal args
    if (arg.startsWith('-') || arg.startsWith('--')) continue;
    // Skip if it's the app path itself
    if (arg.endsWith('.js') || arg.endsWith('electron') || arg.includes('app.asar')) continue;
    // Check if it looks like a file path
    const ext = path.extname(arg).toLowerCase();
    if (['.md', '.qmd', '.markdown', '.mdown', '.mdx', '.ipynb'].includes(ext)) {
      return arg;
    }
  }
  return null;
}

// ============================================================================
// macOS: Handle open-file event
// ============================================================================
// This event can fire BEFORE app.whenReady(), so we set it up early
// and queue files if the app isn't ready yet.
//
// NOTE: We intentionally do NOT use requestSingleInstanceLock() because
// MRMD is a single-document app (no tabs). Each file opens in its own
// window/instance, like opening multiple PDFs in separate viewers.
// ============================================================================

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  console.log(`[open-file] macOS open-file event: ${filePath}`);

  if (app.isReady()) {
    sendFileToOpen(filePath);
  } else {
    // App not ready yet, queue the file
    pendingFilesToOpen.push(filePath);
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

  // Check for file in command line args (Windows/Linux initial launch)
  const initialFile = getFileFromArgv(process.argv);
  if (initialFile) {
    console.log(`[startup] Found file in argv: ${initialFile}`);
    pendingFilesToOpen.push(initialFile);
  }

  const win = createWindow();

  // Process any pending files once the window is ready to receive them
  win.webContents.once('did-finish-load', () => {
    // Small delay to ensure renderer is fully initialized
    setTimeout(() => {
      if (pendingFilesToOpen.length > 0) {
        console.log(`[startup] Processing ${pendingFilesToOpen.length} pending file(s)`);
        for (const filePath of pendingFilesToOpen) {
          sendFileToOpen(filePath);
        }
        pendingFilesToOpen.length = 0; // Clear the queue
      }
    }, 500);
  });

  ensureAiServer().catch(e => console.error('[ai] Failed:', e.message));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// ============================================================================
// CLOUD AUTH IPC HANDLERS
// ============================================================================

ipcMain.handle('cloud:status', async () => {
  const user = cloudAuth.getUser();
  return {
    signedIn: cloudAuth.isSignedIn(),
    user,
    syncStatus: cloudSync?.getStatus() || null,
    machineHub: {
      enabled: MACHINE_HUB_MODE,
      roots: MACHINE_HUB_ROOTS,
      hostedProjects: [...machineHubProjects],
    },
    systemdService: systemd.getStatus(),
  };
});

ipcMain.handle('cloud:signIn', async () => {
  const result = await cloudAuth.signIn();
  await startCloudSyncIfReady();

  // Auto-install systemd service on first sign-in (Linux only).
  // This ensures the machine-agent runs on boot without manual setup.
  if (systemd.isSupported()) {
    const status = systemd.getStatus();
    if (!status.installed) {
      const installResult = systemd.install({
        roots: MACHINE_HUB_ROOTS.join(':'),
        cloudUrl: cloudAuth.cloudUrl,
      });
      if (installResult.ok) {
        console.log('[systemd] Machine agent service auto-installed and started');
      } else {
        console.warn('[systemd] Auto-install failed:', installResult.error);
      }
    }
  }

  return result;
});

ipcMain.handle('cloud:signOut', async () => {
  await stopMachineHub();
  if (cloudSync) {
    await cloudSync.stopAll();
    cloudSync = null;
  }
  await cloudAuth.signOut();
  return { ok: true };
});

ipcMain.handle('cloud:validate', async () => {
  const user = await cloudAuth.validate();
  return { valid: Boolean(user), user };
});

// ============================================================================
// SYSTEMD SERVICE MANAGEMENT (machine-agent)
// ============================================================================

import * as systemd from './src/utils/systemd.js';

ipcMain.handle('systemd:status', () => {
  return systemd.getStatus();
});

ipcMain.handle('systemd:install', (_event, opts = {}) => {
  return systemd.install({
    roots: opts.roots || MACHINE_HUB_ROOTS.join(':'),
    cloudUrl: cloudAuth.cloudUrl,
  });
});

ipcMain.handle('systemd:uninstall', () => {
  return systemd.uninstall();
});

ipcMain.handle('systemd:restart', () => {
  return systemd.restart();
});

ipcMain.handle('systemd:logs', (_event, { lines } = {}) => {
  return systemd.getLogs(lines);
});

ipcMain.handle('cloud:bridgeDoc', async (_event, { projectDir, docName }) => {
  if (!cloudSync) return { ok: false, reason: 'not-signed-in' };
  if (!projectDir || !docName) return { ok: false, reason: 'invalid-params' };
  try {
    cloudSync.bridgeDoc(projectDir, docName);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('cloud:fetchAsset', async (_event, { localProjectRoot, relativePath }) => {
  if (!cloudAuth?.isSignedIn()) return { ok: false, reason: 'not-signed-in' };
  if (!relativePath) return { ok: false, reason: 'invalid-params' };

  const localPath = path.join(localProjectRoot, relativePath);

  // If file exists locally, return early unless it looks like an HTML login page
  // accidentally saved with an image extension (can happen on auth redirect).
  if (fs.existsSync(localPath)) {
    try {
      const probe = fs.readFileSync(localPath, 'utf8').slice(0, 512).trimStart().toLowerCase();
      const looksLikeHtml = probe.startsWith('<!doctype html') || probe.startsWith('<html');
      if (!looksLikeHtml) return { ok: true, exists: true };
      console.warn(`[cloud:fetchAsset] Existing file looks like HTML, re-downloading: ${localPath}`);
    } catch {
      // Binary/non-utf8 file is fine; treat as existing.
      return { ok: true, exists: true };
    }
  }

  const token = cloudAuth.getToken();
  const cloudUrl = cloudSync?.cloudUrl;
  const userId = cloudSync?.userId;
  if (!cloudUrl || !userId || !token) return { ok: false, reason: 'no-cloud-connection' };

  const projectName = path.basename(localProjectRoot);
  const cloudRelativePath = `${projectName}/${relativePath}`;
  const fetchUrl = `${cloudUrl.replace(/\/$/, '')}/u/${userId}/api/project-file?path=${encodeURIComponent(cloudRelativePath)}`;

  try {
    const response = await fetch(fetchUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-User-Id': userId,
      },
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      return { ok: false, reason: 'unexpected-html-response' };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, buffer);
    console.log(`[cloud:fetchAsset] Downloaded: ${cloudRelativePath} -> ${localPath} (${buffer.length} bytes)`);
    return { ok: true, path: localPath, size: buffer.length };
  } catch (err) {
    console.warn(`[cloud:fetchAsset] Failed: ${err.message}`);
    return { ok: false, reason: err.message };
  }
});

// Start cloud sync on app ready (if already signed in)
app.whenReady().then(() => {
  startCloudSyncIfReady().catch(err => {
    console.warn('[cloud] Background sync init failed:', err.message);
  });

  // Keep systemd service in sync with current paths/config.
  // On every startup, if the service is installed, regenerate the unit file
  // so it always points to the current node binary, script path, and env vars.
  if (systemd.isSupported()) {
    const status = systemd.getStatus();
    if (status.installed) {
      const result = systemd.install({
        roots: MACHINE_HUB_ROOTS.join(':'),
        cloudUrl: cloudAuth.cloudUrl,
      });
      if (result.ok) {
        console.log('[systemd] Service unit refreshed with current paths');
      } else {
        console.warn('[systemd] Failed to refresh service unit:', result.error);
      }
    }
  }
});

app.on('window-all-closed', () => {
  for (const [windowId] of windowStates) {
    cleanupWindow(windowId);
  }

  // Machine Hub mode: keep app running headless so this machine remains
  // available to phone/browser collaborators even with no local windows open.
  if (MACHINE_HUB_MODE && cloudSync) {
    console.log('[hub] No windows open — staying alive in Machine Hub mode');
    return;
  }

  // Shutdown all runtime sessions (python, bash, r, julia, pty)
  runtimeService.shutdown();

  stopMachineHub().catch(() => {});

  if (cloudSync) {
    cloudSync.stopAll().catch((err) => {
      console.warn('[cloud] Failed to stop all bridges during shutdown:', err.message);
    });
    cloudSync = null;
  }

  if (aiServer?.proc) {
    aiServer.proc.kill('SIGTERM');
  }

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
