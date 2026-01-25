/**
 * Centralized configuration for mrmd-electron
 *
 * All magic numbers, timeouts, paths, and other configuration values
 * should be defined here for easy modification and documentation.
 */

import os from 'os';
import path from 'path';
import {
  isWin,
  getConfigDir,
  getDataDir,
  getUvInstallDir,
  getSystemPythonPaths,
  getUvPaths,
  getCondaPaths,
} from './utils/platform.js';

// ============================================================================
// PATHS
// ============================================================================

/**
 * User configuration directory
 * Windows: %APPDATA%/mrmd
 * macOS: ~/Library/Application Support/mrmd
 * Linux: ~/.config/mrmd (or XDG_CONFIG_HOME)
 */
export const CONFIG_DIR = getConfigDir();

/**
 * Recent files/venvs persistence file
 */
export const RECENT_FILE = path.join(CONFIG_DIR, 'recent.json');

/**
 * User settings file (API keys, model mappings, custom commands)
 */
export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

/**
 * Legacy runtimes directory (for old-style runtime registration)
 */
export const RUNTIMES_DIR = path.join(os.homedir(), '.mrmd', 'runtimes');

/**
 * Session registry directory (for new session service)
 */
export const SESSIONS_DIR = path.join(os.homedir(), '.mrmd', 'sessions');

/**
 * Asset directory name within projects
 */
export const ASSETS_DIR_NAME = '_assets';

/**
 * Asset manifest filename
 */
export const ASSET_MANIFEST_NAME = '.manifest.json';

// ============================================================================
// NETWORK
// ============================================================================

/**
 * Default host for all network servers
 * Using 127.0.0.1 for security (localhost only)
 * TODO: Make configurable for remote/container setups
 */
export const DEFAULT_HOST = '127.0.0.1';

/**
 * Timeout for waiting for a port to become available (ms)
 */
export const PORT_WAIT_TIMEOUT = 10000;

/**
 * Interval between port checks (ms)
 */
export const PORT_CHECK_INTERVAL = 200;

/**
 * Socket connection timeout (ms)
 */
export const SOCKET_TIMEOUT = 500;

// ============================================================================
// SYNC SERVER
// ============================================================================

/**
 * Memory limit for sync server (MB)
 * Limited to 512MB to fail fast instead of consuming all system memory
 * and crashing unpredictably after hours. Better to restart early than
 * lose hours of work.
 */
export const SYNC_SERVER_MEMORY_MB = 512;

/**
 * Watchdog interval for periodic backups (ms)
 */
export const WATCHDOG_INTERVAL = 60000;

/**
 * WebSocket ping interval for connection health checks (ms)
 */
export const WEBSOCKET_PING_INTERVAL = 30000;

/**
 * WebSocket pong timeout - if no pong received in this time,
 * consider connection dead (ms)
 */
export const WEBSOCKET_PONG_TIMEOUT = 5000;

// ============================================================================
// FILE SCANNING
// ============================================================================

/**
 * Maximum directory depth for file scanning
 */
export const FILE_SCAN_MAX_DEPTH = 6;

/**
 * Maximum directory depth for venv discovery
 */
export const VENV_SCAN_MAX_DEPTH = 4;

/**
 * Maximum directory depth for project file scanning
 */
export const PROJECT_SCAN_MAX_DEPTH = 10;

// ============================================================================
// LIMITS
// ============================================================================

/**
 * Maximum recent files to keep
 */
export const MAX_RECENT_FILES = 50;

/**
 * Maximum recent venvs to keep
 */
export const MAX_RECENT_VENVS = 20;

/**
 * Hash length for asset deduplication (characters)
 */
export const ASSET_HASH_LENGTH = 16;

/**
 * Hash length for directory hashing (characters)
 */
export const DIR_HASH_LENGTH = 12;

// ============================================================================
// WINDOW
// ============================================================================

/**
 * Default window dimensions
 */
export const DEFAULT_WINDOW_WIDTH = 1000;
export const DEFAULT_WINDOW_HEIGHT = 750;

/**
 * Default background color (dark theme)
 */
export const DEFAULT_BACKGROUND_COLOR = '#0d1117';

// ============================================================================
// PYTHON PATHS
// ============================================================================

/**
 * Common system Python paths to check
 * Platform-aware: includes Windows paths on Windows, Unix paths on Unix
 */
export const SYSTEM_PYTHON_PATHS = getSystemPythonPaths();

/**
 * Common conda installation paths (relative to home)
 * Platform-aware: uses backslashes on Windows
 */
export const CONDA_PATHS = getCondaPaths();

/**
 * Common uv installation paths
 * Platform-aware: includes Windows paths on Windows
 */
export const UV_PATHS = getUvPaths();

// ============================================================================
// SPECIAL FILES
// ============================================================================

/**
 * Files that should never have FSML order prefixes
 */
export const UNORDERED_FILES = new Set([
  'readme.md',
  'readme',
  'license.md',
  'license',
  'license.txt',
  'changelog.md',
  'changelog',
  'contributing.md',
  'contributing',
  'mrmd.md',
  'index.md',
  '.gitignore',
  '.gitattributes',
]);

// ============================================================================
// VERSION COMPATIBILITY MATRIX
// ============================================================================
// Defines which Python package versions are compatible with this electron app.
// Updated on each release. Uses pip version specifiers.

/**
 * Current mrmd-electron version
 */
export const APP_VERSION = '0.3.0';

/**
 * Python package version requirements for this electron version.
 * These are installed via uv/pip when user sets up a venv.
 */
export const PYTHON_DEPS = {
  // Core runtime - required
  'mrmd-python': '>=0.3.7,<0.4',

  // AI features - required for full experience
  'mrmd-ai': '>=0.1.0,<0.2',

  // Bash runtime - for ```bash blocks
  'mrmd-bash': '>=0.1.0,<0.2',

  // PTY runtime - for ```term blocks
  'mrmd-pty': '>=0.1.0,<0.2',

  // Orchestrator (optional, for advanced multi-runtime setups)
  // 'mrmd': '>=0.2.0,<0.3',
};

/**
 * Get pip install args for all required Python packages
 * @returns {string[]} Array of package specifiers
 */
export function getPythonInstallArgs() {
  return Object.entries(PYTHON_DEPS).map(
    ([pkg, version]) => `${pkg}${version}`
  );
}

// ============================================================================
// UV AUTO-INSTALL
// ============================================================================

/**
 * uv download URLs by platform
 * Updated from: https://github.com/astral-sh/uv/releases
 */
export const UV_DOWNLOAD_URLS = {
  'linux-x64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz',
  'linux-arm64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-unknown-linux-gnu.tar.gz',
  'darwin-x64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz',
  'darwin-arm64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz',
  'win32-x64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip',
};

/**
 * Default uv install location (user-local)
 * Windows: %LOCALAPPDATA%/uv/bin
 * Unix: ~/.local/bin
 */
export const UV_INSTALL_DIR = getUvInstallDir();

/**
 * Path where uv will be installed
 */
export const UV_INSTALL_PATH = path.join(
  UV_INSTALL_DIR,
  isWin ? 'uv.exe' : 'uv'
);
