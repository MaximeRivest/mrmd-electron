(function (global) {
  if (global.MrmdVoice && global.MrmdVoice.MrmdVoice) return;

  function defaultNoop() {}

  function makeId() {
    try {
      if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    } catch {}
    return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ];
    for (const mime of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(mime)) return mime;
      } catch {}
    }
    return '';
  }

  function blobToFile(blob, name) {
    try {
      return new File([blob], name, { type: blob.type || 'audio/webm' });
    } catch {
      const file = blob;
      file.name = name;
      return file;
    }
  }

  async function transcribeWithApi(provider, apiKey, blob, model) {
    const prov = String(provider || '').toLowerCase();
    const endpoint = prov === 'groq'
      ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : 'https://api.openai.com/v1/audio/transcriptions';
    const defaultModel = prov === 'groq' ? 'whisper-large-v3-turbo' : 'gpt-4o-mini-transcribe';

    const fd = new FormData();
    fd.append('file', blobToFile(blob, `recording.${(blob.type || 'audio/webm').includes('ogg') ? 'ogg' : 'webm'}`));
    fd.append('model', model || defaultModel);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: fd,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${prov} transcription failed (${res.status})${text ? `: ${text}` : ''}`);
    }

    const json = await res.json();
    return {
      text: json?.text || '',
      backend: `api:${prov}`,
      raw: json,
    };
  }

  class SimpleTranscriber {
    constructor() {
      this.backends = new Map();
    }

    addBackend(backend) {
      if (!backend || !backend.name) return;
      this.backends.set(backend.name, backend);
    }

    removeBackend(name) {
      this.backends.delete(name);
    }

    clearApiBackends() {
      for (const name of Array.from(this.backends.keys())) {
        if (name.startsWith('api:')) this.backends.delete(name);
      }
    }

    async getStatus() {
      const out = [];
      for (const backend of this.backends.values()) {
        let available = false;
        try {
          available = backend.isAvailable ? !!(await backend.isAvailable()) : true;
        } catch {
          available = false;
        }
        out.push({ name: backend.name, available });
      }
      return out;
    }

    async transcribe(input) {
      const errors = [];
      for (const backend of this.backends.values()) {
        let available = false;
        try {
          available = backend.isAvailable ? !!(await backend.isAvailable()) : true;
        } catch (err) {
          errors.push(err?.message || String(err));
          continue;
        }
        if (!available) continue;

        try {
          const result = await backend.transcribe(input);
          if (typeof result === 'string') {
            return { text: result, backend: backend.name };
          }
          return {
            ...(result || {}),
            backend: result?.backend || backend.name,
          };
        } catch (err) {
          errors.push(err?.message || String(err));
        }
      }
      throw new Error(errors[0] || 'No voice backend available');
    }
  }

  class FallbackMrmdVoice {
    constructor(options = {}) {
      this.options = options;
      this.textRouter = {
        onInsertToEditor: defaultNoop,
        onInsertToTerminal: defaultNoop,
      };
      this.transcriber = new SimpleTranscriber();
      this.recording = null;
      this.recorder = null;
      this.stream = null;
      this.status = 'idle';
      this._chunks = [];
      this._recordingId = null;
      this._startedAt = 0;
      this._checkpointTimer = null;
    }

    get elapsed() {
      if (!this._startedAt) return 0;
      return Math.max(0, (Date.now() - this._startedAt) / 1000);
    }

    setStatus(status) {
      this.status = status;
      this.options.onStatusChange?.(status);
    }

    setParakeetUrl(url) {
      if (!url) this.transcriber.removeBackend('parakeet');
    }

    setParakeetBridge(transcribe, isAvailable) {
      this.transcriber.addBackend({
        name: 'parakeet',
        inputType: 'blob',
        isAvailable: isAvailable || (async () => true),
        transcribe: async (input) => {
          if (!input?.blob) throw new Error('Missing audio blob');
          const result = await transcribe(input.blob);
          if (typeof result === 'string') return { text: result, backend: 'parakeet' };
          return { ...(result || {}), backend: 'parakeet' };
        },
      });
    }

    clearApiBackends() {
      this.transcriber.clearApiBackends();
    }

    setApiBackend(provider, apiKey, model) {
      const prov = String(provider || '').toLowerCase();
      this.transcriber.addBackend({
        name: `api:${prov}`,
        inputType: 'blob',
        isAvailable: async () => !!apiKey,
        transcribe: async (input) => {
          if (!input?.blob) throw new Error('Missing audio blob');
          return await transcribeWithApi(prov, apiKey, input.blob, model);
        },
      });
    }

    async getBackendStatus() {
      return await this.transcriber.getStatus();
    }

    async toggle() {
      if (this.recording) return await this.stop();
      return await this.start();
    }

    async start() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone capture is not available in this environment');
      }
      if (typeof MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder is not available in this environment');
      }

      const mimeType = pickMimeType();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._chunks = [];
      this._recordingId = makeId();
      this._startedAt = Date.now();

      this.recorder = mimeType
        ? new MediaRecorder(this.stream, { mimeType })
        : new MediaRecorder(this.stream);

      this.recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) this._chunks.push(event.data);
      });

      this.recorder.addEventListener('error', (event) => {
        console.error('[voice:fallback] Recorder error:', event.error || event);
      });

      this.recorder.start(1000);
      this.recording = {
        id: this._recordingId,
        mimeType: this.recorder.mimeType || mimeType || 'audio/webm',
      };
      this.setStatus('recording');
      this.options.onRecordingStart?.(this._recordingId);

      this._checkpointTimer = setInterval(async () => {
        try {
          if (!this._chunks.length) return;
          const blob = new Blob(this._chunks, { type: this.recording?.mimeType || 'audio/webm' });
          await this.options.onSaveCheckpoint?.(blob, this._recordingId);
        } catch (err) {
          console.warn('[voice:fallback] Checkpoint failed:', err?.message || err);
        }
      }, 30000);
    }

    async stop() {
      if (!this.recorder) return;
      const recorder = this.recorder;
      const recordingId = this._recordingId;
      const duration = this.elapsed;

      if (this._checkpointTimer) {
        clearInterval(this._checkpointTimer);
        this._checkpointTimer = null;
      }

      const blob = await new Promise((resolve, reject) => {
        const cleanup = () => {
          recorder.removeEventListener('stop', onStop);
          recorder.removeEventListener('error', onError);
        };
        const onStop = () => {
          cleanup();
          try {
            const out = new Blob(this._chunks, { type: this.recording?.mimeType || recorder.mimeType || 'audio/webm' });
            resolve(out);
          } catch (err) {
            reject(err);
          }
        };
        const onError = (event) => {
          cleanup();
          reject(event?.error || new Error('Recording failed'));
        };
        recorder.addEventListener('stop', onStop, { once: true });
        recorder.addEventListener('error', onError, { once: true });
        recorder.stop();
      });

      try {
        await this.options.onSaveAudio?.(blob, recordingId);
      } catch (err) {
        console.warn('[voice:fallback] Final audio save failed:', err?.message || err);
      }

      try {
        this.stream?.getTracks?.().forEach((t) => t.stop());
      } catch {}

      this.recorder = null;
      this.stream = null;
      this.recording = null;
      this.options.onRecordingStop?.({ duration, recordingId });
      this.setStatus('transcribing');
      this.options.onTranscribing?.();

      try {
        const result = await this.transcriber.transcribe({ blob });
        const text = String(result?.text || '').trim();
        const insertedTo = this._insertText(text);
        this.options.onTranscriptionComplete?.({
          text,
          backend: result?.backend || 'unknown',
          insertedTo,
          result,
        });
      } catch (err) {
        this.options.onTranscriptionError?.(err?.message || String(err));
      } finally {
        this.setStatus('idle');
        this._chunks = [];
        this._recordingId = null;
        this._startedAt = 0;
      }
    }

    _insertText(text) {
      if (!text) return 'none';
      try {
        if (this.textRouter?.onInsertToEditor) {
          this.textRouter.onInsertToEditor(text);
          return 'editor';
        }
      } catch (err) {
        console.warn('[voice:fallback] Insert failed:', err?.message || err);
      }
      return 'none';
    }
  }

  global.MrmdVoice = {
    MrmdVoice: FallbackMrmdVoice,
  };
})(window);
