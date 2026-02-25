/**
 * Systemd user service management for machine-agent
 *
 * Installs/uninstalls a systemd --user service that runs machine-agent
 * headlessly on boot, independent of the Electron GUI.
 *
 * Only works on Linux. Returns { supported: false } on other platforms.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const SERVICE_NAME = 'mrmd-machine-agent';
const SERVICE_FILE = `${SERVICE_NAME}.service`;

function getServiceDir() {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

function getServicePath() {
  return path.join(getServiceDir(), SERVICE_FILE);
}

/**
 * Resolve the absolute path to machine-agent.js
 * Works in both dev (sibling source) and packaged mode.
 */
function getMachineAgentScript() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // src/utils/systemd.js → src/machine-agent.js
  const devPath = path.resolve(__dirname, '..', 'machine-agent.js');
  if (fs.existsSync(devPath)) return devPath;

  // Packaged: check resourcesPath
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'mrmd-electron', 'src', 'machine-agent.js');
    if (fs.existsSync(bundled)) return bundled;
  }

  throw new Error('Cannot locate machine-agent.js');
}

/**
 * Find the node binary to use in the service.
 */
function getNodePath() {
  // Prefer the same node that's running this process
  return process.execPath;
}

/**
 * Generate the systemd unit file content.
 */
function generateUnitFile(opts = {}) {
  const nodePath = getNodePath();
  const scriptPath = getMachineAgentScript();
  const roots = opts.roots || path.join(os.homedir(), 'Projects');
  const cloudUrl = opts.cloudUrl || 'https://markco.dev';

  // Inherit PATH so node/uv/python are findable
  const userPath = process.env.PATH || '';

  return `[Unit]
Description=mrmd Machine Agent — headless cloud sync and runtime provider
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath}
Restart=on-failure
RestartSec=10
Environment=MRMD_MACHINE_HUB_ROOTS=${roots}
Environment=MARKCO_CLOUD_URL=${cloudUrl}
Environment=PATH=${userPath}
Environment=HOME=${os.homedir()}
Environment=NODE_ENV=production

# Graceful shutdown
TimeoutStopSec=15
KillSignal=SIGTERM

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=default.target
`;
}

/**
 * Run a systemctl --user command. Returns { ok, output, error }.
 */
function systemctl(...args) {
  try {
    const output = execFileSync('systemctl', ['--user', ...args], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus` },
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    return { ok: false, output: '', error: err.stderr?.trim() || err.message };
  }
}

/**
 * Check if the platform supports systemd user services.
 */
export function isSupported() {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('systemctl', ['--user', '--version'], { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current status of the machine-agent service.
 *
 * @returns {{ supported: boolean, installed: boolean, enabled: boolean, running: boolean, error?: string }}
 */
export function getStatus() {
  if (!isSupported()) {
    return { supported: false, installed: false, enabled: false, running: false };
  }

  const installed = fs.existsSync(getServicePath());

  if (!installed) {
    return { supported: true, installed: false, enabled: false, running: false };
  }

  const enabledResult = systemctl('is-enabled', SERVICE_FILE);
  const enabled = enabledResult.ok && enabledResult.output === 'enabled';

  const activeResult = systemctl('is-active', SERVICE_FILE);
  const running = activeResult.ok && activeResult.output === 'active';

  return { supported: true, installed, enabled, running };
}

/**
 * Install and enable the machine-agent systemd service.
 *
 * @param {object} [opts]
 * @param {string} [opts.roots] - Colon-separated project roots
 * @param {string} [opts.cloudUrl] - markco.dev URL
 * @returns {{ ok: boolean, error?: string }}
 */
export function install(opts = {}) {
  if (!isSupported()) {
    return { ok: false, error: 'systemd user services not supported on this platform' };
  }

  try {
    const serviceDir = getServiceDir();
    fs.mkdirSync(serviceDir, { recursive: true });

    const unitContent = generateUnitFile(opts);
    fs.writeFileSync(getServicePath(), unitContent, 'utf8');

    // Reload, enable, start
    systemctl('daemon-reload');
    const enableResult = systemctl('enable', SERVICE_FILE);
    if (!enableResult.ok) {
      return { ok: false, error: `Failed to enable: ${enableResult.error}` };
    }

    const startResult = systemctl('start', SERVICE_FILE);
    if (!startResult.ok) {
      return { ok: false, error: `Failed to start: ${startResult.error}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Stop, disable, and remove the machine-agent systemd service.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
export function uninstall() {
  if (!isSupported()) {
    return { ok: false, error: 'systemd user services not supported on this platform' };
  }

  try {
    systemctl('stop', SERVICE_FILE);
    systemctl('disable', SERVICE_FILE);

    const servicePath = getServicePath();
    if (fs.existsSync(servicePath)) {
      fs.unlinkSync(servicePath);
    }

    systemctl('daemon-reload');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Restart the service (e.g. after config changes).
 *
 * @returns {{ ok: boolean, error?: string }}
 */
export function restart() {
  if (!isSupported()) {
    return { ok: false, error: 'systemd user services not supported on this platform' };
  }

  const result = systemctl('restart', SERVICE_FILE);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Get recent journal logs for the service.
 *
 * @param {number} [lines=50]
 * @returns {{ ok: boolean, logs?: string, error?: string }}
 */
export function getLogs(lines = 50) {
  if (!isSupported()) {
    return { ok: false, error: 'not supported' };
  }

  try {
    const output = execFileSync('journalctl', [
      '--user',
      '-u', SERVICE_FILE,
      '-n', String(lines),
      '--no-pager',
      '-o', 'short-iso',
    ], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus` },
    });
    return { ok: true, logs: output };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
