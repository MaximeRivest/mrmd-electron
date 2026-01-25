/**
 * JuliaSessionService - Julia runtime session management
 *
 * Manages Julia runtime sessions (mrmd-julia processes).
 * Sessions are named {projectName}:julia:{sessionName} and persisted
 * in ~/.mrmd/sessions/ for sharing across windows.
 *
 * Julia sessions don't need venv management like Python.
 * They use the system's Julia installation with a specific working directory.
 *
 * Uses mrmd-project for session config resolution.
 */

import { Project } from 'mrmd-project';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Shared utilities and configuration
import { findFreePort, waitForPort } from '../utils/index.js';
import { killProcessTree, isProcessAlive, getDirname, getJuliaPaths, isWin } from '../utils/platform.js';
import { SESSIONS_DIR } from '../config.js';

/**
 * Find Julia executable
 */
function findJulia() {
  // Get platform-specific candidates
  const candidates = getJuliaPaths();

  // Also check PATH (use path.delimiter for cross-platform compatibility)
  const pathJulia = process.env.PATH?.split(path.delimiter)
    .map(p => path.join(p, isWin ? 'julia.exe' : 'julia'))
    .find(p => fs.existsSync(p));

  if (pathJulia) {
    candidates.unshift(pathJulia);
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Resolve the path to mrmd-julia package directory
 */
function resolveJuliaPackageDir() {
  // First try sibling directory (development mode)
  const siblingPath = path.resolve(
    getDirname(import.meta.url),
    '../../../mrmd-julia'
  );

  if (fs.existsSync(siblingPath) && fs.existsSync(path.join(siblingPath, 'Project.toml'))) {
    console.log('[julia-session] Using sibling path for mrmd-julia (development mode)');
    return siblingPath;
  }

  // TODO: Support installed package location
  throw new Error('Cannot resolve mrmd-julia package');
}

class JuliaSessionService {
  constructor() {
    this.sessions = new Map(); // name -> SessionInfo
    this.processes = new Map(); // name -> ChildProcess
    this.juliaPath = findJulia();
    this.packageDir = null;

    try {
      this.packageDir = resolveJuliaPackageDir();
    } catch (e) {
      console.warn('[julia-session] mrmd-julia package not found:', e.message);
    }

    this.loadRegistry();
  }

  /**
   * Check if Julia is available
   */
  isAvailable() {
    return this.juliaPath !== null && this.packageDir !== null;
  }

  /**
   * Load existing julia sessions from disk registry
   */
  loadRegistry() {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.startsWith('julia-') && f.endsWith('.json'));

      for (const file of files) {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));

          // Only load julia sessions
          if (info.language !== 'julia') continue;

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
          console.warn(`[julia-session] Skipping invalid registry file ${file}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[julia-session] Error loading registry:', e.message);
    }
  }

  /**
   * List all julia sessions
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
   * Start a new julia session
   *
   * @param {object} config - Session configuration
   * @param {string} config.name - Session name (e.g., "thesis:julia:default")
   * @param {string} config.cwd - Working directory
   * @returns {Promise<SessionInfo>}
   */
  async start(config) {
    if (!this.isAvailable()) {
      throw new Error('Julia is not available. Please install Julia and mrmd-julia package.');
    }

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

    // 3. Spawn mrmd-julia
    console.log(`[julia-session] Starting "${config.name}" on port ${port} with cwd ${config.cwd}...`);

    const cliScript = path.join(this.packageDir, 'bin', 'mrmd-julia');

    const proc = spawn(this.juliaPath, [
      '--project=' + this.packageDir,
      cliScript,
      '--port', port.toString(),
      '--cwd', config.cwd,
    ], {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        JULIA_PROJECT: this.packageDir,
      },
    });

    proc.stdout.on('data', (d) => console.log(`[julia-session:${config.name}]`, d.toString().trim()));
    proc.stderr.on('data', (d) => console.error(`[julia-session:${config.name}]`, d.toString().trim()));

    // 4. Wait for ready (Julia takes longer to start)
    await waitForPort(port, { timeout: 60000 }); // 60 second timeout for Julia startup

    // 5. Register session
    const info = {
      name: config.name,
      language: 'julia',
      pid: proc.pid,
      port,
      cwd: config.cwd,
      startedAt: new Date().toISOString(),
      alive: true,
    };

    this.sessions.set(config.name, info);
    this.processes.set(config.name, proc);
    this.saveRegistry(info);

    // 6. Handle exit
    proc.on('exit', (code, signal) => {
      console.log(`[julia-session:${config.name}] Exited (code=${code}, signal=${signal})`);
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

    console.log(`[julia-session] Stopping "${sessionName}"...`);

    try {
      if (session.pid) {
        await killProcessTree(session.pid, 'SIGTERM');
      }
    } catch (e) {
      console.error(`[julia-session] Error killing ${sessionName}:`, e.message);
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
      throw new Error(`Julia session "${sessionName}" not found`);
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
   * Get or create julia session for a document
   *
   * @param {string} documentPath - Path to document
   * @param {object} projectConfig - Project configuration
   * @param {object|null} frontmatter - Document frontmatter
   * @param {string} projectRoot - Project root path
   * @returns {Promise<SessionConfig>} Resolved session config with optional session info
   */
  async getForDocument(documentPath, projectConfig, frontmatter, projectRoot) {
    console.log('[julia-session] getForDocument called');
    console.log('[julia-session] projectRoot:', projectRoot);

    // Use mrmd-project to resolve julia session config
    const merged = Project.mergeConfig(projectConfig, frontmatter);
    console.log('[julia-session] merged config:', JSON.stringify(merged, null, 2));

    const resolved = Project.resolveSessionForLanguage('julia', documentPath, projectRoot, merged);
    console.log('[julia-session] resolved:', resolved);

    // Build result with config info
    const result = {
      name: resolved.name,
      cwd: resolved.cwd,
      autoStart: resolved.autoStart,
      language: 'julia',
      alive: false,
      pid: null,
      port: null,
      available: this.isAvailable(),
    };

    if (!this.isAvailable()) {
      result.error = 'Julia is not available. Please install Julia.';
      return result;
    }

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
        console.error('[julia-session] Auto-start failed:', e.message);
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
      const filename = 'julia-' + info.name.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
    } catch (e) {
      console.error('[julia-session] Failed to save registry:', e.message);
    }
  }

  /**
   * Remove session from registry
   */
  removeRegistry(sessionName) {
    try {
      const filename = 'julia-' + sessionName.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    } catch (e) {
      console.error('[julia-session] Failed to remove registry:', e.message);
    }
  }

  /**
   * Clean up all sessions on shutdown
   */
  shutdown() {
    for (const [name] of this.sessions) {
      this.stop(name).catch((e) => {
        console.warn(`[julia-session] Error stopping ${name} during shutdown:`, e.message);
      });
    }
  }
}

export default JuliaSessionService;
