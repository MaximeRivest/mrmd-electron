# mrmd-electron/src/tables

Internal Electron host adapters for linked tables.

This layer should stay host-specific and thin.
It bridges linked-table workflows to filesystem/UI features already present in the app.

## Ownership

- tabular-source file picker mode
- import/copy into `_assets/tables/<id>/`
- open source file/folder helpers
- optional local runtime/service bootstrap helpers

## Planned tree

```text
mrmd-electron/src/tables/
  index.js
  asset-import.js
  file-picker-filters.js
  source-open.js
  runtime-host.js
```

## First slice here

Phase 1 electron-side work should only prove:
- import one CSV into `_assets/tables/<id>/source.csv`
- create transform/cache sibling paths
- expose a file-picker mode for supported table sources
- open source file/folder from linked-table UI actions

## Non-goals for the first slice

- full engine hosting abstraction
- remote-service deployment management
- rich source editing UI inside Electron itself
