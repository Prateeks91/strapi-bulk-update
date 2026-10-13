export default {
  collectionName: 'bulk_updater_audit_logs',
  info: {
    singularName: 'audit-log',
    pluralName: 'audit-logs',
    displayName: 'Bulk Updater Audit Log',
    description: 'Internal audit trail for bulk attribute and relation updates',
  },
  options: {
    draftAndPublish: false,
  },
  pluginOptions: {
    'content-manager': {
      visible: true,
    },
    'content-type-builder': {
      visible: false,
    },
  },
  attributes: {
    batchId: {
      type: 'string',
      required: true,
    },
    attribute: {
      type: 'string',
      required: true,
    },
    value: {
      type: 'text',
    },
    userEmail: {
      type: 'string',
    },
    userName: {
      type: 'string',
    },
    updatedCount: {
      type: 'integer',
      default: 0,
    },
    skippedCount: {
      type: 'integer',
      default: 0,
    },
    totalTargets: {
      type: 'integer',
      default: 0,
    },
    diffs: {
      type: 'json',
    },
    isRolledBack: {
      type: 'boolean',
      default: false,
    },
    rolledBackAt: {
      type: 'datetime',
    },
    rolledBackBy: {
      type: 'string',
    },
    executedAt: {
      type: 'datetime',
    },
  },
};
