/**
 * FileService - File operations with automatic refactoring
 *
 * Manages file operations (create, move, delete) within mrmd projects.
 * Automatically updates internal links and asset paths when files move.
 *
 * Uses mrmd-project for FSML parsing and link/asset refactoring.
 */

import { FSML, Links, Assets } from 'mrmd-project';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';

class FileService {
  /**
   * @param {ProjectService} projectService - Reference to ProjectService for cache invalidation
   */
  constructor(projectService) {
    this.projectService = projectService;
  }

  /**
   * Scan files in a directory
   *
   * @param {string} root - Directory to scan
   * @param {object} options - Scan options
   * @param {boolean} options.includeHidden - Include hidden (_) directories
   * @param {string[]} options.extensions - File extensions to include
   * @param {number} options.maxDepth - Maximum recursion depth
   * @returns {Promise<string[]>} Sorted relative paths
   */
  async scan(root, options = {}) {
    const {
      includeHidden = false,
      extensions = ['.md'],
      maxDepth = 10,
    } = options;

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
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(root, fullPath);

        // Skip system files (.)
        if (entry.name.startsWith('.')) continue;

        // Skip hidden files (_) unless requested
        if (!includeHidden && entry.name.startsWith('_')) continue;

        // Skip node_modules
        if (entry.name === 'node_modules') continue;

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else {
          // Check extension
          const hasMatchingExt = extensions.some(ext => entry.name.endsWith(ext));
          if (hasMatchingExt) {
            files.push(relativePath);
          }
        }
      }
    };

    await walk(root, 0);
    return FSML.sortPaths(files);
  }

  /**
   * Create a file
   *
   * @param {string} filePath - Absolute path to create
   * @param {string} content - File content
   */
  async createFile(filePath, content = '') {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, content);
  }

  /**
   * Create a file within a project (handles FSML ordering)
   *
   * @param {string} projectRoot - Project root path
   * @param {string} relativePath - Desired relative path
   * @param {string} content - File content
   * @returns {Promise<string>} Actual relative path (may have order prefix)
   */
  async createInProject(projectRoot, relativePath, content = '') {
    // Get the directory
    const dir = path.dirname(relativePath);
    const dirPath = dir ? path.join(projectRoot, dir) : projectRoot;

    let finalPath = relativePath;

    // Check if directory exists and has ordered files
    if (await this.dirExists(dirPath)) {
      try {
        const siblings = await fsPromises.readdir(dirPath);
        const mdSiblings = siblings.filter(f => f.endsWith('.md'));

        // Find max order among siblings
        let maxOrder = 0;
        let hasOrderedFiles = false;

        for (const sibling of mdSiblings) {
          const parsed = FSML.parsePath(sibling);
          if (parsed.order !== null) {
            hasOrderedFiles = true;
            maxOrder = Math.max(maxOrder, parsed.order);
          }
        }

        // If folder has ordered files and new file doesn't have order, add one
        if (hasOrderedFiles) {
          const filename = path.basename(relativePath);
          const parsed = FSML.parsePath(filename);

          if (parsed.order === null) {
            // Add next order prefix
            const newOrder = maxOrder + 1;
            const paddedOrder = String(newOrder).padStart(2, '0');
            const newFilename = `${paddedOrder}-${filename}`;
            finalPath = dir ? path.join(dir, newFilename) : newFilename;
          }
        }
      } catch {
        // Directory doesn't exist yet, that's fine
      }
    }

    const fullPath = path.join(projectRoot, finalPath);
    await this.createFile(fullPath, content);

    // Invalidate project cache
    if (this.projectService) {
      this.projectService.invalidate(projectRoot);
    }

    return finalPath;
  }

  /**
   * Move/rename a file with automatic refactoring
   *
   * @param {string} projectRoot - Project root path
   * @param {string} fromPath - Source relative path
   * @param {string} toPath - Destination relative path
   * @returns {Promise<RefactorResult>}
   */
  async move(projectRoot, fromPath, toPath) {
    const updatedFiles = [];

    // 1. Read all .md files in project
    const files = await this.scan(projectRoot);

    // 2. For each file, check if it references the moved file
    for (const file of files) {
      if (file === fromPath) continue;

      const fullPath = path.join(projectRoot, file);
      let content;
      try {
        content = await fsPromises.readFile(fullPath, 'utf8');
      } catch {
        continue;
      }

      // Update links using mrmd-project
      const updatedContent = Links.refactor(content, [
        { from: fromPath, to: toPath },
      ], file);

      if (updatedContent !== content) {
        await fsPromises.writeFile(fullPath, updatedContent);
        updatedFiles.push(file);
      }
    }

    // 3. Read the file being moved
    const fullFromPath = path.join(projectRoot, fromPath);
    let movingContent;
    try {
      movingContent = await fsPromises.readFile(fullFromPath, 'utf8');
    } catch (e) {
      throw new Error(`Cannot read source file: ${e.message}`);
    }

    // 4. Update asset paths IN the moved file using mrmd-project
    const updatedMovingContent = Assets.refactorPaths(
      movingContent,
      fromPath,
      toPath,
      '_assets'
    );

    // 5. Actually move the file
    const fullToPath = path.join(projectRoot, toPath);
    await fsPromises.mkdir(path.dirname(fullToPath), { recursive: true });
    await fsPromises.writeFile(fullToPath, updatedMovingContent);
    await fsPromises.unlink(fullFromPath);

    // 6. Clean up empty directories
    await this.removeEmptyDirs(path.dirname(fullFromPath), projectRoot);

    // 7. Invalidate project cache
    if (this.projectService) {
      this.projectService.invalidate(projectRoot);
    }

    return { movedFile: toPath, updatedFiles };
  }

  /**
   * Delete a file
   *
   * @param {string} filePath - Absolute path to delete
   */
  async delete(filePath) {
    await fsPromises.unlink(filePath);
  }

  /**
   * Read a file
   *
   * @param {string} filePath - Absolute path to read
   * @returns {Promise<string>}
   */
  async read(filePath) {
    return fsPromises.readFile(filePath, 'utf8');
  }

  /**
   * Write a file
   *
   * @param {string} filePath - Absolute path to write
   * @param {string} content - Content to write
   */
  async write(filePath, content) {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, content);
  }

  /**
   * Check if a directory exists
   */
  async dirExists(dir) {
    try {
      const stat = await fsPromises.stat(dir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Remove empty directories up to a limit
   */
  async removeEmptyDirs(dir, stopAt) {
    while (dir !== stopAt && dir.startsWith(stopAt)) {
      try {
        const entries = await fsPromises.readdir(dir);
        if (entries.length === 0) {
          await fsPromises.rmdir(dir);
          dir = path.dirname(dir);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }
}

export default FileService;
