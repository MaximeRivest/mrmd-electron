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
import os from 'os';
import net from 'net';

const REGISTRY_DIR = path.join(os.homedir(), '.mrmd', 'sessions');

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
    if (!fs.existsSync(REGISTRY_DIR)) return;

    try {
      const files = fs.readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json'));

      for (const file of files) {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, file), 'utf8'));

          // Check if process is still alive
          if (info.pid) {
            try {
              process.kill(info.pid, 0); // Signal 0 = check if alive
              info.alive = true;
              this.sessions.set(info.name, info);
            } catch {
              // Process dead, remove registry file
              fs.unlinkSync(path.join(REGISTRY_DIR, file));
            }
          }
        } catch {
          // Skip invalid files
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

    // 2. Validate venv and auto-install mrmd-python if needed
    const mrmdPythonPath = path.join(config.venv, 'bin', 'mrmd-python');
    if (!fs.existsSync(mrmdPythonPath)) {
      console.log(`[session] mrmd-python not found in ${config.venv}, installing...`);
      await this.installMrmdPython(config.venv);

      // Verify installation succeeded
      if (!fs.existsSync(mrmdPythonPath)) {
        throw new Error(`Failed to install mrmd-python in ${config.venv}`);
      }
      console.log(`[session] mrmd-python installed successfully`);
    }

    // 3. Find free port
    const port = await this.findFreePort();

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
    await this.waitForPort(port);

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
        try {
          // Try to kill the process group
          process.kill(-session.pid, 'SIGTERM');
        } catch {
          // Fall back to killing just the process
          process.kill(session.pid, 'SIGTERM');
        }
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
        console.error('[session] Auto-start failed:', e.message);
        result.error = e.message;
      }
    }

    return result;
  }

  /**
   * Find a free port
   */
  findFreePort() {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
  }

  /**
   * Wait for a port to be ready
   */
  waitForPort(port, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      const check = () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`Port ${port} not ready after ${timeout}ms`));
          return;
        }

        const socket = new net.Socket();
        socket.setTimeout(500);

        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });

        socket.on('error', () => {
          socket.destroy();
          setTimeout(check, 200);
        });

        socket.connect(port, '127.0.0.1');
      };

      check();
    });
  }

  /**
   * Find uv binary in common locations
   * @returns {string|null} Path to uv or null if not found
   */
  findUv() {
    const locations = [
      '/usr/local/bin/uv',
      '/usr/bin/uv',
      path.join(os.homedir(), '.local', 'bin', 'uv'),
      path.join(os.homedir(), '.cargo', 'bin', 'uv'),
    ];

    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        return loc;
      }
    }

    // Try PATH
    try {
      const { execSync } = require('child_process');
      const result = execSync('which uv', { encoding: 'utf8' }).trim();
      if (result && fs.existsSync(result)) {
        return result;
      }
    } catch {
      // uv not in PATH
    }

    return null;
  }

  /**
   * Install mrmd-python in a virtual environment using uv
   * @param {string} venvPath - Path to the virtual environment
   * @returns {Promise<void>}
   */
  async installMrmdPython(venvPath) {
    // Try uv first (preferred), fall back to pip
    const uvPath = this.findUv();
    const pipPath = path.join(venvPath, 'bin', 'pip');

    let cmd, args;
    if (uvPath) {
      cmd = uvPath;
      args = ['pip', 'install', '--python', path.join(venvPath, 'bin', 'python'), 'mrmd-python'];
    } else if (fs.existsSync(pipPath)) {
      cmd = pipPath;
      args = ['install', 'mrmd-python'];
    } else {
      throw new Error(`Neither uv nor pip found for ${venvPath}`);
    }

    return new Promise((resolve, reject) => {
      console.log(`[session] Running: ${cmd} ${args.join(' ')}`);

      const proc = spawn(cmd, args, {
        cwd: path.dirname(venvPath),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, VIRTUAL_ENV: venvPath },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
        console.log(`[pip]`, d.toString().trim());
      });

      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        console.error(`[pip]`, d.toString().trim());
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`pip install failed (code ${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run pip: ${err.message}`));
      });
    });
  }

  /**
   * Save session info to registry
   */
  saveRegistry(info) {
    try {
      fs.mkdirSync(REGISTRY_DIR, { recursive: true });
      const filename = info.name.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(REGISTRY_DIR, filename);
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
      const filepath = path.join(REGISTRY_DIR, filename);
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
      this.stop(name).catch(() => {});
    }
  }
}

export default SessionService;
