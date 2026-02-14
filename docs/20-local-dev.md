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

## Notes

- `npm run bundle` pulls sibling package bundles used by the app
- session services may auto-install runtime dependencies through `uv`
- logs from child runtimes appear in main process stdout/stderr

## Where to inspect behavior

- startup/lifecycle: `main.js`
- bridge contract: `preload.cjs`
- session behavior: `src/services/*session-service*.js`
