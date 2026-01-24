/**
 * Asset Handlers
 */

export const assetHandlers = {
  async list({ projectRoot }, ctx) {
    return ctx.assetService.list(projectRoot || ctx.projectDir);
  },

  async save({ projectRoot, file, filename }, ctx) {
    // file comes as array of bytes from IPC, or base64 from HTTP
    const buffer = Array.isArray(file) ? Buffer.from(file) : Buffer.from(file, 'base64');
    return ctx.assetService.save(projectRoot || ctx.projectDir, buffer, filename);
  },

  async relativePath({ assetPath, documentPath }, ctx) {
    return ctx.assetService.getRelativePath(assetPath, documentPath);
  },

  async orphans({ projectRoot }, ctx) {
    return ctx.assetService.findOrphans(projectRoot || ctx.projectDir);
  },

  async delete({ projectRoot, assetPath }, ctx) {
    return ctx.assetService.delete(projectRoot || ctx.projectDir, assetPath);
  },
};
