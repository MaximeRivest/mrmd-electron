/**
 * ProjectService - Project detection, configuration, and caching
 *
 * Manages mrmd project discovery and provides cached project information
 * including config parsing, file listing, and navigation tree building.
 *
 * Uses mrmd-project for all computation (pure logic).
 */

import { Project, FSML, Scaffold } from 'mrmd-project';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ProjectService {
  constructor() {
    this.cache = new Map(); // projectRoot -> ProjectInfo
    this.watchers = new Map(); // projectRoot -> FSWatcher
  }

  /**
   * Get project info for a file path (cached)
   *
   * @param {string} filePath - Absolute path to any file
   * @returns {Promise<ProjectInfo | null>}
   */
  async getProject(filePath) {
    // 1. Find project root using mrmd-project
    const root = Project.findRoot(filePath, (p) => {
      try {
        return fs.existsSync(path.join(p, 'mrmd.md'));
      } catch {
        return false;
      }
    });

    if (!root) return null;

    // 2. Check cache
    if (this.cache.has(root)) {
      return this.cache.get(root);
    }

    // 3. Load project
    const mrmdPath = path.join(root, 'mrmd.md');
    const content = await fsPromises.readFile(mrmdPath, 'utf8');
    const config = Project.parseConfig(content);

    // 4. Scan files
    const files = await this.scanFiles(root);

    // 5. Build nav tree using mrmd-project
    const navTree = FSML.buildNavTree(files);

    // 6. Cache and return
    const info = { root, config, files, navTree };
    this.cache.set(root, info);
    return info;
  }

  /**
   * Invalidate cached project info
   *
   * @param {string} projectRoot - Project root path
   */
  invalidate(projectRoot) {
    this.cache.delete(projectRoot);
  }

  /**
   * Create a new mrmd project
   *
   * @param {string} targetPath - Where to create the project
   * @returns {Promise<ProjectInfo>}
   */
  async createProject(targetPath) {
    // 1. Get scaffold from mrmd-project
    const name = path.basename(targetPath);
    const scaffold = Scaffold.project(name);

    // 2. Create directory
    await fsPromises.mkdir(targetPath, { recursive: true });

    // 3. Write scaffold files
    for (const file of scaffold.files) {
      const fullPath = path.join(targetPath, file.path);
      await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
      await fsPromises.writeFile(fullPath, file.content);
    }

    // 4. Create venv
    const venvPath = path.join(targetPath, scaffold.venvPath);
    await this.createVenv(venvPath);

    // 5. Install mrmd-python
    await this.installMrmdPython(venvPath);

    // 6. Return project info
    return this.getProject(targetPath);
  }

  /**
   * Watch project for changes
   *
   * @param {string} projectRoot - Project root path
   * @param {Function} onChange - Callback when files change
   * @returns {{ close: Function }}
   */
  watch(projectRoot, onChange) {
    // Close existing watcher if any
    if (this.watchers.has(projectRoot)) {
      this.watchers.get(projectRoot).close();
    }

    const watcher = fs.watch(projectRoot, { recursive: true }, (eventType, filename) => {
      // Ignore hidden files and _assets
      if (!filename || filename.startsWith('.') || filename.startsWith('_')) {
        return;
      }

      // Only care about .md files and directories
      if (filename.endsWith('.md') || !filename.includes('.')) {
        this.invalidate(projectRoot);
        onChange();
      }
    });

    this.watchers.set(projectRoot, watcher);

    return {
      close: () => {
        watcher.close();
        this.watchers.delete(projectRoot);
      },
    };
  }

  /**
   * Scan files in project directory
   *
   * @param {string} root - Project root
   * @returns {Promise<string[]>} Relative paths
   */
  async scanFiles(root) {
    const files = [];

    const walk = async (dir, depth = 0) => {
      if (depth > 10) return; // Max depth

      let entries;
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        // Skip hidden and system files/dirs
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(root, fullPath);

        if (entry.isDirectory()) {
          // Skip _assets and node_modules
          if (entry.name === 'node_modules') continue;
          await walk(fullPath, depth + 1);
        } else if (entry.name.endsWith('.md')) {
          files.push(relativePath);
        }
      }
    };

    await walk(root);
    return FSML.sortPaths(files);
  }

  /**
   * Create a Python virtual environment
   *
   * @param {string} venvPath - Path for the venv
   */
  async createVenv(venvPath) {
    return new Promise((resolve, reject) => {
      // Try uv first (faster), fall back to python -m venv
      const proc = spawn('uv', ['venv', venvPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('error', () => {
        // uv not found, try python -m venv
        const fallback = spawn('python3', ['-m', 'venv', venvPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        fallback.on('error', (e) => reject(new Error(`Failed to create venv: ${e.message}`)));
        fallback.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`python -m venv failed with code ${code}`));
        });
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`uv venv failed: ${stderr}`));
      });
    });
  }

  /**
   * Install mrmd-python in a venv
   *
   * @param {string} venvPath - Path to the venv
   */
  async installMrmdPython(venvPath) {
    const pythonPath = path.join(venvPath, 'bin', 'python');
    const mrmdPythonPkg = path.join(path.dirname(path.dirname(__dirname)), 'mrmd-python');

    return new Promise((resolve, reject) => {
      // Use uv pip install for speed
      const proc = spawn('uv', [
        'pip', 'install',
        '--python', pythonPath,
        '-e', mrmdPythonPkg,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { output += d.toString(); });

      proc.on('error', (e) => {
        reject(new Error(`Failed to run uv: ${e.message}. Is uv installed?`));
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`uv pip install failed: ${output.slice(-500)}`));
      });
    });
  }
}

export default ProjectService;
