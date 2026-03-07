/**
 * LanguageToolPreferencesService
 *
 * Stores grammar-checking preferences outside markdown documents.
 *
 * Includes:
 * - global defaults
 * - global custom dictionary words
 * - per-document overrides
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG_DIR } from '../config.js';

const PREFS_FILE = path.join(CONFIG_DIR, 'languagetool-preferences.json');

const DEFAULT_PREFS = {
  version: 1,
  defaults: {
    enabled: true,
    language: null,
    motherTongue: null,
    preferredVariants: [],
    mode: 'default',
    enabledRules: [],
    disabledRules: [],
    enabledCategories: [],
    disabledCategories: [],
  },
  dictionary: {
    words: [],
  },
  projects: {},
};

function sha(input, len = 16) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex').slice(0, len);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizePathMaybe(value) {
  if (!value) return value;
  try {
    return path.resolve(String(value));
  } catch {
    return String(value);
  }
}

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const normalized = String(item || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizeDocumentPatch(patch = {}) {
  const out = {};

  if (patch.enabled !== undefined) out.enabled = Boolean(patch.enabled);
  if (patch.language !== undefined) out.language = patch.language ? String(patch.language).trim() : null;
  if (patch.motherTongue !== undefined) out.motherTongue = patch.motherTongue ? String(patch.motherTongue).trim() : null;
  if (patch.mode !== undefined) out.mode = patch.mode ? String(patch.mode).trim() : 'default';

  const listFields = [
    'preferredVariants',
    'enabledRules',
    'disabledRules',
    'enabledCategories',
    'disabledCategories',
  ];

  for (const field of listFields) {
    if (patch[field] !== undefined) {
      out[field] = normalizeStringList(patch[field]);
    }
  }

  return out;
}

export default class LanguageToolPreferencesService {
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
    } catch (error) {
      console.error('[languagetool-prefs] Failed to load prefs, using defaults:', error.message);
      this._prefs = deepClone(DEFAULT_PREFS);
    }

    return this._prefs;
  }

  _mergeDefaults(raw) {
    const merged = deepClone(DEFAULT_PREFS);
    if (!raw || typeof raw !== 'object') return merged;

    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) continue;
      if (typeof merged[key] === 'object' && merged[key] && !Array.isArray(merged[key]) && typeof value === 'object' && value) {
        merged[key] = { ...merged[key], ...value };
      } else {
        merged[key] = value;
      }
    }

    merged.defaults = {
      ...DEFAULT_PREFS.defaults,
      ...(merged.defaults || {}),
      preferredVariants: normalizeStringList(merged.defaults?.preferredVariants || []),
      enabledRules: normalizeStringList(merged.defaults?.enabledRules || []),
      disabledRules: normalizeStringList(merged.defaults?.disabledRules || []),
      enabledCategories: normalizeStringList(merged.defaults?.enabledCategories || []),
      disabledCategories: normalizeStringList(merged.defaults?.disabledCategories || []),
    };

    merged.dictionary = {
      words: normalizeStringList(merged.dictionary?.words || []),
    };

    merged.projects = merged.projects || {};
    return merged;
  }

  _save() {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(PREFS_FILE, JSON.stringify(this._prefs, null, 2));
      return true;
    } catch (error) {
      console.error('[languagetool-prefs] Failed to save prefs:', error.message);
      return false;
    }
  }

  _findGitRoot(startDir) {
    let current = normalizePathMaybe(startDir);
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
    if (explicitProjectRoot) return normalizePathMaybe(explicitProjectRoot);

    if (this.projectService?.getProject) {
      try {
        const project = await this.projectService.getProject(documentPath);
        if (project?.root) return normalizePathMaybe(project.root);
      } catch {
        // ignore
      }
    }

    const docDir = path.dirname(normalizePathMaybe(documentPath));
    const gitRoot = this._findGitRoot(docDir);
    if (gitRoot) return gitRoot;
    return docDir;
  }

  async getContext(documentPath, explicitProjectRoot = null) {
    const docPath = normalizePathMaybe(documentPath);
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
        overrides: {},
      };
    }
    return projectNode.documents[docRelPath];
  }

  async getForDocument({ documentPath, projectRoot = null } = {}) {
    if (!documentPath) {
      const prefs = this._ensureLoaded();
      return {
        context: null,
        defaults: deepClone(prefs.defaults),
        overrides: {},
        effective: deepClone(prefs.defaults),
        dictionary: deepClone(prefs.dictionary.words || []),
      };
    }

    const prefs = this._ensureLoaded();
    const context = await this.getContext(documentPath, projectRoot);
    const projectNode = prefs.projects?.[context.projectId] || null;
    const documentNode = projectNode?.documents?.[context.docRelPath] || null;
    const overrides = normalizeDocumentPatch(documentNode?.overrides || {});
    const effective = {
      ...prefs.defaults,
      ...overrides,
      preferredVariants: overrides.preferredVariants ?? prefs.defaults.preferredVariants,
      enabledRules: overrides.enabledRules ?? prefs.defaults.enabledRules,
      disabledRules: overrides.disabledRules ?? prefs.defaults.disabledRules,
      enabledCategories: overrides.enabledCategories ?? prefs.defaults.enabledCategories,
      disabledCategories: overrides.disabledCategories ?? prefs.defaults.disabledCategories,
    };

    return {
      context,
      defaults: deepClone(prefs.defaults),
      overrides,
      effective,
      dictionary: deepClone(prefs.dictionary.words || []),
      document: documentNode,
    };
  }

  async setForDocument({ documentPath, patch = {}, projectRoot = null } = {}) {
    if (!documentPath) throw new Error('documentPath is required');

    const normalizedPatch = normalizeDocumentPatch(patch);
    const context = await this.getContext(documentPath, projectRoot);
    const projectNode = this._ensureProjectNode(context.projectId, context.projectRoot);
    const documentNode = this._ensureDocumentNode(projectNode, context.docRelPath);

    documentNode.overrides = {
      ...(documentNode.overrides || {}),
      ...normalizedPatch,
    };
    documentNode.updatedAt = new Date().toISOString();
    projectNode.updatedAt = new Date().toISOString();
    this._save();

    return this.getForDocument({ documentPath, projectRoot: context.projectRoot });
  }

  async clearDocumentOverrides({ documentPath, projectRoot = null } = {}) {
    if (!documentPath) throw new Error('documentPath is required');

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

  getDefaults() {
    const prefs = this._ensureLoaded();
    return deepClone(prefs.defaults);
  }

  setDefaults(patch = {}) {
    const prefs = this._ensureLoaded();
    prefs.defaults = {
      ...prefs.defaults,
      ...normalizeDocumentPatch(patch),
    };
    this._save();
    return deepClone(prefs.defaults);
  }

  getDictionary() {
    const prefs = this._ensureLoaded();
    return deepClone(prefs.dictionary.words || []);
  }

  addToDictionary(word) {
    const normalized = String(word || '').trim();
    if (!normalized) throw new Error('word is required');

    const prefs = this._ensureLoaded();
    prefs.dictionary.words = normalizeStringList([...(prefs.dictionary.words || []), normalized]);
    this._save();
    return this.getDictionary();
  }

  removeFromDictionary(word) {
    const normalized = String(word || '').trim().toLowerCase();
    const prefs = this._ensureLoaded();
    prefs.dictionary.words = (prefs.dictionary.words || []).filter((entry) => entry.toLowerCase() !== normalized);
    this._save();
    return this.getDictionary();
  }
}
