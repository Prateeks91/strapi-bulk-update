import type { Core } from '@strapi/strapi';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getTemplate(ctx: any) {
    try {
      const { uid } = ctx.params;
      const csvService = strapi.plugin('bulk-updater').service('csv');
      const result = await csvService.getTemplateCsv(uid);
      ctx.body = {
        success: true,
        filename: result.filename,
        csvContent: result.csvContent,
        headers: result.headers,
      };
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async exportCollection(ctx: any) {
    try {
      const { uid } = ctx.params;
      const { search, attribute, filterOperator, filterQuery, limit, documentIds } = {
        ...ctx.query,
        ...(ctx.request?.body || {}),
      };
      const csvService = strapi.plugin('bulk-updater').service('csv');

      let parsedDocIds: string[] | undefined;
      if (documentIds) {
        parsedDocIds = Array.isArray(documentIds)
          ? documentIds
          : String(documentIds)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
      }

      const result = await csvService.exportCollectionCsv(uid, {
        search: search ? String(search) : undefined,
        attribute: attribute ? String(attribute) : undefined,
        filterOperator: filterOperator ? String(filterOperator) : undefined,
        filterQuery: filterQuery !== undefined ? String(filterQuery) : undefined,
        limit: limit ? Number(limit) : undefined,
        documentIds: parsedDocIds,
      });

      ctx.body = {
        success: true,
        filename: result.filename,
        csvContent: result.csvContent,
        count: result.count,
        fields: result.fields,
      };
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async exportBulk(ctx: any) {
    try {
      const { selectedEntries } = ctx.request.body || {};
      const csvService = strapi.plugin('bulk-updater').service('csv');
      const result = await csvService.exportBulkCsv(selectedEntries);

      ctx.body = {
        success: true,
        filename: result.filename,
        csvContent: result.csvContent,
        count: result.count,
        isMultiCollection: result.isMultiCollection,
      };
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async exportViolations(ctx: any) {
    try {
      const { ruleId } = ctx.params;
      const csvService = strapi.plugin('bulk-updater').service('csv');
      const result = await csvService.exportViolationsCsv(ruleId);

      ctx.body = {
        success: true,
        filename: result.filename,
        csvContent: result.csvContent,
        count: result.count,
        ruleName: result.ruleName,
      };
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async importCsv(ctx: any) {
    try {
      const { uid, csvText, mode, publish } = ctx.request.body;
      if (!uid) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'Target collection UID is required.' };
        return;
      }
      if (!csvText || typeof csvText !== 'string') {
        ctx.status = 400;
        ctx.body = { success: false, error: 'CSV content is required.' };
        return;
      }

      const csvService = strapi.plugin('bulk-updater').service('csv');
      const result = await csvService.importCsv(uid, csvText, {
        mode: mode === 'update' ? 'update' : mode === 'create_or_override' ? 'create_or_override' : 'auto',
        publish: publish !== false,
        user: ctx.state.user,
      });

      ctx.body = result;
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async importChunk(ctx: any) {
    try {
      const { uid, rows, batchId, isFirstChunk, isLastChunk, startRowNumber, mode, publish } = ctx.request.body;
      if (!uid) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'Target collection UID is required.' };
        return;
      }
      if (!Array.isArray(rows)) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'Rows array is required.' };
        return;
      }

      const csvService = strapi.plugin('bulk-updater').service('csv');
      const result = await csvService.importChunk(uid, rows, {
        batchId: batchId ? String(batchId) : undefined,
        isFirstChunk: Boolean(isFirstChunk),
        isLastChunk: Boolean(isLastChunk),
        startRowNumber: typeof startRowNumber === 'number' ? startRowNumber : undefined,
        mode: mode === 'update' ? 'update' : mode === 'create_or_override' ? 'create_or_override' : 'auto',
        publish: publish !== false,
        user: ctx.state.user,
      });

      ctx.body = result;
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async validatePreflight(ctx: any) {
    try {
      const { uid, rows, mode } = ctx.request.body;
      if (!uid) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'Target collection UID is required.' };
        return;
      }
      if (!Array.isArray(rows)) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'Rows array is required.' };
        return;
      }

      const csvService = strapi.plugin('bulk-updater').service('csv');
      const result = await csvService.validatePreflight(uid, rows, {
        mode: mode === 'update' ? 'update' : mode === 'create_or_override' ? 'create_or_override' : 'auto',
      });

      ctx.body = result;
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },

  async submitBatch(ctx: any) {
    try {
      const { uid, rows, executionMode, makerNotes, forceImmediate, mode, publish } = ctx.request.body;
      if (!uid) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'Target collection UID is required.' };
        return;
      }
      if (!Array.isArray(rows)) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'Rows array is required.' };
        return;
      }

      const csvService = strapi.plugin('bulk-updater').service('csv');
      const result = await csvService.submitBatch(uid, rows, {
        executionMode,
        makerNotes,
        forceImmediate: Boolean(forceImmediate),
        mode: mode === 'update' ? 'update' : mode === 'create_or_override' ? 'create_or_override' : 'auto',
        publish: publish !== false,
        user: ctx.state.user,
      });

      ctx.body = result;
    } catch (err: any) {
      ctx.status = 500;
      ctx.body = { success: false, error: err.message };
    }
  },
});
