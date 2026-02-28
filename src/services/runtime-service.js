/**
 * RuntimeService — unified runtime lifecycle for ALL languages
 *
 * Replaces: SessionService, BashSessionService, RSessionService,
 *           JuliaSessionService, PtySessionService
 *
 * Every MRP-speaking runtime follows the same lifecycle:
 *   1. Resolve config (name, cwd, language, spawn command)
 *   2. Find free port
 *   3. Spawn process
 *   4. Wait for port
 *   5. Register in ~/.mrmd/sessions/
 *   6. Return { name, port, url, ... }
 *
 * The ONLY differences between languages are:
 *   - How to find the executable (venv, system path, uv tool run)
 *   - What CLI args to pass
 *   - Startup timeout (Julia is slow)
 *
 * Those differences are encoded as "spawn descriptors" in LANGUAGE_REGISTRY.
 */

import { Project } from 'mrmd-project';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { findFreePort, waitForPort, installMrmdPython, createVenv } from '../utils/index.js';
import { getVenvExecutable, killProcessTree, isProcessAlive, getDirname, isWin } from '../utils/platform.js';
import { SESSIONS_DIR, PYTHON_DEPS } from '../config.js';

// ============================================================================
// LANGUAGE REGISTRY — add new languages here
// ============================================================================

/**
 * @typedef {Object} SpawnDescriptor
 * @property {string[]} aliases           — language identifiers this handles
 * @property {number}   [startupTimeout]  — ms to wait for port (default 10000)
 * @property {boolean}  [needsVenv]       — whether project config includes a venv
 * @property {function} findExecutable    — (config, service) => string|null
 * @property {function} buildArgs         — (executablePath, port, config, service) => string[]
 * @property {function} [buildEnv]        — (config, service) => env object
 * @property {function} [validate]        — (service) => { available, error? }
 * @property {function} [preStart]        — async (config, service) => void (e.g. install deps)
 */

/**
 * Resolve runtime package path.
 *
 * Resolution order:
 *  1) Dev sibling checkout (../mrmd-packages/<name>)
 *  2) Packaged extraResources (<resources>/<name>)
 */
function getSiblingPath(packageName, markerFile) {
  // 1) Development mode: sibling package checkout
  const siblingPath = path.resolve(getDirname(import.meta.url), '../../../' + packageName);
  if (fs.existsSync(path.join(siblingPath, markerFile))) {
    return siblingPath;
  }

  // 2) Packaged app: files copied via electron-builder extraResources
  if (process.resourcesPath) {
    const resourcePath = path.join(process.resourcesPath, packageName);
    if (fs.existsSync(path.join(resourcePath, markerFile))) {
      return resourcePath;
    }
  }

  return null;
}

/**
 * Find an interpreter in common system paths or PATH
 */
function findInPath(name, extraPaths = []) {
  for (const p of extraPaths) {
    if (p && fs.existsSync(p)) return p;
  }
  // Check PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const exe = isWin ? name + '.exe' : name;
  for (const dir of pathDirs) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Import platform helpers that may or may not exist on all platforms.
// These are optional — if missing, the language just won't auto-detect its interpreter.
import { getRscriptPaths, getJuliaPaths } from '../utils/platform.js';

/** Get platform-specific interpreter search paths */
function getPlatformPaths(fnName) {
  try {
    if (fnName === 'getRscriptPaths' && typeof getRscriptPaths === 'function') return getRscriptPaths();
    if (fnName === 'getJuliaPaths' && typeof getJuliaPaths === 'function') return getJuliaPaths();
    return [];
  } catch {
    return [];
  }
}

const LANGUAGE_REGISTRY = {
  // ── Python ──────────────────────────────────────────────────────────────
  python: {
    aliases: ['python', 'py', 'python3'],
    startupTimeout: 15000,
    needsVenv: true,
    daemonized: false,

    findExecutable(config) {
      if (!config.venv) return null;
      const p = getVenvExecutable(config.venv, 'mrmd-python');
      return fs.existsSync(p) ? p : null;
    },

    buildArgs(exe, port, config) {
      // Use --foreground so the process stays attached to RuntimeService.
      // RuntimeService already spawns with detached:true + unref(), so the
      // runtime survives app restarts.
      //
      // IMPORTANT: do not pass --managed here.
      // Some published mrmd-python builds do not support that flag yet,
      // which causes immediate CLI exit and a misleading port timeout.
      return [
        '--id', config.name,
        '--foreground',
        '--port', port.toString(),
        '--venv', config.venv,
        '--cwd', config.cwd,
      ];
    },

    buildEnv(config) {
      return { ...process.env, VIRTUAL_ENV: config.venv };
    },

    async preStart(config) {
      // Auto-create venv if it doesn't exist (zero-config experience)
      const pythonPath = getVenvExecutable(config.venv, 'python');
      if (!fs.existsSync(pythonPath)) {
        console.log(`[runtime] Venv not found at ${config.venv}, creating automatically...`);
        await createVenv(config.venv);
        if (!fs.existsSync(pythonPath)) {
          throw new Error(`Failed to create venv at ${config.venv}`);
        }
        console.log(`[runtime] Venv created successfully at ${config.venv}`);
      }

      // Auto-install mrmd-python if missing
      const mrmdPythonPath = getVenvExecutable(config.venv, 'mrmd-python');
      if (!fs.existsSync(mrmdPythonPath)) {
        console.log(`[runtime] mrmd-python not found in ${config.venv}, installing...`);
        await installMrmdPython(config.venv);
        if (!fs.existsSync(mrmdPythonPath)) {
          throw new Error(`Failed to install mrmd-python in ${config.venv}`);
        }
        console.log(`[runtime] mrmd-python installed successfully`);
      }
    },
  },

  // ── Bash ────────────────────────────────────────────────────────────────
  bash: {
    aliases: ['bash', 'sh', 'shell'],
    startupTimeout: 10000,

    findExecutable() {
      const siblingPath = getSiblingPath('mrmd-bash', 'pyproject.toml');
      if (siblingPath) return { type: 'dev', packageDir: siblingPath };
      return { type: 'packaged' };
    },

    // For bash, the executable info determines spawn strategy
    buildSpawnArgs(port, config) {
      const resolved = this.findExecutable();
      if (resolved.type === 'dev') {
        return {
          command: 'uv',
          args: [
            'run', '--project', resolved.packageDir,
            'mrmd-bash',
            '--port', port.toString(),
            '--cwd', config.cwd,
          ],
          cwd: resolved.packageDir,
        };
      }
      // Packaged: uv tool run
      return {
        command: 'uv',
        args: [
          'tool', 'run',
          '--from', `mrmd-bash${PYTHON_DEPS['mrmd-bash'] || ''}`,
          'mrmd-bash',
          '--port', port.toString(),
          '--cwd', config.cwd,
        ],
      };
    },
  },

  // ── R ───────────────────────────────────────────────────────────────────
  r: {
    aliases: ['r', 'rlang'],
    startupTimeout: 15000,

    _rscriptPath: null,
    _packageDir: null,
    _resolved: false,

    _resolve(force = false) {
      if (this._resolved && !force) return;
      this._resolved = true;

      // Find Rscript
      const rPaths = getPlatformPaths('getRscriptPaths');
      this._rscriptPath = findInPath('Rscript', rPaths);

      // Find mrmd-r package
      this._packageDir = getSiblingPath('mrmd-r', 'DESCRIPTION');
    },

    /** Force re-resolve (e.g. after PATH changes) */
    invalidate() {
      this._resolved = false;
      this._rscriptPath = null;
      this._packageDir = null;
    },

    validate() {
      this._resolve();
      if (!this._rscriptPath) {
        return { available: false, error: 'R is not installed. Install from https://cran.r-project.org/' };
      }
      if (!this._packageDir) {
        return { available: false, error: 'mrmd-r package not found.' };
      }
      return { available: true };
    },

    findExecutable() {
      this._resolve();
      return this._rscriptPath;
    },

    buildArgs(exe, port, config) {
      this._resolve();
      const cliScript = path.join(this._packageDir, 'inst', 'bin', 'mrmd-r');
      return [cliScript, '--port', port.toString(), '--cwd', config.cwd];
    },

    buildEnv() {
      return { ...process.env, R_LIBS_USER: process.env.R_LIBS_USER || '' };
    },

    spawnCwd() {
      this._resolve();
      return this._packageDir;
    },
  },

  // ── Julia ───────────────────────────────────────────────────────────────
  julia: {
    aliases: ['julia', 'jl'],
    startupTimeout: 60000, // Julia JIT is slow

    _juliaPath: null,
    _packageDir: null,
    _resolved: false,
    _preparedKey: null,

    _resolve(force = false) {
      if (this._resolved && !force) return;
      this._resolved = true;

      const jPaths = getPlatformPaths('getJuliaPaths');
      this._juliaPath = findInPath('julia', jPaths);
      this._packageDir = getSiblingPath('mrmd-julia', 'Project.toml');
    },

    /** Force re-resolve (e.g. after PATH changes) */
    invalidate() {
      this._resolved = false;
      this._juliaPath = null;
      this._packageDir = null;
      this._preparedKey = null;
    },

    validate() {
      this._resolve();
      if (!this._juliaPath) {
        return { available: false, error: 'Julia is not installed.' };
      }
      if (!this._packageDir) {
        return { available: false, error: 'mrmd-julia package not found.' };
      }
      return { available: true };
    },

    findExecutable() {
      this._resolve();
      return this._juliaPath;
    },

    async preStart() {
      this._resolve();
      const key = `${this._juliaPath}|${this._packageDir}`;
      if (this._preparedKey === key) return;

      console.log(`[runtime:julia] Using Julia executable: ${this._juliaPath}`);
      console.log('[runtime:julia] Preparing Julia environment (resolve/instantiate/precompile)...');
      try {
        const cmd = `"${this._juliaPath}" --project="${this._packageDir}" -e "using Pkg; Pkg.resolve(); Pkg.instantiate(); Pkg.precompile()"`;
        execSync(cmd, {
          cwd: this._packageDir,
          env: { ...process.env, JULIA_PROJECT: this._packageDir },
          stdio: 'pipe',
          timeout: 300000,
          maxBuffer: 10 * 1024 * 1024,
        });
        this._preparedKey = key;
      } catch (e) {
        const stderr = e?.stderr ? e.stderr.toString() : '';
        const stdout = e?.stdout ? e.stdout.toString() : '';
        const details = (stderr || stdout || e?.message || '').trim();
        throw new Error(`Julia environment setup failed: ${details.slice(0, 600)}`);
      }
    },

    buildArgs(exe, port, config) {
      this._resolve();
      const cliScript = path.join(this._packageDir, 'bin', 'mrmd-julia');
      return [
        '--project=' + this._packageDir,
        cliScript,
        '--port', port.toString(),
        '--cwd', config.cwd,
      ];
    },

    buildEnv() {
      this._resolve();
      return { ...process.env, JULIA_PROJECT: this._packageDir };
    },

    spawnCwd() {
      this._resolve();
      return this._packageDir;
    },
  },

  // ── PTY (terminal blocks) ──────────────────────────────────────────────
  pty: {
    aliases: ['term'],
    startupTimeout: 10000,

    findExecutable() {
      const siblingPath = getSiblingPath('mrmd-pty', 'pyproject.toml');
      if (siblingPath) return { type: 'dev', packageDir: siblingPath };
      return { type: 'packaged' };
    },

    buildSpawnArgs(port, config) {
      const resolved = this.findExecutable();
      if (resolved.type === 'dev') {
        return {
          command: 'uv',
          args: [
            'run', '--project', resolved.packageDir,
            'mrmd-pty',
            '--port', port.toString(),
          ],
          cwd: resolved.packageDir,
        };
      }
      return {
        command: 'uv',
        args: [
          'tool', 'run',
          '--from', `mrmd-pty${PYTHON_DEPS['mrmd-pty'] || ''}`,
          'mrmd-pty',
          '--port', port.toString(),
        ],
      };
    },

    // PTY has a wsUrl in addition to the HTTP port
    extraInfo(port) {
      return { wsUrl: `ws://127.0.0.1:${port}/api/pty` };
    },
  },
};

// ============================================================================
// RUNTIME SERVICE
// ============================================================================

class RuntimeService {
  constructor() {
    /** @type {Map<string, Object>} name -> session info */
    this.sessions = new Map();

    /** @type {Map<string, import('child_process').ChildProcess>} name -> process */
    this.processes = new Map();

    /** @type {Map<string, Promise<Object>>} name -> in-flight start promise */
    this._startLocks = new Map();

    /** @type {Set<string>} session names currently being explicitly stopped */
    this._stopping = new Set();

    this._loadRegistry();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * List all running sessions, optionally filtered by language.
   * @param {string} [language] — filter by language
   * @returns {Object[]}
   */
  list(language) {
    const result = [];
    for (const [name, info] of this.sessions) {
      // For daemonized Python, the PID in our session map may be the
      // *launcher* PID (which exits immediately) rather than the daemon PID.
      // Don't prune based on PID alone — let _verifySession handle it via
      // port reachability, which is done lazily on next use.
      if (info.daemonized) {
        // Trust the session entry; reachability is verified on actual use.
        info.alive = true;
      } else if (info.pid && !isProcessAlive(info.pid)) {
        info.alive = false;
        this.sessions.delete(name);
        this._removeRegistry(name);
        continue;
      } else {
        info.alive = true;
      }

      if (!language || info.language === language) {
        result.push(info);
      }
    }
    return result;
  }

  /**
   * Start a runtime session.
   *
   * @param {Object} config
   * @param {string} config.name     — unique session name (e.g. "thesis:python:default")
   * @param {string} config.language — language key ("python", "bash", "r", "julia", "term")
   * @param {string} config.cwd      — working directory
   * @param {string} [config.venv]   — venv path (python only)
   * @returns {Promise<Object>} session info
   */
  async start(config) {
    const name = config?.name;
    if (!name) throw new Error('config.name is required');

    if (this._startLocks.has(name)) {
      console.log(`[runtime] Awaiting in-flight start for "${name}"...`);
      return this._startLocks.get(name);
    }

    let startPromise;
    startPromise = this._startInternal(config)
      .finally(() => {
        if (this._startLocks.get(name) === startPromise) {
          this._startLocks.delete(name);
        }
      });

    this._startLocks.set(name, startPromise);
    return startPromise;
  }

  async _startInternal(config) {
    const { name, language, cwd, venv } = config;
    if (!name || !language) {
      throw new Error('config.name and config.language are required');
    }

    // Reuse if already running
    const existing = this.sessions.get(name);
    if (existing?.alive) {
      const pidAlive = !existing.pid || isProcessAlive(existing.pid);

      if (pidAlive) {
        // If we have a child process handle, trust it. Otherwise verify port.
        if (this.processes.has(name)) {
          return existing;
        }
        const reachable = await this._verifySession(name);
        if (reachable) return existing;
        // Not reachable — fall through to spawn a new one
      }
      this.sessions.delete(name);
      this._removeRegistry(name);
    }

    const descriptor = this._getDescriptor(language);

    // Validate
    if (descriptor.validate) {
      const v = descriptor.validate();
      if (!v.available) throw new Error(v.error);
    }

    // Pre-start hook (e.g. install mrmd-python)
    if (descriptor.preStart) {
      await descriptor.preStart(config, this);
    }

    // Clean up any stale legacy daemon entries for this session name.
    // Previous versions used daemon mode which wrote to ~/.mrmd/runtimes/<name>.json.
    // We now run in foreground under RuntimeService management, so these
    // entries are usually stale.
    // However, if a legacy daemon is genuinely alive AND serving MRP, reuse it.
    if (language === 'python') {
      const reused = await this._maybeReuseLegacyPythonRuntime(config);
      if (reused) {
        console.log(`[runtime] Reusing existing python runtime PID=${reused.pid} port=${reused.port}`);
        return reused;
      }
    }

    // Find port
    const port = await findFreePort();
    const timeout = descriptor.startupTimeout || 10000;

    console.log(`[runtime] Starting "${name}" (${language}) on port ${port}...`);

    // Spawn — two modes:
    //   1. buildSpawnArgs() for uv-based runtimes (bash, pty)
    //   2. findExecutable() + buildArgs() for direct executables (python, r, julia)
    //
    // All runtimes use detached: true to get their own process group.
    // IMPORTANT: use stdio: 'ignore' for detached child stability.
    // Piped stdio can cause certain runtimes (notably Python/uvicorn foreground)
    // to exit shortly after startup when no TTY/reader is attached.
    const usePipedLogs = process.env.MRMD_RUNTIME_PIPE_LOGS === '1';
    const childStdio = usePipedLogs ? ['pipe', 'pipe', 'pipe'] : 'ignore';
    console.log(`[runtime] Spawn stdio mode for ${name}: ${usePipedLogs ? 'pipe' : 'ignore'}`);

    let proc;
    if (typeof descriptor.buildSpawnArgs === 'function') {
      const spawn_info = descriptor.buildSpawnArgs(port, config);
      proc = spawn(spawn_info.command, spawn_info.args, {
        cwd: spawn_info.cwd || cwd,
        stdio: childStdio,
        detached: true,
      });
      proc.unref(); // Don't keep electron alive just for this child
    } else {
      const exe = descriptor.findExecutable(config, this);
      if (!exe) {
        throw new Error(`No executable found for ${language}. Is it installed?`);
      }

      const args = descriptor.buildArgs(exe, port, config, this);
      const env = descriptor.buildEnv ? descriptor.buildEnv(config, this) : process.env;
      const spawnCwd = descriptor.spawnCwd ? descriptor.spawnCwd() : cwd;

      if (language === 'python') {
        console.log(`[runtime] Python spawn: ${exe} ${args.join(' ')}`);
      }

      proc = spawn(exe, args, {
        cwd: spawnCwd,
        stdio: childStdio,
        detached: true,
        env,
      });
      proc.unref(); // Don't keep electron alive just for this child
    }

    // Handle spawn errors (e.g. uv not installed)
    const spawnError = new Promise((_, reject) => {
      proc.on('error', (err) => {
        console.error(`[runtime:${name}] Spawn error:`, err.message);
        if (err.code === 'ENOENT') {
          reject(new Error(`Executable not found. Is the runtime installed?`));
        } else {
          reject(err);
        }
      });
    });

    // If the process exits before the port opens, fail fast with a useful
    // error instead of waiting for the full port timeout.
    const earlyExit = new Promise((_, reject) => {
      proc.once('exit', (code, signal) => {
        reject(new Error(`Runtime process exited before ready (code=${code}, signal=${signal})`));
      });
    });

    if (proc.stdout) {
      proc.stdout.on('data', (d) => console.log(`[runtime:${name}]`, d.toString().trim()));
    }
    if (proc.stderr) {
      proc.stderr.on('data', (d) => console.error(`[runtime:${name}]`, d.toString().trim()));
    }

    // Wait for ready
    await Promise.race([
      waitForPort(port, { timeout }),
      spawnError,
      earlyExit,
    ]);

    // Build session info — all runtimes now run in foreground mode,
    // so proc.pid IS the runtime PID directly.
    const info = {
      name,
      language,
      pid: proc.pid,
      port,
      url: `http://127.0.0.1:${port}/mrp/v1`,
      cwd,
      venv: venv || null,
      daemonized: false,
      startedAt: new Date().toISOString(),
      alive: true,
      ...(descriptor.extraInfo ? descriptor.extraInfo(port, config) : {}),
    };

    this.sessions.set(name, info);
    this.processes.set(name, proc);
    this._saveRegistry(info);

    // Handle exit
    proc.on('exit', (code, signal) => {
      const expectedStop = this._stopping.has(name);
      console.log(`[runtime:${name}] Exited (code=${code}, signal=${signal})${expectedStop ? ' [expected-stop]' : ' [unexpected]'} `);
      const session = this.sessions.get(name);
      if (session) session.alive = false;
      this.sessions.delete(name);
      this.processes.delete(name);
      this._removeRegistry(name);
      this._stopping.delete(name);
    });

    return info;
  }

  /**
   * Stop a runtime session.
   * @param {string} sessionName
   * @returns {Promise<boolean>}
   */
  async stop(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) return false;

    this._stopping.add(sessionName);
    console.log(`[runtime] Stopping "${sessionName}" (PID=${session.pid})...`);
    if (process.env.MRMD_RUNTIME_DEBUG_STOP === '1') {
      const stack = new Error().stack?.split('\n').slice(1, 8).join('\n');
      console.warn(`[runtime] stop stack for "${sessionName}":\n${stack}`);
    }
    try {
      const hasManagedProcessHandle = this.processes.has(sessionName);

      // Safety: never kill an unverified recovered PID blindly.
      // PID reuse can target unrelated processes after crashes/reboots.
      if (session.pid && hasManagedProcessHandle) {
        await killProcessTree(session.pid, 'SIGTERM');
      } else if (session.pid) {
        const reachable = await this._verifySession(sessionName);
        if (reachable) {
          await killProcessTree(session.pid, 'SIGTERM');
        } else {
          console.warn(`[runtime] Skip PID kill for unverified session "${sessionName}" (pid=${session.pid})`);
        }
      }
    } catch (e) {
      console.error(`[runtime] Error killing ${sessionName}:`, e.message);
    }

    // Also clean any legacy daemon entry for this name
    try {
      const runtimesDir = path.join(os.homedir(), '.mrmd', 'runtimes');
      const legacyPath = path.join(runtimesDir, `${sessionName}.json`);
      if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    } catch {}

    this.sessions.delete(sessionName);
    this.processes.delete(sessionName);
    this._removeRegistry(sessionName);
    this._stopping.delete(sessionName);
    return true;
  }

  /**
   * Restart a runtime session.
   * @param {string} sessionName
   * @returns {Promise<Object>}
   */
  async restart(sessionName) {
    let session = this.sessions.get(sessionName);

    // If not in memory, try to recover config from the on-disk registry
    if (!session) {
      try {
        const filename = sessionName.replace(/[:/]/g, '-') + '.json';
        const filepath = path.join(SESSIONS_DIR, filename);
        if (fs.existsSync(filepath)) {
          session = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        }
      } catch {}
    }

    if (!session) throw new Error(`Session "${sessionName}" not found`);

    const config = {
      name: sessionName,
      language: session.language,
      cwd: session.cwd,
      venv: session.venv,
    };

    await this.stop(sessionName);
    await new Promise(r => setTimeout(r, 500)); // Wait for port release
    return this.start(config);
  }

  /**
   * Attach to an existing session.
   * @param {string} sessionName
   * @returns {Object|null}
   */
  attach(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) return null;

    if (!session.pid || isProcessAlive(session.pid)) {
      session.alive = true;
      return session;
    }

    session.alive = false;
    this.sessions.delete(sessionName);
    this._removeRegistry(sessionName);
    return null;
  }

  /**
   * Get or create ALL runtimes needed for a document.
   *
   * This is the key method. Instead of calling 5 separate services,
   * the renderer calls this ONCE and gets back every runtime the
   * document needs.
   *
   * @param {string} documentPath — absolute path to the .md file
   * @param {Object} projectConfig — from mrmd.md
   * @param {Object|null} frontmatter — parsed YAML frontmatter
   * @param {string} projectRoot — project root directory
   * @returns {Promise<Object<string, Object>>} language → session info
   */
  async getForDocument(documentPath, projectConfig, frontmatter, projectRoot) {
    const merged = Project.mergeConfig(projectConfig, frontmatter);
    const results = {};

    // Resolve each language that has a descriptor
    for (const [language, descriptor] of Object.entries(LANGUAGE_REGISTRY)) {
      // Skip languages that aren't available
      if (descriptor.validate) {
        const v = descriptor.validate();
        if (!v.available) {
          results[language] = {
            language,
            alive: false,
            available: false,
            error: v.error,
          };
          continue;
        }
      }

      // Use mrmd-project to resolve the session config
      let resolved;
      if (language === 'python') {
        // Python uses the legacy resolveSession (name format: project:session)
        resolved = Project.resolveSession(documentPath, projectRoot, merged);
      } else {
        resolved = Project.resolveSessionForLanguage(language === 'pty' ? 'term' : language, documentPath, projectRoot, merged);
      }

      // Check if already running
      const existing = this.sessions.get(resolved.name);
      if (existing?.alive) {
        const pidAlive = !existing.pid || isProcessAlive(existing.pid);

        // For recovered sessions (no child process handle) or uncertain PID,
        // verify port reachability before trusting.
        const needsVerify = !this.processes.has(resolved.name) || !pidAlive;
        const verified = needsVerify ? await this._verifySession(resolved.name) : true;

        if (verified) {
          results[language] = {
            ...existing,
            autoStart: resolved.autoStart,
            available: true,
          };
          continue;
        }
        // Dead or unreachable, clean up
        this.sessions.delete(resolved.name);
        this._removeRegistry(resolved.name);
      }

      // Build result
      const result = {
        name: resolved.name,
        language: resolved.language || language,
        cwd: resolved.cwd,
        venv: resolved.venv || null,
        autoStart: resolved.autoStart,
        alive: false,
        available: true,
        pid: null,
        port: null,
        url: null,
      };

      // Auto-start if configured
      if (resolved.autoStart) {
        try {
          const started = await this.start({
            name: resolved.name,
            language,
            cwd: resolved.cwd,
            venv: resolved.venv,
          });
          result.alive = true;
          result.pid = started.pid;
          result.port = started.port;
          result.url = started.url;
          result.startedAt = started.startedAt;
          if (started.wsUrl) result.wsUrl = started.wsUrl;
        } catch (e) {
          console.error(`[runtime] Auto-start ${language} failed:`, e.message);
          result.error = e.message;
        }
      }

      results[language] = result;
    }

    return results;
  }

  /**
   * Get or create a SINGLE runtime for a document, for a specific language.
   * Convenience wrapper for backwards compatibility.
   *
   * @param {string} language
   * @param {string} documentPath
   * @param {Object} projectConfig
   * @param {Object|null} frontmatter
   * @param {string} projectRoot
   * @returns {Promise<Object|null>}
   */
  async getForDocumentLanguage(language, documentPath, projectConfig, frontmatter, projectRoot) {
    const merged = Project.mergeConfig(projectConfig, frontmatter);
    const descriptor = LANGUAGE_REGISTRY[language];
    if (!descriptor) return null;

    // Validate
    if (descriptor.validate) {
      const v = descriptor.validate();
      if (!v.available) return { language, alive: false, available: false, error: v.error };
    }

    // Resolve session config
    let resolved;
    if (language === 'python') {
      resolved = Project.resolveSession(documentPath, projectRoot, merged);
    } else {
      resolved = Project.resolveSessionForLanguage(
        language === 'pty' ? 'term' : language,
        documentPath, projectRoot, merged,
      );
    }

    // Check existing
    const existing = this.sessions.get(resolved.name);
    if (existing?.alive) {
      const pidAlive = !existing.pid || isProcessAlive(existing.pid);

      if (pidAlive) {
        const needsVerify = !this.processes.has(resolved.name);
        if (needsVerify) {
          const reachable = await this._verifySession(resolved.name);
          if (!reachable) {
            this.sessions.delete(resolved.name);
            this._removeRegistry(resolved.name);
          } else {
            return { ...existing, autoStart: resolved.autoStart, available: true };
          }
        } else {
          return { ...existing, autoStart: resolved.autoStart, available: true };
        }
      }
    }

    const result = {
      name: resolved.name,
      language,
      cwd: resolved.cwd,
      venv: resolved.venv || null,
      autoStart: resolved.autoStart,
      alive: false,
      available: true,
      pid: null,
      port: null,
      url: null,
    };

    if (resolved.autoStart) {
      try {
        const started = await this.start({
          name: resolved.name,
          language,
          cwd: resolved.cwd,
          venv: resolved.venv,
        });
        result.alive = true;
        result.pid = started.pid;
        result.port = started.port;
        result.url = started.url;
        result.startedAt = started.startedAt;
        if (started.wsUrl) result.wsUrl = started.wsUrl;
      } catch (e) {
        console.error(`[runtime] Auto-start ${language} failed:`, e.message);
        result.error = e.message;
      }
    }

    return result;
  }

  /**
   * Check if a language is available (has interpreter + package installed).
   * @param {string} language
   * @returns {{ available: boolean, error?: string }}
   */
  isAvailable(language) {
    const descriptor = LANGUAGE_REGISTRY[language];
    if (!descriptor) return { available: false, error: `Unknown language: ${language}` };
    if (descriptor.validate) return descriptor.validate();
    return { available: true };
  }

  /**
   * Get all supported languages.
   * @returns {string[]}
   */
  supportedLanguages() {
    return Object.keys(LANGUAGE_REGISTRY);
  }

  /**
   * Shutdown all sessions.
   */
  shutdown() {
    for (const [name] of this.sessions) {
      this.stop(name).catch(e => {
        console.warn(`[runtime] Error stopping ${name} during shutdown:`, e.message);
      });
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Reuse a legacy mrmd-python daemon entry if it matches this session name.
   * Legacy daemons are tracked in ~/.mrmd/runtimes/<id>.json.
   *
   * @param {{name:string, cwd:string, venv?:string}} config
   * @returns {Promise<Object|null>} session info if reused
   */
  async _maybeReuseLegacyPythonRuntime(config) {
    const { name, cwd, venv } = config;
    const runtimesDir = path.join(os.homedir(), '.mrmd', 'runtimes');
    const legacyPath = path.join(runtimesDir, `${name}.json`);

    if (!fs.existsSync(legacyPath)) return null;

    try {
      const info = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      const pidAlive = info?.pid && isProcessAlive(info.pid);
      if (!pidAlive) {
        try { fs.unlinkSync(legacyPath); } catch {}
        return null;
      }

      const port = Number(info.port);
      if (!port) return null;

      // Verify MRP endpoint is reachable
      let res = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        res = await fetch(`http://127.0.0.1:${port}/mrp/v1/capabilities`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
      } catch {
        res = null;
      }

      // If a legacy daemon PID is alive but not serving MRP, treat it as stale.
      // Safety: do NOT kill blindly here (PID reuse can target unrelated processes).
      if (!res?.ok) {
        console.log(`[runtime:legacy] Ignoring stale legacy entry PID=${info.pid} port=${info.port} for "${name}" (capabilities probe failed)`);
        try { fs.unlinkSync(legacyPath); } catch {}
        return null;
      }

      const sessionInfo = {
        name,
        language: 'python',
        pid: info.pid,
        port,
        url: `http://127.0.0.1:${port}/mrp/v1`,
        cwd: cwd || info.cwd || null,
        venv: venv || info.venv || null,
        startedAt: info.created || new Date().toISOString(),
        alive: true,
        reusedLegacy: true,
      };

      this.sessions.set(name, sessionInfo);
      this._saveRegistry(sessionInfo);
      console.log(`[runtime] Reusing existing python daemon for "${name}" on port ${port}`);
      return sessionInfo;
    } catch (e) {
      console.warn(`[runtime] Failed to reuse legacy python runtime ${name}:`, e.message);
      return null;
    }
  }

  _getDescriptor(language) {
    const lang = language.toLowerCase();
    // Direct match
    if (LANGUAGE_REGISTRY[lang]) return LANGUAGE_REGISTRY[lang];
    // Alias match
    for (const [key, desc] of Object.entries(LANGUAGE_REGISTRY)) {
      if (desc.aliases.includes(lang)) return LANGUAGE_REGISTRY[key];
    }
    throw new Error(`No runtime descriptor for language: ${language}`);
  }

  _loadRegistry() {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
          if (info.pid && isProcessAlive(info.pid)) {
            info.alive = true;
            info.recovered = true;
            // Ensure url is present for older registry entries
            if (!info.url && info.port) {
              info.url = `http://127.0.0.1:${info.port}/mrp/v1`;
            }
            this.sessions.set(info.name, info);
            console.log(`[runtime] Reconnected to surviving process: ${info.name} (PID ${info.pid}, port ${info.port})`);
          } else {
            fs.unlinkSync(path.join(SESSIONS_DIR, file));
          }
        } catch (e) {
          console.warn(`[runtime] Skipping invalid registry file ${file}:`, e.message);
        }
      }
      if (this.sessions.size > 0) {
        console.log(`[runtime] Loaded ${this.sessions.size} surviving runtime(s) from previous session`);
      }
    } catch (e) {
      console.error('[runtime] Error loading registry:', e.message);
    }
  }

  /**
   * Verify that a recovered session is actually serving MRP on its port.
   * Called lazily (first use) rather than at startup to avoid blocking init.
   *
   * @param {string} name - session name
   * @returns {Promise<boolean>} true if reachable
   */
  async _verifySession(name) {
    const session = this.sessions.get(name);
    if (!session?.port) return false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://127.0.0.1:${session.port}/mrp/v1/capabilities`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        session.recovered = false;
      }
      return res.ok;
    } catch {
      // Port not reachable — process may have died or port was reused
      console.warn(`[runtime] Surviving process ${name} not reachable on port ${session.port}, removing`);
      this.sessions.delete(name);
      this._removeRegistry(name);
      return false;
    }
  }

  _saveRegistry(info) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const filename = info.name.replace(/[:/]/g, '-') + '.json';
      fs.writeFileSync(path.join(SESSIONS_DIR, filename), JSON.stringify(info, null, 2));
    } catch (e) {
      console.error('[runtime] Failed to save registry:', e.message);
    }
  }

  _removeRegistry(sessionName) {
    try {
      const filename = sessionName.replace(/[:/]/g, '-') + '.json';
      const filepath = path.join(SESSIONS_DIR, filename);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    } catch (e) {
      console.error('[runtime] Failed to remove registry:', e.message);
    }
  }
}

export default RuntimeService;
