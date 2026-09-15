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
        path: '/license',
        handler: 'license.getStatus',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/license/verify',
        handler: 'license.verify',
        config: {
          policies: [],
        },
      },
      {
        method: 'POST',
        path: '/license/deactivate',
        handler: 'license.deactivate',
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
    ],
  },
};
