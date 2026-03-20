import http from 'http';
import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { BrowserWindow } from 'electron';

const BRIDGE_CONFIG_FILE = 'agent-bridge.json';
const API_PREFIX = '/agent/v1';
const HISTORY_LIMIT = 200;

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'http://127.0.0.1',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { success: false, error: message, ...extra });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function getAuthToken(req) {
  const auth = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(auth));
  return match ? match[1] : null;
}

function makeRendererScript(method, payload) {
  return `(() => {
    const bridge = window.__mrmdAgentBridge;
    if (!bridge || typeof bridge[${JSON.stringify(method)}] !== 'function') {
      throw new Error('MRMD agent bridge is not available in renderer');
    }
    return Promise.resolve(bridge[${JSON.stringify(method)}](${JSON.stringify(payload ?? {})}));
  })()`;
}

function summarizePayload(value) {
  if (typeof value === 'string') return value.slice(0, 200);
  if (value && typeof value === 'object') {
    if (typeof value.code === 'string') return value.code.slice(0, 200);
    if (typeof value.match === 'string') return value.match.slice(0, 200);
    if (typeof value.name === 'string') return value.name.slice(0, 200);
  }
  return '';
}

async function forwardMrpJson(port, endpoint, body = {}, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mrp/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || data?.detail || `MRP request failed: ${response.status}`);
  }
  return data;
}

export async function startAgentBridge({ configDir, getWindows }) {
  const token = randomBytes(24).toString('hex');
  const history = [];

  function addHistory(item) {
    history.unshift({
      id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      ...item,
    });
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  }

  function listCandidateWindows() {
    const windows = (typeof getWindows === 'function' ? getWindows() : [])
      .filter((win) => win && !win.isDestroyed());
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) {
      return [focused, ...windows.filter((win) => win.id !== focused.id)];
    }
    return windows;
  }

  async function invokeRenderer(method, payload = {}) {
    let lastError = null;
    for (const win of listCandidateWindows()) {
      try {
        const result = await win.webContents.executeJavaScript(makeRendererScript(method, payload), true);
        if (result && result.ok === false && result.error) {
          throw new Error(result.error);
        }
        return { result, win };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('No MRMD window with an active renderer bridge is available');
  }

  async function getStatusSnapshot() {
    const { result, win } = await invokeRenderer('getStatus', {});
    return {
      ...(result || {}),
      window: {
        id: win.id,
        focused: win.isFocused(),
      },
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': 'http://127.0.0.1',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      if (getAuthToken(req) !== token) {
        sendError(res, 401, 'Unauthorized');
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === `${API_PREFIX}/status`) {
        const status = await getStatusSnapshot();
        sendJson(res, 200, { success: true, ...status });
        return;
      }

      if (req.method === 'GET' && pathname === `${API_PREFIX}/document`) {
        const { result } = await invokeRenderer('getDocument', {});
        sendJson(res, 200, { success: true, ...(result || {}) });
        return;
      }

      if (req.method === 'GET' && pathname === `${API_PREFIX}/cells`) {
        const { result } = await invokeRenderer('listCells', {});
        sendJson(res, 200, { success: true, ...(result || {}) });
        return;
      }

      if (req.method === 'POST' && pathname === `${API_PREFIX}/cells/find`) {
        const body = await readJsonBody(req);
        const { result } = await invokeRenderer('findCells', body);
        sendJson(res, 200, { success: true, ...(result || {}) });
        return;
      }

      if (req.method === 'GET' && pathname === `${API_PREFIX}/history`) {
        sendJson(res, 200, { success: true, items: history });
        return;
      }

      if (req.method === 'POST' && pathname === `${API_PREFIX}/cells/run`) {
        const body = await readJsonBody(req);
        addHistory({ kind: 'cell-run', status: 'started', selector: body, preview: summarizePayload(body) });
        const { result } = await invokeRenderer('runCell', body);
        addHistory({ kind: 'cell-run', status: 'completed', selector: body, preview: summarizePayload(body), result });
        sendJson(res, 200, { success: true, ...(result || {}) });
        return;
      }

      if (req.method === 'POST' && pathname === `${API_PREFIX}/cells/run-all`) {
        const body = await readJsonBody(req);
        addHistory({ kind: 'cell-run-all', status: 'started' });
        const { result } = await invokeRenderer('runAllCells', body);
        addHistory({ kind: 'cell-run-all', status: 'completed', result });
        sendJson(res, 200, { success: true, ...(result || {}) });
        return;
      }

      if (req.method === 'POST' && pathname === `${API_PREFIX}/cells/insert`) {
        const body = await readJsonBody(req);
        addHistory({ kind: 'cell-insert', status: 'started', preview: summarizePayload(body) });
        const { result } = await invokeRenderer('insertCell', body);
        addHistory({ kind: 'cell-insert', status: 'completed', preview: summarizePayload(body), result });
        sendJson(res, 200, { success: true, ...(result || {}) });
        return;
      }

      if (req.method === 'POST' && pathname === `${API_PREFIX}/cells/replace`) {
        const body = await readJsonBody(req);
        addHistory({ kind: 'cell-replace', status: 'started', preview: summarizePayload(body) });
        const { result } = await invokeRenderer('replaceCell', body);
        addHistory({ kind: 'cell-replace', status: 'completed', preview: summarizePayload(body), result });
        sendJson(res, 200, { success: true, ...(result || {}) });
        return;
      }

      const runtimeVarMatch = /^\/agent\/v1\/runtime\/([^/]+)\/variable\/([^/]+)$/.exec(pathname);
      if (runtimeVarMatch && req.method === 'POST') {
        const [, languageRaw, variableRaw] = runtimeVarMatch;
        const language = decodeURIComponent(languageRaw).toLowerCase();
        const variableName = decodeURIComponent(variableRaw);
        if (language === 'javascript' || language === 'js') {
          sendError(res, 501, 'JavaScript runtime bridge is not implemented yet');
          return;
        }

        const status = await getStatusSnapshot();
        const runtime = status?.runtimes?.[language];
        if (!runtime?.port) {
          sendError(res, 404, `No active ${language} runtime`);
          return;
        }

        const body = await readJsonBody(req);
        const result = await forwardMrpJson(runtime.port, `variables/${encodeURIComponent(variableName)}`, body);
        sendJson(res, 200, { success: true, language, runtime, result });
        return;
      }

      const runtimeMatch = /^\/agent\/v1\/runtime\/([^/]+)\/([^/]+)$/.exec(pathname);
      if (runtimeMatch && req.method === 'POST') {
        const [, languageRaw, action] = runtimeMatch;
        const language = decodeURIComponent(languageRaw).toLowerCase();
        if (language === 'javascript' || language === 'js') {
          sendError(res, 501, 'JavaScript runtime bridge is not implemented yet');
          return;
        }

        const status = await getStatusSnapshot();
        const runtime = status?.runtimes?.[language];
        if (!runtime?.port) {
          sendError(res, 404, `No active ${language} runtime`);
          return;
        }

        const body = await readJsonBody(req);
        let result;
        if (action === 'execute') {
          addHistory({ kind: 'runtime-exec', language, status: 'started', preview: summarizePayload(body) });
          result = await forwardMrpJson(runtime.port, 'execute', {
            code: body.code || '',
            storeHistory: body.storeHistory !== false,
            execId: body.execId,
          });
          addHistory({ kind: 'runtime-exec', language, status: 'completed', preview: summarizePayload(body), result });
        } else if (action === 'variables') {
          result = await forwardMrpJson(runtime.port, 'variables', body.filter ? body : { filter: { excludePrivate: true } });
        } else if (action === 'inspect') {
          result = await forwardMrpJson(runtime.port, 'inspect', body);
        } else if (action === 'interrupt') {
          result = await forwardMrpJson(runtime.port, 'interrupt', body);
        } else if (action === 'reset') {
          result = await forwardMrpJson(runtime.port, 'reset', body);
        } else {
          sendError(res, 404, `Unknown runtime action: ${action}`);
          return;
        }

        sendJson(res, 200, { success: true, language, runtime, result });
        return;
      }

      sendError(res, 404, 'Not found');
    } catch (error) {
      sendError(res, 500, error?.message || String(error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) {
    throw new Error('Failed to determine agent bridge port');
  }

  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, BRIDGE_CONFIG_FILE);
  await fs.writeFile(configPath, JSON.stringify({
    version: 1,
    port,
    token,
    url: `http://127.0.0.1:${port}${API_PREFIX}`,
    startedAt: new Date().toISOString(),
  }, null, 2));

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}${API_PREFIX}`,
    configPath,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
