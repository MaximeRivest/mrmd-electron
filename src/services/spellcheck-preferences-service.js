/**
 * SpellcheckPreferencesService
 *
 * Stores per-document spellcheck language preferences outside the markdown
 * document itself. This keeps language selection app-owned (like runtime prefs)
 * instead of frontmatter-owned.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG_DIR } from '../config.js';

const PREFS_FILE = path.join(CONFIG_DIR, 'spellcheck-preferences.json');

const DEFAULT_PREFS = {
  version: 1,
  projects: {},
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function sha(input, len = 16) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex').slice(0, len);
}

function normalizePath(p) {
  if (!p) return p;
  try {
    return path.resolve(String(p));
  } catch {
    return String(p);
  }
}

function normalizeLanguages(languages) {
  const list = Array.isArray(languages) ? languages : [languages];
  const out = [];
  const seen = new Set();

  for (const entry of list) {
    const value = String(entry || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

class SpellcheckPreferencesService {
  constructor({ projectService } = {}) {
    this.projectService = projectService || null;
    this._prefs = null;
  }

  _ensureLoaded() {
    if (this._prefs) return this._prefs;

    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      if (fs.existsSync(PREFS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
        this._prefs = this._mergeDefaults(raw);
      } else {
        this._prefs = deepClone(DEFAULT_PREFS);
        this._save();
      }
    } catch (e) {
      console.error('[spellcheck-prefs] Failed to load prefs, using defaults:', e.message);
      this._prefs = deepClone(DEFAULT_PREFS);
    }

    return this._prefs;
  }

  _mergeDefaults(raw) {
    const merged = deepClone(DEFAULT_PREFS);
    if (!raw || typeof raw !== 'object') return merged;

    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined) continue;
      if (typeof merged[k] === 'object' && merged[k] && !Array.isArray(merged[k]) && typeof v === 'object' && v) {
        merged[k] = { ...merged[k], ...v };
      } else {
        merged[k] = v;
      }
    }

    merged.projects = merged.projects || {};
    return merged;
  }

  _save() {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(PREFS_FILE, JSON.stringify(this._prefs, null, 2));
      return true;
    } catch (e) {
      console.error('[spellcheck-prefs] Failed to save prefs:', e.message);
      return false;
    }
  }

  _findGitRoot(startDir) {
    let current = normalizePath(startDir);
    if (!current) return null;

    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) return current;
      const parent = path.dirname(current);
      if (!parent || parent === current) break;
      current = parent;
    }
    return null;
  }

  async _resolveProjectRoot(documentPath, explicitProjectRoot = null) {
    if (explicitProjectRoot) return normalizePath(explicitProjectRoot);

    if (this.projectService?.getProject) {
      try {
        const project = await this.projectService.getProject(documentPath);
        if (project?.root) return normalizePath(project.root);
      } catch {
        // ignore
      }
    }

    const docDir = path.dirname(normalizePath(documentPath));
    const gitRoot = this._findGitRoot(docDir);
    if (gitRoot) return gitRoot;

    return docDir;
  }

  async getContext(documentPath, explicitProjectRoot = null) {
    const docPath = normalizePath(documentPath);
    const projectRoot = await this._resolveProjectRoot(docPath, explicitProjectRoot);
    const projectId = sha(projectRoot, 16);
    const rel = path.relative(projectRoot, docPath).replace(/\\/g, '/');
    const docRelPath = rel.startsWith('../') ? path.basename(docPath) : rel;

    return {
      documentPath: docPath,
      projectRoot,
      projectId,
      docRelPath,
      documentKey: `${projectId}:${docRelPath}`,
    };
  }

  _ensureProjectNode(projectId, projectRoot) {
    const prefs = this._ensureLoaded();
    if (!prefs.projects[projectId]) {
      prefs.projects[projectId] = {
        root: projectRoot,
        updatedAt: new Date().toISOString(),
        documents: {},
      };
    }
    return prefs.projects[projectId];
  }

  _ensureDocumentNode(projectNode, docRelPath) {
    if (!projectNode.documents[docRelPath]) {
      projectNode.documents[docRelPath] = {
        updatedAt: new Date().toISOString(),
        languages: [],
      };
    }
    return projectNode.documents[docRelPath];
  }

  async getForDocument({ documentPath, projectRoot = null }) {
    const prefs = this._ensureLoaded();
    const context = await this.getContext(documentPath, projectRoot);
    const projectNode = prefs.projects?.[context.projectId] || null;
    const documentNode = projectNode?.documents?.[context.docRelPath] || null;
    const languages = normalizeLanguages(documentNode?.languages || []);

    return {
      context,
      document: documentNode,
      languages,
      hasOverride: languages.length > 0,
    };
  }

  async setForDocument({ documentPath, languages = [], projectRoot = null }) {
    const normalized = normalizeLanguages(languages);
    const context = await this.getContext(documentPath, projectRoot);
    const projectNode = this._ensureProjectNode(context.projectId, context.projectRoot);
    const documentNode = this._ensureDocumentNode(projectNode, context.docRelPath);

    documentNode.languages = normalized;
    documentNode.updatedAt = new Date().toISOString();
    projectNode.updatedAt = new Date().toISOString();
    this._save();

    return this.getForDocument({ documentPath, projectRoot: context.projectRoot });
  }

  async clearForDocument({ documentPath, projectRoot = null }) {
    const context = await this.getContext(documentPath, projectRoot);
    const prefs = this._ensureLoaded();
    const projectNode = prefs.projects?.[context.projectId];

    if (projectNode?.documents?.[context.docRelPath]) {
      delete projectNode.documents[context.docRelPath];
      projectNode.updatedAt = new Date().toISOString();
      this._save();
    }

    return this.getForDocument({ documentPath, projectRoot: context.projectRoot });
  }
}

export default SpellcheckPreferencesService;
