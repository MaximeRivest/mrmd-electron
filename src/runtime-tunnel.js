/**
 * Runtime Tunnel Provider — exposes local MRP servers to the cloud relay
 *
 * When connected to markco.dev via CloudSync, this module opens a persistent
 * WebSocket to the relay as a "provider". The web editor (phone/tablet) sends
 * MRP traffic through the tunnel to this machine's local runtimes (mrmd-python,
 * mrmd-bash, mrmd-pty, mrmd-monitor, mrmd-sync, etc.) instead of the server's.
 *
 * The tunnel is transparent: HTTP request/response pairs and WebSocket sessions
 * are multiplexed over a single WebSocket connection. The web editor's proxy
 * layer just routes to the tunnel instead of 127.0.0.1.
 *
 * Protocol (JSON text messages, multiplexed):
 *
 * ── Runtime discovery ──
 *   → {t:"start-runtime", id, language, documentPath, projectRoot, projectConfig, frontmatter}
 *   ← {t:"runtime-started", id, runtimes: {python:{port,...}, bash:{port,...}, ...}}
 *   ← {t:"runtime-error", id, error}
 *   ← {t:"runtime-update", requestId, language, runtimes: {julia:{port,...}}}
 *   ← {t:"runtime-update-error", requestId, language, error}
 *   ← {t:"provider-info", capabilities:[...]}
 *
 * ── HTTP proxy (for /proxy/:port/*) ──
 *   → {t:"http-req", id, port, method, path, headers, body}
 *   ← {t:"http-res", id, status, headers}
 *   ← {t:"http-chunk", id, data}        — streamed body chunk (SSE, etc.)
 *   ← {t:"http-end", id}                — response complete
 *   ← {t:"http-error", id, error}
 *
 * ── WebSocket proxy (for /sync/:port/*) ──
 *   → {t:"ws-open", id, port, path}
 *   ← {t:"ws-opened", id}
 *   ↔ {t:"ws-msg", id, data, bin}       — binary flag; data is base64 if bin=true
 *   → {t:"ws-close", id}
 *   ← {t:"ws-close", id, code, reason}
 *   ← {t:"ws-error", id, error}
 */

import os from 'os';
import { WebSocket } from 'ws';

export class RuntimeTunnel {
  /**
   * @param {object} opts
   * @param {string} opts.relayUrl - WebSocket URL (e.g. 'wss://markco.dev')
   * @param {string} opts.userId - User UUID
   * @param {string} opts.token - Session token for authentication
   * @param {object} opts.runtimeService - RuntimeService instance (for starting runtimes)
   */
  constructor(opts) {
    this.relayUrl = opts.relayUrl;
    this.userId = opts.userId;
    this.token = opts.token;
    this.runtimeService = opts.runtimeService;
    this.runtimePreferencesService = opts.runtimePreferencesService;
    this.machineId = opts.machineId || process.env.MRMD_MACHINE_ID || `${os.hostname()}-${os.userInfo().username}`;
    this.machineName = opts.machineName || process.env.MRMD_MACHINE_NAME || os.hostname();
    this.hostname = os.hostname();
    /** @type {((req: {project: string, docPath: string}) => void) | null} */
    this.onBridgeRequest = opts.onBridgeRequest || null;
    /** @type {((req: {audioBase64: string, mimeType: string, url: string}) => Promise<object>) | null} */
    this.onVoiceTranscribe = opts.onVoiceTranscribe || null;
    this.ws = null;
    this._destroyed = false;
    this._reconnectTimer = null;
    this._connected = false;

    /** @type {Map<string, WebSocket>} id → local WebSocket */
    this._wsSessions = new Map();

    /** @type {Map<string, AbortController>} id → HTTP abort controller */
    this._httpSessions = new Map();
  }

  start() {
    this._connect();
  }

  _connect() {
    if (this._destroyed) return;

    const url = `${this.relayUrl}/tunnel/${encodeURIComponent(this.userId)}?role=provider&token=${encodeURIComponent(this.token)}&machine_id=${encodeURIComponent(this.machineId)}&machine_name=${encodeURIComponent(this.machineName)}&hostname=${encodeURIComponent(this.hostname)}`;
    try {
      this.ws = new WebSocket(url, {
        headers: {
          'X-User-Id': this.userId,
          Authorization: `Bearer ${this.token}`,
        },
      });
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this._connected = true;
      console.log('[runtime-tunnel] Connected to relay as provider');

      // Advertise capabilities
      const languages = this.runtimeService.supportedLanguages?.() || [];
      this._send({
        t: 'provider-info',
        machineId: this.machineId,
        machineName: this.machineName,
        hostname: this.hostname,
        capabilities: languages,
      });
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
        this._handleMessage(msg);
      } catch (err) {
        console.error('[runtime-tunnel] Bad message:', err.message);
      }
    });

    this.ws.on('close', () => {
      this._connected = false;
      this._cleanupAll();
      if (!this._destroyed) this._scheduleReconnect();
    });

    this.ws.on('error', () => { /* handled by close */ });
  }

  _scheduleReconnect() {
    if (this._destroyed || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, 5000);
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  _handleMessage(msg) {
    switch (msg.t) {
      case 'list-runtimes':   return this._handleListRuntimes(msg);
      case 'start-runtime':   return this._handleStartRuntime(msg);
      case 'stop-runtime':    return this._handleStopRuntime(msg);
      case 'restart-runtime': return this._handleRestartRuntime(msg);
      case 'http-req':        return this._handleHttpReq(msg);
      case 'ws-open':         return this._handleWsOpen(msg);
      case 'ws-msg':          return this._handleWsMsg(msg);
      case 'ws-close':        return this._handleWsClose(msg);
      case 'bridge-request':  return this._handleBridgeRequest(msg);
      case 'voice-transcribe': return this._handleVoiceTranscribe(msg);
      case 'provider-status': return; // ignore, for consumers
      default: return; // unknown
    }
  }

  _handleBridgeRequest(msg) {
    const { project, docPath } = msg;
    if (!project || !docPath) return;
    console.log(`[runtime-tunnel] Bridge request: ${project}/${docPath}`);
    if (this.onBridgeRequest) {
      try { this.onBridgeRequest({ project, docPath }); } catch (err) {
        console.error('[runtime-tunnel] Bridge request handler error:', err.message);
      }
    }
  }

  // ── Voice transcription ────────────────────────────────────────────────

  async _handleVoiceTranscribe(msg) {
    const { id, audioBase64, mimeType, url } = msg;
    if (!this.onVoiceTranscribe) {
      this._send({ t: 'voice-result', id, error: 'Voice transcription not supported on this provider' });
      return;
    }
    try {
      console.log(`[runtime-tunnel] Voice transcribe request: ${(audioBase64?.length || 0)} chars base64 → ${url}`);
      const result = await this.onVoiceTranscribe({ audioBase64, mimeType, url });
      this._send({ t: 'voice-result', id, result });
    } catch (err) {
      console.error('[runtime-tunnel] Voice transcribe error:', err.message);
      this._send({ t: 'voice-result', id, error: err.message });
    }
  }

  // ── Runtime discovery ─────────────────────────────────────────────────

  _handleListRuntimes(msg) {
    const { id, language } = msg;
    try {
      const runtimes = this.runtimeService.list(language);
      this._send({ t: 'runtimes-list', id, runtimes });
    } catch (err) {
      this._send({ t: 'runtime-error', id, error: err.message });
    }
  }

  async _handleStopRuntime(msg) {
    const { id, name } = msg;
    try {
      const success = await this.runtimeService.stop(name);
      this._send({ t: 'runtime-stopped', id, success });
    } catch (err) {
      this._send({ t: 'runtime-error', id, error: err.message });
    }
  }

  async _handleRestartRuntime(msg) {
    const { id, name } = msg;
    try {
      const result = await this.runtimeService.restart(name);
      this._send({ t: 'runtime-started', id, runtimes: { [result.language]: result } });
    } catch (err) {
      this._send({ t: 'runtime-error', id, error: err.message });
    }
  }

  async _ensureEffectiveRuntime(documentPath, language, projectRoot) {
    const l = String(language || '').toLowerCase();
    const normalized = (l === 'py' || l === 'python3') ? 'python' :
                       (l === 'sh' || l === 'shell' || l === 'zsh') ? 'bash' :
                       (l === 'rlang') ? 'r' :
                       (l === 'jl') ? 'julia' :
                       (l === 'term' || l === 'terminal') ? 'pty' : l;

    const supported = new Set(this.runtimeService.supportedLanguages?.() || []);
    if (!supported.has(normalized)) {
      return {
        language: normalized,
        alive: false,
        available: false,
        error: `Unsupported runtime language: ${language}`,
      };
    }

    let effective = null;
    let startConfig = null;
    if (this.runtimePreferencesService) {
      effective = await this.runtimePreferencesService.getEffectiveForDocument({
        documentPath,
        language: normalized,
        projectRoot,
        deviceKind: 'desktop', // default to desktop for tunnel provider
      });
      startConfig = this.runtimePreferencesService.toRuntimeStartConfig(effective);
    } else {
      // Fallback if preferences service isn't available
      startConfig = {
        name: `rt:notebook:default:${normalized}`,
        language: normalized,
        cwd: projectRoot || '.',
      };
      if (normalized === 'python') {
        startConfig.venv = projectRoot ? `${projectRoot}/.venv` : '.venv';
      }
    }

    try {
      const runtime = await this.runtimeService.start(startConfig);
      return {
        ...runtime,
        id: runtime.name,
        alive: true,
        available: true,
        autoStart: true,
        effective,
      };
    } catch (e) {
      return {
        ...startConfig,
        id: startConfig.name,
        alive: false,
        available: true,
        autoStart: true,
        error: e.message,
        effective,
      };
    }
  }

  async _handleStartRuntime(msg) {
    const { id, language, name, cwd, venv, documentPath, projectRoot } = msg;
    try {
      let result;
      if (documentPath) {
        if (language) {
          // Single language for document
          result = await this._ensureEffectiveRuntime(documentPath, language, projectRoot);
          this._send({ t: 'runtime-started', id, runtimes: { [language]: result } });
        } else {
          // All runtimes for document
          // IMPORTANT: Do NOT block tunnel startup on slow/unstable runtimes (notably Julia).
          // Start the common runtimes first so browser/phone execution is responsive.
          const preferred = ['python', 'bash', 'r', 'pty'];
          const runtimes = {};

          for (const lang of preferred) {
            try {
              runtimes[lang] = await this._ensureEffectiveRuntime(documentPath, lang, projectRoot);
            } catch (e) {
              runtimes[lang] = { language: lang, alive: false, available: false, error: e.message };
            }
          }

          // Julia is optional in tunnel bootstrap; only start it in the background.
          setTimeout(async () => {
            try {
              const julia = await this._ensureEffectiveRuntime(documentPath, 'julia', projectRoot);
              this._send({
                t: 'runtime-update',
                requestId: id,
                language: 'julia',
                runtimes: { julia },
                projectRoot: projectRoot || null,
              });
            } catch (e) {
              this._send({
                t: 'runtime-update-error',
                requestId: id,
                language: 'julia',
                error: e.message,
              });
            }
          }, 0);

          this._send({ t: 'runtime-started', id, runtimes });
        }
      } else if (name && language) {
        // Manual start by config
        result = await this.runtimeService.start({ name, language, cwd, venv });
        this._send({ t: 'runtime-started', id, runtimes: { [language]: result } });
      } else {
        throw new Error('documentPath or (name and language) required');
      }
    } catch (err) {
      this._send({ t: 'runtime-error', id, error: err.message });
    }
  }

  // ── HTTP proxy ────────────────────────────────────────────────────────

  async _handleHttpReq(msg) {
    const { id, port, method, path, headers, body } = msg;
    const ac = new AbortController();
    this._httpSessions.set(id, ac);

    try {
      const url = `http://127.0.0.1:${port}${path}`;
      const fetchOpts = {
        method: method || 'GET',
        headers: headers || {},
        signal: ac.signal,
      };
      if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(method)) {
        fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }

      const res = await fetch(url, fetchOpts);

      // Send response headers
      const resHeaders = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });
      this._send({ t: 'http-res', id, status: res.status, headers: resHeaders });

      // Stream response body
      if (res.body) {
        const reader = res.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // Send chunk as base64
            const b64 = Buffer.from(value).toString('base64');
            this._send({ t: 'http-chunk', id, data: b64 });
          }
        } catch (err) {
          if (err.name !== 'AbortError') {
            this._send({ t: 'http-error', id, error: err.message });
          }
        }
      }

      this._send({ t: 'http-end', id });
    } catch (err) {
      if (err.name !== 'AbortError') {
        this._send({ t: 'http-error', id, error: err.message });
      }
    } finally {
      this._httpSessions.delete(id);
    }
  }

  // ── WebSocket proxy ───────────────────────────────────────────────────

  _handleWsOpen(msg) {
    const { id, port, path } = msg;

    if (this._wsSessions.has(id)) {
      this._send({ t: 'ws-error', id, error: 'Session ID already in use' });
      return;
    }

    const url = `ws://127.0.0.1:${port}/${path}`;
    let localWs;
    try {
      localWs = new WebSocket(url);
    } catch (err) {
      this._send({ t: 'ws-error', id, error: err.message });
      return;
    }

    // Track connection state and queue messages until local WS is open.
    // Messages from the consumer can arrive before the local WS connects;
    // without queuing they would be silently dropped (e.g. initial resize).
    const session = { localWs, ready: false, queue: [] };
    this._wsSessions.set(id, session);

    localWs.on('open', () => {
      session.ready = true;
      this._send({ t: 'ws-opened', id });
      // Flush any messages that arrived before the local WS was ready
      for (const queued of session.queue) {
        try {
          if (queued.bin) {
            localWs.send(Buffer.from(queued.data, 'base64'));
          } else {
            localWs.send(queued.data);
          }
        } catch { /* ignore */ }
      }
      session.queue.length = 0;
    });

    localWs.on('message', (data, isBinary) => {
      // IMPORTANT: In Node.js ws, `data` is always a Buffer regardless of
      // frame type. Only `isBinary` correctly distinguishes text vs binary
      // frames. Using Buffer.isBuffer() would incorrectly treat ALL messages
      // as binary, breaking text-based protocols (PTY, MRP).
      if (isBinary) {
        this._send({ t: 'ws-msg', id, data: Buffer.from(data).toString('base64'), bin: true });
      } else {
        this._send({ t: 'ws-msg', id, data: data.toString(), bin: false });
      }
    });

    localWs.on('close', (code, reason) => {
      this._wsSessions.delete(id);
      this._send({ t: 'ws-close', id, code, reason: reason?.toString() });
    });

    localWs.on('error', (err) => {
      this._send({ t: 'ws-error', id, error: err.message });
    });
  }

  _handleWsMsg(msg) {
    const session = this._wsSessions.get(msg.id);
    if (!session) return;

    // Queue messages until the local WebSocket is connected
    if (!session.ready) {
      session.queue.push({ data: msg.data, bin: msg.bin });
      return;
    }

    const localWs = session.localWs;
    if (!localWs || localWs.readyState !== WebSocket.OPEN) return;

    try {
      if (msg.bin) {
        localWs.send(Buffer.from(msg.data, 'base64'));
      } else {
        localWs.send(msg.data);
      }
    } catch { /* ignore */ }
  }

  _handleWsClose(msg) {
    const session = this._wsSessions.get(msg.id);
    if (!session) return;
    try { session.localWs?.close(); } catch { /* ignore */ }
    this._wsSessions.delete(msg.id);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  _cleanupAll() {
    for (const [id, session] of this._wsSessions) {
      try { session.localWs?.close(); } catch { /* ignore */ }
    }
    this._wsSessions.clear();

    for (const [id, ac] of this._httpSessions) {
      try { ac.abort(); } catch { /* ignore */ }
    }
    this._httpSessions.clear();
  }

  stop() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    this._cleanupAll();
    try { this.ws?.close(); } catch { /* ignore */ }
    console.log('[runtime-tunnel] Stopped');
  }

  get connected() {
    return this._connected;
  }
}

export default RuntimeTunnel;
