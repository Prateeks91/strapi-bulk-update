export const PLUGIN_ID = 'bulk-updater';

export const PERMISSIONS = {
  // General (support both .read and .access aliases)
  read: `plugin::${PLUGIN_ID}.read`,
  access: `plugin::${PLUGIN_ID}.access`,

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

/**
 * Menu link permission guards:
 * If the user has ANY of the main functional permissions or the general access permission,
 * the main menu link will be displayed in Strapi's navigation bar.
 */
export const MAIN_MENU_PERMISSIONS = [
  { action: PERMISSIONS.read, subject: null },
  { action: PERMISSIONS.access, subject: null },
  { action: PERMISSIONS.workspaceView, subject: null },
  { action: PERMISSIONS.auditView, subject: null },
  { action: PERMISSIONS.approvalView, subject: null },
  { action: PERMISSIONS.validationView, subject: null },
  { action: PERMISSIONS.csvExport, subject: null },
  { action: PERMISSIONS.csvImport, subject: null },
];

export const SETTINGS_MENU_PERMISSIONS = [
  { action: PERMISSIONS.settingsView, subject: null },
  { action: PERMISSIONS.settingsManage, subject: null },
];
