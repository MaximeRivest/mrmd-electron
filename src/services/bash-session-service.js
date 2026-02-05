/**
 * BashSessionService - Bash runtime session management
 *
 * Manages Bash runtime sessions (mrmd-bash processes).
 * Sessions are named {projectName}:bash:{sessionName} and persisted
 * in ~/.mrmd/sessions/ for sharing across windows.
 *
 * Unlike Python sessions, bash sessions don't need venv management.
 * They use the system's bash with a specific working directory.
 *
 * Uses mrmd-project for session config resolution.
 */

import { Project } from 'mrmd-project';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

// Shared utilities and configuration
import { findFreePort, waitForPort } from '../utils/index.js';
import { killProcessTree, isProcessAlive, getDirname } from '../utils/platform.js';
import { SESSIONS_DIR, PYTHON_DEPS } from '../config.js';

// Create require for resolving package paths
const require = createRequire(import.meta.url);

/**
 * Get the sibling path for mrmd-bash (development mode)
 * Returns null if not in dev mode or sibling doesn't exist
 */
function getBashSiblingPath() {
  // From src/services/ → ../../../ gets us to mrmd-packages/, then into mrmd-bash/
  const siblingPath = path.resolve(getDirname(import.meta.url), '../../../mrmd-bash');
  if (fs.existsSync(path.join(siblingPath, 'pyproject.toml'))) {
    return siblingPath;
  }
  return null;
}

class BashSessionService {
  constructor() {
    this.sessions = new Map(); // name -> SessionInfo
    this.processes = new Map(); // name -> ChildProcess
    this.loadRegistry();
  }

  /**
   * Load existing bash sessions from disk registry
   */
  loadRegistry() {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.startsWith('bash-') && f.endsWith('.json'));

      for (const file of files) {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));

          // Only load bash sessions
          if (info.language !== 'bash') continue;

          // Check if process is still alive
          if (info.pid) {
            if (isProcessAlive(info.pid)) {
              info.alive = true;
              this.sessions.set(info.name, info);
            } else {
              // Process dead, remove registry file
              fs.unlinkSync(path.join(SESSIONS_DIR, file));
            }
          }
        } catch (e) {
          console.warn(`[bash-session] Skipping invalid registry file ${file}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[bash-session] Error loading registry:', e.message);
    }
  }

  /**
   * List all bash sessions
   *
   * @returns {SessionInfo[]}
   */
  list() {
    // Refresh alive status
    for (const [name, info] of this.sessions) {
      if (isProcessAlive(info.pid)) {
        info.alive = true;
      } else {
        info.alive = false;
        this.sessions.delete(name);
        this.removeRegistry(name);
      }
    }

    return Array.from(this.sessions.values());
  }

  /**
   * Start a new bash session
   *
   * @param {object} config - Session configuration
   * @param {string} config.name - Session name (e.g., "thesis:bash:default")
   * @param {string} config.cwd - Working directory
   * @returns {Promise<SessionInfo>}
   */
  async start(config) {
    // 1. Check if already running
    if (this.sessions.has(config.name)) {
      const existing = this.sessions.get(config.name);
      if (existing.alive) {
        // Verify it's actually alive
        if (isProcessAlive(existing.pid)) {
          return existing;
        } else {
          // Actually dead, clean up
          this.sessions.delete(config.name);
          this.removeRegistry(config.name);
        }
      }
    }

    // 2. Find free port
    const port = await findFreePort();

    // 3. Spawn mrmd-bash - use local source in dev, PyPI in packaged mode
    console.log(`[bash-session] Starting "${config.name}" on port ${port} with cwd ${config.cwd}...`);

    let proc;
    const siblingPath = getBashSiblingPath();

    if (siblingPath) {
      // DEV MODE: Use local source via uv run --project
      console.log(`[bash-session] Using local package: ${siblingPath}`);
      proc = spawn('uv', [
        'run', '--project', siblingPath,
        'mrmd-bash',
        '--port', port.toString(),
        '--cwd', config.cwd,
      ], {
        cwd: siblingPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
    } else {
      // PACKAGED MODE: Download from PyPI via uv tool run
      console.log(`[bash-session] Using uv tool run (packaged mode)`);
      proc = spawn('uv', [
        'tool', 'run',
        '--from', `mrmd-bash${PYTHON_DEPS['mrmd-bash']}`,
        'mrmd-bash',
        '--port', port.toString(),
        '--cwd', config.cwd,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
    }

    // Handle spawn errors (e.g., uv not installed)
    const spawnError = new Promise((_, reject) => {
      proc.on('error', (err) => {
        console.error(`[bash-session] Spawn error for "${config.name}":`, err.message);
        if (err.code === 'ENOENT') {
          reject(new Error(`'uv' is not installed. Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh`));
        } else {
          reject(err);
        }
      });
    });

    proc.stdout.on('data', (d) => console.log(`[bash-session:${config.name}]`, d.toString().trim()));
    proc.stderr.on('data', (d) => console.error(`[bash-session:${config.name}]`, d.toString().trim()));

    // 5. Wait for ready (race with spawn error)
    await Promise.race([
      waitForPort(port),
      spawnError,
    ]);

    // 6. Register session
    const info = {
      name: config.name,
      language: 'bash',
      pid: proc.pid,
      port,
      cwd: config.cwd,
      startedAt: new Date().toISOString(),
      alive: true,
    };

    this.sessions.set(config.name, info);
    this.processes.set(config.name, proc);
    this.saveRegistry(info);

    // 7. Handle exit
    proc.on('exit', (code, signal) => {
      console.log(`[bash-session:${config.name}] Exited (code=${code}, signal=${signal})`);
      const session = this.sessions.get(config.name);
      if (session) {
        session.alive = false;
      }
      this.sessions.delete(config.name);
      this.processes.delete(config.name);
      this.removeRegistry(config.name);
    });

    return info;
  }

  /**
   * Stop a session
   *
   * @param {string} sessionName - Session name to stop
   * @returns {Promise<boolean>}
   */
  async stop(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) return false;

    console.log(`[bash-session] Stopping "${sessionName}"...`);

    try {
      if (session.pid) {
        await killProcessTree(session.pid, 'SIGTERM');
      }
    } catch (e) {
      console.error(`[bash-session] Error killing ${sessionName}:`, e.message);
    }

    this.sessions.delete(sessionName);
    this.processes.delete(sessionName);
    this.removeRegistry(sessionName);

    return true;
  }

  /**
   * Restart a session
   *
   * @param {string} sessionName - Session name to restart
   * @returns {Promise<SessionInfo>}
   */
  async restart(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) {
      throw new Error(`Bash session "${sessionName}" not found`);
    }

    const config = {
      name: sessionName,
      cwd: session.cwd,
    };

    await this.stop(sessionName);

    // Brief delay to ensure port is released
    await new Promise(r => setTimeout(r, 500));

    return this.start(config);
  }

  /**
   * Attach to an existing session
   *
   * @param {string} sessionName - Session name
   * @returns {SessionInfo | null}
   */
  attach(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) return null;

    // Verify alive
    if (isProcessAlive(session.pid)) {
      session.alive = true;
      return session;
    } else {
      session.alive = false;
      this.sessions.delete(sessionName);
      this.removeRegistry(sessionName);
      return null;
    }
  }

  /**
   * Get or create bash session for a document
   *
   * @param {string} documentPath - Path to document
   * @param {object} projectConfig - Project configuration
   * @param {object|null} frontmatter - Document frontmatter
   * @param {string} projectRoot - Project root path
   * @returns {Promise<SessionConfig>} Resolved session config with optional session info
   */
  async getForDocument(documentPath, projectConfig, frontmatter, projectRoot) {
    console.log('[bash-session] getForDocument called');
    console.log('[bash-session] projectRoot:', projectRoot);
    console.log('[bash-session] projectConfig:', JSON.stringify(projectConfig, null, 2));

    // Use mrmd-project to resolve bash session config
    const merged = Project.mergeConfig(projectConfig, frontmatter);
    console.log('[bash-session] merged config:', JSON.stringify(merged, null, 2));

    const resolved = Project.resolveSessionForLanguage('bash', documentPath, projectRoot, merged);
    console.log('[bash-session] resolved:', resolved);

    // Build result with config info
    const result = {
      name: resolved.name,
      cwd: resolved.cwd,
      autoStart: resolved.autoStart,
      language: 'bash',
      alive: false,
      pid: null,
      port: null,
    };

    // Check if session exists and is alive
    const existing = this.sessions.get(resolved.name);
    if (existing?.alive) {
      // Verify still alive
      if (isProcessAlive(existing.pid)) {
        result.alive = true;
        result.pid = existing.pid;
        result.port = existing.port;
        result.startedAt = existing.startedAt;
        return result;
      } else {
        // Dead, clean up
        this.sessions.delete(resolved.name);
        this.removeRegistry(resolved.name);
      }
    }

    // Auto-start if configured
    if (resolved.autoStart) {
      try {
        const started = await this.start(resolved);
        result.alive = true;
        result.pid = started.pid;
        result.port = started.port;
        result.startedAt = started.startedAt;
      } catch (e) {
        console.error('[bash-session] Auto-start failed:', e.message);
        result.error = e.message;
      }
    }

    return result;
  }

  /**
   * Save session info to registry
   */
  saveRegistry(info) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const filename = 'bash-' + info.name.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
    } catch (e) {
      console.error('[bash-session] Failed to save registry:', e.message);
    }
  }

  /**
   * Remove session from registry
   */
  removeRegistry(sessionName) {
    try {
      const filename = 'bash-' + sessionName.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    } catch (e) {
      console.error('[bash-session] Failed to remove registry:', e.message);
    }
  }

  /**
   * Clean up all sessions on shutdown
   */
  shutdown() {
    for (const [name] of this.sessions) {
      this.stop(name).catch((e) => {
        console.warn(`[bash-session] Error stopping ${name} during shutdown:`, e.message);
      });
    }
  }
}

export default BashSessionService;
