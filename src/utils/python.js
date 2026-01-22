/**
 * Python environment utilities for mrmd-electron
 *
 * Shared functions for Python/venv management used by main process and services.
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { UV_PATHS } from '../config.js';

/**
 * Find uv binary in common locations
 *
 * @returns {string|null} Path to uv or null if not found
 */
export function findUv() {
  return findUvSync();
}

/**
 * Find uv binary (sync version for use in constructors)
 *
 * @returns {string|null} Path to uv or null if not found
 */
export function findUvSync() {
  // Check known locations
  for (const loc of UV_PATHS) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  // Try PATH via 'which'
  try {
    const result = execSync('which uv', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch {
    // uv not in PATH (expected if not installed)
  }

  return null;
}

/**
 * Install mrmd-python in a virtual environment
 *
 * Tries uv first (preferred), falls back to pip.
 *
 * @param {string} venvPath - Path to the virtual environment
 * @param {object} options - Options
 * @param {string} options.localDev - Local development path (from MRMD_PYTHON_DEV env)
 * @returns {Promise<{ success: boolean }>}
 */
export async function installMrmdPython(venvPath, options = {}) {
  const { localDev = process.env.MRMD_PYTHON_DEV } = options;

  const pythonPath = path.join(venvPath, 'bin', 'python');
  const pipPath = path.join(venvPath, 'bin', 'pip');

  // Validate venv exists
  if (!fs.existsSync(pythonPath)) {
    throw new Error(`Python not found at ${pythonPath}. Is this a valid venv?`);
  }

  // Try uv first (faster), fall back to pip
  const uvPath = findUvSync();
  let cmd, args;

  if (uvPath) {
    cmd = uvPath;
    args = ['pip', 'install', '--python', pythonPath];
  } else if (fs.existsSync(pipPath)) {
    cmd = pipPath;
    args = ['install'];
  } else {
    throw new Error(`Neither uv nor pip found for ${venvPath}`);
  }

  // Add package to install
  if (localDev) {
    args.push('-e', localDev);
    console.log('[python] Installing mrmd-python from local:', localDev);
  } else {
    args.push('mrmd-python');
    console.log('[python] Installing mrmd-python from PyPI');
  }

  return new Promise((resolve, reject) => {
    console.log(`[python] Running: ${cmd} ${args.join(' ')}`);

    const proc = spawn(cmd, args, {
      cwd: path.dirname(venvPath),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, VIRTUAL_ENV: venvPath },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      console.log('[pip]', d.toString().trim());
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      console.error('[pip]', d.toString().trim());
    });

    proc.on('error', (e) => {
      reject(new Error(`Failed to run ${cmd}: ${e.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        reject(new Error(`pip install failed (code ${code}): ${(stderr || stdout).slice(-500)}`));
      }
    });
  });
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
    const proc = spawn('python3', ['-m', 'venv', venvPath], {
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
    hasPython = fs.existsSync(path.join(envPath, 'bin', 'python'));

    // Get Python version from pyvenv.cfg
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
