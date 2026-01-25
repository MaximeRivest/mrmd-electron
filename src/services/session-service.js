/**
 * SessionService - Python runtime session management
 *
 * Manages Python runtime sessions (mrmd-python processes).
 * Sessions are named {projectName}:{sessionName} and persisted
 * in ~/.mrmd/sessions/ for sharing across windows.
 *
 * Uses mrmd-project for session config resolution.
 */

import { Project } from 'mrmd-project';
import { spawn } from 'child_process';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';

// Shared utilities and configuration
import { findFreePort, waitForPort } from '../utils/index.js';
import { installMrmdPython } from '../utils/index.js';
import { getVenvExecutable, killProcessTree, isProcessAlive } from '../utils/platform.js';
import { SESSIONS_DIR } from '../config.js';

class SessionService {
  constructor() {
    this.sessions = new Map(); // name -> SessionInfo
    this.processes = new Map(); // name -> ChildProcess
    this.loadRegistry();
  }

  /**
   * Load existing sessions from disk registry
   */
  loadRegistry() {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));

      for (const file of files) {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));

          // Check if process is still alive
          if (info.pid) {
            if (isProcessAlive(info.pid)) {
              info.alive = true;
              this.sessions.set(info.name, info);
            } else {
              // Process dead, remove registry file (expected - ESRCH means not running)
              fs.unlinkSync(path.join(SESSIONS_DIR, file));
            }
          }
        } catch (e) {
          // Skip invalid files but log for debugging
          console.warn(`[session] Skipping invalid registry file ${file}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[session] Error loading registry:', e.message);
    }
  }

  /**
   * List all sessions
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
   * Start a new session
   *
   * @param {object} config - Session configuration
   * @param {string} config.name - Session name (e.g., "thesis:default")
   * @param {string} config.venv - Absolute path to venv
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

    // 2. Validate venv and auto-install mrmd-python if needed
    const mrmdPythonPath = getVenvExecutable(config.venv, 'mrmd-python');
    if (!fs.existsSync(mrmdPythonPath)) {
      console.log(`[session] mrmd-python not found in ${config.venv}, installing...`);
      await installMrmdPython(config.venv);

      // Verify installation succeeded
      if (!fs.existsSync(mrmdPythonPath)) {
        throw new Error(`Failed to install mrmd-python in ${config.venv}`);
      }
      console.log(`[session] mrmd-python installed successfully`);
    }

    // 3. Find free port
    const port = await findFreePort();

    // 4. Spawn mrmd-python
    console.log(`[session] Starting "${config.name}" on port ${port}...`);

    const proc = spawn(mrmdPythonPath, [
      '--id', config.name,
      '--port', port.toString(),
      '--foreground',
    ], {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, VIRTUAL_ENV: config.venv },
      detached: false,
    });

    proc.stdout.on('data', (d) => console.log(`[session:${config.name}]`, d.toString().trim()));
    proc.stderr.on('data', (d) => console.error(`[session:${config.name}]`, d.toString().trim()));

    // 5. Wait for ready
    await waitForPort(port);

    // 6. Register session
    const info = {
      name: config.name,
      pid: proc.pid,
      port,
      venv: config.venv,
      cwd: config.cwd,
      startedAt: new Date().toISOString(),
      alive: true,
    };

    this.sessions.set(config.name, info);
    this.processes.set(config.name, proc);
    this.saveRegistry(info);

    // 7. Handle exit
    proc.on('exit', (code, signal) => {
      console.log(`[session:${config.name}] Exited (code=${code}, signal=${signal})`);
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

    console.log(`[session] Stopping "${sessionName}"...`);

    try {
      // Kill process (and process group for GPU memory release)
      if (session.pid) {
        await killProcessTree(session.pid, 'SIGTERM');
      }
    } catch (e) {
      console.error(`[session] Error killing ${sessionName}:`, e.message);
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
      throw new Error(`Session "${sessionName}" not found`);
    }

    const config = {
      name: sessionName,
      venv: session.venv,
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
   * Get or create session for a document
   *
   * Returns the resolved session config, optionally with running session info.
   * Always returns config so renderer can show start button even when not auto-started.
   *
   * @param {string} documentPath - Path to document
   * @param {object} projectConfig - Project configuration
   * @param {object|null} frontmatter - Document frontmatter
   * @param {string} projectRoot - Project root path
   * @returns {Promise<SessionConfig>} Resolved session config with optional session info
   */
  async getForDocument(documentPath, projectConfig, frontmatter, projectRoot) {
    // Use mrmd-project to resolve session config
    const merged = Project.mergeConfig(projectConfig, frontmatter);
    const resolved = Project.resolveSession(documentPath, projectRoot, merged);

    // Build result with config info
    const result = {
      name: resolved.name,
      venv: resolved.venv,
      cwd: resolved.cwd,
      autoStart: resolved.autoStart,
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
        console.error('[session] Auto-start failed:', e.message);
        result.error = e.message;
      }
    }

    return result;
  }

  // Note: findFreePort, waitForPort, and installMrmdPython are now imported from utils

  /**
   * Save session info to registry
   */
  saveRegistry(info) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const filename = info.name.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
    } catch (e) {
      console.error('[session] Failed to save registry:', e.message);
    }
  }

  /**
   * Remove session from registry
   */
  removeRegistry(sessionName) {
    try {
      const filename = sessionName.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    } catch (e) {
      console.error('[session] Failed to remove registry:', e.message);
    }
  }

  /**
   * Clean up all sessions on shutdown
   */
  shutdown() {
    for (const [name] of this.sessions) {
      this.stop(name).catch((e) => {
        console.warn(`[session] Error stopping ${name} during shutdown:`, e.message);
      });
    }
  }
}

export default SessionService;
