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

import { findFreePort, waitForPort, installMrmdPython } from '../utils/index.js';
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
 * Get sibling package path (development mode)
 */
function getSiblingPath(packageName, markerFile) {
  const siblingPath = path.resolve(getDirname(import.meta.url), '../../../' + packageName);
  if (fs.existsSync(path.join(siblingPath, markerFile))) {
    return siblingPath;
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

    findExecutable(config) {
      if (!config.venv) return null;
      const p = getVenvExecutable(config.venv, 'mrmd-python');
      return fs.existsSync(p) ? p : null;
    },

    buildArgs(exe, port, config) {
      return [
        '--id', config.name,
        '--port', port.toString(),
        '--foreground',
      ];
    },

    buildEnv(config) {
      return { ...process.env, VIRTUAL_ENV: config.venv };
    },

    async preStart(config) {
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

    _resolve() {
      if (this._resolved) return;
      this._resolved = true;

      // Find Rscript
      const rPaths = getPlatformPaths('getRscriptPaths');
      this._rscriptPath = findInPath('Rscript', rPaths);

      // Find mrmd-r package
      this._packageDir = getSiblingPath('mrmd-r', 'DESCRIPTION');
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

    _resolve() {
      if (this._resolved) return;
      this._resolved = true;

      const jPaths = getPlatformPaths('getJuliaPaths');
      this._juliaPath = findInPath('julia', jPaths);
      this._packageDir = getSiblingPath('mrmd-julia', 'Project.toml');
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
      if (info.pid && !isProcessAlive(info.pid)) {
        info.alive = false;
        this.sessions.delete(name);
        this._removeRegistry(name);
        continue;
      }
      info.alive = true;
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
    const { name, language, cwd, venv } = config;
    if (!name || !language) {
      throw new Error('config.name and config.language are required');
    }

    // Reuse if already running
    const existing = this.sessions.get(name);
    if (existing?.alive) {
      if (!existing.pid || isProcessAlive(existing.pid)) {
        return existing;
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

    // Find port
    const port = await findFreePort();
    const timeout = descriptor.startupTimeout || 10000;

    console.log(`[runtime] Starting "${name}" (${language}) on port ${port}...`);

    // Spawn — two modes:
    //   1. buildSpawnArgs() for uv-based runtimes (bash, pty)
    //   2. findExecutable() + buildArgs() for direct executables (python, r, julia)
    let proc;
    if (typeof descriptor.buildSpawnArgs === 'function') {
      const spawn_info = descriptor.buildSpawnArgs(port, config);
      proc = spawn(spawn_info.command, spawn_info.args, {
        cwd: spawn_info.cwd || cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
    } else {
      const exe = descriptor.findExecutable(config, this);
      if (!exe) {
        throw new Error(`No executable found for ${language}. Is it installed?`);
      }

      const args = descriptor.buildArgs(exe, port, config, this);
      const env = descriptor.buildEnv ? descriptor.buildEnv(config, this) : process.env;
      const spawnCwd = descriptor.spawnCwd ? descriptor.spawnCwd() : cwd;

      proc = spawn(exe, args, {
        cwd: spawnCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        env,
      });
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

    proc.stdout.on('data', (d) => console.log(`[runtime:${name}]`, d.toString().trim()));
    proc.stderr.on('data', (d) => console.error(`[runtime:${name}]`, d.toString().trim()));

    // Wait for ready
    await Promise.race([
      waitForPort(port, { timeout }),
      spawnError,
    ]);

    // Build session info
    const info = {
      name,
      language,
      pid: proc.pid,
      port,
      url: `http://127.0.0.1:${port}/mrp/v1`,
      cwd,
      venv: venv || null,
      startedAt: new Date().toISOString(),
      alive: true,
      ...(descriptor.extraInfo ? descriptor.extraInfo(port, config) : {}),
    };

    this.sessions.set(name, info);
    this.processes.set(name, proc);
    this._saveRegistry(info);

    // Handle exit
    proc.on('exit', (code, signal) => {
      console.log(`[runtime:${name}] Exited (code=${code}, signal=${signal})`);
      const session = this.sessions.get(name);
      if (session) session.alive = false;
      this.sessions.delete(name);
      this.processes.delete(name);
      this._removeRegistry(name);
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

    console.log(`[runtime] Stopping "${sessionName}"...`);
    try {
      if (session.pid) {
        await killProcessTree(session.pid, 'SIGTERM');
      }
    } catch (e) {
      console.error(`[runtime] Error killing ${sessionName}:`, e.message);
    }

    this.sessions.delete(sessionName);
    this.processes.delete(sessionName);
    this._removeRegistry(sessionName);
    return true;
  }

  /**
   * Restart a runtime session.
   * @param {string} sessionName
   * @returns {Promise<Object>}
   */
  async restart(sessionName) {
    const session = this.sessions.get(sessionName);
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
        if (!existing.pid || isProcessAlive(existing.pid)) {
          results[language] = {
            ...existing,
            autoStart: resolved.autoStart,
            available: true,
          };
          continue;
        }
        // Dead, clean up
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
    if (existing?.alive && (!existing.pid || isProcessAlive(existing.pid))) {
      return { ...existing, autoStart: resolved.autoStart, available: true };
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
            // Ensure url is present for older registry entries
            if (!info.url && info.port) {
              info.url = `http://127.0.0.1:${info.port}/mrp/v1`;
            }
            this.sessions.set(info.name, info);
          } else {
            fs.unlinkSync(path.join(SESSIONS_DIR, file));
          }
        } catch (e) {
          console.warn(`[runtime] Skipping invalid registry file ${file}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[runtime] Error loading registry:', e.message);
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
