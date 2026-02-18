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
    // Buffer messages when the other side isn't ready yet.
    // Critical: without this, Yjs sync step 1/2 messages are dropped during
    // the race between local and remote WS connections opening, causing
    // the sync to never complete for many documents when bridges start in bulk.
    this._localBuffer = [];   // messages from remote waiting for local
    this._remoteBuffer = [];  // messages from local waiting for remote
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
      // Flush buffered messages from local that arrived before remote was ready
      for (const msg of this._remoteBuffer) {
        try { this.remoteWs.send(msg.data, { binary: msg.isBinary }); } catch { /* ignore */ }
      }
      this._remoteBuffer = [];
    });

    this.remoteWs.on('message', (data, isBinary) => {
      this._lastMessageAt = Date.now();
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
    this[key] = setTimeout(() => {
      this[key] = null;
      if (which === 'local') this._connectLocal();
      else this._connectRemote();
    }, 3000);
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
   * @param {function} [opts.log]
   */
  constructor(opts) {
    this.cloudUrl = opts.cloudUrl;
    this.token = opts.token;
    this.userId = opts.userId;
    this.log = opts.log || console.log;

    // Convert https to wss for relay
    this.relayBaseUrl = this.cloudUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

    /** @type {Map<string, { bridges: Map<string, DocBridge>, port: number, projectName: string }>} */
    this._projects = new Map();

    // Runtime tunnel: expose local MRP servers to the web editor via relay
    this._runtimeTunnel = null;
    if (opts.runtimeService) {
      this._runtimeTunnel = new RuntimeTunnel({
        relayUrl: this.relayBaseUrl,
        userId: this.userId,
        token: this.token,
        runtimeService: opts.runtimeService,
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
    if (this._projects.has(projectDir)) return;

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

    bridge.start();
    project.bridges.set(docName, bridge);

    this.log(`[cloud-sync] Bridged doc: ${docName}`);
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
