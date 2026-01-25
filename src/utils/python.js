/**
 * Python environment utilities for mrmd-electron
 *
 * Shared functions for Python/venv management used by main process and services.
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PYTHON_DEPS, getPythonInstallArgs } from '../config.js';
import { findUv, ensureUv } from './uv-installer.js';
import {
  getVenvPython,
  getVenvExecutable,
  getVenvBinDir,
  getPythonCommand,
} from './platform.js';

// Re-export for backwards compatibility
export { findUv, ensureUv };

/**
 * Find uv binary (sync version for use in constructors)
 * @deprecated Use findUv from uv-installer.js instead
 * @returns {string|null} Path to uv or null if not found
 */
export function findUvSync() {
  return findUv();
}

/**
 * Install all required Python packages in a virtual environment
 *
 * Uses uv (auto-installed if missing). Installs packages according to
 * the version compatibility matrix in config.js.
 *
 * @param {string} venvPath - Path to the virtual environment
 * @param {object} options - Options
 * @param {string} options.localDev - Local development path (from MRMD_PYTHON_DEV env)
 * @param {boolean} options.fullInstall - Install all packages including optional (default: true)
 * @param {function} options.onProgress - Progress callback (stage, detail)
 * @returns {Promise<{ success: boolean, packages: string[] }>}
 */
export async function installMrmdPython(venvPath, options = {}) {
  const {
    localDev = process.env.MRMD_PYTHON_DEV,
    fullInstall = true,
    onProgress
  } = options;

  const report = (stage, detail) => {
    console.log(`[python] ${stage}: ${detail}`);
    if (onProgress) onProgress(stage, detail);
  };

  const pythonPath = getVenvPython(venvPath);

  // Validate venv exists
  if (!fs.existsSync(pythonPath)) {
    throw new Error(`Python not found at ${pythonPath}. Is this a valid venv?`);
  }

  // Ensure uv is installed (auto-install if missing)
  report('checking', 'uv installation');
  const uvPath = await ensureUv({
    onProgress: (stage, detail) => report(`uv-${stage}`, detail)
  });

  // Build package list from version matrix
  const packages = [];

  if (localDev) {
    // Development mode: install from local path
    packages.push('-e', localDev);
    report('mode', 'local development');
  } else {
    // Production: install from PyPI with version constraints
    const installArgs = getPythonInstallArgs();
    packages.push(...installArgs);
    report('mode', `PyPI (${installArgs.length} packages)`);
  }

  // Run uv pip install
  const args = ['pip', 'install', '--python', pythonPath, ...packages];

  report('installing', packages.filter(p => !p.startsWith('-')).join(', '));

  return new Promise((resolve, reject) => {
    console.log(`[python] Running: ${uvPath} ${args.join(' ')}`);

    const proc = spawn(uvPath, args, {
      cwd: path.dirname(venvPath),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, VIRTUAL_ENV: venvPath },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      const line = d.toString().trim();
      if (line) console.log('[uv]', line);
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      const line = d.toString().trim();
      if (line) console.error('[uv]', line);
    });

    proc.on('error', (e) => {
      reject(new Error(`Failed to run uv: ${e.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        report('complete', 'all packages installed');
        resolve({
          success: true,
          packages: Object.keys(PYTHON_DEPS)
        });
      } else {
        reject(new Error(`uv pip install failed (code ${code}): ${(stderr || stdout).slice(-500)}`));
      }
    });
  });
}

/**
 * Install mrmd-python only (legacy function for backwards compatibility)
 * @deprecated Use installMrmdPython with fullInstall option
 */
export async function installMrmdPythonOnly(venvPath, options = {}) {
  return installMrmdPython(venvPath, { ...options, fullInstall: false });
}

/**
 * Create a Python virtual environment
 *
 * Tries uv first (faster), falls back to python -m venv.
 *
 * @param {string} venvPath - Path for the new venv
 * @returns {Promise<void>}
 */
export function createVenv(venvPath) {
  return new Promise((resolve, reject) => {
    const uvPath = findUvSync();

    if (uvPath) {
      // Try uv first (faster)
      const proc = spawn(uvPath, ['venv', venvPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`uv venv failed: ${stderr}`));
        }
      });

      proc.on('error', () => {
        // uv failed, fall back to python -m venv
        createVenvWithPython(venvPath).then(resolve).catch(reject);
      });
    } else {
      // No uv, use python -m venv
      createVenvWithPython(venvPath).then(resolve).catch(reject);
    }
  });
}

/**
 * Create venv using python -m venv
 */
function createVenvWithPython(venvPath) {
  return new Promise((resolve, reject) => {
    const pythonCmd = getPythonCommand();
    const proc = spawn(pythonCmd, ['-m', 'venv', venvPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (e) => {
      reject(new Error(`Failed to create venv: ${e.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`python -m venv failed (code ${code}): ${stderr}`));
      }
    });
  });
}

/**
 * Get information about a Python environment
 *
 * @param {string} envPath - Path to the environment
 * @param {string} envType - Type of environment ('system', 'venv', 'conda', 'pyenv')
 * @returns {object} Environment info
 */
export function getEnvInfo(envPath, envType) {
  let pythonVersion = null;
  let hasMrmdPython = false;
  let hasPython = false;
  let projectName = '';
  let name = '';

  try {
    hasPython = fs.existsSync(getVenvPython(envPath));

    // Get Python version from pyvenv.cfg
    const pyvenvCfg = path.join(envPath, 'pyvenv.cfg');
    if (fs.existsSync(pyvenvCfg)) {
      const content = fs.readFileSync(pyvenvCfg, 'utf8');
      const match = content.match(/version\s*=\s*(\d+\.\d+)/);
      if (match) pythonVersion = match[1];
    }

    // Check if mrmd-python is installed
    hasMrmdPython = fs.existsSync(getVenvExecutable(envPath, 'mrmd-python'));

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
    console.warn(`[python] Error getting env info for ${envPath}:`, e.message);
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
