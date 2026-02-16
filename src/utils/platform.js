/**
 * Cross-platform utilities for mrmd-electron
 *
 * Provides platform-aware helpers for paths, processes, and system operations.
 * All functions preserve existing Linux/macOS behavior while adding Windows support.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

// Platform detection
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/**
 * Get the bin directory name for a Python venv
 * Unix: bin/
 * Windows: Scripts/
 */
export function getVenvBinDir() {
  return isWin ? 'Scripts' : 'bin';
}

/**
 * Get the Python executable path within a venv
 * @param {string} venvPath - Path to the virtual environment
 * @returns {string} Path to the Python executable
 */
export function getVenvPython(venvPath) {
  return isWin
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python');
}

/**
 * Get the path to an executable within a venv
 * @param {string} venvPath - Path to the virtual environment
 * @param {string} execName - Name of the executable (without .exe)
 * @returns {string} Path to the executable
 */
export function getVenvExecutable(venvPath, execName) {
  return isWin
    ? path.join(venvPath, 'Scripts', `${execName}.exe`)
    : path.join(venvPath, 'bin', execName);
}

/**
 * Get the Python command to use for creating venvs
 * Windows: python (python3 doesn't exist)
 * Unix: python3
 */
export function getPythonCommand() {
  return isWin ? 'python' : 'python3';
}

/**
 * Get the appropriate config directory for the platform
 * Windows: %APPDATA%/mrmd
 * macOS: ~/Library/Application Support/mrmd
 * Linux: ~/.config/mrmd (or XDG_CONFIG_HOME)
 */
export function getConfigDir() {
  if (isWin) {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'mrmd');
  } else if (isMac) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'mrmd');
  } else {
    // Linux - respect XDG
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'mrmd');
  }
}

/**
 * Get the appropriate data directory for the platform
 * Windows: %LOCALAPPDATA%/mrmd
 * macOS: ~/Library/Application Support/mrmd
 * Linux: ~/.mrmd (legacy) or XDG_DATA_HOME
 */
export function getDataDir() {
  if (isWin) {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'mrmd');
  } else if (isMac) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'mrmd');
  } else {
    // Linux - keep legacy ~/.mrmd for backwards compatibility
    return path.join(os.homedir(), '.mrmd');
  }
}

/**
 * Get the uv install directory for the platform
 * Windows: %LOCALAPPDATA%/uv/bin
 * Unix: ~/.local/bin
 */
export function getUvInstallDir() {
  if (isWin) {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'uv', 'bin');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

/**
 * Get common Python installation paths for the platform
 * @returns {string[]} Array of paths to check
 */
export function getSystemPythonPaths() {
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      // Python launcher (recommended way on Windows)
      'py',
      'python',
      // Common install locations
      path.join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe'),
      path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
      path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
      path.join(localAppData, 'Programs', 'Python', 'Python310', 'python.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Python313', 'python.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Python312', 'python.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Python311', 'python.exe'),
    ];
  }
  // Unix paths (unchanged)
  return [
    '/usr/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',  // macOS Homebrew ARM
  ];
}

/**
 * Get common uv installation paths for the platform
 * @returns {string[]} Array of paths to check
 */
export function getUvPaths() {
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(localAppData, 'uv', 'bin', 'uv.exe'),
      path.join(os.homedir(), '.cargo', 'bin', 'uv.exe'),
      'uv',  // PATH lookup
    ];
  }
  // Unix paths (unchanged)
  return [
    '/usr/local/bin/uv',
    '/usr/bin/uv',
    path.join(os.homedir(), '.local', 'bin', 'uv'),
    path.join(os.homedir(), '.cargo', 'bin', 'uv'),
  ];
}

/**
 * Get common conda environment paths for the platform
 * @returns {string[]} Array of relative paths from home directory
 */
export function getCondaPaths() {
  if (isWin) {
    return [
      'anaconda3\\envs',
      'miniconda3\\envs',
      'miniforge3\\envs',
      '.conda\\envs',
      // Also check ProgramData for system-wide installs
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'anaconda3', 'envs'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'miniconda3', 'envs'),
    ];
  }
  // Unix paths (unchanged)
  return [
    'anaconda3/envs',
    'miniconda3/envs',
    'miniforge3/envs',
    '.conda/envs',
  ];
}

/**
 * Get common R installation paths for the platform
 * @returns {string[]} Array of paths to Rscript executable
 */
export function getRscriptPaths() {
  if (isWin) {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      // Common R versions on Windows
      path.join(programFiles, 'R', 'R-4.4.0', 'bin', 'Rscript.exe'),
      path.join(programFiles, 'R', 'R-4.3.2', 'bin', 'Rscript.exe'),
      path.join(programFiles, 'R', 'R-4.3.1', 'bin', 'Rscript.exe'),
      path.join(programFiles, 'R', 'R-4.2.3', 'bin', 'Rscript.exe'),
      'Rscript',  // PATH lookup
    ];
  }
  // Unix paths (unchanged)
  return [
    '/usr/bin/Rscript',
    '/usr/local/bin/Rscript',
    '/opt/homebrew/bin/Rscript',  // macOS Homebrew
    '/opt/R/arm64/bin/Rscript',   // macOS R.app ARM
    '/opt/R/x86_64/bin/Rscript',  // macOS R.app Intel
    'Rscript',  // PATH lookup
  ];
}

/**
 * Get common Julia installation paths for the platform
 * @returns {string[]} Array of paths to julia executable
 */
export function getJuliaPaths() {
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      process.env.JULIA_EXECUTABLE,
      path.join(localAppData, 'Programs', 'Julia-1.10.0', 'bin', 'julia.exe'),
      path.join(localAppData, 'Programs', 'Julia-1.9.4', 'bin', 'julia.exe'),
      path.join(localAppData, 'Julia', 'bin', 'julia.exe'),
      path.join(os.homedir(), '.julia', 'juliaup', 'julia.exe'),
      'julia',  // PATH lookup
    ].filter(Boolean);
  }
  // Unix paths (unchanged)
  return [
    process.env.JULIA_EXECUTABLE,
    '/usr/bin/julia',
    '/usr/local/bin/julia',
    '/opt/julia/bin/julia',
    path.join(os.homedir(), '.julia', 'juliaup', 'julia'),
    path.join(os.homedir(), 'julia', 'bin', 'julia'),
    'julia',  // PATH lookup
  ].filter(Boolean);
}

/**
 * Kill a process and its children (process tree)
 * @param {number} pid - Process ID to kill
 * @param {string} signal - Signal to send (default: SIGTERM)
 * @returns {Promise<void>}
 */
export async function killProcessTree(pid, signal = 'SIGTERM') {
  if (isWin) {
    // Windows: use taskkill with /T flag for tree kill
    return new Promise((resolve) => {
      const proc = spawn('taskkill', ['/PID', pid.toString(), '/T', '/F'], {
        stdio: 'ignore',
      });
      proc.on('close', () => resolve());
      proc.on('error', () => resolve()); // Don't fail if process already dead
    });
  } else {
    // Unix: try process group first, fall back to single process
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Process already dead, ignore
      }
    }
  }
}

/**
 * Check if a process is alive
 * @param {number} pid - Process ID to check
 * @returns {boolean} True if process is alive
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a file:// URL to a path, handling platform differences
 * Windows file URLs are file:///C:/path, Unix are file:///path
 * @param {string} fileUrl - The file:// URL (typically import.meta.url)
 * @returns {string} The file path
 */
export function fileUrlToPath(fileUrl) {
  return fileURLToPath(fileUrl);
}

/**
 * Get the directory containing a module from its import.meta.url
 * @param {string} importMetaUrl - import.meta.url value
 * @returns {string} Directory path
 */
export function getDirname(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/**
 * Walk a directory recursively, yielding file paths
 * Cross-platform alternative to `find` command
 * @param {string} dir - Directory to walk
 * @param {object} options - Options
 * @param {number} options.maxDepth - Maximum depth (default: Infinity)
 * @param {string[]} options.extensions - File extensions to include (e.g., ['.md', '.ipynb'])
 * @param {string[]} options.ignoreDirs - Directory names to skip (e.g., ['node_modules', '.git'])
 * @param {function} options.onFile - Callback for each file found
 * @param {function} options.onDir - Callback for each directory visited
 * @param {function} options.onDone - Callback when done
 * @param {function} options.onError - Callback on error
 */
export function walkDir(dir, options = {}) {
  const {
    maxDepth = Infinity,
    extensions = null,
    ignoreDirs = ['node_modules', '.git', '.mrmd'],
    onFile = () => {},
    onDir = () => {},
    onDone = () => {},
    onError = () => {},
  } = options;

  const ignoreDirsSet = new Set(ignoreDirs.map(d => d.toLowerCase()));
  let cancelled = false;

  // Async walk that yields to the event loop every CHUNK_SIZE entries
  // to avoid blocking the main process during large scans
  const CHUNK_SIZE = 200;

  async function walkAsync(currentDir, depth) {
    if (cancelled || depth > maxDepth) return;
    onDir(currentDir);

    let entries;
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch (e) {
      // Permission denied or other error, skip this directory
      return;
    }

    const subdirs = [];
    let processed = 0;

    for (const entry of entries) {
      if (cancelled) return;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!ignoreDirsSet.has(entry.name.toLowerCase())) {
          subdirs.push({ path: fullPath, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        if (extensions === null || extensions.includes(path.extname(entry.name).toLowerCase())) {
          onFile(fullPath);
        }
      }

      processed++;
      // Yield to event loop periodically to keep UI responsive
      if (processed % CHUNK_SIZE === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Process subdirectories
    for (const subdir of subdirs) {
      if (cancelled) return;
      await walkAsync(subdir.path, subdir.depth);
    }
  }

  // Start async walk
  walkAsync(dir, 0).then(() => {
    if (!cancelled) onDone();
  }).catch((e) => {
    if (!cancelled) onError(e);
  });

  // Return cancellable handle
  return {
    kill: () => { cancelled = true; },
  };
}

/**
 * Find directories matching specific names (cross-platform alternative to find -type d)
 * @param {string} startDir - Directory to start search
 * @param {string[]} dirNames - Directory names to find (e.g., ['.venv', 'venv', 'env'])
 * @param {object} options - Options
 * @param {number} options.maxDepth - Maximum depth
 * @param {string[]} options.ignoreDirs - Directories to skip
 * @param {function} options.onFound - Callback for each match
 * @param {function} options.onDone - Callback when done
 */
export function findDirs(startDir, dirNames, options = {}) {
  const {
    maxDepth = 4,
    ignoreDirs = ['node_modules'],
    onFound = () => {},
    onDone = () => {},
  } = options;

  const targetNames = new Set(dirNames.map(n => n.toLowerCase()));
  const ignoreDirsSet = new Set(ignoreDirs.map(d => d.toLowerCase()));
  let cancelled = false;

  async function walkAsync(currentDir, depth) {
    if (cancelled || depth > maxDepth) return;

    let entries;
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (cancelled) return;
      if (!entry.isDirectory()) continue;

      const nameLower = entry.name.toLowerCase();
      if (ignoreDirsSet.has(nameLower)) continue;

      const fullPath = path.join(currentDir, entry.name);

      if (targetNames.has(nameLower)) {
        onFound(fullPath);
      }

      await walkAsync(fullPath, depth + 1);
    }
  }

  walkAsync(startDir, 0).then(() => {
    if (!cancelled) onDone();
  }).catch(() => {
    if (!cancelled) onDone();
  });

  return {
    kill: () => { cancelled = true; },
  };
}
