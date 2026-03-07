# MRMD Electron Local Development

## Prereqs

- Node.js 18+
- Python + `uv`

## Typical flow

```bash
cd mrmd-electron
npm install
npm run bundle
npm start
```

## Windows setup

From `mrmd-electron` on a Windows machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1 -PullExisting -IncludeOptional -BuildDir
```

That script:

- clones missing sibling repos next to `mrmd-electron`
- installs/builds the required Node packages
- bundles sibling CLIs used by Electron
- performs Windows packaging preflight checks
- optionally builds a packaged Windows app for sanity checking

## Notes

- `npm run bundle` pulls sibling package bundles used by the app
- session services may auto-install runtime dependencies through `uv`
- logs from child runtimes appear in main process stdout/stderr

## Where to inspect behavior

- startup/lifecycle: `main.js`
- bridge contract: `preload.cjs`
- session behavior: `src/services/*session-service*.js`
