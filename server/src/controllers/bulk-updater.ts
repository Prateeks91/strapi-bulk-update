import type { Core } from '@strapi/strapi';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getModels(ctx: any) {
    try {
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const data = await service.getModels();

      if (data?.etag) {
        ctx.set('ETag', data.etag);
        ctx.set('Cache-Control', 'private, no-cache');
      }

      ctx.body = data;
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async getCollectionEntries(ctx: any) {
    try {
      const { uid } = ctx.params;
      const { page, pageSize, attribute, searchAttribute, filterOperator, filterQuery, search, sortField, sortOrder } = ctx.query;
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const data = await service.getCollectionEntries(uid, {
        page: page ? Number(page) : 1,
        pageSize: pageSize ? Number(pageSize) : 10,
        attribute: attribute ? String(attribute) : undefined,
        searchAttribute: searchAttribute ? String(searchAttribute) : undefined,
        filterOperator: filterOperator ? String(filterOperator) : undefined,
        filterQuery: filterQuery !== undefined ? String(filterQuery) : undefined,
        search: search ? String(search) : undefined,
        sortField: sortField ? String(sortField) : undefined,
        sortOrder: sortOrder === 'asc' ? 'asc' : 'desc',
      });

      if (data?.etag) {
        ctx.set('ETag', data.etag);
        ctx.set('Cache-Control', 'private, no-cache');
      }

      ctx.body = { success: true, ...data };
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async getRelationOptions(ctx: any) {
    try {
      const { targetUid } = ctx.query;
      if (!targetUid) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'targetUid is required' };
        return;
      }
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const data = await service.getRelationOptions(String(targetUid));
      ctx.body = { success: true, ...data };
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async batchUpdate(ctx: any) {
    try {
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const currentUser = ctx.state.user;
      const result = await service.batchUpdate(ctx.request.body || {}, currentUser);
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 400;
      ctx.body = { success: false, error: err.message };
    }
  },

  async batchPublish(ctx: any) {
    try {
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const currentUser = ctx.state.user;
      const result = await service.batchPublish(ctx.request.body || {}, currentUser);
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 400;
      ctx.body = { success: false, error: err.message };
    }
  },

  async previewBatch(ctx: any) {
    try {
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const result = await service.previewBatch(ctx.request.body || {});
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 400;
      ctx.body = { success: false, error: err.message };
    }
  },

  async getPendingBatches(ctx: any) {
    try {
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const result = await service.getPendingBatches();
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async approveBatch(ctx: any) {
    try {
      const { batchId } = ctx.params;
      const { executeImmediately = true } = ctx.request.body || {};
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const currentUser = ctx.state.user;
      const result = await service.approveBatch(batchId, currentUser, { executeImmediately });
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 400;
      ctx.body = { success: false, error: err.message };
    }
  },

  async rejectBatch(ctx: any) {
    try {
      const { batchId } = ctx.params;
      const { reason } = ctx.request.body || {};
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const currentUser = ctx.state.user;
      const result = await service.rejectBatch(batchId, currentUser, reason);
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 400;
      ctx.body = { success: false, error: err.message };
    }
  },

  async executeNow(ctx: any) {
    try {
      const { batchId } = ctx.params;
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const currentUser = ctx.state.user;
      const result = await service.executeNow(batchId, currentUser);
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 400;
      ctx.body = { success: false, error: err.message };
    }
  },

  async getBatchStatus(ctx: any) {
    try {
      const { batchId } = ctx.params;
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const result = await service.getBatchStatus(batchId);
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 404;
      ctx.body = { success: false, error: err.message };
    }
  },

  async getBatchReport(ctx: any) {
    try {
      const { batchId } = ctx.params;
      const { format = 'csv' } = ctx.query;
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const result = await service.getBatchReport(batchId, format);
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async getRecentBatches(ctx: any) {
    try {
      const service = strapi.plugin('bulk-updater').service('bulkUpdater');
      const result = await service.getRecentBatches();
      ctx.body = result;
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },
});
