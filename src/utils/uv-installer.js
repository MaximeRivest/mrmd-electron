/**
 * UV Auto-Installer for mrmd-electron
 *
 * Automatically downloads and installs uv if not present.
 * uv is required for fast Python package management.
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';

import {
  UV_PATHS,
  UV_DOWNLOAD_URLS,
  UV_INSTALL_DIR,
  UV_INSTALL_PATH,
} from '../config.js';

/**
 * Find existing uv installation
 * @returns {string|null} Path to uv binary or null
 */
export function findUv() {
  // Check configured paths
  for (const loc of UV_PATHS) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  // Check our install location
  if (fs.existsSync(UV_INSTALL_PATH)) {
    return UV_INSTALL_PATH;
  }

  // Try PATH via 'which' (Unix) or 'where' (Windows)
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${cmd} uv`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim().split('\n')[0];

    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch {
    // uv not in PATH
  }

  return null;
}

/**
 * Get the download URL for current platform
 * @returns {string|null} Download URL or null if unsupported
 */
function getDownloadUrl() {
  const platform = process.platform;
  const arch = process.arch;

  const key = `${platform}-${arch}`;
  return UV_DOWNLOAD_URLS[key] || null;
}

/**
 * Download a file to a local path
 * @param {string} url - URL to download
 * @param {string} dest - Destination path
 * @param {function} onProgress - Progress callback (received, total)
 * @returns {Promise<void>}
 */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);

    const request = (url) => {
      https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        const total = parseInt(response.headers['content-length'], 10);
        let received = 0;

        response.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

/**
 * Extract tar.gz archive
 * @param {string} archive - Path to archive
 * @param {string} dest - Destination directory
 * @returns {Promise<void>}
 */
async function extractTarGz(archive, dest) {
  // Use tar command (available on Unix and modern Windows)
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', archive, '-C', dest], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar extract failed: ${stderr}`));
    });

    proc.on('error', reject);
  });
}

/**
 * Extract zip archive (Windows)
 * @param {string} archive - Path to archive
 * @param {string} dest - Destination directory
 * @returns {Promise<void>}
 */
async function extractZip(archive, dest) {
  // Use PowerShell on Windows
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell', [
      '-Command',
      `Expand-Archive -Path '${archive}' -DestinationPath '${dest}' -Force`
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`zip extract failed: ${stderr}`));
    });

    proc.on('error', reject);
  });
}

/**
 * Install uv automatically
 * @param {object} options - Options
 * @param {function} options.onProgress - Progress callback (stage, detail)
 * @returns {Promise<string>} Path to installed uv binary
 */
export async function installUv(options = {}) {
  const { onProgress } = options;

  const report = (stage, detail) => {
    console.log(`[uv-install] ${stage}: ${detail}`);
    if (onProgress) onProgress(stage, detail);
  };

  // Check if already installed
  const existing = findUv();
  if (existing) {
    report('found', existing);
    return existing;
  }

  // Get download URL
  const url = getDownloadUrl();
  if (!url) {
    throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  }

  report('downloading', url);

  // Create temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-install-'));
  const isZip = url.endsWith('.zip');
  const archivePath = path.join(tmpDir, isZip ? 'uv.zip' : 'uv.tar.gz');

  try {
    // Download
    await downloadFile(url, archivePath, (received, total) => {
      const pct = total ? Math.round((received / total) * 100) : 0;
      report('downloading', `${pct}%`);
    });

    report('extracting', archivePath);

    // Extract
    if (isZip) {
      await extractZip(archivePath, tmpDir);
    } else {
      await extractTarGz(archivePath, tmpDir);
    }

    // Find the uv binary in extracted files
    const uvBinary = process.platform === 'win32' ? 'uv.exe' : 'uv';
    let extractedUv = null;

    // Search for uv in tmpDir (might be in a subdirectory)
    const searchDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = searchDir(fullPath);
          if (found) return found;
        } else if (entry.name === uvBinary) {
          return fullPath;
        }
      }
      return null;
    };

    extractedUv = searchDir(tmpDir);

    if (!extractedUv) {
      throw new Error('uv binary not found in archive');
    }

    report('installing', UV_INSTALL_PATH);

    // Ensure install directory exists
    fs.mkdirSync(UV_INSTALL_DIR, { recursive: true });

    // Move uv to install location
    fs.copyFileSync(extractedUv, UV_INSTALL_PATH);

    // Make executable (Unix)
    if (process.platform !== 'win32') {
      fs.chmodSync(UV_INSTALL_PATH, 0o755);
    }

    report('complete', UV_INSTALL_PATH);

    return UV_INSTALL_PATH;

  } finally {
    // Cleanup temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Ensure uv is installed, installing if necessary
 * @param {object} options - Options passed to installUv
 * @returns {Promise<string>} Path to uv binary
 */
export async function ensureUv(options = {}) {
  const existing = findUv();
  if (existing) {
    return existing;
  }

  return installUv(options);
}

/**
 * Get uv version
 * @param {string} uvPath - Path to uv binary
 * @returns {string|null} Version string or null
 */
export function getUvVersion(uvPath) {
  try {
    const result = execSync(`"${uvPath}" --version`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    // Output is like "uv 0.5.14"
    return result.split(' ')[1] || result;
  } catch {
    return null;
  }
}
