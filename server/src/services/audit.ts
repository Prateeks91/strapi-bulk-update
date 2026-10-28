import type { Core } from '@strapi/strapi';
import { recordContentHistoryVersion } from './content-history';
import {
  setDeepProperty,
  buildDeepPopulate,
  parseDynamicZonePath,
  isDeepComponentField,
} from './bulk-updater';

export interface AuditConfig {
  enabled: boolean;
  mode?: 'custom' | 'default' | 'enterprise_native' | 'store' | 'disabled';
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
  'plugin::bulk-updater.audit-log',
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
   * 4. Zero-config plugin core store (works out of the box in 100% of Strapi installations)
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

    // Tier 4: Zero-config core store fallback (always available in all Strapi installations)
    return {
      enabled: true,
      mode: 'store',
      isEnterpriseNativeAvailable: false,
    };
  },

  /**
   * Checks whether audit logging is enabled.
   */
  isAuditEnabled(): boolean {
    const config = this.getAuditConfig();
    return Boolean(config && config.enabled);
  },

  /**
   * Convenience alias to log an operation into the audit trail.
   */
  async logOperation(data: {
    batchId: string;
    attribute: string;
    value: string;
    userEmail?: string;
    userName?: string;
    updatedCount: number;
    skippedCount: number;
    totalTargets: number;
    diffs?: any[];
  }) {
    return this.recordBatch(
      {
        batchId: data.batchId,
        attribute: data.attribute,
        value: data.value,
        updatedCount: data.updatedCount,
        skippedCount: data.skippedCount,
        totalTargets: data.totalTargets,
      },
      data.diffs || [],
      {
        email: data.userEmail,
        firstname: data.userName,
      }
    );
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
      publishOnApproval?: boolean;
      publishStrategy?: 'safe' | 'all';
      unreviewedConsent?: boolean;
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
        publishStrategy: batchSummary.publishStrategy,
        unreviewedConsent: batchSummary.unreviewedConsent,
      },
      user
    );

    // 2. Persist to rollback-capable storage
    if (!config.enabled) {
      return null;
    }

    if (config.mode === 'store') {
      try {
        const store = strapi.store({ type: 'plugin', name: 'bulk-updater', key: 'audit-history' });
        const stored = (await store.get({})) || { history: [] };
        const history = Array.isArray(stored.history) ? stored.history : [];

        const newRecord = {
          id: batchSummary.batchId,
          documentId: batchSummary.batchId,
          batchId: batchSummary.batchId,
          attribute: batchSummary.attribute,
          value: batchSummary.value,
          userEmail: user?.email || 'admin@strapi.io',
          userName: user?.firstname
            ? `${user.firstname} ${user.lastname || ''}`.trim()
            : user?.email || 'Admin',
          updatedCount: batchSummary.updatedCount,
          skippedCount: batchSummary.skippedCount,
          totalTargets: batchSummary.totalTargets,
          publishOnApproval: batchSummary.publishOnApproval,
          publishStrategy: batchSummary.publishStrategy,
          unreviewedConsent: batchSummary.unreviewedConsent,
          diffs: results,
          isRolledBack: false,
          rolledBackAt: null,
          rolledBackBy: null,
          executedAt: new Date().toISOString(),
        };

        const updatedHistory = [newRecord, ...history].slice(0, 200);
        await store.set({ value: { history: updatedHistory } });
        return newRecord;
      } catch (err: any) {
        strapi.log.error(`[bulk-updater] Failed to record audit log in core store: ${err.message}`);
        return null;
      }
    }

    if (!config.contentType || !config.fields) {
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

    if (config.mode === 'store') {
      try {
        const store = strapi.store({ type: 'plugin', name: 'bulk-updater', key: 'audit-history' });
        const stored = (await store.get({})) || { history: [] };
        const history = Array.isArray(stored.history) ? stored.history : [];

        return {
          enabled: true,
          mode: 'store',
          isEnterpriseNativeAvailable: config.isEnterpriseNativeAvailable,
          history,
        };
      } catch (err: any) {
        return {
          enabled: false,
          message: `Failed to read audit history from core store: ${err.message}`,
          history: [],
        };
      }
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
   * Helper to revert diff items back to original values
   */
  async revertDiffItems(diffs: any[], userId?: any) {
    let revertedCount = 0;
    const rollbackDetails = [];

    for (const item of diffs) {
      if (item.status === 'updated' && item.uid && item.documentId && item.attribute) {
        try {
          const ct = strapi.contentTypes[item.uid];
          if (!ct) {
            throw new Error(`Content type "${item.uid}" does not exist in schema.`);
          }

          const isRel = item.oldValue && typeof item.oldValue === 'object' && item.oldValue.isRelation;
          let rollbackPayload: any;

          if (isRel) {
            const oldDocIds = Array.isArray(item.oldValue.documentIds) ? item.oldValue.documentIds : [];
            rollbackPayload = { set: oldDocIds };
          } else {
            rollbackPayload = item.oldValue ?? null;
          }

          const parsed = parseDynamicZonePath(item.attribute);
          const rootKey = parsed.rootKey;
          const rootAttrDef = ct.attributes?.[rootKey];
          const isComponent = rootAttrDef?.type === 'component';
          const isDynamicZone = rootAttrDef?.type === 'dynamiczone';
          const isNested =
            item.attribute.includes('.') ||
            item.attribute.includes('[') ||
            isComponent ||
            isDynamicZone ||
            isDeepComponentField(ct, strapi.components, item.attribute);

          let wasPublished = false;

          if (isNested && (isComponent || isDynamicZone || rootAttrDef)) {
            // Retrieve current document with recursive deep populate to preserve all sibling fields, components, media, and relations
            const populateOption = buildDeepPopulate(ct.attributes, strapi.components);
            const findOneArgs: any = { documentId: item.documentId };
            if (populateOption) {
              findOneArgs.populate = populateOption;
            }
            const currentDoc: any = await strapi.documents(item.uid as any).findOne(findOneArgs);
            if (!currentDoc) {
              throw new Error(`Document "${item.documentId}" not found in collection "${item.uid}".`);
            }
            wasPublished = Boolean(currentDoc?.publishedAt);

            const isRootDz = isDynamicZone;
            const existingRoot = currentDoc?.[rootKey] || (isRootDz ? [] : {});

            let restoredRoot: any;

            if (Array.isArray(item.dynamicZoneDiffs) && item.dynamicZoneDiffs.length > 0) {
              // If item recorded individual dynamic zone block diffs, revert each one
              let workingRoot = existingRoot;
              for (const dzDiff of item.dynamicZoneDiffs) {
                const parsedDz = parseDynamicZonePath(dzDiff.attribute || item.attribute);
                const dzParts = parsedDz.cleanPath.split('.').slice(1);
                const targetIndexes =
                  dzDiff.index !== undefined
                    ? [dzDiff.index]
                    : parsedDz.targetIndex !== undefined
                    ? [parsedDz.targetIndex]
                    : undefined;
                workingRoot = setDeepProperty(workingRoot, dzParts, dzDiff.oldValue ?? null, {
                  targetIndexes,
                  targetComponentUid: dzDiff.componentUid || parsedDz.targetComponentUid,
                  strapi,
                });
              }
              restoredRoot = workingRoot;
            } else {
              const parts = parsed.cleanPath.split('.');
              const pathParts = parts.slice(1);
              const targetIndexes = parsed.targetIndex !== undefined ? [parsed.targetIndex] : undefined;
              const targetComponentUid = parsed.targetComponentUid;

              restoredRoot = setDeepProperty(existingRoot, pathParts, rollbackPayload, {
                targetIndexes,
                targetComponentUid,
                strapi,
              });
            }

            await strapi.documents(item.uid as any).update({
              documentId: item.documentId,
              data: {
                [rootKey]: restoredRoot,
              },
            });
          } else {
            // Top-level scalar or relation
            const currentDoc: any = await strapi.documents(item.uid as any).findOne({
              documentId: item.documentId,
            });
            wasPublished = Boolean(currentDoc?.publishedAt);

            await strapi.documents(item.uid as any).update({
              documentId: item.documentId,
              data: {
                [item.attribute]: rollbackPayload,
              },
            });
          }

          if (ct?.options?.draftAndPublish && wasPublished) {
            try {
              await (strapi.documents(item.uid as any) as any).publish({
                documentId: item.documentId,
              });
            } catch (publishErr: any) {
              strapi.log.warn(`[bulk-updater] Failed to auto-publish rollback for ${item.uid}/${item.documentId}:`, publishErr?.message);
            }
          }

          // Record Content History Version for Strapi Content Manager
          try {
            await recordContentHistoryVersion(strapi, {
              uid: item.uid,
              documentId: item.documentId,
              userId,
              statusOverride: ct?.options?.draftAndPublish ? (wasPublished ? 'published' : 'draft') : undefined,
            });
          } catch {}

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

    return { revertedCount, rollbackDetails };
  },

  /**
   * Performs deterministic rollback of a batch
   */
  async rollbackBatch(batchId: string, currentUser?: any) {
    const config = this.getAuditConfig();
    if (!config.enabled) {
      throw new Error('Audit trail is not configured or disabled.');
    }

    if (config.mode === 'store') {
      const store = strapi.store({ type: 'plugin', name: 'bulk-updater', key: 'audit-history' });
      const stored = (await store.get({})) || { history: [] };
      const history = Array.isArray(stored.history) ? stored.history : [];

      const recordIndex = history.findIndex((r: any) => r.batchId === batchId);
      if (recordIndex === -1) {
        throw new Error(`Batch record with ID "${batchId}" was not found in audit trail.`);
      }

      const record = history[recordIndex];
      if (record.isRolledBack) {
        throw new Error(`Batch "${batchId}" has already been rolled back.`);
      }

      const diffs = Array.isArray(record.diffs) ? record.diffs : [];
      const { revertedCount, rollbackDetails } = await this.revertDiffItems(diffs, currentUser?.id);

      record.isRolledBack = true;
      record.rolledBackAt = new Date().toISOString();
      record.rolledBackBy = currentUser?.email || 'Admin';
      history[recordIndex] = record;
      await store.set({ value: { history } });

      try {
        const affectedUids = new Set(rollbackDetails.map((d: any) => d.uid));
        const bulkService = strapi.plugin('bulk-updater').service('bulkUpdater');
        affectedUids.forEach((uid: any) => {
          if (uid && bulkService?.invalidateCache) {
            bulkService.invalidateCache(uid);
          }
        });
      } catch {}

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
    }

    if (!config.contentType || !config.fields) {
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

    const { revertedCount, rollbackDetails } = await this.revertDiffItems(diffs, currentUser?.id);

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
