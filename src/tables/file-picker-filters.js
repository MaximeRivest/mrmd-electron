/**
 * Linked-table file picker filters and source-format helpers.
 */

import path from 'node:path';

export const SUPPORTED_TABLE_EXTENSIONS = [
  '.csv',
  '.tsv',
  '.parquet',
  '.arrow',
  '.feather',
  '.ipc',
];

export const DELIMITED_TABLE_EXTENSIONS = ['.csv', '.tsv'];

export const TABLE_SOURCE_FILTERS = [
  {
    name: 'Tabular data',
    extensions: SUPPORTED_TABLE_EXTENSIONS.map((ext) => ext.slice(1)),
  },
  {
    name: 'Delimited text',
    extensions: DELIMITED_TABLE_EXTENSIONS.map((ext) => ext.slice(1)),
  },
];

export function inferTableFormatFromPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.tsv') return 'tsv';
  if (ext === '.parquet') return 'parquet';
  if (ext === '.feather' || ext === '.arrow' || ext === '.ipc') return 'arrow';
  return null;
}

export function isSupportedTablePath(filePath) {
  return !!inferTableFormatFromPath(filePath);
}

export function isDelimitedTablePath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return DELIMITED_TABLE_EXTENSIONS.includes(ext);
}

export default {
  SUPPORTED_TABLE_EXTENSIONS,
  DELIMITED_TABLE_EXTENSIONS,
  TABLE_SOURCE_FILTERS,
  inferTableFormatFromPath,
  isSupportedTablePath,
  isDelimitedTablePath,
};
