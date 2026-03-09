/**
 * Linked-table host handlers.
 */

export const tableHandlers = {
  async filters() {
    const { TABLE_SOURCE_FILTERS } = await import('../tables/file-picker-filters.js');
    return {
      sourceFilters: TABLE_SOURCE_FILTERS,
    };
  },

  async importDelimited({ projectRoot, documentPath, sourceFilePath, tableId, reuseExisting, label, cacheFormat, maxRows, overflow }, ctx) {
    const { importLinkedTableFile } = await import('../tables/asset-import.js');
    return importLinkedTableFile({
      projectRoot: projectRoot || ctx.projectDir,
      documentPath,
      sourceFilePath,
      tableId,
      reuseExisting,
      label,
      cacheFormat,
      maxRows,
      overflow,
    });
  },

  async resolvePaths({ projectRoot, documentPath, spec }, ctx) {
    const { resolveLinkedTablePaths } = await import('../tables/source-open.js');
    return resolveLinkedTablePaths({
      projectRoot: projectRoot || ctx.projectDir,
      documentPath,
      spec,
    });
  },
};
