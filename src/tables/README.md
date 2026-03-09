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

## Current phase

A first Electron host helper layer now exists for:
- supported table-source file picker filters
- importing one csv/tsv file into `_assets/tables/<id>/source.*`
- scaffolding sibling `transform.R` + `cache.csv` / `cache.tsv`
- generating the first linked-table block markdown for insertion into the document
- resolving linked-table source/transform/cache paths back to absolute host paths
- passing `--project-root` through to the spawned monitor for linked-table jobs
- exposing table host helpers through preload + IPC
- supporting a visible nav-sidebar csv/tsv context-menu action: `Insert as Linked Table`
- opening/revealing primary linked-table source files from widget actions
- hosting the first real `Open grid` workspace panel shell with result/source/transform/cache tabs

Current limitations:
- this is csv/tsv-first for the first real host path
- repeated imports can now reuse an existing matching table id, but broader cleanup/provenance policy is still not complete
- richer source-open/workspace actions still need to be wired in

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
