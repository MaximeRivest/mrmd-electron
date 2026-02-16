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
import { UNORDERED_FILES, ASSETS_DIR_NAME } from '../config.js';

const DOC_EXTENSIONS = ['.md', '.qmd'];

function isDocFilename(filename) {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return DOC_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function semanticLinkName(filePath) {
  if (!filePath) return '';
  return filePath
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '')
    .replace(/^\d+-/, '')
    .toLowerCase();
}

function needsGlobalLinkRefactor(fromPath, toPath) {
  return semanticLinkName(fromPath) !== semanticLinkName(toPath);
}

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
      extensions = DOC_EXTENSIONS,
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
  // Files that should never have order prefixes (using config from ../config.js)

  /**
   * Check if a filename should bypass FSML ordering
   */
  static shouldBypassOrdering(filename) {
    const lower = filename.toLowerCase();
    return UNORDERED_FILES.has(lower) || lower.startsWith('_');
  }

  async createInProject(projectRoot, relativePath, content = '') {
    // Get the directory
    const dir = path.dirname(relativePath);
    const dirPath = dir ? path.join(projectRoot, dir) : projectRoot;

    let finalPath = relativePath;
    const filename = path.basename(relativePath);

    // Skip ordering for special files (README.md/README.qmd, LICENSE, etc.)
    if (FileService.shouldBypassOrdering(filename)) {
      const fullPath = path.join(projectRoot, finalPath);
      await this.createFile(fullPath, content);

      if (this.projectService) {
        this.projectService.invalidate(projectRoot);
      }
      return finalPath;
    }

    // Check if directory exists and has ordered files
    if (await this.dirExists(dirPath)) {
      try {
        const siblings = await fsPromises.readdir(dirPath);
        const docSiblings = siblings.filter(isDocFilename);

        // Find max order among siblings
        let maxOrder = 0;
        let hasOrderedFiles = false;

        for (const sibling of docSiblings) {
          const parsed = FSML.parsePath(sibling);
          if (parsed.order !== null) {
            hasOrderedFiles = true;
            maxOrder = Math.max(maxOrder, parsed.order);
          }
        }

        // If folder has ordered files and new file doesn't have order, add one
        if (hasOrderedFiles) {
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
   * Reorder a file/folder using FSML conventions (for drag-drop)
   *
   * Uses FSML.computeReorder() with sibling information to properly
   * shift all numbered items and maintain FSML ordering.
   *
   * @param {string} projectRoot - Project root path
   * @param {string} sourcePath - Source relative path
   * @param {string} targetPath - Target relative path (drop target)
   * @param {'before' | 'after' | 'inside'} position - Drop position
   * @returns {Promise<RefactorResult>}
   */
  async reorder(projectRoot, sourcePath, targetPath, position) {
    // 1. Scan all files ONCE for both reorder computation and link refactoring
    const allFiles = await this.scan(projectRoot, { includeHidden: true });

    // 2. Use FSML.computeReorder with siblings for proper shift computation
    const { newPath, renames } = FSML.computeReorder(sourcePath, targetPath, position, allFiles);

    console.log(`[FileService.reorder] ${sourcePath} -> ${newPath} (${position})`);
    console.log(`[FileService.reorder] Renames needed:`, renames);

    // 3. If no renames needed, nothing to do
    if (renames.length === 0) {
      console.log(`[FileService.reorder] No changes needed`);
      return { movedFile: sourcePath, updatedFiles: [] };
    }

    const updatedFiles = [];

    // 4. Execute renames in order, passing pre-scanned files to avoid redundant scans
    for (const rename of renames) {
      try {
        const result = await this.move(projectRoot, rename.from, rename.to, { _cachedFiles: allFiles });
        updatedFiles.push(...result.updatedFiles);
      } catch (e) {
        console.error(`[FileService.reorder] Failed to rename ${rename.from} -> ${rename.to}:`, e.message);
        // Continue with other renames - partial success is better than nothing
      }
    }

    // 5. Invalidate project cache once at the end (not per-move)
    if (this.projectService) {
      this.projectService.invalidate(projectRoot);
    }

    return { movedFile: newPath, updatedFiles: [...new Set(updatedFiles)] };
  }

  /**
   * Move/rename a file or folder with automatic refactoring
   *
   * @param {string} projectRoot - Project root path
   * @param {string} fromPath - Source relative path
   * @param {string} toPath - Destination relative path
   * @returns {Promise<RefactorResult>}
   */
  /**
   * Move/rename a file or folder with automatic refactoring
   *
   * @param {string} projectRoot - Project root path
   * @param {string} fromPath - Source relative path
   * @param {string} toPath - Destination relative path
   * @param {object} [options] - Internal options
   * @param {string[]} [options._cachedFiles] - Pre-scanned file list (avoids redundant scans in batch ops)
   * @returns {Promise<RefactorResult>}
   */
  async move(projectRoot, fromPath, toPath, options = {}) {
    const fullFromPath = path.join(projectRoot, fromPath);
    const fullToPath = path.join(projectRoot, toPath);

    // Check if source exists
    let stat;
    try {
      stat = await fsPromises.stat(fullFromPath);
    } catch (e) {
      // Source doesn't exist - might have been renamed already in a batch
      console.log(`[FileService.move] Source doesn't exist (may have been renamed): ${fromPath}`);
      return { movedFile: toPath, updatedFiles: [] };
    }

    // Check if source is a directory
    const isDirectory = stat.isDirectory();

    if (isDirectory) {
      return this.moveDirectory(projectRoot, fromPath, toPath, options);
    }

    const updatedFiles = [];

    const shouldRefactorLinks = needsGlobalLinkRefactor(fromPath, toPath);
    if (shouldRefactorLinks) {
      // Use pre-scanned files if available, otherwise scan
      const files = options._cachedFiles || await this.scan(projectRoot, { includeHidden: true });

      // For each file, check if it references the moved file
      for (const file of files) {
        if (file === fromPath) continue;

        const fullPath = path.join(projectRoot, file);
        let content;
        try {
          content = await fsPromises.readFile(fullPath, 'utf8');
        } catch (e) {
          console.warn(`[file] Could not read ${file} for link refactoring:`, e.message);
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
    }

    // Read the file being moved
    let movingContent;
    try {
      movingContent = await fsPromises.readFile(fullFromPath, 'utf8');
    } catch (e) {
      throw new Error(`Cannot read source file: ${e.message}`);
    }

    // Update asset paths IN the moved file using mrmd-project
    const updatedMovingContent = Assets.refactorPaths(
      movingContent,
      fromPath,
      toPath,
      ASSETS_DIR_NAME
    );

    // Actually move the file
    await fsPromises.mkdir(path.dirname(fullToPath), { recursive: true });
    await fsPromises.writeFile(fullToPath, updatedMovingContent);
    await fsPromises.unlink(fullFromPath);

    // Clean up empty directories
    await this.removeEmptyDirs(path.dirname(fullFromPath), projectRoot);

    // Invalidate project cache (skip if called from batch operation like reorder)
    if (!options._cachedFiles && this.projectService) {
      this.projectService.invalidate(projectRoot);
    }

    return { movedFile: toPath, updatedFiles };
  }

  /**
   * Move/rename a directory with automatic refactoring
   *
   * @param {string} projectRoot - Project root path
   * @param {string} fromPath - Source relative path (folder)
   * @param {string} toPath - Destination relative path (folder)
   * @returns {Promise<RefactorResult>}
   */
  /**
   * Move/rename a directory with automatic refactoring
   *
   * @param {string} projectRoot - Project root path
   * @param {string} fromPath - Source relative path (folder)
   * @param {string} toPath - Destination relative path (folder)
   * @param {object} [options] - Internal options
   * @param {string[]} [options._cachedFiles] - Pre-scanned file list
   * @returns {Promise<RefactorResult>}
   */
  async moveDirectory(projectRoot, fromPath, toPath, options = {}) {
    const fullFromPath = path.join(projectRoot, fromPath);
    const fullToPath = path.join(projectRoot, toPath);
    const updatedFiles = [];

    // Use pre-scanned files if available, otherwise scan
    const allFiles = options._cachedFiles || await this.scan(projectRoot, { includeHidden: true });

    // 2. Build list of files being moved and their new paths
    const movedFiles = [];
    for (const file of allFiles) {
      if (file.startsWith(fromPath + '/') || file === fromPath) {
        const newPath = file.replace(fromPath, toPath);
        movedFiles.push({ from: file, to: newPath });
      }
    }

    const shouldRefactorLinks = movedFiles.some(moved => needsGlobalLinkRefactor(moved.from, moved.to));
    if (shouldRefactorLinks) {
      // 3. Update links in files NOT being moved that reference moved files
      for (const file of allFiles) {
        if (file.startsWith(fromPath + '/')) continue; // Skip files being moved

        const fullPath = path.join(projectRoot, file);
        let content;
        try {
          content = await fsPromises.readFile(fullPath, 'utf8');
        } catch (e) {
          console.warn(`[file] Could not read ${file} for directory refactoring:`, e.message);
          continue;
        }

        // Update all links to moved files
        let updatedContent = content;
        for (const moved of movedFiles) {
          updatedContent = Links.refactor(updatedContent, [
            { from: moved.from, to: moved.to },
          ], file);
        }

        if (updatedContent !== content) {
          await fsPromises.writeFile(fullPath, updatedContent);
          updatedFiles.push(file);
        }
      }
    }

    // 4. Update asset paths in files being moved
    for (const moved of movedFiles) {
      const fullPath = path.join(projectRoot, moved.from);
      let content;
      try {
        content = await fsPromises.readFile(fullPath, 'utf8');
      } catch (e) {
        console.warn(`[file] Could not read ${moved.from} for asset path update:`, e.message);
        continue;
      }

      const updatedContent = Assets.refactorPaths(
        content,
        moved.from,
        moved.to,
        ASSETS_DIR_NAME
      );

      if (updatedContent !== content) {
        await fsPromises.writeFile(fullPath, updatedContent);
      }
    }

    // 5. Actually move the directory
    await fsPromises.mkdir(path.dirname(fullToPath), { recursive: true });
    await fsPromises.rename(fullFromPath, fullToPath);

    // 6. Clean up empty directories
    await this.removeEmptyDirs(path.dirname(fullFromPath), projectRoot);

    // 7. Invalidate project cache (skip if called from batch operation)
    if (!options._cachedFiles && this.projectService) {
      this.projectService.invalidate(projectRoot);
    }

    return { movedFile: toPath, updatedFiles };
  }

  /**
   * Delete a file or directory
   *
   * @param {string} filePath - Absolute path to delete
   */
  async delete(filePath) {
    const stat = await fsPromises.stat(filePath);
    if (stat.isDirectory()) {
      await fsPromises.rm(filePath, { recursive: true });
    } else {
      await fsPromises.unlink(filePath);
    }
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
