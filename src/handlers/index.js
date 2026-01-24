/**
 * Unified Handler Definitions
 *
 * These handlers work for both Electron IPC and HTTP.
 * Each handler receives (args, context) and returns a result.
 *
 * Convention:
 *   - Handlers are grouped by namespace (project, session, file, etc.)
 *   - Each handler is an async function: (args, ctx) => result
 *   - The context provides services and state
 *
 * Usage in Electron (main.js):
 *   import { registerHandlers } from './handlers/index.js';
 *   registerHandlers(ipcMain, context);
 *
 * Usage in mrmd-server:
 *   import { handlers } from 'mrmd-electron/src/handlers/index.js';
 *   // Mount as HTTP routes
 */

import { projectHandlers } from './project.js';
import { sessionHandlers } from './session.js';
import { bashHandlers } from './bash.js';
import { fileHandlers } from './file.js';
import { assetHandlers } from './asset.js';
import { systemHandlers } from './system.js';

export const handlers = {
  project: projectHandlers,
  session: sessionHandlers,
  bash: bashHandlers,
  file: fileHandlers,
  asset: assetHandlers,
  system: systemHandlers,
};

/**
 * Register all handlers with Electron's ipcMain
 * @param {Electron.IpcMain} ipcMain
 * @param {object} context - Services and state
 */
export function registerElectronHandlers(ipcMain, context) {
  for (const [namespace, namespaceHandlers] of Object.entries(handlers)) {
    for (const [method, handler] of Object.entries(namespaceHandlers)) {
      const channel = `${namespace}:${method}`;
      ipcMain.handle(channel, async (event, args) => {
        try {
          return await handler(args || {}, context, event);
        } catch (err) {
          console.error(`[${channel}] Error:`, err);
          throw err;
        }
      });
    }
  }
}

/**
 * Register all handlers as Express routes
 * @param {Express.Application} app
 * @param {object} context - Services and state
 */
export function registerHttpHandlers(app, context) {
  for (const [namespace, namespaceHandlers] of Object.entries(handlers)) {
    for (const [method, handler] of Object.entries(namespaceHandlers)) {
      // Convert to HTTP route: project:get -> POST /api/project/get
      const route = `/api/${namespace}/${method}`;

      app.post(route, async (req, res) => {
        try {
          const result = await handler(req.body || {}, context, req);
          res.json(result);
        } catch (err) {
          console.error(`[${route}] Error:`, err);
          res.status(500).json({ error: err.message });
        }
      });
    }
  }
}

/**
 * Generate http-shim.js content from handlers
 * This creates a browser-compatible electronAPI
 */
export function generateHttpShim(baseUrl = '') {
  const lines = [
    '// Auto-generated from mrmd-electron/src/handlers',
    '(function() {',
    '  const BASE = window.MRMD_SERVER_URL || window.location.origin;',
    '  const TOKEN = new URLSearchParams(window.location.search).get("token") || "";',
    '',
    '  async function call(path, body) {',
    '    const url = new URL(path, BASE);',
    '    if (TOKEN) url.searchParams.set("token", TOKEN);',
    '    const res = await fetch(url, {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    '      body: JSON.stringify(body || {})',
    '    });',
    '    if (!res.ok) throw new Error((await res.json()).error || res.statusText);',
    '    return res.json();',
    '  }',
    '',
    '  window.electronAPI = {',
  ];

  for (const [namespace, namespaceHandlers] of Object.entries(handlers)) {
    lines.push(`    ${namespace}: {`);
    for (const method of Object.keys(namespaceHandlers)) {
      lines.push(`      ${method}: (args) => call("/api/${namespace}/${method}", args),`);
    }
    lines.push('    },');
  }

  lines.push('  };');
  lines.push('})();');

  return lines.join('\n');
}
