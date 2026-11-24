import { useMemo } from 'react';
import { useRBAC } from '@strapi/strapi/admin';
import { BULK_UPDATER_PERMISSIONS_LAYOUT } from '../constants/permissions';

export interface BulkUpdaterRBACPermissions {
  isLoading: boolean;
  canRead: boolean;
  canWorkspaceView: boolean;
  canWorkspaceExecute: boolean;
  canWorkspacePublish: boolean;
  canCsvExport: boolean;
  canCsvImport: boolean;
  canAuditView: boolean;
  canAuditDetails: boolean;
  canAuditRollback: boolean;
  canApprovalView: boolean;
  canApprovalApprove: boolean;
  canApprovalReject: boolean;
  canValidationView: boolean;
  canValidationManage: boolean;
  canSettingsView: boolean;
  canSettingsManage: boolean;
}

export function useBulkUpdaterRBAC(): BulkUpdaterRBACPermissions {
  let rbacResult: any = null;

  try {
    if (typeof useRBAC === 'function') {
      rbacResult = useRBAC(BULK_UPDATER_PERMISSIONS_LAYOUT);
    }
  } catch {
    rbacResult = null;
  }

  return useMemo(() => {
    if (!rbacResult) {
      // Fallback for tests or non-admin mock contexts
      return {
        isLoading: false,
        canRead: true,
        canWorkspaceView: true,
        canWorkspaceExecute: true,
        canWorkspacePublish: true,
        canCsvExport: true,
        canCsvImport: true,
        canAuditView: true,
        canAuditDetails: true,
        canAuditRollback: true,
        canApprovalView: true,
        canApprovalApprove: true,
        canApprovalReject: true,
        canValidationView: true,
        canValidationManage: true,
        canSettingsView: true,
        canSettingsManage: true,
      };
    }

    const { isLoading = false, allowedActions = {} } = rbacResult;

    return {
      isLoading,
      canRead: Boolean(allowedActions.canRead),
      canWorkspaceView: Boolean(allowedActions.canWorkspaceView),
      canWorkspaceExecute: Boolean(allowedActions.canWorkspaceExecute),
      canWorkspacePublish: Boolean(allowedActions.canWorkspacePublish),
      canCsvExport: Boolean(allowedActions.canCsvExport),
      canCsvImport: Boolean(allowedActions.canCsvImport),
      canAuditView: Boolean(allowedActions.canAuditView),
      canAuditDetails: Boolean(allowedActions.canAuditDetails),
      canAuditRollback: Boolean(allowedActions.canAuditRollback),
      canApprovalView: Boolean(allowedActions.canApprovalView),
      canApprovalApprove: Boolean(allowedActions.canApprovalApprove),
      canApprovalReject: Boolean(allowedActions.canApprovalReject),
      canValidationView: Boolean(allowedActions.canValidationView),
      canValidationManage: Boolean(allowedActions.canValidationManage),
      canSettingsView: Boolean(allowedActions.canSettingsView),
      canSettingsManage: Boolean(allowedActions.canSettingsManage),
    };
  }, [rbacResult]);
}
