/**
 * RuntimePreferencesService
 *
 * App-owned runtime preferences (scope/profile/cwd) stored outside markdown docs.
 * Phase 1: local compute target only.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { CONFIG_DIR } from '../config.js';

const PREFS_FILE = path.join(CONFIG_DIR, 'runtime-preferences.json');

const LANGUAGES = ['python', 'r', 'julia', 'bash', 'pty'];

const DEFAULT_PREFS = {
  version: 2,
  identity: {
    currentMachineId: `local:${os.hostname()}`,
  },
  compute: {
    primaryComputeTargetId: `local:${os.hostname()}`,
    defaultPolicies: {
      desktop: 'local-first',
      mobile: 'primary-remote-first',
      tablet: 'primary-remote-first',
    },
    fallbackPolicy: 'ask',
    knownTargets: {
      [`local:${os.hostname()}`]: {
        type: 'local',
        label: 'This Computer',
      },
    },
  },
  defaults: {
    newNotebookPolicy: 'always-notebook',
    scopeByLanguage: {
      python: 'notebook',
      r: 'notebook',
      julia: 'notebook',
      bash: 'notebook',
      pty: 'notebook',
    },
    profileByLanguage: {
      python: 'python:system',
      r: 'r:system',
      julia: 'julia:system',
      bash: 'bash:system',
      pty: 'pty:default',
    },
    cwdModeByLanguage: {
      python: 'project-root',
      r: 'project-root',
      julia: 'project-root',
      bash: 'project-root',
      pty: 'project-root',
    },
    computeByLanguage: {
      python: { mode: 'policy', targetId: null },
      r: { mode: 'policy', targetId: null },
      julia: { mode: 'policy', targetId: null },
      bash: { mode: 'policy', targetId: null },
      pty: { mode: 'policy', targetId: null },
    },
  },
  projects: {},
  profiles: {
    python: {
      'python:system': { kind: 'system', label: 'System Python' },
    },
    r: {
      'r:system': { kind: 'system', label: 'System R' },
    },
    julia: {
      'julia:system': { kind: 'system', label: 'System Julia' },
    },
    bash: {
      'bash:system': { kind: 'system-shell', shell: '/bin/bash', label: 'System Bash' },
    },
    pty: {
      'pty:default': { kind: 'pty-default', label: 'Default Terminal' },
    },
  },
};

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

function normalizeLanguage(language) {
  const l = String(language || '').toLowerCase();
  if (l === 'py' || l === 'python3') return 'python';
  if (l === 'sh' || l === 'shell' || l === 'zsh') return 'bash';
  if (l === 'rlang') return 'r';
  if (l === 'jl') return 'julia';
  if (l === 'term' || l === 'terminal') return 'pty';
  return l;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

class RuntimePreferencesService {
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
      console.error('[runtime-prefs] Failed to load prefs, using defaults:', e.message);
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

    merged.defaults = {
      ...DEFAULT_PREFS.defaults,
      ...(merged.defaults || {}),
      scopeByLanguage: {
        ...DEFAULT_PREFS.defaults.scopeByLanguage,
        ...(merged.defaults?.scopeByLanguage || {}),
      },
      profileByLanguage: {
        ...DEFAULT_PREFS.defaults.profileByLanguage,
        ...(merged.defaults?.profileByLanguage || {}),
      },
      cwdModeByLanguage: {
        ...DEFAULT_PREFS.defaults.cwdModeByLanguage,
        ...(merged.defaults?.cwdModeByLanguage || {}),
      },
      computeByLanguage: {
        ...DEFAULT_PREFS.defaults.computeByLanguage,
        ...(merged.defaults?.computeByLanguage || {}),
      },
    };

    merged.projects = merged.projects || {};
    merged.profiles = merged.profiles || deepClone(DEFAULT_PREFS.profiles);
    merged.compute = {
      ...DEFAULT_PREFS.compute,
      ...(merged.compute || {}),
      defaultPolicies: {
        ...DEFAULT_PREFS.compute.defaultPolicies,
        ...(merged.compute?.defaultPolicies || {}),
      },
      knownTargets: {
        ...DEFAULT_PREFS.compute.knownTargets,
        ...(merged.compute?.knownTargets || {}),
      },
    };

    return merged;
  }

  _save() {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(PREFS_FILE, JSON.stringify(this._prefs, null, 2));
      return true;
    } catch (e) {
      console.error('[runtime-prefs] Failed to save prefs:', e.message);
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
      notebookKey: `${projectId}:${docRelPath}`,
    };
  }

  _ensureProjectNode(projectId, projectRoot) {
    const prefs = this._ensureLoaded();
    if (!prefs.projects[projectId]) {
      prefs.projects[projectId] = {
        root: projectRoot,
        updatedAt: new Date().toISOString(),
        overrides: {
          scopeByLanguage: {},
          profileByLanguage: {},
          cwdModeByLanguage: {},
          cwdByLanguage: {},
          computeByLanguage: {},
        },
        notebooks: {},
      };
    }
    return prefs.projects[projectId];
  }

  _ensureNotebookNode(projectNode, docRelPath) {
    if (!projectNode.notebooks[docRelPath]) {
      projectNode.notebooks[docRelPath] = {
        updatedAt: new Date().toISOString(),
        scopeByLanguage: {},
        profileByLanguage: {},
        cwdModeByLanguage: {},
        cwdByLanguage: {},
        computeByLanguage: {},
        attachmentByLanguage: {},
      };
    }
    return projectNode.notebooks[docRelPath];
  }

  _pick(preferred, fallback) {
    return preferred !== undefined && preferred !== null && preferred !== '' ? preferred : fallback;
  }

  _resolveProfile(language, profileId, projectRoot) {
    const prefs = this._ensureLoaded();
    const lang = normalizeLanguage(language);
    const byLang = prefs.profiles?.[lang] || {};

    let resolvedId = profileId;
    if (!resolvedId && lang === 'python') {
      resolvedId = `python:venv:${normalizePath(path.join(projectRoot, '.venv'))}`;
    } else if (!resolvedId) {
      resolvedId = prefs.defaults.profileByLanguage?.[lang] || DEFAULT_PREFS.defaults.profileByLanguage[lang];
    }

    let profile = byLang[resolvedId] || null;

    if (!profile && lang === 'python' && resolvedId.startsWith('python:venv:')) {
      profile = {
        kind: 'venv',
        venvPath: resolvedId.slice('python:venv:'.length),
        label: path.basename(resolvedId.slice('python:venv:'.length)) || '.venv',
      };
      prefs.profiles.python = prefs.profiles.python || {};
      prefs.profiles.python[resolvedId] = profile;
      this._save();
    }

    return { profileId: resolvedId, profile };
  }

  _computeCwd({ cwdMode, customCwd, projectRoot, documentPath }) {
    if (cwdMode === 'notebook-dir') return path.dirname(documentPath);
    if (cwdMode === 'custom' && customCwd) return normalizePath(customCwd);
    return projectRoot;
  }

  _sessionName({ scope, language, profileId, projectId, docRelPath }) {
    const profileHash = sha(profileId || 'default', 8);
    const docHash = sha(docRelPath || 'doc', 10);

    if (scope === 'global') return `rt:global:${language}:${profileHash}`;
    if (scope === 'project') return `rt:project:${projectId}:${language}:${profileHash}`;
    return `rt:notebook:${projectId}:${docHash}:${language}:${profileHash}`;
  }

  async getAll({ documentPath, projectRoot } = {}) {
    const prefs = this._ensureLoaded();
    const all = deepClone(prefs);

    if (!documentPath) return all;

    const context = await this.getContext(documentPath, projectRoot);
    const projectNode = prefs.projects?.[context.projectId] || null;
    const notebookNode = projectNode?.notebooks?.[context.docRelPath] || null;

    return {
      ...all,
      context,
      project: projectNode,
      notebook: notebookNode,
    };
  }

  async getEffectiveForDocument({ documentPath, language, deviceKind = 'desktop', projectRoot = null }) {
    const lang = normalizeLanguage(language);
    const context = await this.getContext(documentPath, projectRoot);
    const prefs = this._ensureLoaded();

    const projectNode = this._ensureProjectNode(context.projectId, context.projectRoot);
    const notebookNode = this._ensureNotebookNode(projectNode, context.docRelPath);

    const nbScope = notebookNode.scopeByLanguage?.[lang];
    const pjScope = projectNode.overrides?.scopeByLanguage?.[lang];
    const defScope = prefs.defaults.scopeByLanguage?.[lang] || 'notebook';
    const scope = this._pick(nbScope, this._pick(pjScope, defScope));

    const nbProfile = notebookNode.profileByLanguage?.[lang];
    const pjProfile = projectNode.overrides?.profileByLanguage?.[lang];
    const defProfile = prefs.defaults.profileByLanguage?.[lang];
    const profileSeed = this._pick(nbProfile, this._pick(pjProfile, defProfile));
    const { profileId, profile } = this._resolveProfile(lang, profileSeed, context.projectRoot);

    const nbCwdMode = notebookNode.cwdModeByLanguage?.[lang];
    const pjCwdMode = projectNode.overrides?.cwdModeByLanguage?.[lang];
    const defCwdMode = prefs.defaults.cwdModeByLanguage?.[lang] || 'project-root';
    const cwdMode = this._pick(nbCwdMode, this._pick(pjCwdMode, defCwdMode));

    const nbCwd = notebookNode.cwdByLanguage?.[lang];
    const pjCwd = projectNode.overrides?.cwdByLanguage?.[lang];
    const customCwd = this._pick(nbCwd, pjCwd);

    const nbCompute = notebookNode.computeByLanguage?.[lang];
    const pjCompute = projectNode.overrides?.computeByLanguage?.[lang];
    const defCompute = prefs.defaults.computeByLanguage?.[lang] || { mode: 'policy' };
    const computePref = nbCompute || pjCompute || defCompute;

    let targetId = null;
    const localTarget = prefs.identity?.currentMachineId || `local:${os.hostname()}`;

    if (computePref.mode === 'target' && computePref.targetId) {
      targetId = computePref.targetId;
    } else {
      // Resolve by policy
      const devicePolicy = prefs.compute?.defaultPolicies?.[deviceKind] || 'local-first';
      const primaryTarget = prefs.compute?.primaryComputeTargetId || localTarget;

      if (devicePolicy === 'primary-remote-first') {
        // In real impl, check if primaryTarget is online via tunnel. For now, try it.
        targetId = primaryTarget;
      } else {
        // local-first
        targetId = localTarget;
      }
    }

    const cwd = this._computeCwd({
      cwdMode,
      customCwd,
      projectRoot: context.projectRoot,
      documentPath: context.documentPath,
    });

    const sessionName = this._sessionName({
      scope,
      language: lang,
      profileId,
      projectId: context.projectId,
      docRelPath: context.docRelPath,
    });

    const out = {
      language: lang,
      targetId,
      scope,
      profileId,
      profile: profile || null,
      cwdMode,
      cwd,
      projectRoot: context.projectRoot,
      projectId: context.projectId,
      docRelPath: context.docRelPath,
      documentPath: context.documentPath,
      sessionName,
      deviceKind,
    };

    if (lang === 'python') {
      if (profile?.kind === 'venv' && profile?.venvPath) {
        out.venv = normalizePath(profile.venvPath);
      } else {
        out.venv = normalizePath(path.join(context.projectRoot, '.venv'));
      }
    }

    return out;
  }

  toRuntimeStartConfig(effective) {
    const cfg = {
      name: effective.sessionName,
      language: effective.language,
      cwd: effective.cwd,
    };
    if (effective.language === 'python') {
      cfg.venv = effective.venv;
    }
    return cfg;
  }

  async setNotebookOverride({ documentPath, language, patch = {}, projectRoot = null }) {
    const lang = normalizeLanguage(language);
    const context = await this.getContext(documentPath, projectRoot);
    const prefs = this._ensureLoaded();

    const projectNode = this._ensureProjectNode(context.projectId, context.projectRoot);
    const notebookNode = this._ensureNotebookNode(projectNode, context.docRelPath);

    if (patch.scope) notebookNode.scopeByLanguage[lang] = patch.scope;
    if (patch.cwdMode) notebookNode.cwdModeByLanguage[lang] = patch.cwdMode;
    if (patch.cwd !== undefined) notebookNode.cwdByLanguage[lang] = patch.cwd;

    if (patch.compute) {
      notebookNode.computeByLanguage[lang] = patch.compute;
    }

    if (patch.profileId) {
      notebookNode.profileByLanguage[lang] = patch.profileId;
    }

    if (patch.venv && lang === 'python') {
      const venvPath = normalizePath(path.isAbsolute(patch.venv)
        ? patch.venv
        : path.join(context.projectRoot, patch.venv));
      const profileId = `python:venv:${venvPath}`;
      prefs.profiles.python = prefs.profiles.python || {};
      prefs.profiles.python[profileId] = {
        kind: 'venv',
        venvPath,
        label: path.basename(venvPath) || '.venv',
      };
      notebookNode.profileByLanguage[lang] = profileId;
    }

    projectNode.updatedAt = new Date().toISOString();
    notebookNode.updatedAt = new Date().toISOString();
    this._save();

    return this.getEffectiveForDocument({ documentPath, language: lang, projectRoot: context.projectRoot });
  }

  async setProjectOverride({ projectRoot, language, patch = {} }) {
    const lang = normalizeLanguage(language);
    const root = normalizePath(projectRoot);
    const projectId = sha(root, 16);
    const prefs = this._ensureLoaded();
    const projectNode = this._ensureProjectNode(projectId, root);

    if (patch.scope) projectNode.overrides.scopeByLanguage[lang] = patch.scope;
    if (patch.profileId) projectNode.overrides.profileByLanguage[lang] = patch.profileId;
    if (patch.cwdMode) projectNode.overrides.cwdModeByLanguage[lang] = patch.cwdMode;
    if (patch.cwd !== undefined) projectNode.overrides.cwdByLanguage[lang] = patch.cwd;

    if (patch.compute) {
      projectNode.overrides.computeByLanguage[lang] = patch.compute;
    }

    if (patch.venv && lang === 'python') {
      const venvPath = normalizePath(path.isAbsolute(patch.venv)
        ? patch.venv
        : path.join(root, patch.venv));
      const profileId = `python:venv:${venvPath}`;
      prefs.profiles.python = prefs.profiles.python || {};
      prefs.profiles.python[profileId] = {
        kind: 'venv',
        venvPath,
        label: path.basename(venvPath) || '.venv',
      };
      projectNode.overrides.profileByLanguage[lang] = profileId;
    }

    projectNode.updatedAt = new Date().toISOString();
    this._save();
    return deepClone(projectNode.overrides);
  }

  setDefault({ language, patch = {} }) {
    const lang = normalizeLanguage(language);
    const prefs = this._ensureLoaded();

    if (patch.scope) prefs.defaults.scopeByLanguage[lang] = patch.scope;
    if (patch.profileId) prefs.defaults.profileByLanguage[lang] = patch.profileId;
    if (patch.cwdMode) prefs.defaults.cwdModeByLanguage[lang] = patch.cwdMode;

    if (patch.venv && lang === 'python') {
      const venvPath = normalizePath(patch.venv);
      const profileId = `python:venv:${venvPath}`;
      prefs.profiles.python = prefs.profiles.python || {};
      prefs.profiles.python[profileId] = {
        kind: 'venv',
        venvPath,
        label: path.basename(venvPath) || '.venv',
      };
      prefs.defaults.profileByLanguage[lang] = profileId;
    }

    this._save();
    return {
      scope: prefs.defaults.scopeByLanguage[lang],
      profileId: prefs.defaults.profileByLanguage[lang],
      cwdMode: prefs.defaults.cwdModeByLanguage[lang],
    };
  }

  async clearNotebookOverride({ documentPath, language, projectRoot = null }) {
    const lang = normalizeLanguage(language);
    const context = await this.getContext(documentPath, projectRoot);
    const prefs = this._ensureLoaded();

    const projectNode = this._ensureProjectNode(context.projectId, context.projectRoot);
    const notebookNode = this._ensureNotebookNode(projectNode, context.docRelPath);

    delete notebookNode.scopeByLanguage[lang];
    delete notebookNode.profileByLanguage[lang];
    delete notebookNode.cwdModeByLanguage[lang];
    delete notebookNode.cwdByLanguage[lang];

    notebookNode.updatedAt = new Date().toISOString();
    this._save();

    return this.getEffectiveForDocument({ documentPath, language: lang, projectRoot: context.projectRoot });
  }

  listProfiles(language) {
    const lang = normalizeLanguage(language);
    const prefs = this._ensureLoaded();
    const byLang = prefs.profiles?.[lang] || {};
    return Object.entries(byLang).map(([id, profile]) => ({ id, ...profile }));
  }

  upsertProfile(language, id, profile) {
    const lang = normalizeLanguage(language);
    const prefs = this._ensureLoaded();
    prefs.profiles[lang] = prefs.profiles[lang] || {};
    prefs.profiles[lang][id] = { ...(prefs.profiles[lang][id] || {}), ...(profile || {}) };
    this._save();
    return { id, ...prefs.profiles[lang][id] };
  }

  supportedLanguages() {
    return [...LANGUAGES];
  }
}

export default RuntimePreferencesService;
export { PREFS_FILE, DEFAULT_PREFS };