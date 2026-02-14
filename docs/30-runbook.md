# MRMD Electron Runbook

This is the practical troubleshooting guide for desktop issues.

## 1) Fast triage checklist

1. Launch from terminal and inspect startup logs
2. Confirm `uv` is available (startup logs include uv checks)
3. Open a markdown doc and verify project/session bootstrap
4. Run a small Python cell and a small Bash cell
5. Confirm sync is active for the project (collab changes persist)

## 2) Common failure domains

- missing runtime tool/install (`mrmd-python`, `mrmd-bash`, etc.)
- port binding failures for spawned child services
- stale/dead session registry entries from prior crashes
- sync server crash (critical: unsaved-state risk if unnoticed)
- runtime availability issues (R/Julia not installed or package path unresolved)

## 3) Where to inspect

- orchestration and IPC: `main.js`
- bridge surface: `preload.cjs`
- Python sessions: `src/services/session-service.js`
- Bash sessions: `src/services/bash-session-service.js`
- R sessions: `src/services/r-session-service.js`
- Julia sessions: `src/services/julia-session-service.js`
- project scanning/navigation: `src/services/project-service.js`

## 4) Recovery actions

- restart app first (clears most transient state)
- stop stale sessions/runtimes from runtime/session controls
- verify venv and runtime package installations
- reopen the target file to retrigger project/session setup

## 5) Dev-mode sanity commands

```bash
cd mrmd-electron
npm install
npm run bundle
npm start
```

If behavior differs between packaged and dev mode, compare package resolution paths in `main.js` (`resolvePackageBin` / `resolvePackageDir`).
