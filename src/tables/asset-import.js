/**
 * Linked-table asset import helpers.
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { Assets } from 'mrmd-project';

import { createRDplyrEngine } from '../../../mrmd-table-engine-r-dplyr/src/index.js';
import { serializeLinkedTableHeader } from '../../../mrmd-table-spec/src/index.js';
import { inferTableFormatFromPath } from './file-picker-filters.js';

function slugifyTableId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function inferLabelFromPath(filePath) {
  const base = path.basename(String(filePath || ''), path.extname(String(filePath || '')));
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitDelimitedLine(line, delimiter) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === delimiter && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  values.push(current);
  return values;
}

function parseDelimitedText(text, delimiter) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      columnNames: [],
      rows: [],
    };
  }

  const columnNames = splitDelimitedLine(lines[0], delimiter);
  const rows = [];

  for (let index = 1; index < lines.length; index++) {
    const values = splitDelimitedLine(lines[index], delimiter);
    const row = {};
    for (let columnIndex = 0; columnIndex < columnNames.length; columnIndex++) {
      row[columnNames[columnIndex]] = values[columnIndex] ?? '';
    }
    rows.push(row);
  }

  return {
    columnNames,
    rows,
  };
}

function quoteDelimitedCell(value, delimiter) {
  const text = String(value ?? '');
  if (!text.includes('"') && !text.includes('\n') && !text.includes('\r') && !text.includes(delimiter)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function serializeDelimitedTable(columnNames, rows, delimiter) {
  const lines = [columnNames.map((name) => quoteDelimitedCell(name, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push(columnNames.map((name) => quoteDelimitedCell(row[name], delimiter)).join(delimiter));
  }
  return lines.join('\n') + '\n';
}

async function readDelimitedFile(filePath, format) {
  const text = await fsPromises.readFile(filePath, 'utf8');
  return parseDelimitedText(text, format === 'tsv' ? '\t' : ',');
}

async function writeDelimitedFile(filePath, format, table) {
  const delimiter = format === 'tsv' ? '\t' : ',';
  const content = serializeDelimitedTable(table.columnNames, table.rows, delimiter);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, content, 'utf8');
}

async function ensureUniqueTableId(projectRoot, desiredId) {
  let candidate = desiredId;
  let counter = 1;

  while (true) {
    const dirPath = path.join(projectRoot, '_assets', 'tables', candidate);
    try {
      await fsPromises.access(dirPath);
      candidate = `${desiredId}-${counter}`;
      counter++;
    } catch {
      return candidate;
    }
  }
}

function buildRelativeAssetPath(documentPath, projectRelativePath) {
  return Assets.computeRelativePath(documentPath, projectRelativePath);
}

function buildLinkedTableBlockText(spec, snapshotMarkdown) {
  return `${serializeLinkedTableHeader(spec).trimEnd()}\n${String(snapshotMarkdown || '').trim()}`;
}

export async function importLinkedTableFile(options = {}) {
  const {
    projectRoot,
    documentPath,
    sourceFilePath,
    tableId = null,
    reuseExisting = false,
    label = null,
    cacheFormat = 'csv',
    engineId = 'r-dplyr',
    maxRows = 12,
    overflow = 'paginate',
  } = options;

  if (!projectRoot) throw new Error('importLinkedTableFile requires `projectRoot`');
  if (!documentPath) throw new Error('importLinkedTableFile requires `documentPath`');
  if (!sourceFilePath) throw new Error('importLinkedTableFile requires `sourceFilePath`');

  const sourceFormat = inferTableFormatFromPath(sourceFilePath);
  if (!sourceFormat) {
    throw new Error(`Unsupported table source for phase 1: ${sourceFilePath}`);
  }
  if (!['csv', 'tsv'].includes(sourceFormat)) {
    throw new Error(`Phase-1 linked-table import currently supports csv/tsv only; got \`${sourceFormat}\``);
  }
  if (!['csv', 'tsv'].includes(cacheFormat)) {
    throw new Error(`Phase-1 linked-table cache import currently supports csv/tsv only; got \`${cacheFormat}\``);
  }

  const baseId = slugifyTableId(tableId || path.basename(sourceFilePath, path.extname(sourceFilePath))) || 'linked-table';
  const finalTableId = (reuseExisting && tableId)
    ? baseId
    : await ensureUniqueTableId(projectRoot, baseId);
  const tableDirProjectRelative = path.join('_assets', 'tables', finalTableId);
  const sourceFilename = `source${path.extname(sourceFilePath).toLowerCase() || '.csv'}`;
  const sourceProjectRelative = path.join(tableDirProjectRelative, sourceFilename);
  const transformProjectRelative = path.join(tableDirProjectRelative, 'transform.R');
  const cacheProjectRelative = path.join(tableDirProjectRelative, `cache.${cacheFormat}`);

  const sourceAbsolute = path.join(projectRoot, sourceProjectRelative);
  const transformAbsolute = path.join(projectRoot, transformProjectRelative);
  const cacheAbsolute = path.join(projectRoot, cacheProjectRelative);

  await fsPromises.mkdir(path.dirname(sourceAbsolute), { recursive: true });
  await fsPromises.copyFile(sourceFilePath, sourceAbsolute);

  const table = await readDelimitedFile(sourceAbsolute, sourceFormat);

  const spec = {
    version: 1,
    id: finalTableId,
    label: label || inferLabelFromPath(sourceFilePath) || finalTableId,
    engine: engineId,
    sources: [
      {
        name: 'source',
        role: 'primary',
        kind: 'file',
        path: buildRelativeAssetPath(documentPath, sourceProjectRelative),
        format: sourceFormat,
        editable: true,
      },
    ],
    transform: {
      path: buildRelativeAssetPath(documentPath, transformProjectRelative),
      output: 'view_tbl',
      managedBlock: 'mrmd-ops-v1',
    },
    cache: {
      path: buildRelativeAssetPath(documentPath, cacheProjectRelative),
      format: cacheFormat,
    },
    view: {
      document: {
        maxRows,
        overflow,
        defaultState: 'frozen',
      },
      grid: {
        showTechnicalColumns: false,
        allowRawSourceEdits: true,
      },
    },
  };

  const engine = createRDplyrEngine();
  const scaffold = await engine.scaffoldTransform(spec);
  await fsPromises.mkdir(path.dirname(transformAbsolute), { recursive: true });
  await fsPromises.writeFile(transformAbsolute, scaffold.transformText, 'utf8');

  await writeDelimitedFile(cacheAbsolute, cacheFormat, table);

  const snapshot = await engine.createSnapshot(spec, {
    rowCount: table.rows.length,
    columnNames: table.columnNames,
    rows: table.rows,
  });

  spec.snapshot = {
    rowCount: table.rows.length,
    materializedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    tableId: finalTableId,
    spec,
    transformText: scaffold.transformText,
    snapshotMarkdown: snapshot.markdown,
    blockMarkdown: buildLinkedTableBlockText(spec, snapshot.markdown),
    paths: {
      tableDirProjectRelative,
      sourceProjectRelative,
      transformProjectRelative,
      cacheProjectRelative,
      sourceAbsolute,
      transformAbsolute,
      cacheAbsolute,
    },
    source: {
      format: sourceFormat,
      rowCount: table.rows.length,
      columnNames: table.columnNames,
    },
  };
}

export default {
  importLinkedTableFile,
};
