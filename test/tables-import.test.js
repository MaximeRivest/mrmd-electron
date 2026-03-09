import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { importLinkedTableFile, resolveLinkedTablePaths } from '../src/tables/index.js';

test('importLinkedTableFile copies csv source, scaffolds transform/cache, and builds a linked block', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mrmd-electron-table-import-'));

  try {
    const projectRoot = path.join(tempDir, 'project');
    const sourceDir = path.join(tempDir, 'incoming');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'notes'), { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });

    const sourceFilePath = path.join(sourceDir, 'sales-summary.csv');
    await fs.writeFile(sourceFilePath, 'Region,Revenue\nSouth,8.25\nNorth,12.50\nWest,4.10\n', 'utf8');

    const result = await importLinkedTableFile({
      projectRoot,
      documentPath: 'notes/demo.md',
      sourceFilePath,
      tableId: 'sales-summary',
      label: 'Sales summary',
      cacheFormat: 'csv',
      maxRows: 2,
    });

    assert.equal(result.ok, true);
    assert.equal(result.tableId, 'sales-summary');
    assert.equal(result.spec.engine, 'r-dplyr');
    assert.equal(result.spec.cache.format, 'csv');
    assert.equal(result.spec.snapshot.rowCount, 3);
    assert.ok(result.blockMarkdown.includes('<!--mrmd:table'));
    assert.ok(result.blockMarkdown.includes('id: sales-summary'));
    assert.ok(result.blockMarkdown.includes('| Region | Revenue |'));
    assert.ok(result.blockMarkdown.includes('| South | 8.25 |'));
    assert.ok(result.blockMarkdown.includes('| North | 12.50 |'));
    assert.ok(!result.blockMarkdown.includes('| West | 4.10 |'));

    const transformText = await fs.readFile(result.paths.transformAbsolute, 'utf8');
    const copiedSource = await fs.readFile(result.paths.sourceAbsolute, 'utf8');
    const cacheText = await fs.readFile(result.paths.cacheAbsolute, 'utf8');

    assert.ok(transformText.includes('mrmd_write_table'));
    assert.equal(copiedSource, 'Region,Revenue\nSouth,8.25\nNorth,12.50\nWest,4.10\n');
    assert.equal(cacheText, copiedSource);

    const resolvedPaths = resolveLinkedTablePaths({
      projectRoot,
      documentPath: 'notes/demo.md',
      spec: result.spec,
    });

    assert.ok(resolvedPaths.transformPath.endsWith(path.join('_assets', 'tables', 'sales-summary', 'transform.R')));
    assert.ok(resolvedPaths.cachePath.endsWith(path.join('_assets', 'tables', 'sales-summary', 'cache.csv')));
    assert.ok(resolvedPaths.sourcePaths[0].path.endsWith(path.join('_assets', 'tables', 'sales-summary', 'source.csv')));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('importLinkedTableFile can reuse an existing table id instead of creating duplicate directories', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mrmd-electron-table-import-reuse-'));

  try {
    const projectRoot = path.join(tempDir, 'project');
    const sourceDir = path.join(tempDir, 'incoming');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });

    const sourceFilePath = path.join(sourceDir, 'sales-summary.csv');
    await fs.writeFile(sourceFilePath, 'Region,Revenue\nSouth,8.25\n', 'utf8');

    const first = await importLinkedTableFile({
      projectRoot,
      documentPath: 'notes/demo.md',
      sourceFilePath,
      tableId: 'sales-summary',
      cacheFormat: 'csv',
    });

    await fs.writeFile(sourceFilePath, 'Region,Revenue\nNorth,12.50\n', 'utf8');

    const second = await importLinkedTableFile({
      projectRoot,
      documentPath: 'notes/demo.md',
      sourceFilePath,
      tableId: 'sales-summary',
      reuseExisting: true,
      cacheFormat: 'csv',
    });

    assert.equal(first.tableId, 'sales-summary');
    assert.equal(second.tableId, 'sales-summary');
    assert.equal(first.paths.tableDirProjectRelative, second.paths.tableDirProjectRelative);

    const sourceText = await fs.readFile(second.paths.sourceAbsolute, 'utf8');
    assert.equal(sourceText, 'Region,Revenue\nNorth,12.50\n');

    const tablesRoot = path.join(projectRoot, '_assets', 'tables');
    const entries = await fs.readdir(tablesRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    assert.deepEqual(dirs, ['sales-summary']);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
