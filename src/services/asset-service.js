/**
 * AssetService - Asset management with deduplication
 *
 * Manages assets in the _assets/ directory.
 * Handles saving with hash-based deduplication, orphan detection, etc.
 *
 * Uses mrmd-project for path computation.
 */

import { Assets } from 'mrmd-project';
import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { ASSETS_DIR_NAME, ASSET_MANIFEST_NAME, ASSET_HASH_LENGTH } from '../config.js';

// MIME type mapping
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

class AssetService {
  /**
   * @param {FileService} fileService - Reference to FileService for scanning
   */
  constructor(fileService) {
    this.fileService = fileService;
  }

  /**
   * List all assets in a project
   *
   * @param {string} projectRoot - Project root path
   * @returns {Promise<AssetInfo[]>}
   */
  async list(projectRoot) {
    const assetsDir = path.join(projectRoot, ASSETS_DIR_NAME);

    if (!fs.existsSync(assetsDir)) {
      return [];
    }

    const manifest = await this.loadManifest(projectRoot);
    const assets = [];

    const walk = async (dir) => {
      let entries;
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        // Skip hidden files
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(assetsDir, fullPath);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          const stat = await fsPromises.stat(fullPath);

          // Get hash from manifest or compute it
          let hash = manifest[relativePath]?.hash;
          if (!hash) {
            hash = await this.computeFileHash(fullPath);
          }

          assets.push({
            path: relativePath,
            fullPath,
            hash,
            size: stat.size,
            mimeType: this.getMimeType(entry.name),
            usedIn: manifest[relativePath]?.usedIn || [],
          });
        }
      }
    };

    await walk(assetsDir);
    return assets;
  }

  /**
   * Save an asset (handles deduplication)
   *
   * @param {string} projectRoot - Project root path
   * @param {Buffer} file - File content
   * @param {string} filename - Desired filename
   * @returns {Promise<{ path: string, deduplicated: boolean }>}
   */
  async save(projectRoot, file, filename) {
    const assetsDir = path.join(projectRoot, ASSETS_DIR_NAME);
    const hash = this.computeHashFromBuffer(file);

    // Load manifest to check for duplicates
    const manifest = await this.loadManifest(projectRoot);

    // Check for duplicate by hash
    for (const [assetPath, info] of Object.entries(manifest)) {
      if (info.hash === hash) {
        // Found duplicate
        return { path: assetPath, deduplicated: true };
      }
    }

    // Also check files not in manifest
    const existingAssets = await this.list(projectRoot);
    for (const asset of existingAssets) {
      if (asset.hash === hash) {
        return { path: asset.path, deduplicated: true };
      }
    }

    // Save new file
    const assetPath = await this.uniquePath(assetsDir, filename);
    const fullPath = path.join(assetsDir, assetPath);

    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
    await fsPromises.writeFile(fullPath, file);

    // Update manifest
    manifest[assetPath] = {
      hash,
      addedAt: new Date().toISOString(),
      usedIn: [],
    };
    await this.saveManifest(projectRoot, manifest);

    return { path: assetPath, deduplicated: false };
  }

  /**
   * Get relative path from a document to an asset
   *
   * @param {string} assetPath - Asset path relative to _assets/
   * @param {string} documentPath - Document path relative to project root
   * @returns {string}
   */
  getRelativePath(assetPath, documentPath) {
    // Use mrmd-project for computation
    return Assets.computeRelativePath(documentPath, path.join(ASSETS_DIR_NAME, assetPath));
  }

  /**
   * Find orphaned assets (not referenced by any document)
   *
   * @param {string} projectRoot - Project root path
   * @returns {Promise<string[]>} Orphaned asset paths
   */
  async findOrphans(projectRoot) {
    const assets = await this.list(projectRoot);

    if (assets.length === 0) return [];

    // Get all markdown files
    const files = await this.fileService.scan(projectRoot);

    // Extract all asset references from all documents
    const usedAssets = new Set();

    for (const file of files) {
      try {
        const fullPath = path.join(projectRoot, file);
        const content = await fsPromises.readFile(fullPath, 'utf8');
        const refs = Assets.extractPaths(content);

        for (const ref of refs) {
          // Normalize the path to extract just the asset name
          // Paths might be: _assets/img.png, ../_assets/img.png, etc.
          const normalized = this.normalizeAssetRef(ref.path);
          if (normalized) {
            usedAssets.add(normalized);
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }

    // Find assets not in usedAssets
    return assets
      .filter(a => !usedAssets.has(a.path))
      .map(a => a.path);
  }

  /**
   * Delete an asset
   *
   * @param {string} projectRoot - Project root path
   * @param {string} assetPath - Asset path relative to _assets/
   */
  async delete(projectRoot, assetPath) {
    const fullPath = path.join(projectRoot, ASSETS_DIR_NAME, assetPath);

    await fsPromises.unlink(fullPath);

    // Update manifest
    const manifest = await this.loadManifest(projectRoot);
    delete manifest[assetPath];
    await this.saveManifest(projectRoot, manifest);

    // Clean up empty directories
    await this.removeEmptyDirs(
      path.dirname(fullPath),
      path.join(projectRoot, ASSETS_DIR_NAME)
    );
  }

  /**
   * Compute hash of a file
   */
  async computeFileHash(filePath) {
    const content = await fsPromises.readFile(filePath);
    return this.computeHashFromBuffer(content);
  }

  /**
   * Compute hash from buffer
   */
  computeHashFromBuffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, ASSET_HASH_LENGTH);
  }

  /**
   * Get MIME type from filename
   */
  getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
  }

  /**
   * Generate a unique path for a new asset
   */
  async uniquePath(assetsDir, filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let candidate = filename;
    let counter = 1;

    while (fs.existsSync(path.join(assetsDir, candidate))) {
      candidate = `${base}-${counter}${ext}`;
      counter++;
    }

    return candidate;
  }

  /**
   * Normalize an asset reference path
   */
  normalizeAssetRef(refPath) {
    // Handle: _assets/img.png, ../_assets/img.png, ../../_assets/img.png
    const match = refPath.match(/(?:\.\.\/)*_assets\/(.+)/);
    if (match) {
      return match[1];
    }
    return null;
  }

  /**
   * Load manifest file
   */
  async loadManifest(projectRoot) {
    const manifestPath = path.join(projectRoot, ASSETS_DIR_NAME, ASSET_MANIFEST_NAME);
    try {
      const content = await fsPromises.readFile(manifestPath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      console.warn(`[asset] Could not load manifest: ${e.message}`);
      return {};
    }
  }

  /**
   * Save manifest file
   */
  async saveManifest(projectRoot, manifest) {
    const assetsDir = path.join(projectRoot, ASSETS_DIR_NAME);
    const manifestPath = path.join(assetsDir, ASSET_MANIFEST_NAME);

    await fsPromises.mkdir(assetsDir, { recursive: true });
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }

  /**
   * Remove empty directories
   */
  async removeEmptyDirs(dir, stopAt) {
    while (dir !== stopAt && dir.startsWith(stopAt)) {
      try {
        const entries = await fsPromises.readdir(dir);
        // Don't count manifest file as a real entry
        const realEntries = entries.filter(e => e !== ASSET_MANIFEST_NAME);
        if (realEntries.length === 0) {
          await fsPromises.rmdir(dir);
          dir = path.dirname(dir);
        } else {
          break;
        }
      } catch (e) {
        console.warn(`[asset] Error removing empty directory ${dir}: ${e.message}`);
        break;
      }
    }
  }
}

export default AssetService;
