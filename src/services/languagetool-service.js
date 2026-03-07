/**
 * LanguageToolService
 *
 * Shared Node service for MRMD Electron + mrmd-server.
 *
 * Responsibilities:
 * - resolve a LanguageTool endpoint or local distribution
 * - lazily start a local LanguageTool HTTP server when needed
 * - expose status/languages/check operations
 *
 * Resolution order:
 * 1. MRMD_LANGUAGETOOL_URL           → remote HTTP endpoint
 * 2. MRMD_LANGUAGETOOL_DIR           → explicit local distribution
 * 3. constructor-provided dirs       → app/server-specific vendor/resource dirs
 * 4. packaged resource candidates    → process.resourcesPath
 * 5. local vendor/dev candidates     → repo-relative directories
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import os from 'os';
import https from 'https';
import { getDataDir } from '../utils/platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizePathMaybe(value) {
  if (!value) return null;
  try {
    return path.resolve(String(value));
  } catch {
    return String(value);
  }
}

function normalizeBaseUrl(url) {
  if (!url) return null;
  return String(url).replace(/\/+$/, '');
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findInPath(executable) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${cmd} ${executable}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim().split('\n')[0];
    return result && fileExists(result) ? result : null;
  } catch {
    return null;
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const normalized = String(item || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function firstExisting(paths) {
  for (const candidate of paths) {
    if (candidate && fileExists(candidate)) return candidate;
  }
  return null;
}

function uniquePaths(paths) {
  return Array.from(new Set(paths.filter(Boolean).map((p) => normalizePathMaybe(p))));
}

function detectDistributionRoot(rootDir) {
  const root = normalizePathMaybe(rootDir);
  if (!root || !fileExists(root)) return null;

  const candidates = [
    root,
    path.join(root, 'LanguageTool'),
    path.join(root, 'languagetool'),
  ];

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidates.push(path.join(root, entry.name));
      }
    }
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    const serverJar = path.join(candidate, 'languagetool-server.jar');
    const libsDir = path.join(candidate, 'libs');
    if (fileExists(serverJar) || fileExists(libsDir)) {
      return candidate;
    }
  }

  return null;
}

function gatherJarPaths(distributionDir) {
  const dir = normalizePathMaybe(distributionDir);
  if (!dir) return [];

  const jars = [];
  const pushJarIfExists = (jarPath) => {
    if (fileExists(jarPath) && jarPath.endsWith('.jar')) jars.push(jarPath);
  };

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jar')) {
        jars.push(path.join(dir, entry.name));
      }
    }
  } catch {
    // ignore
  }

  const libsDir = path.join(dir, 'libs');
  if (fileExists(libsDir)) {
    try {
      for (const entry of fs.readdirSync(libsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jar')) {
          jars.push(path.join(libsDir, entry.name));
        }
      }
    } catch {
      // ignore
    }
  }

  pushJarIfExists(path.join(dir, 'languagetool-server.jar'));
  pushJarIfExists(path.join(dir, 'languagetool-commandline.jar'));

  return uniquePaths(jars);
}

async function waitForHealthy(baseUrl, { timeout = 30000 } = {}) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v2/languages`);
      if (response.ok) return true;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }

  throw lastError || new Error(`Timed out waiting for LanguageTool at ${baseUrl}`);
}

function canonicalizeLanguageCode(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase() === 'auto') return 'auto';

  const aliases = {
    eng: 'en',
    fra: 'fr',
    fre: 'fr',
    deu: 'de',
    ger: 'de',
    spa: 'es',
    por: 'pt',
    ita: 'it',
    jpn: 'ja',
    zho: 'zh',
    chi: 'zh',
    can: 'ca',
    cat: 'ca',
  };

  const parts = raw.replace(/_/g, '-').split('-').filter(Boolean);
  if (parts.length === 0) return '';
  const first = aliases[parts[0].toLowerCase()] || parts[0].toLowerCase();
  const rest = parts.slice(1).map((part) => {
    if (part.length === 2) return part.toUpperCase();
    return part;
  });
  return [first, ...rest].join('-');
}

function getSupportedLanguageCodes(languageEntries = []) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(languageEntries) ? languageEntries : []) {
    for (const code of [entry?.code, entry?.longCode]) {
      const normalized = canonicalizeLanguageCode(code);
      if (!normalized || normalized === 'auto') continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
  }
  return out;
}

function normalizeRequestedLanguage(input, supportedCodes = [], { allowAuto = false } = {}) {
  const normalized = canonicalizeLanguageCode(input);
  if (!normalized) return allowAuto ? 'auto' : null;
  if (allowAuto && normalized === 'auto') return 'auto';
  if (!allowAuto && normalized === 'auto') return null;

  const codes = Array.isArray(supportedCodes) ? supportedCodes : [];
  const exact = codes.find((code) => code.toLowerCase() === normalized.toLowerCase());
  if (exact) return exact;

  const base = normalized.split('-')[0].toLowerCase();
  if (!base) return allowAuto ? 'auto' : null;

  const exactBase = codes.find((code) => code.toLowerCase() === base);
  if (exactBase) return exactBase;

  const prefixed = codes.find((code) => code.toLowerCase().startsWith(`${base}-`));
  if (prefixed) return prefixed;

  return allowAuto ? 'auto' : null;
}

function buildFormBody(payload = {}) {
  const body = new URLSearchParams();

  const scalarFields = [
    'text',
    'language',
    'motherTongue',
    'preferredVariants',
    'level',
    'mode',
  ];

  for (const field of scalarFields) {
    if (payload[field] !== undefined && payload[field] !== null && payload[field] !== '') {
      body.set(field, String(payload[field]));
    }
  }

  const listFields = [
    'enabledRules',
    'disabledRules',
    'enabledCategories',
    'disabledCategories',
  ];

  for (const field of listFields) {
    const list = normalizeStringList(payload[field]);
    if (list.length > 0) {
      body.set(field, list.join(','));
    }
  }

  return body;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${code}): ${stderr.trim()}`));
    });
    proc.on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const request = (currentUrl) => {
      https.get(currentUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          fs.unlink(dest, () => {});
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(dest);
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', (error) => {
          file.close();
          fs.unlink(dest, () => {});
          reject(error);
        });
      }).on('error', (error) => {
        fs.unlink(dest, () => {});
        reject(error);
      });
    };

    request(url);
  });
}

async function extractZip(archivePath, destDir) {
  if (process.platform === 'win32') {
    await runCommand('powershell', [
      '-Command',
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
    ]);
    return;
  }

  const unzip = findInPath('unzip');
  if (unzip) {
    await runCommand(unzip, ['-q', archivePath, '-d', destDir]);
    return;
  }

  const python = findInPath('python3') || findInPath('python');
  if (python) {
    await runCommand(python, ['-m', 'zipfile', '-e', archivePath, destDir]);
    return;
  }

  throw new Error('No zip extractor found. Install unzip or Python.');
}

export default class LanguageToolService {
  constructor(options = {}) {
    this.options = options;
    this.process = null;
    this.processInfo = null;
    this.startPromise = null;
    this.installPromise = null;
    this.languagesCache = null;
    this.languagesCacheAt = 0;
  }

  _resolveJavaBin() {
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    const candidates = uniquePaths([
      this.options.javaBin,
      process.env.MRMD_LANGUAGETOOL_JAVA,
      process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', exe) : null,
      process.resourcesPath ? path.join(process.resourcesPath, 'jre', 'bin', exe) : null,
      process.resourcesPath ? path.join(process.resourcesPath, 'languagetool', 'jre', 'bin', exe) : null,
    ]);

    return firstExisting(candidates) || findInPath(process.platform === 'win32' ? 'java.exe' : 'java');
  }

  _isAutoInstallEnabled() {
    if (this.options.autoInstall === false) return false;
    if (process.env.MRMD_LANGUAGETOOL_AUTO_INSTALL === '0') return false;
    return true;
  }

  _getManagedBaseDir() {
    return normalizePathMaybe(this.options.dataDir || path.join(getDataDir(), 'languagetool'));
  }

  _getManagedDistributionDir() {
    return path.join(this._getManagedBaseDir(), 'LanguageTool');
  }

  _getDownloadUrl() {
    return process.env.MRMD_LANGUAGETOOL_DOWNLOAD_URL
      || this.options.downloadUrl
      || 'https://languagetool.org/download/LanguageTool-stable.zip';
  }

  async _ensureManagedDistribution() {
    if (this.installPromise) return this.installPromise;

    this.installPromise = (async () => {
      const managedDir = this._getManagedDistributionDir();
      const existing = detectDistributionRoot(managedDir);
      if (existing) return existing;

      const javaBin = this._resolveJavaBin();
      if (!javaBin) {
        throw new Error('Java runtime not found. Set MRMD_LANGUAGETOOL_JAVA or install Java.');
      }

      const baseDir = this._getManagedBaseDir();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrmd-languagetool-'));
      const archivePath = path.join(tmpDir, 'LanguageTool-stable.zip');
      const extractDir = path.join(tmpDir, 'extract');
      fs.mkdirSync(extractDir, { recursive: true });

      const downloadUrl = this._getDownloadUrl();
      console.log(`[languagetool] Downloading LanguageTool from ${downloadUrl}`);
      await downloadFile(downloadUrl, archivePath);
      console.log('[languagetool] Extracting LanguageTool archive');
      await extractZip(archivePath, extractDir);

      const extractedRoot = detectDistributionRoot(extractDir);
      if (!extractedRoot) {
        throw new Error('Downloaded LanguageTool archive did not contain a valid distribution');
      }

      fs.mkdirSync(baseDir, { recursive: true });
      try {
        fs.rmSync(managedDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      fs.cpSync(extractedRoot, managedDir, { recursive: true });
      console.log(`[languagetool] Installed LanguageTool to ${managedDir}`);
      return managedDir;
    })();

    try {
      return await this.installPromise;
    } finally {
      this.installPromise = null;
    }
  }

  _resolveLocalDistribution() {
    const configuredCandidates = Array.isArray(this.options.distributionDirs)
      ? this.options.distributionDirs
      : [];

    const candidates = uniquePaths([
      process.env.MRMD_LANGUAGETOOL_DIR,
      ...configuredCandidates,
      this._getManagedDistributionDir(),
      this._getManagedBaseDir(),
      process.resourcesPath ? path.join(process.resourcesPath, 'languagetool') : null,
      path.resolve(__dirname, '../../vendor/languagetool'),
      path.resolve(__dirname, '../../../../vendor/languagetool'),
      path.resolve(__dirname, '../../../../languagetool'),
    ]);

    for (const candidate of candidates) {
      const root = detectDistributionRoot(candidate);
      if (root) return root;
    }

    return null;
  }

  resolve() {
    const remoteUrl = normalizeBaseUrl(this.options.baseUrl || process.env.MRMD_LANGUAGETOOL_URL);
    if (remoteUrl) {
      return {
        mode: 'remote',
        baseUrl: remoteUrl,
        source: 'env:url',
      };
    }

    const distributionDir = this._resolveLocalDistribution();
    if (!distributionDir) {
      return {
        mode: 'unavailable',
        baseUrl: null,
        source: 'none',
        error: this._isAutoInstallEnabled()
          ? 'LanguageTool distribution not found yet. MRMD can download it automatically on first use.'
          : 'LanguageTool distribution not found. Set MRMD_LANGUAGETOOL_URL or MRMD_LANGUAGETOOL_DIR.',
      };
    }

    const javaBin = this._resolveJavaBin();
    if (!javaBin) {
      return {
        mode: 'unavailable',
        baseUrl: null,
        source: 'none',
        distributionDir,
        error: 'Java runtime not found. Set MRMD_LANGUAGETOOL_JAVA or install Java.',
      };
    }

    return {
      mode: 'local',
      source: 'local:distribution',
      baseUrl: null,
      distributionDir,
      javaBin,
    };
  }

  async ensureStarted() {
    let resolved = this.resolve();

    if (resolved.mode === 'remote') {
      return {
        ...resolved,
        running: true,
      };
    }

    if (resolved.mode !== 'local' && this._isAutoInstallEnabled()) {
      try {
        await this._ensureManagedDistribution();
        resolved = this.resolve();
      } catch (error) {
        throw new Error(`LanguageTool is unavailable: ${error?.message || error}`);
      }
    }

    if (resolved.mode !== 'local') {
      throw new Error(resolved.error || 'LanguageTool is unavailable');
    }

    if (this.process && this.process.exitCode === null && this.processInfo?.baseUrl) {
      return {
        ...resolved,
        ...this.processInfo,
        running: true,
      };
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      const jars = gatherJarPaths(resolved.distributionDir);
      if (jars.length === 0) {
        throw new Error(`No LanguageTool jars found in ${resolved.distributionDir}`);
      }

      const port = this.options.port || await findFreePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const classpath = jars.join(path.delimiter);

      const args = [
        '-cp',
        classpath,
        'org.languagetool.server.HTTPServer',
        '--port',
        String(port),
        '--allow-origin',
        '*',
      ];

      const proc = spawn(resolved.javaBin, args, {
        cwd: resolved.distributionDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      proc.stdout?.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.log('[languagetool]', text);
      });
      proc.stderr?.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.warn('[languagetool]', text);
      });
      proc.on('exit', (code, signal) => {
        console.log(`[languagetool] exited code=${code} signal=${signal}`);
        this.process = null;
        this.processInfo = null;
        this.startPromise = null;
        this.languagesCache = null;
        this.languagesCacheAt = 0;
      });

      try {
        await waitForHealthy(baseUrl, { timeout: this.options.startupTimeout || 30000 });
      } catch (error) {
        try { proc.kill('SIGTERM'); } catch {}
        throw error;
      }

      this.process = proc;
      this.processInfo = {
        baseUrl,
        port,
        pid: proc.pid,
      };

      return {
        ...resolved,
        ...this.processInfo,
        running: true,
      };
    })();

    try {
      return await this.startPromise;
    } finally {
      if (!this.processInfo) {
        this.startPromise = null;
      }
    }
  }

  async stop() {
    if (this.process && this.process.exitCode === null) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.process = null;
    this.processInfo = null;
    this.startPromise = null;
    this.languagesCache = null;
    this.languagesCacheAt = 0;
    return { success: true };
  }

  async status() {
    const resolved = this.resolve();

    if (resolved.mode === 'remote') {
      try {
        await waitForHealthy(resolved.baseUrl, { timeout: 1500 });
        return {
          available: true,
          configured: true,
          mode: 'remote',
          running: true,
          source: resolved.source,
          baseUrl: resolved.baseUrl,
        };
      } catch (error) {
        return {
          available: true,
          configured: true,
          mode: 'remote',
          running: false,
          source: resolved.source,
          baseUrl: resolved.baseUrl,
          error: error?.message || String(error),
        };
      }
    }

    if (resolved.mode === 'local') {
      const running = Boolean(this.process && this.process.exitCode === null && this.processInfo?.baseUrl);
      return {
        available: true,
        configured: true,
        mode: 'local',
        running,
        source: resolved.source,
        distributionDir: resolved.distributionDir,
        javaBin: resolved.javaBin,
        baseUrl: running ? this.processInfo.baseUrl : null,
        port: running ? this.processInfo.port : null,
        pid: running ? this.processInfo.pid : null,
      };
    }

    return {
      available: false,
      configured: false,
      mode: 'unavailable',
      running: false,
      source: resolved.source,
      error: resolved.error || 'LanguageTool unavailable',
    };
  }

  async languages({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.languagesCache && now - this.languagesCacheAt < 5 * 60 * 1000) {
      return this.languagesCache;
    }

    const runtime = await this.ensureStarted();
    const response = await fetch(`${normalizeBaseUrl(runtime.baseUrl)}/v2/languages`);
    if (!response.ok) {
      throw new Error(`LanguageTool languages failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    this.languagesCache = data;
    this.languagesCacheAt = now;
    return data;
  }

  async check(payload = {}) {
    const text = String(payload.text || '');
    if (!text.trim()) {
      return {
        software: { name: 'LanguageTool' },
        language: null,
        matches: [],
      };
    }

    const runtime = await this.ensureStarted();
    const supportedCodes = getSupportedLanguageCodes(await this.languages());
    const normalizedPayload = {
      ...payload,
      language: normalizeRequestedLanguage(payload.language, supportedCodes, { allowAuto: true }),
      motherTongue: normalizeRequestedLanguage(payload.motherTongue, supportedCodes, { allowAuto: false }) || undefined,
    };

    const preferredVariants = normalizeStringList(payload.preferredVariants)
      .map((value) => normalizeRequestedLanguage(value, supportedCodes, { allowAuto: false }))
      .filter(Boolean);
    normalizedPayload.preferredVariants = preferredVariants.length > 0 ? preferredVariants.join(',') : undefined;

    const response = await fetch(`${normalizeBaseUrl(runtime.baseUrl)}/v2/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: buildFormBody(normalizedPayload).toString(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`LanguageTool check failed: HTTP ${response.status}${body ? ` — ${body}` : ''}`);
    }

    return response.json();
  }
}
