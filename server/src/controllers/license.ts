import type { Core } from '@strapi/strapi';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getStatus(ctx: any) {
    try {
      const service = strapi.plugin('bulk-updater').service('license');
      const license = await service.getLicenseStatus();
      ctx.body = { success: true, license };
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async verify(ctx: any) {
    try {
      const { licenseKey } = ctx.request.body || {};
      const service = strapi.plugin('bulk-updater').service('license');
      const result = await service.verifyAndActivateLicense(licenseKey);
      if (!result.success) {
        ctx.status = 400;
        ctx.body = result;
        return;
      }
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async deactivate(ctx: any) {
    try {
      const service = strapi.plugin('bulk-updater').service('license');
      const license = await service.deactivateLicense();
      ctx.body = { success: true, license };
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },
});
