/**
 * SettingsService - User preferences and configuration management
 *
 * Manages persistent user settings stored in ~/.config/mrmd/settings.json.
 * Includes API keys, quality level model mappings, and custom AI commands.
 *
 * Settings are loaded on startup and cached in memory for fast access.
 * Changes are written to disk immediately for persistence.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '../config.js';

/**
 * Default settings schema
 */
const DEFAULT_SETTINGS = {
  version: 1,

  // API keys for various providers
  apiKeys: {
    anthropic: '',
    openai: '',
    groq: '',
    gemini: '',
    openrouter: '',
  },

  // Quality level to model mappings (1-5)
  qualityLevels: {
    1: {
      model: 'groq/moonshotai/kimi-k2-instruct-0905',
      reasoningDefault: 0,
      name: 'Quick',
    },
    2: {
      model: 'anthropic/claude-sonnet-4-5',
      reasoningDefault: 1,
      name: 'Balanced',
    },
    3: {
      model: 'gemini/gemini-3-pro-preview',
      reasoningDefault: 2,
      name: 'Deep',
    },
    4: {
      model: 'anthropic/claude-opus-4-5',
      reasoningDefault: 3,
      name: 'Maximum',
    },
    5: {
      type: 'multi',
      models: [
        'openrouter/x-ai/grok-4',
        'openai/gpt-5.2',
        'gemini/gemini-3-pro-preview',
        'anthropic/claude-opus-4-5',
      ],
      synthesizer: 'gemini/gemini-3-pro-preview',
      name: 'Ultimate',
    },
  },

  // Custom AI command sections
  customSections: [],

  // Default preferences
  defaults: {
    juiceLevel: 2,
    reasoningLevel: 1,
  },
};

/**
 * Available API providers with metadata
 */
const API_PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    keyPrefix: 'sk-ant-',
    envVar: 'ANTHROPIC_API_KEY',
    testEndpoint: 'https://api.anthropic.com/v1/messages',
  },
  openai: {
    name: 'OpenAI',
    keyPrefix: 'sk-',
    envVar: 'OPENAI_API_KEY',
    testEndpoint: 'https://api.openai.com/v1/models',
  },
  groq: {
    name: 'Groq',
    keyPrefix: 'gsk_',
    envVar: 'GROQ_API_KEY',
    testEndpoint: 'https://api.groq.com/openai/v1/models',
  },
  gemini: {
    name: 'Google Gemini',
    keyPrefix: '',
    envVar: 'GEMINI_API_KEY',
    testEndpoint: 'https://generativelanguage.googleapis.com/v1/models',
  },
  openrouter: {
    name: 'OpenRouter',
    keyPrefix: 'sk-or-',
    envVar: 'OPENROUTER_API_KEY',
    testEndpoint: 'https://openrouter.ai/api/v1/models',
  },
};

/**
 * Settings file path
 */
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

class SettingsService {
  constructor() {
    this.settings = null;
    this.loaded = false;
  }

  /**
   * Ensure config directory exists
   */
  ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  /**
   * Load settings from disk
   * Creates default settings file if it doesn't exist
   *
   * @returns {object} Settings object
   */
  load() {
    if (this.loaded && this.settings) {
      return this.settings;
    }

    this.ensureConfigDir();

    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const content = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const loaded = JSON.parse(content);

        // Merge with defaults to handle schema upgrades
        this.settings = this.mergeWithDefaults(loaded);

        // If merge added new fields, save back
        if (JSON.stringify(loaded) !== JSON.stringify(this.settings)) {
          this.save();
        }
      } else {
        // Create default settings file
        this.settings = { ...DEFAULT_SETTINGS };
        this.save();
      }
    } catch (e) {
      console.error('[settings] Error loading settings:', e.message);
      // Fall back to defaults on error
      this.settings = { ...DEFAULT_SETTINGS };
    }

    this.loaded = true;
    return this.settings;
  }

  /**
   * Merge loaded settings with defaults (for schema upgrades)
   *
   * @param {object} loaded - Loaded settings from disk
   * @returns {object} Merged settings
   */
  mergeWithDefaults(loaded) {
    const merged = { ...DEFAULT_SETTINGS };

    // Deep merge top-level objects
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (loaded[key] !== undefined) {
        if (typeof DEFAULT_SETTINGS[key] === 'object' && !Array.isArray(DEFAULT_SETTINGS[key])) {
          // Deep merge objects
          merged[key] = { ...DEFAULT_SETTINGS[key], ...loaded[key] };
        } else {
          // Replace arrays and primitives
          merged[key] = loaded[key];
        }
      }
    }

    // Preserve version from loaded if higher
    if (loaded.version && loaded.version > merged.version) {
      merged.version = loaded.version;
    }

    return merged;
  }

  /**
   * Save settings to disk
   *
   * @returns {boolean} Success
   */
  save() {
    this.ensureConfigDir();

    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
      return true;
    } catch (e) {
      console.error('[settings] Error saving settings:', e.message);
      return false;
    }
  }

  /**
   * Get all settings
   *
   * @returns {object} Complete settings object
   */
  getAll() {
    return this.load();
  }

  /**
   * Get a specific setting by path (dot notation)
   *
   * @param {string} keyPath - Setting path (e.g., "apiKeys.anthropic")
   * @param {any} defaultValue - Default if not found
   * @returns {any} Setting value
   */
  get(keyPath, defaultValue = undefined) {
    const settings = this.load();
    const parts = keyPath.split('.');
    let value = settings;

    for (const part of parts) {
      if (value === undefined || value === null) {
        return defaultValue;
      }
      value = value[part];
    }

    return value !== undefined ? value : defaultValue;
  }

  /**
   * Set a specific setting by path (dot notation)
   *
   * @param {string} keyPath - Setting path (e.g., "apiKeys.anthropic")
   * @param {any} value - Value to set
   * @returns {boolean} Success
   */
  set(keyPath, value) {
    this.load(); // Ensure loaded

    const parts = keyPath.split('.');
    let obj = this.settings;

    // Navigate to parent
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (obj[part] === undefined) {
        obj[part] = {};
      }
      obj = obj[part];
    }

    // Set value
    obj[parts[parts.length - 1]] = value;

    return this.save();
  }

  /**
   * Update multiple settings at once
   *
   * @param {object} updates - Object with key paths and values
   * @returns {boolean} Success
   */
  update(updates) {
    this.load(); // Ensure loaded

    for (const [keyPath, value] of Object.entries(updates)) {
      const parts = keyPath.split('.');
      let obj = this.settings;

      // Navigate to parent
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (obj[part] === undefined) {
          obj[part] = {};
        }
        obj = obj[part];
      }

      // Set value
      obj[parts[parts.length - 1]] = value;
    }

    return this.save();
  }

  /**
   * Reset settings to defaults
   *
   * @returns {boolean} Success
   */
  reset() {
    this.settings = { ...DEFAULT_SETTINGS };
    return this.save();
  }

  // ==========================================================================
  // API KEYS
  // ==========================================================================

  /**
   * Get all API keys (masked for display)
   *
   * @param {boolean} masked - Whether to mask keys for display
   * @returns {object} API keys by provider
   */
  getApiKeys(masked = true) {
    const keys = this.get('apiKeys', {});

    if (!masked) {
      return keys;
    }

    // Mask keys for display (show first 8 and last 4 chars)
    const maskedKeys = {};
    for (const [provider, key] of Object.entries(keys)) {
      if (key && key.length > 12) {
        maskedKeys[provider] = `${key.slice(0, 8)}${'•'.repeat(key.length - 12)}${key.slice(-4)}`;
      } else if (key) {
        maskedKeys[provider] = '•'.repeat(key.length);
      } else {
        maskedKeys[provider] = '';
      }
    }

    return maskedKeys;
  }

  /**
   * Set an API key for a provider
   *
   * @param {string} provider - Provider name (anthropic, openai, etc.)
   * @param {string} key - API key
   * @returns {boolean} Success
   */
  setApiKey(provider, key) {
    return this.set(`apiKeys.${provider}`, key);
  }

  /**
   * Get a single API key (unmasked)
   *
   * @param {string} provider - Provider name
   * @returns {string} API key or empty string
   */
  getApiKey(provider) {
    return this.get(`apiKeys.${provider}`, '');
  }

  /**
   * Get API provider metadata
   *
   * @returns {object} Provider metadata
   */
  getApiProviders() {
    return API_PROVIDERS;
  }

  /**
   * Check if a provider has a key configured
   *
   * @param {string} provider - Provider name
   * @returns {boolean} Has key
   */
  hasApiKey(provider) {
    const key = this.getApiKey(provider);
    return key && key.length > 0;
  }

  // ==========================================================================
  // QUALITY LEVELS
  // ==========================================================================

  /**
   * Get all quality level configurations
   *
   * @returns {object} Quality levels config
   */
  getQualityLevels() {
    return this.get('qualityLevels', DEFAULT_SETTINGS.qualityLevels);
  }

  /**
   * Get a specific quality level configuration
   *
   * @param {number} level - Quality level (1-5)
   * @returns {object} Level config
   */
  getQualityLevel(level) {
    return this.get(`qualityLevels.${level}`, DEFAULT_SETTINGS.qualityLevels[level]);
  }

  /**
   * Set a quality level configuration
   *
   * @param {number} level - Quality level (1-5)
   * @param {object} config - Level configuration
   * @returns {boolean} Success
   */
  setQualityLevel(level, config) {
    return this.set(`qualityLevels.${level}`, config);
  }

  /**
   * Set the model for a quality level
   *
   * @param {number} level - Quality level (1-5)
   * @param {string} model - Model identifier
   * @returns {boolean} Success
   */
  setQualityLevelModel(level, model) {
    const current = this.getQualityLevel(level);
    return this.set(`qualityLevels.${level}`, { ...current, model });
  }

  // ==========================================================================
  // CUSTOM COMMANDS
  // ==========================================================================

  /**
   * Get all custom sections with their commands
   *
   * @returns {Array} Custom sections
   */
  getCustomSections() {
    return this.get('customSections', []);
  }

  /**
   * Add a new custom section
   *
   * @param {string} name - Section name
   * @returns {object} Created section
   */
  addCustomSection(name) {
    const sections = this.getCustomSections();
    const id = `section-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const section = {
      id,
      name,
      commands: [],
    };

    sections.push(section);
    this.set('customSections', sections);

    return section;
  }

  /**
   * Remove a custom section
   *
   * @param {string} sectionId - Section ID
   * @returns {boolean} Success
   */
  removeCustomSection(sectionId) {
    const sections = this.getCustomSections();
    const filtered = sections.filter(s => s.id !== sectionId);

    if (filtered.length === sections.length) {
      return false; // Not found
    }

    return this.set('customSections', filtered);
  }

  /**
   * Add a custom command to a section
   *
   * @param {string} sectionId - Section ID
   * @param {object} command - Command definition
   * @returns {object|null} Created command or null
   */
  addCustomCommand(sectionId, command) {
    const sections = this.getCustomSections();
    const section = sections.find(s => s.id === sectionId);

    if (!section) {
      return null;
    }

    const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newCommand = {
      id,
      ...command,
      // Generate program name from command name
      program: `Custom_${id.replace(/-/g, '_')}`,
      // Default result field based on output type
      resultField: command.resultField || 'result',
    };

    section.commands.push(newCommand);
    this.set('customSections', sections);

    return newCommand;
  }

  /**
   * Update a custom command
   *
   * @param {string} sectionId - Section ID
   * @param {string} commandId - Command ID
   * @param {object} updates - Fields to update
   * @returns {boolean} Success
   */
  updateCustomCommand(sectionId, commandId, updates) {
    const sections = this.getCustomSections();
    const section = sections.find(s => s.id === sectionId);

    if (!section) {
      return false;
    }

    const command = section.commands.find(c => c.id === commandId);
    if (!command) {
      return false;
    }

    Object.assign(command, updates);
    return this.set('customSections', sections);
  }

  /**
   * Remove a custom command
   *
   * @param {string} sectionId - Section ID
   * @param {string} commandId - Command ID
   * @returns {boolean} Success
   */
  removeCustomCommand(sectionId, commandId) {
    const sections = this.getCustomSections();
    const section = sections.find(s => s.id === sectionId);

    if (!section) {
      return false;
    }

    const originalLength = section.commands.length;
    section.commands = section.commands.filter(c => c.id !== commandId);

    if (section.commands.length === originalLength) {
      return false; // Not found
    }

    return this.set('customSections', sections);
  }

  /**
   * Get all custom commands as a flat list (for AI_COMMANDS merge)
   *
   * @returns {Array} All custom commands with section info
   */
  getAllCustomCommands() {
    const sections = this.getCustomSections();
    const commands = [];

    for (const section of sections) {
      for (const command of section.commands) {
        commands.push({
          ...command,
          sectionId: section.id,
          sectionName: section.name,
        });
      }
    }

    return commands;
  }

  // ==========================================================================
  // DEFAULTS
  // ==========================================================================

  /**
   * Get default juice level
   *
   * @returns {number} Default juice level
   */
  getDefaultJuiceLevel() {
    return this.get('defaults.juiceLevel', 2);
  }

  /**
   * Set default juice level
   *
   * @param {number} level - Juice level (1-5)
   * @returns {boolean} Success
   */
  setDefaultJuiceLevel(level) {
    return this.set('defaults.juiceLevel', level);
  }

  /**
   * Get default reasoning level
   *
   * @returns {number} Default reasoning level
   */
  getDefaultReasoningLevel() {
    return this.get('defaults.reasoningLevel', 1);
  }

  /**
   * Set default reasoning level
   *
   * @param {number} level - Reasoning level (0-5)
   * @returns {boolean} Success
   */
  setDefaultReasoningLevel(level) {
    return this.set('defaults.reasoningLevel', level);
  }

  // ==========================================================================
  // EXPORT/IMPORT
  // ==========================================================================

  /**
   * Export settings to JSON string
   *
   * @param {boolean} includeKeys - Whether to include API keys
   * @returns {string} JSON string
   */
  export(includeKeys = false) {
    const settings = this.load();

    if (!includeKeys) {
      // Remove API keys for sharing
      const exported = { ...settings };
      exported.apiKeys = {};
      return JSON.stringify(exported, null, 2);
    }

    return JSON.stringify(settings, null, 2);
  }

  /**
   * Import settings from JSON string
   *
   * @param {string} json - JSON string
   * @param {boolean} mergeKeys - Whether to merge API keys (false = skip)
   * @returns {boolean} Success
   */
  import(json, mergeKeys = false) {
    try {
      const imported = JSON.parse(json);

      // Validate structure
      if (typeof imported !== 'object') {
        throw new Error('Invalid settings format');
      }

      // Preserve existing keys if not merging
      if (!mergeKeys) {
        imported.apiKeys = this.get('apiKeys', {});
      }

      // Merge with defaults and save
      this.settings = this.mergeWithDefaults(imported);
      return this.save();
    } catch (e) {
      console.error('[settings] Import failed:', e.message);
      return false;
    }
  }
}

export default SettingsService;
export { DEFAULT_SETTINGS, API_PROVIDERS, SETTINGS_FILE };
