/**
 * Centralized configuration for mrmd-electron
 *
 * All magic numbers, timeouts, paths, and other configuration values
 * should be defined here for easy modification and documentation.
 */

import os from 'os';
import path from 'path';

// ============================================================================
// PATHS
// ============================================================================

/**
 * User configuration directory
 * TODO: Support XDG_CONFIG_HOME on Linux, ~/Library on macOS, %APPDATA% on Windows
 */
export const CONFIG_DIR = path.join(os.homedir(), '.config', 'mrmd');

/**
 * Recent files/venvs persistence file
 */
export const RECENT_FILE = path.join(CONFIG_DIR, 'recent.json');

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
 */
export const SYSTEM_PYTHON_PATHS = [
  '/usr/bin/python3',
  '/usr/local/bin/python3',
  '/opt/homebrew/bin/python3',  // macOS Homebrew
];

/**
 * Common conda installation paths (relative to home)
 */
export const CONDA_PATHS = [
  'anaconda3/envs',
  'miniconda3/envs',
  'miniforge3/envs',
  '.conda/envs',
];

/**
 * Common uv installation paths
 */
export const UV_PATHS = [
  '/usr/local/bin/uv',
  '/usr/bin/uv',
  path.join(os.homedir(), '.local', 'bin', 'uv'),
  path.join(os.homedir(), '.cargo', 'bin', 'uv'),
];

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
