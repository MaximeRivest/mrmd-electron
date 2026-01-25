/**
 * PtySessionService - PTY terminal session management
 *
 * Manages the mrmd-pty server process for terminal blocks (```term).
 * One PTY server per project, individual terminal sessions are managed
 * by the PTY server via WebSocket connections.
 *
 * Sessions are named {projectName}:pty and persisted in ~/.mrmd/sessions/
 * for sharing across windows.
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
import { SESSIONS_DIR, PYTHON_DEPS } from '../config.js';

// Create require for resolving package paths
const require = createRequire(import.meta.url);

/**
 * Get the sibling path for mrmd-pty (development mode)
 * Returns null if not in dev mode or sibling doesn't exist
 */
function getPtySiblingPath() {
  // From src/services/ -> ../../../ gets us to mrmd-packages/, then into mrmd-pty/
  const siblingPath = path.resolve(path.dirname(import.meta.url.replace('file://', '')), '../../../mrmd-pty');
  if (fs.existsSync(path.join(siblingPath, 'pyproject.toml'))) {
    return siblingPath;
  }
  return null;
}

class PtySessionService {
  constructor() {
    this.sessions = new Map(); // name -> SessionInfo
    this.processes = new Map(); // name -> ChildProcess
    this.loadRegistry();
  }

  /**
   * Load existing PTY sessions from disk registry
   */
  loadRegistry() {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.startsWith('pty-') && f.endsWith('.json'));

      for (const file of files) {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));

          // Only load pty sessions
          if (info.language !== 'term') continue;

          // Check if process is still alive
          if (info.pid) {
            try {
              process.kill(info.pid, 0); // Signal 0 = check if alive
              info.alive = true;
              this.sessions.set(info.name, info);
            } catch {
              // Process dead, remove registry file
              fs.unlinkSync(path.join(SESSIONS_DIR, file));
            }
          }
        } catch (e) {
          console.warn(`[pty-session] Skipping invalid registry file ${file}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[pty-session] Error loading registry:', e.message);
    }
  }

  /**
   * List all PTY sessions
   *
   * @returns {SessionInfo[]}
   */
  list() {
    // Refresh alive status
    for (const [name, info] of this.sessions) {
      try {
        process.kill(info.pid, 0);
        info.alive = true;
      } catch {
        info.alive = false;
        this.sessions.delete(name);
        this.removeRegistry(name);
      }
    }

    return Array.from(this.sessions.values());
  }

  /**
   * Start a new PTY server session
   *
   * @param {object} config - Session configuration
   * @param {string} config.name - Session name (e.g., "thesis:pty")
   * @param {string} config.cwd - Working directory
   * @param {string} [config.venv] - Optional venv path for activation
   * @returns {Promise<SessionInfo>}
   */
  async start(config) {
    // 1. Check if already running
    if (this.sessions.has(config.name)) {
      const existing = this.sessions.get(config.name);
      if (existing.alive) {
        // Verify it's actually alive
        try {
          process.kill(existing.pid, 0);
          return existing;
        } catch {
          // Actually dead, clean up
          this.sessions.delete(config.name);
          this.removeRegistry(config.name);
        }
      }
    }

    // 2. Find free port
    const port = await findFreePort();

    // 3. Spawn mrmd-pty - use local source in dev, PyPI in packaged mode
    console.log(`[pty-session] Starting "${config.name}" on port ${port} with cwd ${config.cwd}...`);

    let proc;
    const siblingPath = getPtySiblingPath();

    if (siblingPath) {
      // DEV MODE: Use local source via uv run --project
      console.log(`[pty-session] Using local package: ${siblingPath}`);
      proc = spawn('uv', [
        'run', '--project', siblingPath,
        'mrmd-pty',
        '--port', port.toString(),
      ], {
        cwd: siblingPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
    } else {
      // PACKAGED MODE: Download from PyPI via uv tool run
      console.log(`[pty-session] Using uv tool run (packaged mode)`);
      proc = spawn('uv', [
        'tool', 'run',
        '--from', `mrmd-pty${PYTHON_DEPS['mrmd-pty']}`,
        'mrmd-pty',
        '--port', port.toString(),
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
    }

    proc.stdout.on('data', (d) => console.log(`[pty-session:${config.name}]`, d.toString().trim()));
    proc.stderr.on('data', (d) => console.error(`[pty-session:${config.name}]`, d.toString().trim()));

    // 5. Wait for ready
    await waitForPort(port);

    // 6. Register session
    const info = {
      name: config.name,
      language: 'term',
      pid: proc.pid,
      port,
      cwd: config.cwd,
      venv: config.venv || null,
      wsUrl: `ws://127.0.0.1:${port}/api/pty`,
      startedAt: new Date().toISOString(),
      alive: true,
    };

    this.sessions.set(config.name, info);
    this.processes.set(config.name, proc);
    this.saveRegistry(info);

    // 7. Handle exit
    proc.on('exit', (code, signal) => {
      console.log(`[pty-session:${config.name}] Exited (code=${code}, signal=${signal})`);
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

    console.log(`[pty-session] Stopping "${sessionName}"...`);

    try {
      if (session.pid) {
        try {
          // Try to kill the process group
          process.kill(-session.pid, 'SIGTERM');
        } catch {
          // Fall back to killing just the process
          process.kill(session.pid, 'SIGTERM');
        }
      }
    } catch (e) {
      console.error(`[pty-session] Error killing ${sessionName}:`, e.message);
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
      throw new Error(`PTY session "${sessionName}" not found`);
    }

    const config = {
      name: sessionName,
      cwd: session.cwd,
      venv: session.venv,
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
    try {
      process.kill(session.pid, 0);
      session.alive = true;
      return session;
    } catch {
      session.alive = false;
      this.sessions.delete(sessionName);
      this.removeRegistry(sessionName);
      return null;
    }
  }

  /**
   * Get or create PTY session for a document
   *
   * @param {string} documentPath - Path to document
   * @param {object} projectConfig - Project configuration
   * @param {object|null} frontmatter - Document frontmatter
   * @param {string} projectRoot - Project root path
   * @returns {Promise<SessionConfig>} Resolved session config with optional session info
   */
  async getForDocument(documentPath, projectConfig, frontmatter, projectRoot) {
    console.log('[pty-session] getForDocument called');
    console.log('[pty-session] projectRoot:', projectRoot);
    console.log('[pty-session] projectConfig:', JSON.stringify(projectConfig, null, 2));

    // Use mrmd-project to resolve term session config
    const merged = Project.mergeConfig(projectConfig, frontmatter);
    console.log('[pty-session] merged config:', JSON.stringify(merged, null, 2));

    const resolved = Project.resolveSessionForLanguage('term', documentPath, projectRoot, merged);
    console.log('[pty-session] resolved:', resolved);

    // Build result with config info
    const result = {
      name: resolved.name,
      cwd: resolved.cwd,
      venv: resolved.venv || null,
      autoStart: resolved.autoStart,
      language: 'term',
      alive: false,
      pid: null,
      port: null,
      wsUrl: null,
    };

    // Check if session exists and is alive
    const existing = this.sessions.get(resolved.name);
    if (existing?.alive) {
      // Verify still alive
      try {
        process.kill(existing.pid, 0);
        result.alive = true;
        result.pid = existing.pid;
        result.port = existing.port;
        result.wsUrl = existing.wsUrl;
        result.startedAt = existing.startedAt;
        return result;
      } catch {
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
        result.wsUrl = started.wsUrl;
        result.startedAt = started.startedAt;
      } catch (e) {
        console.error('[pty-session] Auto-start failed:', e.message);
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
      const filename = 'pty-' + info.name.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
    } catch (e) {
      console.error('[pty-session] Failed to save registry:', e.message);
    }
  }

  /**
   * Remove session from registry
   */
  removeRegistry(sessionName) {
    try {
      const filename = 'pty-' + sessionName.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    } catch (e) {
      console.error('[pty-session] Failed to remove registry:', e.message);
    }
  }

  /**
   * Clean up all sessions on shutdown
   */
  shutdown() {
    for (const [name] of this.sessions) {
      this.stop(name).catch((e) => {
        console.warn(`[pty-session] Error stopping ${name} during shutdown:`, e.message);
      });
    }
  }
}

export default PtySessionService;
