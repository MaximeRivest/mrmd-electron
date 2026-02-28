(function (global) {
  'use strict';

  /**
   * Runtime Controller
   *
   * Extracted orchestration layer for runtime UX actions.
   * The renderer passes dependencies so this stays framework-agnostic and
   * works in Electron + browser shim flows.
   */
  function createRuntimeController(deps) {
    if (!deps || !deps.state) {
      throw new Error('createRuntimeController requires deps.state');
    }

    const state = deps.state;

    const normalizeRuntimeLanguage = deps.normalizeRuntimeLanguage || ((l) => String(l || '').toLowerCase());
    const getPreferredRuntimeForLanguage = deps.getPreferredRuntimeForLanguage;
    const renderRuntimesPanel = deps.renderRuntimesPanel || (() => {});
    const resolvePythonStartConfig = deps.resolvePythonStartConfig;
    const startPythonRuntimeFromConfig = deps.startPythonRuntimeFromConfig;
    const registerRuntimeWithEditor = deps.registerRuntimeWithEditor;
    const registerPtyWithEditor = deps.registerPtyWithEditor;
    const refreshRuntimes = deps.refreshRuntimes;
    const killAndRefreshRuntime = deps.killAndRefreshRuntime;
    const electronAPI = deps.electronAPI;
    const pinRuntimeAttachment = deps.pinRuntimeAttachment || (() => {});

    function setPending(language, pending) {
      const normalized = normalizeRuntimeLanguage(language) || language;
      if (pending) state.runtimePending.add(normalized);
      else state.runtimePending.delete(normalized);
    }

    function setError(language, errorMessage = null) {
      const normalized = normalizeRuntimeLanguage(language) || language;
      if (!errorMessage) state.runtimeErrors.delete(normalized);
      else state.runtimeErrors.set(normalized, String(errorMessage));
    }

    function getAttachedIds() {
      return {
        python: state.pythonVenv?.runtimeId || state.pythonVenv?.name || state.session?.name,
        bash: state.bashSession?.name,
        r: state.rSession?.name,
        julia: state.juliaSession?.name,
        pty: state.ptySession?.name,
      };
    }

    async function start(language, options = {}) {
      const normalized = normalizeRuntimeLanguage(language);
      const docPath = state.currentFile;

      if (!docPath) {
        console.log(`[startRuntime] No document open, cannot start ${language}`);
        return;
      }

      setPending(normalized, true);
      setError(normalized, null);
      renderRuntimesPanel();

      try {
        if (normalized === 'python') {
          if (typeof resolvePythonStartConfig !== 'function' || typeof startPythonRuntimeFromConfig !== 'function') {
            throw new Error('Python runtime helpers are not available');
          }
          const cfg = await resolvePythonStartConfig(options?.config || {});
          await startPythonRuntimeFromConfig(cfg, 'manual-start');
        } else if (['bash', 'r', 'julia'].includes(normalized)) {
          const ok = await registerRuntimeWithEditor(normalized);
          if (!ok) {
            throw new Error(`${normalized} runtime could not start`);
          }
        } else if (normalized === 'pty') {
          await registerPtyWithEditor();
        }

        setError(normalized, null);
      } catch (e) {
        setError(normalized, e?.message || e);
        console.error(`Failed to start ${language} runtime:`, e);
      } finally {
        setPending(normalized, false);
        await refreshRuntimes();
      }
    }

    async function restart(language) {
      const normalized = normalizeRuntimeLanguage(language);
      setPending(normalized, true);
      setError(normalized, null);
      renderRuntimesPanel();

      try {
        const { runtime } = getPreferredRuntimeForLanguage(
          normalized,
          state.runningRuntimes || [],
          getAttachedIds(),
        );

        if (runtime?.id) {
          const restarted = await electronAPI.runtime.restart(runtime.id);
          if (restarted?.name && restarted?.port) {
            pinRuntimeAttachment(normalized, restarted, 'manual-restart');
          }
        }

        if (normalized === 'python') {
          await registerRuntimeWithEditor('python');
        } else if (['bash', 'r', 'julia'].includes(normalized)) {
          await registerRuntimeWithEditor(normalized);
        } else if (normalized === 'pty') {
          await registerPtyWithEditor();
        }

        setError(normalized, null);
      } catch (e) {
        setError(normalized, e?.message || e);
        console.error(`Failed to restart ${language} runtime:`, e);
      } finally {
        setPending(normalized, false);
        await refreshRuntimes();
      }
    }

    async function stop(language) {
      const normalized = normalizeRuntimeLanguage(language);
      const { runtime } = getPreferredRuntimeForLanguage(
        normalized,
        state.runningRuntimes || [],
        getAttachedIds(),
      );
      if (!runtime?.id) return;
      await killAndRefreshRuntime(runtime.id, normalized);
    }

    return {
      setPending,
      setError,
      start,
      restart,
      stop,
      refresh: () => refreshRuntimes(),
      applyConfig: (language) => deps.applyRuntimeConfig(language),
    };
  }

  global.createRuntimeController = createRuntimeController;
})(typeof window !== 'undefined' ? window : globalThis);
