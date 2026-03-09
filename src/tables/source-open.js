/**
 * Linked-table source path helpers.
 */

import path from 'node:path';

function resolveAgainstDocument(projectRoot, documentPath, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return null;
  if (path.isAbsolute(relativePath)) return relativePath;

  const documentDir = path.dirname(documentPath || '.');
  return path.resolve(projectRoot, documentDir, relativePath);
}

export function resolveLinkedTablePaths({ projectRoot, documentPath, spec }) {
  if (!projectRoot) {
    throw new Error('resolveLinkedTablePaths requires `projectRoot`');
  }
  if (!documentPath) {
    throw new Error('resolveLinkedTablePaths requires `documentPath`');
  }
  if (!spec) {
    throw new Error('resolveLinkedTablePaths requires `spec`');
  }

  return {
    tableId: spec.id,
    transformPath: resolveAgainstDocument(projectRoot, documentPath, spec.transform?.path),
    cachePath: resolveAgainstDocument(projectRoot, documentPath, spec.cache?.path),
    sourcePaths: (spec.sources || []).map((source) => ({
      name: source.name,
      role: source.role || null,
      kind: source.kind || null,
      path: resolveAgainstDocument(projectRoot, documentPath, source.path),
      format: source.format || null,
    })),
  };
}

export default {
  resolveLinkedTablePaths,
};
