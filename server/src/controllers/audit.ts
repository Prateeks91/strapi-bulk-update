import type { Core } from '@strapi/strapi';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getHistory(ctx: any) {
    try {
      const service = strapi.plugin('bulk-updater').service('audit');
      const data = await service.getHistory();
      ctx.body = data;
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async rollback(ctx: any) {
    try {
      const { batchId } = ctx.params;
      const service = strapi.plugin('bulk-updater').service('audit');
      const currentUser = ctx.state.user;
      const result = await service.rollbackBatch(batchId, currentUser);
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 400;
      ctx.body = { success: false, error: err.message };
    }
  },
});
