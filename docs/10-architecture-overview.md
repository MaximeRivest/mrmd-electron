# MRMD Electron Architecture Overview

This document is the canonical implementation overview for the desktop app.

## Core runtime pieces

- **Main process:** `main.js`
  - window lifecycle
  - child process lifecycle (sync/monitor/runtimes/AI)
  - IPC handlers (`ipcMain.handle(...)`)
- **Renderer bridge:** `preload.cjs`
  - exposes `window.electronAPI`
- **UI shell:** `index.html`
  - hosts editor UI (`mrmd-editor` bundle + app logic)
- **Service layer:** `src/services/*`
  - pure Node modules (designed for reuse by `mrmd-server`)

## Process model

Main process coordinates multiple process types:

- `mrmd-sync` — one per project directory (reused by hash/refcount)
- `mrmd-monitor` — one per open document (monitor mode execution)
- `mrmd-python` — session-based runtime processes
- `mrmd-bash` / `mrmd-r` / `mrmd-julia` / `mrmd-pty` — session services by language
- `mrmd-ai` — shared singleton, lazy startup

### Important resilience behavior

`main.js` includes explicit sync-server death detection and UI notification (`sync-server-died`) to reduce silent data-loss risk if sync crashes.

## Service layer responsibilities

- `ProjectService` — project detection, config parsing, nav/file indexing
- `SessionService` — Python runtime sessions
- `BashSessionService` — Bash runtime sessions
- `RSessionService` — R runtime sessions
- `JuliaSessionService` — Julia runtime sessions
- `PtySessionService` — PTY terminal sessions
- `FileService` — create/move/reorder/delete/read/write with FSML semantics
- `AssetService` — assets and path helpers
- `SettingsService` — user settings/API keys

## Execution path (desktop)

1. User runs a cell in editor
2. Renderer calls `window.electronAPI.*`
3. Main process IPC handlers resolve project/session/runtime
4. Editor executes:
   - directly against runtime endpoint, or
   - through monitor coordination (`Y.Map('executions')` protocol)

## Cross-repo architectural note

Desktop behavior is the baseline contract.
`mrmd-server` mirrors this model by mapping Electron API calls to HTTP/WebSocket, while reusing the same services where possible.
