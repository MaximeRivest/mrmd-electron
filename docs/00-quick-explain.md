# MRMD Electron — Quick Explain

`mrmd-electron` is the desktop shell for MRMD.

- UI: single-page editor UI (`index.html`) using `mrmd-editor`
- Main process: `main.js`
- Renderer bridge: `preload.cjs` exposes `window.electronAPI`
- Services: pure Node services in `src/services/*`

## Runtime model (desktop)

- `mrmd-sync`: per-project (collaboration and file sync)
- `mrmd-monitor`: per-document (execution survives UI disconnect)
- language runtimes: started via session services (python/bash/r/julia/pty)
- AI server: shared singleton

## Why this matters

The desktop app is the source of truth for:
- IPC API shape
- session semantics
- process lifecycle behavior

`mrmd-server` mirrors this behavior over HTTP.
