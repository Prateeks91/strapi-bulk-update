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

export const BULK_UPDATER_PERMISSIONS_LAYOUT = {
  canRead: [{ action: PERMISSIONS.read, subject: null }],
  canWorkspaceView: [{ action: PERMISSIONS.workspaceView, subject: null }],
  canWorkspaceExecute: [{ action: PERMISSIONS.workspaceExecute, subject: null }],
  canWorkspacePublish: [{ action: PERMISSIONS.workspacePublish, subject: null }],
  canCsvExport: [{ action: PERMISSIONS.csvExport, subject: null }],
  canCsvImport: [{ action: PERMISSIONS.csvImport, subject: null }],
  canAuditView: [{ action: PERMISSIONS.auditView, subject: null }],
  canAuditDetails: [{ action: PERMISSIONS.auditDetails, subject: null }],
  canAuditRollback: [{ action: PERMISSIONS.auditRollback, subject: null }],
  canApprovalView: [{ action: PERMISSIONS.approvalView, subject: null }],
  canApprovalApprove: [{ action: PERMISSIONS.approvalApprove, subject: null }],
  canApprovalReject: [{ action: PERMISSIONS.approvalReject, subject: null }],
  canValidationView: [{ action: PERMISSIONS.validationView, subject: null }],
  canValidationManage: [{ action: PERMISSIONS.validationManage, subject: null }],
  canSettingsView: [{ action: PERMISSIONS.settingsView, subject: null }],
  canSettingsManage: [{ action: PERMISSIONS.settingsManage, subject: null }],
};
