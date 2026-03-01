/**
 * ProjectService - Project detection, configuration, and caching
 *
 * Manages mrmd project discovery and provides cached project information
 * including config parsing, file listing, and navigation tree building.
 *
 * Uses mrmd-project for all computation (pure logic).
 */

import { FSML, Scaffold } from 'mrmd-project';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import chokidar from 'chokidar';

// Shared utilities and configuration
import { createVenv, installMrmdPython } from '../utils/index.js';
import { PROJECT_SCAN_MAX_DEPTH } from '../config.js';

const DOC_EXTENSIONS = ['.md', '.qmd'];

function isDocPath(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return DOC_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function hasDocsInDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && isDocPath(entry.name));
  } catch {
    return false;
  }
}

function findGitRoot(startDir) {
  let current = path.resolve(startDir || '/');
  while (true) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current;
    } catch {
      // ignore
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

function resolveProjectRootFromPath(filePath) {
  const absolute = path.resolve(String(filePath || '.'));
  let startDir = absolute;
  try {
    const stat = fs.statSync(absolute);
    if (stat.isFile()) startDir = path.dirname(absolute);
  } catch {
    if (path.extname(absolute)) startDir = path.dirname(absolute);
  }

  const gitRoot = findGitRoot(startDir);
  if (gitRoot) return gitRoot;

  // Heuristic fallback: bubble up through nearby doc-containing parents
  // so opening a deep notebook still gets a useful sidebar root.
  const homeDir = path.resolve(process.env.HOME || '/');
  let current = startDir;
  let candidate = startDir;

  for (let i = 0; i < 4; i++) {
    const parent = path.dirname(current);
    if (!parent || parent === current || parent === homeDir || parent === '/') break;
    if (hasDocsInDir(parent)) {
      candidate = parent;
      current = parent;
      continue;
    }
    break;
  }

  return candidate;
}

class ProjectService {
  constructor() {
    this.cache = new Map(); // projectRoot -> ProjectInfo
    this.rawTreeCache = new Map(); // `${root}::${showSystem}::${maxDepth}` -> { tree, expiresAt }
    this.watchers = new Map(); // projectRoot -> FSWatcher
  }

  /**
   * Get project info for a file path (cached)
   *
   * @param {string} filePath - Absolute path to any file
   * @returns {Promise<ProjectInfo | null>}
   */
  async getProject(filePath) {
    const root = resolveProjectRootFromPath(filePath);

    // Check cache
    if (this.cache.has(root)) {
      return this.cache.get(root);
    }

    // App-owned project metadata (runtime prefs/config is no longer in mrmd.md)
    const config = {
      name: path.basename(root) || 'Project',
    };

    // Scan files
    const files = await this.scanFiles(root);

    // Build nav tree using mrmd-project FSML utils
    const navTree = FSML.buildNavTree(files);

    // Cache and return
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

    const normalizedRoot = path.resolve(String(projectRoot || '.'));
    for (const key of this.rawTreeCache.keys()) {
      if (key.startsWith(`${normalizedRoot}::`)) {
        this.rawTreeCache.delete(key);
      }
    }
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
    await createVenv(venvPath);

    // 5. Install mrmd-python
    await installMrmdPython(venvPath);

    // 6. Return project info
    return this.getProject(targetPath);
  }

  /**
   * Watch project for changes (cross-platform using chokidar)
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

    // Use chokidar for cross-platform recursive watching
    const watcher = chokidar.watch(projectRoot, {
      ignored: [
        /(^|[\/\\])\../, // Hidden files
        /(^|[\/\\])_/,   // Underscore prefixed (assets, etc.)
        /node_modules/,
        /\.git/,
      ],
      persistent: true,
      ignoreInitial: true,
      depth: 10,
    });

    // Debounce file change events to batch rapid changes (e.g., git checkout,
    // bulk rename) into a single cache invalidation + callback.
    let debounceTimer = null;
    const DEBOUNCE_MS = 150;

    const handleChange = (filePath) => {
      // Only care about markdown-like doc files and directories
      if (isDocPath(filePath) || !path.extname(filePath)) {
        // Batch rapid changes
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          this.invalidate(projectRoot);
          onChange();
        }, DEBOUNCE_MS);
      }
    };

    watcher.on('add', handleChange);
    watcher.on('change', handleChange);
    watcher.on('unlink', handleChange);
    watcher.on('addDir', handleChange);
    watcher.on('unlinkDir', handleChange);

    this.watchers.set(projectRoot, watcher);

    return {
      close: () => {
        if (debounceTimer) clearTimeout(debounceTimer);
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
      if (depth > PROJECT_SCAN_MAX_DEPTH) return;

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
        } else if (isDocPath(entry.name)) {
          files.push(relativePath);
        }
      }
    };

    await walk(root);
    return FSML.sortPaths(files);
  }

  /**
   * Scan ALL files in a directory (for raw file browser view).
   *
   * Unlike scanFiles, this includes every file type and _ prefixed dirs.
   * Only skips .git, node_modules, __pycache__, .venv.
   *
   * @param {string} root - Directory to scan
   * @param {object} [options]
   * @param {number} [options.maxDepth=10] - Max recursion depth
   * @param {boolean} [options.showSystem=false] - Include . prefixed entries
   * @returns {Promise<string[]>} Relative paths of all files
   */
  async scanAllFiles(root, options = {}) {
    const { maxDepth = PROJECT_SCAN_MAX_DEPTH, showSystem = false } = options;
    const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.venv', '.mrmd-sync']);
    const files = [];

    const walk = async (dir, depth) => {
      if (depth > maxDepth) return;

      let entries;
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!showSystem && entry.name.startsWith('.')) continue;
        if (SKIP_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(root, fullPath);

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else {
          files.push(relativePath);
        }
      }
    };

    await walk(root, 0);
    return files;
  }

  /**
   * Build a raw file tree for the file browser.
   *
   * Returns all files and folders with actual filenames (no FSML title derivation).
   *
   * @param {string} root - Directory to scan
   * @param {object} [options]
   * @param {number} [options.maxDepth=10]
   * @param {boolean} [options.showSystem=false]
   * @returns {Promise<object[]>} Raw tree nodes
   */
  async getRawTree(root, options = {}) {
    const { showSystem = false, maxDepth = PROJECT_SCAN_MAX_DEPTH } = options;
    const normalizedRoot = path.resolve(String(root || '.'));
    const cacheKey = `${normalizedRoot}::${showSystem ? '1' : '0'}::${maxDepth}`;
    const now = Date.now();
    const cached = this.rawTreeCache.get(cacheKey);

    // Very short-lived cache to absorb repeated UI requests while staying fresh.
    const RAW_TREE_CACHE_TTL_MS = 2000;
    if (cached && cached.expiresAt > now) {
      return cached.tree;
    }

    const allFiles = await this.scanAllFiles(normalizedRoot, { showSystem, maxDepth });
    const tree = FSML.buildRawTree(allFiles, { showSystem });

    this.rawTreeCache.set(cacheKey, {
      tree,
      expiresAt: now + RAW_TREE_CACHE_TTL_MS,
    });

    // Opportunistic cleanup to prevent unbounded growth when users browse many roots.
    if (this.rawTreeCache.size > 256) {
      const cutoff = Date.now();
      for (const [key, value] of this.rawTreeCache.entries()) {
        if (!value || value.expiresAt <= cutoff) {
          this.rawTreeCache.delete(key);
        }
      }
    }

    return tree;
  }

  /**
   * Browse a single directory, returning immediate children.
   * Used for navigating above the project root.
   *
   * @param {string} dirPath - Absolute directory path
   * @param {object} [options]
   * @param {boolean} [options.showHidden=false]
   * @returns {Promise<object[]>} Array of { name, path, isFolder, size?, modified? }
   */
  async browseDirectory(dirPath, options = {}) {
    const { showHidden = false } = options;
    const SKIP = new Set(['node_modules', '__pycache__', '.git']);

    let entries;
    try {
      entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const results = [];
    for (const entry of entries) {
      if (!showHidden && entry.name.startsWith('.')) continue;
      if (SKIP.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const isFolder = entry.isDirectory();
      const item = {
        name: entry.name,
        path: fullPath,
        isFolder,
        isHidden: entry.name.startsWith('_'),
      };

      if (!isFolder) {
        try {
          const stat = await fsPromises.stat(fullPath);
          item.size = stat.size;
          item.modified = stat.mtime.toISOString();
        } catch { /* ignore */ }
      }

      results.push(item);
    }

    // Sort: folders first, then alphabetical
    results.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return results;
  }

  // Note: createVenv and installMrmdPython are now imported from utils
}


export default ProjectService;
