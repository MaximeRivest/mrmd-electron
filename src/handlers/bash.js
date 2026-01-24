/**
 * Bash Session Handlers
 */

export const bashHandlers = {
  async list(args, ctx) {
    return ctx.bashService.list();
  },

  async start({ config }, ctx) {
    return ctx.bashService.start(config);
  },

  async stop({ sessionName }, ctx) {
    return ctx.bashService.stop(sessionName);
  },

  async restart({ sessionName }, ctx) {
    return ctx.bashService.restart(sessionName);
  },

  async forDocument({ documentPath }, ctx) {
    return ctx.bashService.forDocument(documentPath);
  },
};
