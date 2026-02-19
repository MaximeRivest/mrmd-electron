/**
 * Machine Agent MVP (headless)
 *
 * Runs without Electron windows and turns this machine into a collaboration hub:
 * - Starts mrmd-sync per discovered local project
 * - Bridges all project docs to cloud relay via CloudSync
 * - Exposes local runtimes (python/bash/r/julia/pty/ai) via runtime tunnel
 *
 * Usage:
 *   npm run machine-agent
 *
 * Optional env:
 *   MARKCO_CLOUD_URL=https://markco.dev
 *   MRMD_MACHINE_HUB_ROOTS=/home/me/Projects:/mnt/work
 *   MRMD_MACHINE_ID=my-laptop
 *   MRMD_MACHINE_NAME="XPSwhite"
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

import { CloudSync } from './cloud-sync.js';
import { RuntimeService, SettingsService } from './services/index.js';
import { findFreePort, waitForPort } from './utils/index.js';
import { DIR_HASH_LENGTH, SYNC_SERVER_MEMORY_MB } from './config.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLOUD_URL = process.env.MARKCO_CLOUD_URL || 'https://markco.dev';
const ROOTS = (process.env.MRMD_MACHINE_HUB_ROOTS || path.join(os.homedir(), 'Projects'))
  .split(path.delimiter)
  .map((p) => p.trim())
  .filter(Boolean);
const RESCAN_MS = parseInt(process.env.MRMD_MACHINE_RESCAN_MS || '30000', 10);
const MACHINE_ID = process.env.MRMD_MACHINE_ID || `${os.hostname()}-${os.userInfo().username}`;
const MACHINE_NAME = process.env.MRMD_MACHINE_NAME || os.hostname();

const settings = new SettingsService();
const runtimeService = new RuntimeService();

/** @type {Map<string, { proc: import('child_process').ChildProcess, port: number, dir: string }>} */
const syncServers = new Map();

let cloudSync = null;
let cloudToken = null;
let cloudUserId = null;
let scanTimer = null;
let stopping = false;

function log(...args) {
  console.log('[machine-agent]', ...args);
}

function computeDirHash(dir) {
  return crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, DIR_HASH_LENGTH);
}

function resolvePackageBin(packageName, binPath) {
  // 1) node_modules resolution
  try {
    const pkgPath = require.resolve(`${packageName}/package.json`);
    return path.join(path.dirname(pkgPath), binPath);
  } catch {
    // 2) sibling package in monorepo
    const sibling = path.resolve(__dirname, '../../', packageName, binPath);
    if (fs.existsSync(sibling)) return sibling;
    throw new Error(`Cannot resolve ${packageName}/${binPath}`);
  }
}

function docNameFromPath(filePath, projectDir) {
  const rel = path.relative(projectDir, filePath).replace(/\\/g, '/');
  if (rel.endsWith('.qmd')) return rel.slice(0, -4);
  if (rel.endsWith('.md')) return rel.slice(0, -3);
  return rel;
}

function discoverDocNames(projectDir) {
  const docs = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.venv' || entry.name === '__pycache__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.qmd')) {
        docs.push(docNameFromPath(full, projectDir));
      }
    }
  };
  walk(projectDir);
  return docs;
}

function discoverProjects() {
  const projects = new Set();

  for (const root of ROOTS) {
    if (!fs.existsSync(root)) continue;

    // Root itself may be a project
    if (fs.existsSync(path.join(root, 'mrmd.md'))) {
      projects.add(path.resolve(root));
    }

    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      if (fs.existsSync(path.join(dir, 'mrmd.md'))) {
        projects.add(path.resolve(dir));
      }
    }
  }

  return [...projects];
}

async function ensureSyncServer(projectDir) {
  const dirHash = computeDirHash(projectDir);
  if (syncServers.has(dirHash)) return syncServers.get(dirHash);

  const port = await findFreePort();
  const syncCliPath = resolvePackageBin('mrmd-sync', 'bin/cli.js');

  const nodeArgs = [
    `--max-old-space-size=${SYNC_SERVER_MEMORY_MB}`,
    syncCliPath,
    '--port', String(port),
    // Headless host mode can bridge hundreds of docs concurrently.
    '--max-connections', '1200',
    '--max-per-doc', '100',
    '--i-know-what-i-am-doing',
    projectDir,
  ];

  const proc = spawn('node', nodeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => log(`[sync:${port}]`, d.toString().trim()));
  proc.stderr.on('data', (d) => log(`[sync:${port}:err]`, d.toString().trim()));

  proc.on('exit', (code, signal) => {
    log(`sync exited for ${projectDir} (code=${code}, signal=${signal})`);
    syncServers.delete(dirHash);
  });

  await waitForPort(port, { timeout: 15000 });

  const server = { proc, port, dir: projectDir };
  syncServers.set(dirHash, server);

  log(`hosting project ${projectDir} on sync:${port}`);
  return server;
}

async function registerProject(server) {
  if (!cloudSync) return;
  const projectName = path.basename(server.dir);
  // Register project without eager doc bridging — bridges happen on-demand
  // when the relay sends bridge-request (someone opened a doc on web/phone)
  cloudSync.bridgeProject(server.port, server.dir, projectName, []);
}

/** Pull cloud-created docs into local filesystem (missing files only). */
async function pullProjectFromCloud(projectDir) {
  if (!cloudToken || !cloudUserId) return;

  const projectName = path.basename(projectDir);
  const url = `${CLOUD_URL}/api/sync/documents?project=${encodeURIComponent(projectName)}&content=1`;

  let data;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cloudToken}`,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }

  const docs = data?.documents || [];
  for (const doc of docs) {
    const filePath = path.join(projectDir, `${doc.docPath}.md`);
    if (fs.existsSync(filePath)) continue; // only materialize missing docs

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, doc.content || '', 'utf8');
      log(`pulled cloud doc -> local: ${filePath}`);
    } catch (err) {
      log(`failed writing pulled doc ${filePath}: ${err.message}`);
    }
  }
}

async function syncScan() {
  if (stopping) return;

  const projectDirs = discoverProjects();
  for (const dir of projectDirs) {
    try {
      await pullProjectFromCloud(dir);
      const server = await ensureSyncServer(dir);
      await registerProject(server);
    } catch (err) {
      log(`failed hosting ${dir}: ${err.message}`);
    }
  }

  // Register projects and collect catalog entries
  const catalogEntries = [];
  for (const server of syncServers.values()) {
    try {
      await registerProject(server);
      // Collect catalog entries
      const projectName = path.basename(server.dir);
      const docs = discoverDocNames(server.dir);
      for (const docName of docs) {
        catalogEntries.push({ project: projectName, docPath: docName });
      }
    } catch (err) {
      log(`failed registering ${server.dir}: ${err.message}`);
    }
  }

  // Push lightweight file catalog to relay
  if (cloudSync && catalogEntries.length > 0) {
    cloudSync.pushCatalog(MACHINE_ID, {
      machineName: MACHINE_NAME,
      hostname: os.hostname(),
      capabilities: runtimeService.supportedLanguages?.() || [],
      entries: catalogEntries,
    }).catch(err => log('catalog push failed:', err.message));
  }
}

async function start() {
  settings.load();
  const token = settings.get('cloud.token', null);
  const user = settings.get('cloud.user', null);

  if (!token || !user?.id) {
    throw new Error('Not signed in. Open mrmd-electron once and sign in to markco.dev first.');
  }

  cloudToken = token;
  cloudUserId = user.id;

  cloudSync = new CloudSync({
    cloudUrl: CLOUD_URL,
    token,
    userId: user.id,
    runtimeService,
    log: (...args) => log(...args),
  });

  log(`connected as ${user.name || user.email || user.id}`);
  log(`roots: ${ROOTS.join(', ')}`);

  await syncScan();
  scanTimer = setInterval(() => {
    syncScan().catch((err) => log('scan failed:', err.message));
  }, RESCAN_MS);
}

async function stop() {
  if (stopping) return;
  stopping = true;

  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }

  try { await cloudSync?.stopAll(); } catch {}
  cloudSync = null;
  cloudToken = null;
  cloudUserId = null;

  runtimeService.shutdown();

  for (const server of syncServers.values()) {
    try { server.proc.kill('SIGTERM'); } catch {}
  }
  syncServers.clear();

  log('stopped');
}

process.on('SIGINT', async () => {
  await stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await stop();
  process.exit(0);
});

start().catch(async (err) => {
  console.error('[machine-agent] fatal:', err.message);
  await stop();
  process.exit(1);
});
