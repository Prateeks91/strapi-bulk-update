import type { Core } from '@strapi/strapi';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getRules(ctx: any) {
    try {
      const rules = await strapi.plugin('bulk-updater').service('validationRules').getRules();
      ctx.body = {
        success: true,
        rules,
      };
    } catch (err: any) {
      ctx.throw(500, err.message);
    }
  },

  async saveRule(ctx: any) {
    try {
      const { rule } = ctx.request.body || {};
      if (!rule) {
        return ctx.badRequest('Rule payload is required');
      }
      const saved = await strapi.plugin('bulk-updater').service('validationRules').saveRule(rule);
      ctx.body = {
        success: true,
        rule: saved,
      };
    } catch (err: any) {
      ctx.throw(500, err.message);
    }
  },

  async deleteRule(ctx: any) {
    try {
      const { id } = ctx.params;
      if (!id) {
        return ctx.badRequest('Rule ID is required');
      }
      await strapi.plugin('bulk-updater').service('validationRules').deleteRule(id);
      ctx.body = {
        success: true,
        id,
      };
    } catch (err: any) {
      ctx.throw(500, err.message);
    }
  },

  async toggleRule(ctx: any) {
    try {
      const { id } = ctx.params;
      const { enabled } = ctx.request.body || {};
      const updated = await strapi.plugin('bulk-updater').service('validationRules').toggleRule(id, enabled);
      if (!updated) {
        return ctx.notFound('Rule not found');
      }
      ctx.body = {
        success: true,
        rule: updated,
      };
    } catch (err: any) {
      ctx.throw(500, err.message);
    }
  },

  async scanViolations(ctx: any) {
    try {
      const { id } = ctx.params;
      if (!id) {
        return ctx.badRequest('Rule ID is required');
      }
      const report = await strapi.plugin('bulk-updater').service('validationRules').scanViolations(id);
      ctx.body = {
        success: true,
        ...report,
      };
    } catch (err: any) {
      ctx.throw(500, err.message);
    }
  },
});
