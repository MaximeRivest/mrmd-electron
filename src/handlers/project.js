/**
 * Project Handlers
 *
 * These handlers are used by both Electron (IPC) and mrmd-server (HTTP).
 * Each handler: async (args, context) => result
 */

/**
 * @typedef {object} HandlerContext
 * @property {import('../services/project-service.js').ProjectService} projectService
 * @property {string} projectDir - Base project directory
 * @property {import('../events.js').EventBus} [eventBus] - For push events
 * @property {Map} [watchers] - File watchers
 */

export const projectHandlers = {
  /**
   * Get project info for a file path
   * @param {{ filePath: string }} args
   * @param {HandlerContext} ctx
   */
  async get({ filePath }, ctx) {
    if (!filePath) {
      throw new Error('filePath is required');
    }
    return ctx.projectService.getProject(filePath);
  },

  /**
   * Create a new mrmd project
   * @param {{ targetPath: string }} args
   * @param {HandlerContext} ctx
   */
  async create({ targetPath }, ctx) {
    if (!targetPath) {
      throw new Error('targetPath is required');
    }
    return ctx.projectService.createProject(targetPath);
  },

  /**
   * Get navigation tree for a project
   * @param {{ projectRoot: string }} args
   * @param {HandlerContext} ctx
   */
  async nav({ projectRoot }, ctx) {
    const root = projectRoot || ctx.projectDir;
    return ctx.projectService.getNavTree(root);
  },

  /**
   * Invalidate cached project info
   * @param {{ projectRoot: string }} args
   * @param {HandlerContext} ctx
   */
  async invalidate({ projectRoot }, ctx) {
    const root = projectRoot || ctx.projectDir;
    ctx.projectService.invalidateCache(root);
    ctx.eventBus?.projectChanged(root);
    return { success: true };
  },

  /**
   * Watch project for file changes
   * @param {{ projectRoot: string }} args
   * @param {HandlerContext} ctx
   */
  async watch({ projectRoot }, ctx) {
    const root = projectRoot || ctx.projectDir;
    await ctx.projectService.watch(root, (changedPath) => {
      ctx.eventBus?.projectChanged(root);
    });
    return { success: true, watching: root };
  },

  /**
   * Stop watching project
   * @param {object} args
   * @param {HandlerContext} ctx
   */
  async unwatch(args, ctx) {
    await ctx.projectService.unwatchAll();
    return { success: true };
  },
};
