export default {
  admin: {
    type: 'admin',
    routes: [
      {
        method: 'GET',
        path: '/models',
        handler: 'bulkUpdater.getModels',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/collections/:uid/entries',
        handler: 'bulkUpdater.getCollectionEntries',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/relation-options',
        handler: 'bulkUpdater.getRelationOptions',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/batch-update',
        handler: 'bulkUpdater.batchUpdate',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/preview',
        handler: 'bulkUpdater.previewBatch',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/pending-batches',
        handler: 'bulkUpdater.getPendingBatches',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/batches/:batchId/approve',
        handler: 'bulkUpdater.approveBatch',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/batches/:batchId/reject',
        handler: 'bulkUpdater.rejectBatch',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/batches/:batchId/execute-now',
        handler: 'bulkUpdater.executeNow',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/batches/recent',
        handler: 'bulkUpdater.getRecentBatches',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/batches/:batchId/status',
        handler: 'bulkUpdater.getBatchStatus',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/batches/:batchId/report',
        handler: 'bulkUpdater.getBatchReport',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/audit/history',
        handler: 'audit.getHistory',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/audit/:batchId/rollback',
        handler: 'audit.rollback',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/validation-rules',
        handler: 'validationRules.getRules',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/validation-rules',
        handler: 'validationRules.saveRule',
        config: {
          policies: [],
        },
      },
      {
        method: 'DELETE',
        path: '/validation-rules/:id',
        handler: 'validationRules.deleteRule',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/validation-rules/:id/toggle',
        handler: 'validationRules.toggleRule',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/validation-rules/:id/scan',
        handler: 'validationRules.scanViolations',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/csv/template/:uid',
        handler: 'csv.getTemplate',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/csv/export/:uid',
        handler: 'csv.exportCollection',
        config: {
          policies: [],
        },
      },
      {
        method: 'GET',
        path: '/csv/export-violations/:ruleId',
        handler: 'csv.exportViolations',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/csv/import',
        handler: 'csv.importCsv',
        config: {
          policies: [],
        },
      },
    ],
  },
};
