/**
 * Cloud Sync for mrmd-electron
 *
 * Bridges the local mrmd-sync WebSocket to the markco.dev relay WebSocket.
 * Does NOT implement Yjs protocol — just forwards raw binary messages
 * between the two WebSocket connections. Both ends speak Yjs natively.
 *
 * Architecture:
 *   local mrmd-sync (filesystem)  ←→  CloudSync bridge  ←→  markco.dev relay (postgres)
 *                                          ↕
 *                                   browser/phone clients
 *
 * Usage:
 *   const sync = new CloudSync({ cloudUrl, token, userId });
 *   sync.bridgeProject(localSyncPort, projectDir, projectName, docNames);
 *   sync.stopAll();
 */

import { WebSocket } from 'ws';
import { RuntimeTunnel } from './runtime-tunnel.js';

function encodePathSegments(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

/**
 * Bridges a single document between local mrmd-sync and cloud relay.
 * Just forwards raw WS messages — no Yjs dependency needed.
 */
class DocBridge {
  constructor(opts) {
    this.localUrl = opts.localUrl;
    this.remoteUrl = opts.remoteUrl;
    this.remoteHeaders = opts.remoteHeaders || {};
    this.log = opts.log || console.log;
    this.docName = opts.docName;

    this.localWs = null;
    this.remoteWs = null;
    this._destroyed = false;
    this._reconnectLocal = null;
    this._reconnectRemote = null;
    this._localReady = false;
    this._remoteReady = false;
    this._lastError = null;
    this._lastMessageAt = null;
    this._startedAt = Date.now();
    // Reconnect attempt counters for exponential backoff
    this._localAttempts = 0;
    this._remoteAttempts = 0;
    // Buffer messages when the other side isn't ready yet.
    // Critical: without this, Yjs sync step 1/2 messages are dropped during
    // the race between local and remote WS connections opening, causing
    // the sync to never complete for many documents when bridges start in bulk.
    this._localBuffer = [];   // messages from remote waiting for local
    this._remoteBuffer = [];  // messages from local waiting for remote

    // ── Guard against stale cloud state overwriting local edits ──────
    // When true, the initial Yjs sync handshake from remote→local has
    // completed.  After that, only incremental updates flow.  The flag
    // lets us block the very first remote→local sync-step-2 when the
    // cloud doc looks stale compared to the local state.
    this._initialSyncDone = false;
    // Number of bytes received from remote during initial sync.
    // Very large payloads (>0) on a reconnect indicate the cloud has
    // divergent state — exactly the scenario that causes the snap-back.
    this._remoteSyncBytes = 0;
  }

  start() {
    this._connectLocal();
    this._connectRemote();
  }

  _connectLocal() {
    if (this._destroyed) return;
    try {
      this.localWs = new WebSocket(this.localUrl);
    } catch {
      this._scheduleReconnect('local');
      return;
    }

    this.localWs.binaryType = 'arraybuffer';

    this.localWs.on('open', () => {
      this._localReady = true;
      this._localAttempts = 0; // reset backoff on success
      // Flush buffered messages from remote that arrived before local was ready
      for (const msg of this._localBuffer) {
        try { this.localWs.send(msg.data, { binary: msg.isBinary }); } catch { /* ignore */ }
      }
      this._localBuffer = [];
    });

    this.localWs.on('message', (data, isBinary) => {
      this._lastMessageAt = Date.now();
      // Forward to remote (cloud relay)
      if (this._remoteReady && this.remoteWs?.readyState === WebSocket.OPEN) {
        try { this.remoteWs.send(data, { binary: isBinary }); } catch { /* ignore */ }
      } else {
        this._remoteBuffer.push({ data, isBinary });
      }
    });

    this.localWs.on('close', () => {
      this._localReady = false;
      this._localBuffer = [];
      if (!this._destroyed) this._scheduleReconnect('local');
    });

    this.localWs.on('error', (err) => {
      this._lastError = `local:${err?.code || err?.message || 'error'}`;
    });
  }

  _connectRemote() {
    if (this._destroyed) return;
    try {
      this.remoteWs = new WebSocket(this.remoteUrl, { headers: this.remoteHeaders });
    } catch {
      this._scheduleReconnect('remote');
      return;
    }

    this.remoteWs.binaryType = 'arraybuffer';

    this.remoteWs.on('open', () => {
      this._remoteReady = true;
      this._remoteAttempts = 0; // reset backoff on success
      // Flush buffered messages from local that arrived before remote was ready
      for (const msg of this._remoteBuffer) {
        try { this.remoteWs.send(msg.data, { binary: msg.isBinary }); } catch { /* ignore */ }
      }
      this._remoteBuffer = [];
    });

    this.remoteWs.on('message', (data, isBinary) => {
      this._lastMessageAt = Date.now();

      // ── Guard: block stale remote state from overwriting local ──
      // Yjs sync protocol: byte[0]=messageType (0=sync, 1=awareness)
      // For sync: byte[1]=syncStep (0=step1/request, 1=step2/response, 2=update)
      //
      // Step 1 (state-vector request) is always safe — it just asks
      //   "what do you have?"  We forward it so the local sync server
      //   can reply with its updates.
      // Step 2 (bulk state response) is dangerous on reconnect — it may
      //   contain stale cloud state that overwrites local edits.
      // Update (type 2) messages are incremental and safe.
      //
      // Strategy: allow sync step 1 and updates through, but block
      // sync step 2 from remote on reconnect.  After the first
      // successful handshake the guard is lowered.
      if (isBinary && !this._initialSyncDone) {
        try {
          // data may be Buffer, ArrayBuffer, or Uint8Array depending on ws config
          const bytes = Buffer.isBuffer(data) ? data
            : data instanceof ArrayBuffer ? new Uint8Array(data)
            : new Uint8Array(data.buffer || data);

          if (bytes.length >= 2) {
            const msgType = bytes[0];  // 0=sync, 1=awareness
            const subType = bytes[1];  // 0=step1, 1=step2, 2=update

            if (msgType === 0 && subType === 1) {
              // Sync step 2 from remote — bulk state push.
              // Block it: local Electron is authoritative.
              this._remoteSyncBytes += bytes.length;
              this.log(`[cloud-bridge] Blocked remote sync-step-2 (${bytes.length}B) for ${this.docName} — local is authoritative`);
              this._initialSyncDone = true;
              return; // Do NOT forward to local
            }

            // Sync step 1 (state-vector request) is safe — it asks
            // local what it has.  Let it through so local can reply
            // with its updates (pushing local state TO cloud).
            if (msgType === 0 && (subType === 0 || subType === 2)) {
              // step1 or incremental update — safe to forward
              this._initialSyncDone = true;
            }
          }
        } catch { /* If parsing fails, let the message through */ }
      }

      // Forward to local mrmd-sync
      if (this._localReady && this.localWs?.readyState === WebSocket.OPEN) {
        try { this.localWs.send(data, { binary: isBinary }); } catch { /* ignore */ }
      } else {
        this._localBuffer.push({ data, isBinary });
      }
    });

    this.remoteWs.on('close', () => {
      this._remoteReady = false;
      this._remoteBuffer = [];
      // Reset sync guard so next reconnect is also protected
      this._initialSyncDone = false;
      this._remoteSyncBytes = 0;
      if (!this._destroyed) this._scheduleReconnect('remote');
    });

    this.remoteWs.on('error', (err) => {
      this._lastError = `remote:${err?.code || err?.message || 'error'}`;
    });
  }

  _scheduleReconnect(which) {
    if (this._destroyed) return;
    const key = which === 'local' ? '_reconnectLocal' : '_reconnectRemote';
    if (this[key]) return;

    const attemptsKey = which === 'local' ? '_localAttempts' : '_remoteAttempts';
    this[attemptsKey] = (this[attemptsKey] || 0) + 1;
    const attempts = this[attemptsKey];

    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 60s, plus jitter
    const baseDelay = Math.min(1000 * Math.pow(2, attempts - 1), 60000);
    const jitter = Math.random() * Math.min(2000, baseDelay);
    const delay = baseDelay + jitter;

    this[key] = setTimeout(() => {
      this[key] = null;
      if (which === 'local') this._connectLocal();
      else this._connectRemote();
    }, delay);
  }

  getStatus() {
    return {
      docName: this.docName,
      localReady: this._localReady,
      remoteReady: this._remoteReady,
      connected: this._localReady && this._remoteReady,
      reconnecting: Boolean(this._reconnectLocal || this._reconnectRemote),
      lastError: this._lastError,
      lastMessageAt: this._lastMessageAt,
      startedAt: this._startedAt,
    };
  }

  async stop() {
    this._destroyed = true;
    clearTimeout(this._reconnectLocal);
    clearTimeout(this._reconnectRemote);
    try { this.localWs?.close(); } catch { /* ignore */ }
    try { this.remoteWs?.close(); } catch { /* ignore */ }
  }
}

// ─── Staggered connection queue ──────────────────────────────────────────────
// Instead of opening hundreds of WebSocket bridges simultaneously (which causes
// a thundering herd that overwhelms the relay), we queue bridge starts and
// drain them in small batches with delays between each batch.
const BRIDGE_BATCH_SIZE = 8;       // connections to start per tick
const BRIDGE_BATCH_DELAY_MS = 250; // pause between batches

class BridgeQueue {
  constructor() {
    /** @type {Array<() => void>} */
    this._queue = [];
    this._draining = false;
  }

  /** Enqueue a bridge start function. */
  push(fn) {
    this._queue.push(fn);
    if (!this._draining) this._drain();
  }

  async _drain() {
    this._draining = true;
    while (this._queue.length > 0) {
      const batch = this._queue.splice(0, BRIDGE_BATCH_SIZE);
      for (const fn of batch) {
        try { fn(); } catch { /* ignore */ }
      }
      if (this._queue.length > 0) {
        await new Promise(r => setTimeout(r, BRIDGE_BATCH_DELAY_MS));
      }
    }
    this._draining = false;
  }

  /** Cancel all pending bridges (does not stop already-started ones). */
  clear() {
    this._queue.length = 0;
  }
}

/**
 * CloudSync manages document bridges for all open projects.
 */
export class CloudSync {
  /**
   * @param {object} opts
   * @param {string} opts.cloudUrl - e.g. 'https://markco.dev'
   * @param {string} opts.token - session token
   * @param {string} opts.userId - user UUID
   * @param {object} [opts.runtimeService] - RuntimeService instance for tunnel
   * @param {function} [opts.onVoiceTranscribe] - Voice transcription handler for tunnel
   * @param {function} [opts.log]
   */
  constructor(opts) {
    this.cloudUrl = opts.cloudUrl;
    this.token = opts.token;
    this.userId = opts.userId;
    this.log = opts.log || console.log;
    this._onVoiceTranscribe = opts.onVoiceTranscribe || null;

    // Convert https to wss for relay
    this.relayBaseUrl = this.cloudUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

    /** @type {Map<string, { bridges: Map<string, DocBridge>, port: number, projectName: string }>} */
    this._projects = new Map();

    // Staggered bridge startup queue
    this._bridgeQueue = new BridgeQueue();

    // Idle bridge teardown: close bridges with no Yjs traffic for 5+ minutes
    this._idleCheckInterval = setInterval(() => this._teardownIdleBridges(), 60000);

    // Runtime tunnel: expose local MRP servers to the web editor via relay
    this._runtimeTunnel = null;
    if (opts.runtimeService) {
      this._runtimeTunnel = new RuntimeTunnel({
        relayUrl: this.relayBaseUrl,
        userId: this.userId,
        token: this.token,
        runtimeService: opts.runtimeService,
        runtimePreferencesService: opts.runtimePreferencesService,
        onBridgeRequest: ({ project, docPath }) => {
          this._handleBridgeRequest(project, docPath);
        },
        onVoiceTranscribe: this._onVoiceTranscribe,
      });
      this._runtimeTunnel.start();
      this.log('[cloud-sync] Runtime tunnel started');
    }
  }

  /**
   * Bridge a local project's sync server to the cloud relay.
   *
   * @param {number} localSyncPort - Local mrmd-sync port
   * @param {string} projectDir - Local project directory
   * @param {string} projectName - Project name/slug for the relay
   * @param {string[]} docNames - Document names to bridge
   */
  bridgeProject(localSyncPort, projectDir, projectName, docNames = []) {
    if (this._projects.has(projectDir)) {
      // Already bridged — add any new docs
      const existing = this._projects.get(projectDir);
      for (const docName of docNames) {
        if (!existing.bridges.has(docName)) {
          this._bridgeDoc(projectDir, existing.port, existing.projectName, docName);
        }
      }
      return;
    }

    this.log(`[cloud-sync] Bridging ${projectName} (port ${localSyncPort}, ${docNames.length} docs)`);

    const bridges = new Map();
    this._projects.set(projectDir, { bridges, port: localSyncPort, projectName });

    for (const docName of docNames) {
      this._bridgeDoc(projectDir, localSyncPort, projectName, docName);
    }
  }

  /**
   * Add a document to an existing project bridge.
   */
  bridgeDoc(projectDir, docName) {
    const project = this._projects.get(projectDir);
    if (!project || project.bridges.has(docName)) return;
    this._bridgeDoc(projectDir, project.port, project.projectName, docName);
  }

  _bridgeDoc(projectDir, localSyncPort, projectName, docName) {
    const project = this._projects.get(projectDir);
    if (!project) return;

    const encodedDoc = encodePathSegments(docName);
    const encodedProject = encodePathSegments(projectName);
    const encodedUserId = encodeURIComponent(this.userId);

    const localUrl = `ws://127.0.0.1:${localSyncPort}/${encodedDoc}`;
    const remoteUrl = `${this.relayBaseUrl}/sync/${encodedUserId}/${encodedProject}/${encodedDoc}?token=${encodeURIComponent(this.token)}`;

    const bridge = new DocBridge({
      localUrl,
      remoteUrl,
      remoteHeaders: { Authorization: `Bearer ${this.token}` },
      log: this.log,
      docName,
    });

    // Register immediately so we don't double-bridge on next scan
    project.bridges.set(docName, bridge);

    // Start through the staggered queue to avoid thundering herd
    this._bridgeQueue.push(() => {
      if (!bridge._destroyed) bridge.start();
    });
  }

  /**
   * Handle a bridge-request from the relay (via runtime tunnel).
   * The relay tells us "someone opened project/docPath, please bridge it."
   */
  _handleBridgeRequest(project, docPath) {
    // Find the project by name
    for (const [dir, info] of this._projects) {
      if (info.projectName === project) {
        if (info.bridges.has(docPath)) {
          // Already bridged — nothing to do
          return;
        }
        this.log(`[cloud-sync] On-demand bridge: ${project}/${docPath}`);
        this._bridgeDoc(dir, info.port, info.projectName, docPath);
        return;
      }
    }
    this.log(`[cloud-sync] Bridge request for unknown project: ${project}`);
  }

  /**
   * Tear down bridges that have been idle (no Yjs messages) for 5+ minutes.
   * The Yjs snapshot stays in the relay's Postgres for fast re-open.
   */
  _teardownIdleBridges() {
    const IDLE_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    for (const [, info] of this._projects) {
      for (const [docName, bridge] of info.bridges) {
        // Only tear down bridges that are fully connected and idle
        if (!bridge._localReady || !bridge._remoteReady) continue;

        const lastActivity = bridge._lastMessageAt || bridge._startedAt;
        if (now - lastActivity > IDLE_MS) {
          this.log(`[cloud-sync] Idle teardown: ${info.projectName}/${docName}`);
          bridge.stop();
          info.bridges.delete(docName);
        }
      }
    }
  }

  /**
   * Stop syncing a specific project.
   */
  async stopProject(projectDir) {
    const project = this._projects.get(projectDir);
    if (!project) return;

    for (const bridge of project.bridges.values()) {
      await bridge.stop();
    }
    project.bridges.clear();
    this._projects.delete(projectDir);
    this.log(`[cloud-sync] Stopped project: ${projectDir}`);
  }

  /**
   * Stop all project bridges.
   */
  async stopAll() {
    // Cancel any pending bridge starts first
    this._bridgeQueue.clear();
    clearInterval(this._idleCheckInterval);
    for (const projectDir of [...this._projects.keys()]) {
      await this.stopProject(projectDir);
    }
    if (this._runtimeTunnel) {
      this._runtimeTunnel.stop();
      this._runtimeTunnel = null;
    }
    this.log('[cloud-sync] All bridges stopped');
  }

  /**
   * Push a file catalog to the relay for this machine.
   * This is a lightweight manifest (no file content) so the web editor
   * can browse projects across all connected machines.
   *
   * @param {string} machineId - Unique machine identifier
   * @param {object} opts
   * @param {string} [opts.machineName] - Human-readable machine name
   * @param {string} [opts.hostname] - OS hostname
   * @param {string[]} [opts.capabilities] - Runtime capabilities
   * @param {Array<{project: string, docPath: string, contentHash?: string, byteSize?: number}>} opts.entries
   */
  async pushCatalog(machineId, opts = {}) {
    const { machineName, hostname, capabilities, entries } = opts;
    const relayHttpUrl = this.cloudUrl; // already http(s)

    const url = `${relayHttpUrl}/api/catalog/${encodeURIComponent(this.userId)}/${encodeURIComponent(machineId)}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          machineName: machineName || null,
          hostname: hostname || null,
          capabilities: capabilities || [],
          entries: entries || [],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.log(`[cloud-sync] Catalog push failed: HTTP ${res.status} ${text.slice(0, 200)}`);
        return false;
      }

      const data = await res.json();
      this.log(`[cloud-sync] Catalog pushed: ${data.entries} entries for ${machineId}`);
      return true;
    } catch (err) {
      this.log(`[cloud-sync] Catalog push error: ${err.message}`);
      return false;
    }
  }

  /**
   * Get sync status.
   */
  getStatus() {
    const projects = [];
    let connectedDocs = 0;
    let totalDocs = 0;

    for (const [dir, info] of this._projects) {
      const docs = [];
      for (const [name, bridge] of info.bridges) {
        const status = bridge.getStatus();
        docs.push(status);
        totalDocs += 1;
        if (status.connected) connectedDocs += 1;
      }

      projects.push({
        dir,
        projectName: info.projectName,
        port: info.port,
        documents: docs,
      });
    }

    return {
      projects,
      cloudUrl: this.cloudUrl,
      userId: this.userId,
      totals: {
        projects: projects.length,
        documents: totalDocs,
        connectedDocuments: connectedDocs,
      },
    };
  }
}

export default CloudSync;
