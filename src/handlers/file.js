/**
 * File Handlers
 */

export const fileHandlers = {
  async scan({ root, options }, ctx) {
    return ctx.fileService.scan(root || ctx.projectDir, options);
  },

  async create({ filePath, content }, ctx) {
    return ctx.fileService.create(filePath, content);
  },

  async createInProject({ projectRoot, relativePath, content }, ctx) {
    return ctx.fileService.createInProject(projectRoot || ctx.projectDir, relativePath, content);
  },

  async move({ projectRoot, fromPath, toPath }, ctx) {
    return ctx.fileService.move(projectRoot || ctx.projectDir, fromPath, toPath);
  },

  async reorder({ projectRoot, sourcePath, targetPath, position }, ctx) {
    return ctx.fileService.reorder(projectRoot || ctx.projectDir, sourcePath, targetPath, position);
  },

  async delete({ filePath }, ctx) {
    return ctx.fileService.delete(filePath);
  },

  async read({ filePath }, ctx) {
    return ctx.fileService.read(filePath);
  },

  async write({ filePath, content }, ctx) {
    return ctx.fileService.write(filePath, content);
  },

  async preview({ filePath, lines }, ctx) {
    return ctx.fileService.readPreview(filePath, lines);
  },

  async info({ filePath }, ctx) {
    return ctx.fileService.getInfo(filePath);
  },
};
