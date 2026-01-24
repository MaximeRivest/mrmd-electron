/**
 * Session Handlers
 */

export const sessionHandlers = {
  async list(args, ctx) {
    return ctx.sessionService.list();
  },

  async start({ config }, ctx) {
    return ctx.sessionService.start(config);
  },

  async stop({ sessionName }, ctx) {
    return ctx.sessionService.stop(sessionName);
  },

  async restart({ sessionName }, ctx) {
    return ctx.sessionService.restart(sessionName);
  },

  async forDocument({ documentPath }, ctx) {
    return ctx.sessionService.forDocument(documentPath);
  },
};
