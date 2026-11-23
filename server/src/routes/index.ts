import { PERMISSIONS } from '../constants/permissions';

function requirePermissions(actions: string | string[], mode: 'all' | 'any' = 'all') {
  return [
    {
      name: 'plugin::bulk-updater.hasPermissions',
      config: {
        actions: Array.isArray(actions) ? actions : [actions],
        mode,
      },
    },
  ];
}

export default {
  admin: {
    type: 'admin',
    routes: [
      {
        method: 'GET',
        path: '/models',
        handler: 'bulkUpdater.getModels',
        config: {
          policies: requirePermissions(
            [
              PERMISSIONS.workspaceView,
              PERMISSIONS.csvExport,
              PERMISSIONS.csvImport,
              PERMISSIONS.validationView,
            ],
            'any'
          ),
        },
      },
      {
        method: 'GET',
        path: '/collections/:uid/entries',
        handler: 'bulkUpdater.getCollectionEntries',
        config: {
          policies: requirePermissions(
            [PERMISSIONS.workspaceView, PERMISSIONS.csvExport, PERMISSIONS.csvImport],
            'any'
          ),
        },
      },
      {
        method: 'GET',
        path: '/relation-options',
        handler: 'bulkUpdater.getRelationOptions',
        config: {
          policies: requirePermissions(
            [PERMISSIONS.workspaceView, PERMISSIONS.csvExport, PERMISSIONS.csvImport],
            'any'
          ),
        },
      },
      {
        method: 'GET',
        path: '/media-options',
        handler: 'bulkUpdater.getMediaOptions',
        config: {
          policies: requirePermissions(
            [PERMISSIONS.workspaceView, PERMISSIONS.csvExport, PERMISSIONS.csvImport],
            'any'
          ),
        },
      },
      {
        method: 'POST',
        path: '/batch-update',
        handler: 'bulkUpdater.batchUpdate',
        config: {
          policies: requirePermissions(PERMISSIONS.workspaceExecute),
        },
      },
      {
        method: 'POST',
        path: '/batch-publish',
        handler: 'bulkUpdater.batchPublish',
        config: {
          policies: requirePermissions(PERMISSIONS.workspacePublish),
        },
      },
      {
        method: 'POST',
        path: '/preview',
        handler: 'bulkUpdater.previewBatch',
        config: {
          policies: requirePermissions(PERMISSIONS.workspaceExecute),
        },
      },
      {
        method: 'GET',
        path: '/pending-batches',
        handler: 'bulkUpdater.getPendingBatches',
        config: {
          policies: requirePermissions(PERMISSIONS.approvalView),
        },
      },
      {
        method: 'POST',
        path: '/batches/:batchId/approve',
        handler: 'bulkUpdater.approveBatch',
        config: {
          policies: requirePermissions(PERMISSIONS.approvalApprove),
        },
      },
      {
        method: 'POST',
        path: '/batches/:batchId/reject',
        handler: 'bulkUpdater.rejectBatch',
        config: {
          policies: requirePermissions(PERMISSIONS.approvalReject),
        },
      },
      {
        method: 'POST',
        path: '/batches/:batchId/execute-now',
        handler: 'bulkUpdater.executeNow',
        config: {
          policies: requirePermissions(PERMISSIONS.approvalApprove),
        },
      },
      {
        method: 'GET',
        path: '/batches/recent',
        handler: 'bulkUpdater.getRecentBatches',
        config: {
          policies: requirePermissions(
            [PERMISSIONS.workspaceView, PERMISSIONS.auditView, PERMISSIONS.approvalView],
            'any'
          ),
        },
      },
      {
        method: 'GET',
        path: '/batches/:batchId/status',
        handler: 'bulkUpdater.getBatchStatus',
        config: {
          policies: requirePermissions(
            [
              PERMISSIONS.workspaceView,
              PERMISSIONS.workspaceExecute,
              PERMISSIONS.csvImport,
              PERMISSIONS.auditView,
              PERMISSIONS.approvalView,
            ],
            'any'
          ),
        },
      },
      {
        method: 'GET',
        path: '/batches/:batchId/report',
        handler: 'bulkUpdater.getBatchReport',
        config: {
          policies: requirePermissions([PERMISSIONS.auditDetails, PERMISSIONS.approvalView], 'any'),
        },
      },
      {
        method: 'GET',
        path: '/batches/:batchId/diffs',
        handler: 'bulkUpdater.getPendingBatchDiffs',
        config: {
          policies: requirePermissions([PERMISSIONS.approvalView, PERMISSIONS.auditDetails], 'any'),
        },
      },
      {
        method: 'GET',
        path: '/batches/:batchId/diffs/export',
        handler: 'bulkUpdater.exportPendingBatchDiffs',
        config: {
          policies: requirePermissions([PERMISSIONS.approvalView, PERMISSIONS.auditDetails], 'any'),
        },
      },
      {
        method: 'GET',
        path: '/audit/history',
        handler: 'audit.getHistory',
        config: {
          policies: requirePermissions(PERMISSIONS.auditView),
        },
      },
      {
        method: 'POST',
        path: '/audit/:batchId/rollback',
        handler: 'audit.rollback',
        config: {
          policies: requirePermissions(PERMISSIONS.auditRollback),
        },
      },
      {
        method: 'GET',
        path: '/validation-rules',
        handler: 'validationRules.getRules',
        config: {
          policies: requirePermissions(PERMISSIONS.validationView),
        },
      },
      {
        method: 'POST',
        path: '/validation-rules',
        handler: 'validationRules.saveRule',
        config: {
          policies: requirePermissions(PERMISSIONS.validationManage),
        },
      },
      {
        method: 'DELETE',
        path: '/validation-rules/:id',
        handler: 'validationRules.deleteRule',
        config: {
          policies: requirePermissions(PERMISSIONS.validationManage),
        },
      },
      {
        method: 'POST',
        path: '/validation-rules/:id/toggle',
        handler: 'validationRules.toggleRule',
        config: {
          policies: requirePermissions(PERMISSIONS.validationManage),
        },
      },
      {
        method: 'GET',
        path: '/validation-rules/:id/scan',
        handler: 'validationRules.scanViolations',
        config: {
          policies: requirePermissions(PERMISSIONS.validationView),
        },
      },
      {
        method: 'GET',
        path: '/csv/template/:uid',
        handler: 'csv.getTemplate',
        config: {
          policies: requirePermissions([PERMISSIONS.csvExport, PERMISSIONS.csvImport], 'any'),
        },
      },
      {
        method: 'GET',
        path: '/csv/export/:uid',
        handler: 'csv.exportCollection',
        config: {
          policies: requirePermissions(PERMISSIONS.csvExport),
        },
      },
      {
        method: 'POST',
        path: '/csv/export/:uid',
        handler: 'csv.exportCollection',
        config: {
          policies: requirePermissions(PERMISSIONS.csvExport),
        },
      },
      {
        method: 'POST',
        path: '/csv/export-bulk',
        handler: 'csv.exportBulk',
        config: {
          policies: requirePermissions(PERMISSIONS.csvExport),
        },
      },
      {
        method: 'GET',
        path: '/csv/export-violations/:ruleId',
        handler: 'csv.exportViolations',
        config: {
          policies: requirePermissions(PERMISSIONS.csvExport),
        },
      },
      {
        method: 'POST',
        path: '/csv/import',
        handler: 'csv.importCsv',
        config: {
          policies: requirePermissions(PERMISSIONS.csvImport),
        },
      },
      {
        method: 'POST',
        path: '/csv/import-chunk',
        handler: 'csv.importChunk',
        config: {
          policies: requirePermissions(PERMISSIONS.csvImport),
        },
      },
      {
        method: 'POST',
        path: '/csv/validate-preflight',
        handler: 'csv.validatePreflight',
        config: {
          policies: requirePermissions(PERMISSIONS.csvImport),
        },
      },
      {
        method: 'POST',
        path: '/csv/submit-batch',
        handler: 'csv.submitBatch',
        config: {
          policies: requirePermissions(PERMISSIONS.csvImport),
        },
      },
    ],
  },
};
