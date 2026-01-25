/**
 * RSessionService - R runtime session management
 *
 * Manages R runtime sessions (mrmd-r processes).
 * Sessions are named {projectName}:r:{sessionName} and persisted
 * in ~/.mrmd/sessions/ for sharing across windows.
 *
 * Unlike Python sessions, R sessions don't need venv management.
 * They use the system's R with a specific working directory.
 *
 * Uses mrmd-project for session config resolution.
 */

import { Project } from 'mrmd-project';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// Shared utilities and configuration
import { findFreePort, waitForPort } from '../utils/index.js';
import { SESSIONS_DIR } from '../config.js';

/**
 * Find the Rscript executable
 */
function findRscript() {
  const candidates = [
    '/usr/bin/Rscript',
    '/usr/local/bin/Rscript',
    '/opt/homebrew/bin/Rscript',  // macOS Homebrew
    '/opt/R/arm64/bin/Rscript',   // macOS R.app ARM
    '/opt/R/x86_64/bin/Rscript',  // macOS R.app Intel
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to PATH lookup
  return 'Rscript';
}

/**
 * Resolve the path to mrmd-r package directory
 */
function resolveRPackageDir() {
  // Check sibling directory (development mode)
  // From src/services/ → ../../../ gets us to mrmd-packages/, then into mrmd-r/
  const siblingPath = path.resolve(
    path.dirname(import.meta.url.replace('file://', '')),
    '../../../mrmd-r'
  );

  if (fs.existsSync(siblingPath) && fs.existsSync(path.join(siblingPath, 'DESCRIPTION'))) {
    console.log('[r-session] Using sibling path for mrmd-r (development mode)');
    return siblingPath;
  }

  throw new Error('Cannot find mrmd-r package. Expected at: ' + siblingPath);
}

class RSessionService {
  constructor() {
    this.sessions = new Map(); // name -> SessionInfo
    this.processes = new Map(); // name -> ChildProcess
    this.rscriptPath = findRscript();
    this.loadRegistry();
  }

  /**
   * Load existing R sessions from disk registry
   */
  loadRegistry() {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.startsWith('r-') && f.endsWith('.json'));

      for (const file of files) {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));

          // Only load R sessions
          if (info.language !== 'r') continue;

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
          console.warn(`[r-session] Skipping invalid registry file ${file}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[r-session] Error loading registry:', e.message);
    }
  }

  /**
   * List all R sessions
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
   * Start a new R session
   *
   * @param {object} config - Session configuration
   * @param {string} config.name - Session name (e.g., "thesis:r:default")
   * @param {string} config.cwd - Working directory
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

    // 2. Find mrmd-r package
    const rPackageDir = resolveRPackageDir();
    const cliScript = path.join(rPackageDir, 'inst', 'bin', 'mrmd-r');

    // 3. Find free port
    const port = await findFreePort();

    // 4. Spawn mrmd-r using Rscript
    console.log(`[r-session] Starting "${config.name}" on port ${port} with cwd ${config.cwd}...`);

    const proc = spawn(this.rscriptPath, [
      cliScript,
      '--port', port.toString(),
      '--cwd', config.cwd,
    ], {
      cwd: rPackageDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        // Ensure R can find packages
        R_LIBS_USER: process.env.R_LIBS_USER || '',
      },
    });

    proc.stdout.on('data', (d) => console.log(`[r-session:${config.name}]`, d.toString().trim()));
    proc.stderr.on('data', (d) => console.error(`[r-session:${config.name}]`, d.toString().trim()));

    // 5. Wait for ready
    await waitForPort(port);

    // 6. Register session
    const info = {
      name: config.name,
      language: 'r',
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
      console.log(`[r-session:${config.name}] Exited (code=${code}, signal=${signal})`);
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

    console.log(`[r-session] Stopping "${sessionName}"...`);

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
      console.error(`[r-session] Error killing ${sessionName}:`, e.message);
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
      throw new Error(`R session "${sessionName}" not found`);
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
   * Get or create R session for a document
   *
   * @param {string} documentPath - Path to document
   * @param {object} projectConfig - Project configuration
   * @param {object|null} frontmatter - Document frontmatter
   * @param {string} projectRoot - Project root path
   * @returns {Promise<SessionConfig>} Resolved session config with optional session info
   */
  async getForDocument(documentPath, projectConfig, frontmatter, projectRoot) {
    console.log('[r-session] getForDocument called');
    console.log('[r-session] projectRoot:', projectRoot);

    // Use mrmd-project to resolve R session config
    const merged = Project.mergeConfig(projectConfig, frontmatter);
    const resolved = Project.resolveSessionForLanguage('r', documentPath, projectRoot, merged);
    console.log('[r-session] resolved:', resolved);

    // Build result with config info
    const result = {
      name: resolved.name,
      cwd: resolved.cwd,
      autoStart: resolved.autoStart,
      language: 'r',
      alive: false,
      pid: null,
      port: null,
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
        result.startedAt = started.startedAt;
      } catch (e) {
        console.error('[r-session] Auto-start failed:', e.message);
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
      const filename = 'r-' + info.name.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
    } catch (e) {
      console.error('[r-session] Failed to save registry:', e.message);
    }
  }

  /**
   * Remove session from registry
   */
  removeRegistry(sessionName) {
    try {
      const filename = 'r-' + sessionName.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    } catch (e) {
      console.error('[r-session] Failed to remove registry:', e.message);
    }
  }

  /**
   * Clean up all sessions on shutdown
   */
  shutdown() {
    for (const [name] of this.sessions) {
      this.stop(name).catch((e) => {
        console.warn(`[r-session] Error stopping ${name} during shutdown:`, e.message);
      });
    }
  }
}

export default RSessionService;
