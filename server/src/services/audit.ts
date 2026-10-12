import type { Core } from '@strapi/strapi';

export interface AuditConfig {
  enabled: boolean;
  mode?: 'custom' | 'default' | 'enterprise_native' | 'disabled';
  contentType?: string;
  fields?: Record<string, string>;
  isEnterpriseNativeAvailable?: boolean;
  error?: string;
}

const DEFAULT_FIELDS: Record<string, string> = {
  batchId: 'batchId',
  attribute: 'attribute',
  value: 'value',
  userEmail: 'userEmail',
  userName: 'userName',
  updatedCount: 'updatedCount',
  skippedCount: 'skippedCount',
  totalTargets: 'totalTargets',
  diffs: 'diffs',
  isRolledBack: 'isRolledBack',
  rolledBackAt: 'rolledBackAt',
  rolledBackBy: 'rolledBackBy',
  executedAt: 'executedAt',
};

const DEFAULT_CANDIDATE_TYPES = [
  'api::audit-log.audit-log',
  'api::audit.audit',
  'api::bulk-audit-log.bulk-audit-log',
];

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Detects whether Strapi Enterprise Native Audit Log service is available.
   */
  getEnterpriseAuditService() {
    try {
      const svc =
        (strapi as any).service?.('admin::audit-logs') ||
        (strapi as any).admin?.services?.['audit-logs'];
      return svc || null;
    } catch {
      return null;
    }
  },

  /**
   * Resolves the audit configuration:
   * 1. Explicit consumer custom schema (full declarative control)
   * 2. Zero-config convention auto-detection (api::audit-log.audit-log)
   * 3. Strapi Enterprise native audit log bridge
   */
  getAuditConfig(): AuditConfig {
    const rawConfig = strapi.config.get('plugin::bulk-updater.audit') as any;
    const eeService = this.getEnterpriseAuditService();
    const isEnterpriseNativeAvailable = Boolean(
      eeService && typeof eeService.save === 'function'
    );

    // If consumer explicitly disabled audit
    if (rawConfig && rawConfig.enabled === false) {
      return {
        enabled: false,
        mode: 'disabled',
        isEnterpriseNativeAvailable,
      };
    }

    // Tier 1: Explicit consumer custom schema
    if (rawConfig?.contentType) {
      const { contentType, fields } = rawConfig;
      const schema = strapi.contentTypes[contentType];
      if (!schema) {
        return {
          enabled: false,
          mode: 'disabled',
          isEnterpriseNativeAvailable,
          error: `Declared audit contentType "${contentType}" does not exist in Strapi schema registry.`,
        };
      }

      // Check fields or fallback to DEFAULT_FIELDS
      const resolvedFields = { ...DEFAULT_FIELDS, ...(fields || {}) };
      return {
        enabled: true,
        mode: 'custom',
        contentType,
        fields: resolvedFields,
        isEnterpriseNativeAvailable,
      };
    }

    // Tier 2: Zero-config auto-discovery of default audit collection
    for (const candidate of DEFAULT_CANDIDATE_TYPES) {
      if (strapi.contentTypes[candidate]) {
        return {
          enabled: true,
          mode: 'default',
          contentType: candidate,
          fields: DEFAULT_FIELDS,
          isEnterpriseNativeAvailable,
        };
      }
    }

    // Tier 3: Strapi Enterprise native audit logs
    if (isEnterpriseNativeAvailable) {
      return {
        enabled: true,
        mode: 'enterprise_native',
        isEnterpriseNativeAvailable: true,
      };
    }

    // Tier 4: Audit disabled / unconfigured
    return {
      enabled: false,
      mode: 'disabled',
      isEnterpriseNativeAvailable: false,
      error:
        'No audit collection configured or detected. To enable rollback, provide a collection or use Strapi Enterprise.',
    };
  },

  /**
   * Optionally writes an audit event directly to Strapi Enterprise's native Audit Logs table.
   */
  async recordToEnterpriseNative(
    action: string,
    payload: Record<string, any>,
    user?: any
  ) {
    try {
      const eeService = this.getEnterpriseAuditService();
      if (eeService && typeof eeService.save === 'function') {
        await eeService.save({
          action,
          date: new Date(),
          userId: user?.id,
          payload,
        });
        strapi.log.info(
          `[bulk-updater] Successfully dispatched event to Strapi Enterprise Audit Log: ${action}`
        );
      }
    } catch (err: any) {
      strapi.log.warn(
        `[bulk-updater] Note: Could not dispatch to Strapi Enterprise native audit log: ${err.message}`
      );
    }
  },

  /**
   * Records a batch execution:
   * - Dispatches to Strapi Enterprise native audit log if available
   * - Records to consumer or auto-detected collection type for one-click rollback
   */
  async recordBatch(
    batchSummary: {
      batchId: string;
      attribute: string;
      value: string;
      updatedCount: number;
      skippedCount: number;
      totalTargets: number;
    },
    results: any[],
    user?: any
  ) {
    const config = this.getAuditConfig();

    // 1. Always attempt Strapi Enterprise native logging if available
    await this.recordToEnterpriseNative(
      'bulk-updater.batch-update',
      {
        batchId: batchSummary.batchId,
        attribute: batchSummary.attribute,
        value: batchSummary.value,
        updatedCount: batchSummary.updatedCount,
        skippedCount: batchSummary.skippedCount,
        totalTargets: batchSummary.totalTargets,
      },
      user
    );

    // 2. Persist to rollback-capable collection type if available
    if (!config.enabled || !config.contentType || !config.fields) {
      return null;
    }

    const f = config.fields;
    const mappedData: any = {};

    if (f.batchId) mappedData[f.batchId] = batchSummary.batchId;
    if (f.attribute) mappedData[f.attribute] = batchSummary.attribute;
    if (f.value) mappedData[f.value] = batchSummary.value;
    if (f.userEmail) mappedData[f.userEmail] = user?.email || 'admin@strapi.io';
    if (f.userName) {
      mappedData[f.userName] = user?.firstname
        ? `${user.firstname} ${user.lastname || ''}`.trim()
        : user?.email || 'Admin';
    }
    if (f.updatedCount) mappedData[f.updatedCount] = batchSummary.updatedCount;
    if (f.skippedCount) mappedData[f.skippedCount] = batchSummary.skippedCount;
    if (f.totalTargets) mappedData[f.totalTargets] = batchSummary.totalTargets;
    if (f.diffs) mappedData[f.diffs] = results;
    if (f.isRolledBack) mappedData[f.isRolledBack] = false;
    if (f.executedAt) mappedData[f.executedAt] = new Date().toISOString();

    try {
      const created = await strapi.documents(config.contentType as any).create({
        data: mappedData,
      });
      return created;
    } catch (err: any) {
      strapi.log.error(`[bulk-updater] Failed to record audit log: ${err.message}`);
      return null;
    }
  },

  /**
   * Fetches audit history for the UI
   */
  async getHistory() {
    const config = this.getAuditConfig();

    if (config.mode === 'enterprise_native' && !config.contentType) {
      return {
        enabled: true,
        mode: 'enterprise_native',
        message:
          'Strapi Enterprise Native Audit Logs active. Batch events are recorded directly to Strapi Settings > Audit Logs. (To enable one-click document rollback, declare or add an audit-log collection).',
        history: [],
      };
    }

    if (!config.enabled || !config.contentType || !config.fields) {
      return {
        enabled: false,
        message:
          config.error ||
          'Audit trail is disabled. To enable audit logs & rollback, declare an audit schema in config/plugins.ts or create api::audit-log.audit-log.',
        history: [],
      };
    }

    try {
      const records: any[] = await strapi.documents(config.contentType as any).findMany({
        sort: { createdAt: 'desc' } as any,
      });

      const f = config.fields;
      const normalized = (records || []).map((r: any) => ({
        id: r.id,
        documentId: r.documentId,
        batchId: r[f.batchId] || r.documentId,
        attribute: r[f.attribute],
        value: r[f.value],
        userEmail: r[f.userEmail] || 'admin@strapi.io',
        userName: r[f.userName] || 'Admin',
        updatedCount: r[f.updatedCount] || 0,
        skippedCount: r[f.skippedCount] || 0,
        totalTargets: r[f.totalTargets] || 0,
        diffs: typeof r[f.diffs] === 'string' ? JSON.parse(r[f.diffs]) : r[f.diffs] || [],
        isRolledBack: Boolean(r[f.isRolledBack]),
        rolledBackAt: r[f.rolledBackAt] || null,
        rolledBackBy: r[f.rolledBackBy] || null,
        executedAt: r[f.executedAt] || r.createdAt,
      }));

      return {
        enabled: true,
        mode: config.mode,
        contentType: config.contentType,
        isEnterpriseNativeAvailable: config.isEnterpriseNativeAvailable,
        history: normalized,
      };
    } catch (err: any) {
      return {
        enabled: false,
        message: `Failed to read audit history: ${err.message}`,
        history: [],
      };
    }
  },

  /**
   * Performs deterministic rollback of a batch
   */
  async rollbackBatch(batchId: string, currentUser?: any) {
    const config = this.getAuditConfig();
    if (!config.enabled || !config.contentType || !config.fields) {
      throw new Error('Audit trail is not configured or disabled.');
    }

    const f = config.fields;
    const records: any[] = await strapi.documents(config.contentType as any).findMany({
      filters: {
        [f.batchId]: { $eq: batchId },
      } as any,
    });

    const record = records?.[0];
    if (!record) {
      throw new Error(`Batch record with ID "${batchId}" was not found in audit trail.`);
    }

    if (record[f.isRolledBack]) {
      throw new Error(`Batch "${batchId}" has already been rolled back.`);
    }

    const diffs =
      typeof record[f.diffs] === 'string'
        ? JSON.parse(record[f.diffs])
        : record[f.diffs] || [];

    let revertedCount = 0;
    const rollbackDetails = [];

    for (const item of diffs) {
      if (item.status === 'updated' && item.uid && item.documentId && item.attribute) {
        try {
          const isRel = item.oldValue && typeof item.oldValue === 'object' && item.oldValue.isRelation;
          let rollbackPayload: any;

          if (isRel) {
            const oldDocIds = Array.isArray(item.oldValue.documentIds) ? item.oldValue.documentIds : [];
            rollbackPayload = { set: oldDocIds };
          } else {
            rollbackPayload = item.oldValue;
          }

          if (item.attribute.includes('.')) {
            const [parentKey, childKey] = item.attribute.split('.');
            const ct = strapi.contentTypes[item.uid];
            if (ct?.attributes?.[parentKey]?.type === 'component') {
              const currentDoc: any = await strapi.documents(item.uid as any).findOne({
                documentId: item.documentId,
                populate: [parentKey],
              });
              const currentParent = currentDoc?.[parentKey] || {};
              const restoredParent = {
                ...currentParent,
                [childKey]: rollbackPayload,
              };
              await strapi.documents(item.uid as any).update({
                documentId: item.documentId,
                data: {
                  [parentKey]: restoredParent,
                },
              });
            } else {
              await strapi.documents(item.uid as any).update({
                documentId: item.documentId,
                data: {
                  [item.attribute]: rollbackPayload,
                },
              });
            }
          } else {
            await strapi.documents(item.uid as any).update({
              documentId: item.documentId,
              data: {
                [item.attribute]: rollbackPayload,
              },
            });
          }

          const ct = strapi.contentTypes[item.uid];
          if (ct?.options?.draftAndPublish) {
            try {
              await (strapi.documents(item.uid as any) as any).publish({
                documentId: item.documentId,
              });
            } catch {}
          }

          try {
            const bulkService = strapi.plugin('bulk-updater').service('bulkUpdater');
            if (bulkService?.invalidateCache) {
              bulkService.invalidateCache(item.uid);
            }
          } catch {}

          revertedCount++;
          rollbackDetails.push({
            uid: item.uid,
            documentId: item.documentId,
            label: item.label,
            attribute: item.attribute,
            revertedTo: item.oldValue,
            status: 'reverted',
          });
        } catch (err: any) {
          rollbackDetails.push({
            uid: item.uid,
            documentId: item.documentId,
            label: item.label,
            status: 'error',
            message: err.message,
          });
        }
      }
    }

    const updateData: any = {};
    if (f.isRolledBack) updateData[f.isRolledBack] = true;
    if (f.rolledBackAt) updateData[f.rolledBackAt] = new Date().toISOString();
    if (f.rolledBackBy) {
      updateData[f.rolledBackBy] = currentUser?.email || 'Admin';
    }

    await strapi.documents(config.contentType as any).update({
      documentId: record.documentId,
      data: updateData,
    });

    // Invalidate affected collection caches
    try {
      const affectedUids = new Set(rollbackDetails.map((d: any) => d.uid));
      const bulkService = strapi.plugin('bulk-updater').service('bulkUpdater');
      affectedUids.forEach((uid: any) => {
        if (uid && bulkService?.invalidateCache) {
          bulkService.invalidateCache(uid);
        }
      });
    } catch {}

    // Mirror rollback event to Strapi Enterprise native audit log if available
    await this.recordToEnterpriseNative(
      'bulk-updater.rollback',
      {
        batchId,
        revertedCount,
      },
      currentUser
    );

    return {
      success: true,
      batchId,
      revertedCount,
      details: rollbackDetails,
    };
  },
});
