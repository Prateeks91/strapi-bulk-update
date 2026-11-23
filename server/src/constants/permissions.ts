export const PLUGIN_ID = 'bulk-updater';

export const PERMISSIONS = {
  // General
  read: `plugin::${PLUGIN_ID}.read`,

  // Workspace
  workspaceView: `plugin::${PLUGIN_ID}.workspace.view`,
  workspaceExecute: `plugin::${PLUGIN_ID}.workspace.execute`,
  workspacePublish: `plugin::${PLUGIN_ID}.workspace.publish`,

  // CSV Management
  csvExport: `plugin::${PLUGIN_ID}.csv.export`,
  csvImport: `plugin::${PLUGIN_ID}.csv.import`,

  // Audit Trail
  auditView: `plugin::${PLUGIN_ID}.audit.view`,
  auditDetails: `plugin::${PLUGIN_ID}.audit.details`,
  auditRollback: `plugin::${PLUGIN_ID}.audit.rollback`,

  // Approvals (Maker-Checker)
  approvalView: `plugin::${PLUGIN_ID}.approval.view`,
  approvalApprove: `plugin::${PLUGIN_ID}.approval.approve`,
  approvalReject: `plugin::${PLUGIN_ID}.approval.reject`,

  // Validation Rules
  validationView: `plugin::${PLUGIN_ID}.validation.view`,
  validationManage: `plugin::${PLUGIN_ID}.validation.manage`,

  // Settings
  settingsView: `plugin::${PLUGIN_ID}.settings.view`,
  settingsManage: `plugin::${PLUGIN_ID}.settings.manage`,
} as const;

export interface BulkUpdaterPermissionAction {
  section: string;
  displayName: string;
  uid: string;
  pluginName: string;
  subCategory?: string;
}

export const BULK_UPDATER_PERMISSION_ACTIONS: BulkUpdaterPermissionAction[] = [
  {
    section: 'plugins',
    displayName: 'Access Bulk Updater Plugin',
    uid: 'read',
    pluginName: PLUGIN_ID,
    subCategory: 'General',
  },
  {
    section: 'plugins',
    displayName: 'View Workspace & Collections',
    uid: 'workspace.view',
    pluginName: PLUGIN_ID,
    subCategory: 'Workspace',
  },
  {
    section: 'plugins',
    displayName: 'Execute Bulk Updates',
    uid: 'workspace.execute',
    pluginName: PLUGIN_ID,
    subCategory: 'Workspace',
  },
  {
    section: 'plugins',
    displayName: 'Execute Bulk Publishing',
    uid: 'workspace.publish',
    pluginName: PLUGIN_ID,
    subCategory: 'Workspace',
  },
  {
    section: 'plugins',
    displayName: 'Export CSV & Templates',
    uid: 'csv.export',
    pluginName: PLUGIN_ID,
    subCategory: 'CSV Management',
  },
  {
    section: 'plugins',
    displayName: 'Import CSV & Validate Preflight',
    uid: 'csv.import',
    pluginName: PLUGIN_ID,
    subCategory: 'CSV Management',
  },
  {
    section: 'plugins',
    displayName: 'View Audit History',
    uid: 'audit.view',
    pluginName: PLUGIN_ID,
    subCategory: 'Audit Trail',
  },
  {
    section: 'plugins',
    displayName: 'View Audit Details & Diffs',
    uid: 'audit.details',
    pluginName: PLUGIN_ID,
    subCategory: 'Audit Trail',
  },
  {
    section: 'plugins',
    displayName: 'Execute Batch Rollback',
    uid: 'audit.rollback',
    pluginName: PLUGIN_ID,
    subCategory: 'Audit Trail',
  },
  {
    section: 'plugins',
    displayName: 'View Pending Batches for Review',
    uid: 'approval.view',
    pluginName: PLUGIN_ID,
    subCategory: 'Approvals',
  },
  {
    section: 'plugins',
    displayName: 'Approve Batches & Execute Now',
    uid: 'approval.approve',
    pluginName: PLUGIN_ID,
    subCategory: 'Approvals',
  },
  {
    section: 'plugins',
    displayName: 'Reject Pending Batches',
    uid: 'approval.reject',
    pluginName: PLUGIN_ID,
    subCategory: 'Approvals',
  },
  {
    section: 'plugins',
    displayName: 'View Validation Rules & Scan Violations',
    uid: 'validation.view',
    pluginName: PLUGIN_ID,
    subCategory: 'Validation Rules',
  },
  {
    section: 'plugins',
    displayName: 'Create, Edit, Toggle & Delete Validation Rules',
    uid: 'validation.manage',
    pluginName: PLUGIN_ID,
    subCategory: 'Validation Rules',
  },
  {
    section: 'plugins',
    displayName: 'View Plugin Settings',
    uid: 'settings.view',
    pluginName: PLUGIN_ID,
    subCategory: 'Settings',
  },
  {
    section: 'plugins',
    displayName: 'Manage Plugin Settings',
    uid: 'settings.manage',
    pluginName: PLUGIN_ID,
    subCategory: 'Settings',
  },
];
