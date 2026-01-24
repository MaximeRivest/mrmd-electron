/**
 * System Handlers
 */

import os from 'os';

export const systemHandlers = {
  async getHomeDir(args, ctx) {
    return { homeDir: os.homedir() };
  },

  async getRecent(args, ctx) {
    return ctx.recentService?.getRecent() || { files: [], venvs: [] };
  },

  async getAi(args, ctx) {
    return {
      port: ctx.aiPort || 51790,
      url: `http://localhost:${ctx.aiPort || 51790}`,
    };
  },

  async discoverVenvs({ projectDir }, ctx) {
    // Start async discovery, results come via events
    ctx.venvService?.discover(projectDir || ctx.projectDir);
    return { started: true };
  },

  async installMrmdPython({ venvPath }, ctx) {
    return ctx.pythonService?.installMrmdPython(venvPath);
  },

  async startPython({ venvPath, forceNew }, ctx) {
    return ctx.pythonService?.start(venvPath, forceNew);
  },

  async listRuntimes(args, ctx) {
    return ctx.runtimeService?.list() || [];
  },

  async killRuntime({ runtimeId }, ctx) {
    return ctx.runtimeService?.kill(runtimeId);
  },

  async attachRuntime({ runtimeId }, ctx) {
    return ctx.runtimeService?.attach(runtimeId);
  },

  // Shell operations - these are Electron-specific but we provide stubs
  async shellShowInFolder({ fullPath }, ctx) {
    if (ctx.shell?.showItemInFolder) {
      ctx.shell.showItemInFolder(fullPath);
      return { success: true };
    }
    return { success: false, message: 'Not available', path: fullPath };
  },

  async shellOpenExternal({ url }, ctx) {
    if (ctx.shell?.openExternal) {
      await ctx.shell.openExternal(url);
      return { success: true };
    }
    return { success: true, url, action: 'window.open' };
  },

  async shellOpenPath({ fullPath }, ctx) {
    if (ctx.shell?.openPath) {
      await ctx.shell.openPath(fullPath);
      return { success: true };
    }
    return { success: false, message: 'Not available', path: fullPath };
  },
};
