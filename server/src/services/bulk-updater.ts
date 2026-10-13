import type { Core } from '@strapi/strapi';
import crypto from 'crypto';

// In-process memory caches (scoped to pod)
interface CacheEntry {
  signature: string;
  data: any;
  timestamp: number;
}

const queryCache = new Map<string, CacheEntry>();
const modelsCache = new Map<string, { signature: string; totalCount: number; entries: any[] }>();
const MAX_QUERY_CACHE_SIZE = 500;
const CACHE_TTL_MS = 60 * 1000; // 60-second TTL fallback

export interface RelationMeta {
  isRelation: boolean;
  relationType: string;
  targetUid: string;
  targetDisplayName: string;
  isMulti: boolean;
}

let staticSchemaCache: {
  attributes: string[];
  targetUids: string[];
  metaByUid: Record<
    string,
    {
      uid: string;
      kind: string;
      isSingleType: boolean;
      singularName: string;
      pluralName: string;
      displayName: string;
      attributes: string[];
      relations: Record<string, RelationMeta>;
    }
  >;
  relationsMeta: Record<string, RelationMeta>;
} | null = null;

export interface ExecutionWindowConfig {
  enabled: boolean;
  timeZone: string;
  businessHours: {
    start: string;
    end: string;
  };
  offPeakStartTime: string;
  autoQueueDuringBusinessHours: boolean;
}

export function getSafeTimezone(timeZone?: string): string {
  if (!timeZone || typeof timeZone !== 'string') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timeZone.trim() });
    return timeZone.trim();
  } catch {
    return 'UTC';
  }
}

export function getTimeInTimezone(timeZone: string, date: Date = new Date()): { hours: number; minutes: number; timeString: string } {
  const safeTz = getSafeTimezone(timeZone);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const timeString = formatter.format(date);
  const [h, m] = timeString.split(':').map(Number);
  return { hours: h, minutes: m, timeString };
}

export function getExecutionWindowConfig(strapi: Core.Strapi): ExecutionWindowConfig {
  const pluginConfig = strapi.config.get('plugin::bulk-updater.executionWindow') as Partial<ExecutionWindowConfig> | undefined;
  const configuredTz = pluginConfig?.timeZone ||
                       strapi.config.get('server.timeZone') ||
                       Intl.DateTimeFormat().resolvedOptions().timeZone ||
                       'UTC';
  const timeZone = getSafeTimezone(configuredTz);

  return {
    enabled: pluginConfig?.enabled ?? true,
    timeZone,
    businessHours: {
      start: pluginConfig?.businessHours?.start || '09:00',
      end: pluginConfig?.businessHours?.end || '18:00',
    },
    offPeakStartTime: pluginConfig?.offPeakStartTime || '18:00',
    autoQueueDuringBusinessHours: pluginConfig?.autoQueueDuringBusinessHours ?? true,
  };
}

export function checkBusinessHours(config: ExecutionWindowConfig, testDate?: Date) {
  const timeZone = getSafeTimezone(config.timeZone);
  const { hours, minutes, timeString } = getTimeInTimezone(timeZone, testDate || new Date());

  const currentMinutes = hours * 60 + minutes;
  const [startH, startM] = (config.businessHours.start || '09:00').split(':').map(Number);
  const [endH, endM] = (config.businessHours.end || '18:00').split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  const isBusinessHours = currentMinutes >= startMinutes && currentMinutes < endMinutes;

  return {
    isBusinessHours,
    currentServerTime: timeString,
    timeZone,
    businessHours: config.businessHours,
    offPeakStartTime: config.offPeakStartTime,
    policyMessage: isBusinessHours
      ? `Server policy restricts bulk updates during peak business hours (${config.businessHours.start} - ${config.businessHours.end} ${timeZone}). Current time: ${timeString} (${timeZone}). Updates will be queued for off-peak execution at ${config.offPeakStartTime} ${timeZone}.`
      : `Currently in off-peak execution window (outside ${config.businessHours.start} - ${config.businessHours.end} ${timeZone}). Current time: ${timeString} (${timeZone}). Direct execution is permitted.`,
  };
}

export interface PendingBatch {
  id: string;
  createdAt: string;
  createdBy: { id?: string | number; email?: string; firstname?: string; lastname?: string; username?: string };
  payload: {
    attribute: string;
    value: string;
    selectedEntries?: Array<{ uid: string; documentId: string }>;
    selectedCollections?: string[];
    isRegex?: boolean;
    regexPattern?: string;
    publishOnApproval?: boolean;
  };
  summary: {
    attribute: string;
    value: string;
    totalTargets: number;
    collectionBreakdown: Record<string, number>;
    publishOnApproval?: boolean;
  };
  status: 'pending_approval' | 'queued_offpeak' | 'approved' | 'rejected' | 'executed';
  executionMode: 'maker_checker' | 'queue_offpeak' | 'immediate';
  scheduledFor?: string;
  makerNotes?: string;
  approval?: {
    checkerUser?: { id?: string | number; email?: string; firstname?: string; lastname?: string; username?: string };
    decisionDate?: string;
    rejectionReason?: string;
  };
  executionResult?: any;
}

const pendingBatches = new Map<string, PendingBatch>();
let isRunnerRunning = false;
let runnerInterval: NodeJS.Timeout | null = null;

export function invalidateCollectionCache(uid: string) {
  modelsCache.delete(uid);
  for (const key of queryCache.keys()) {
    if (key.startsWith(`${uid}:`)) {
      queryCache.delete(key);
    }
  }
}

async function getCollectionSignature(strapi: Core.Strapi, uid: string): Promise<string> {
  const contentType = strapi.contentTypes[uid];
  if (!contentType) return 'invalid';

  const isSingleType = contentType.kind === 'singleType';
  try {
    if (isSingleType) {
      const doc: any = await (strapi.documents(uid as any) as any).findFirst({
        fields: ['updatedAt', 'id'],
      });
      return doc ? `single:${doc.id}:${doc.updatedAt}` : 'single:empty';
    }

    const [total, latest] = await Promise.all([
      strapi.documents(uid as any).count(),
      strapi.documents(uid as any).findMany({
        limit: 1,
        sort: { updatedAt: 'desc' },
        fields: ['updatedAt', 'id'],
      }),
    ]);

    const latestDoc = latest && latest.length > 0 ? latest[0] : null;
    return `${total}:${latestDoc?.updatedAt || '0'}:${latestDoc?.id || '0'}`;
  } catch {
    return `${Date.now()}`;
  }
}

async function computeTargetsSummary(strapi: Core.Strapi, { selectedCollections = [], selectedEntries = [] }: any) {
  const targetsMap = new Map<string, { uid: string; documentId: string }>();
  const breakdown: Record<string, number> = {};

  for (const colUid of selectedCollections) {
    const contentType = strapi.contentTypes[colUid];
    const displayName = contentType?.info?.displayName || colUid;
    try {
      const entries = await strapi.documents(colUid as any).findMany();
      const count = entries ? entries.length : 0;
      breakdown[displayName] = (breakdown[displayName] || 0) + count;
      for (const entry of (entries || []) as any[]) {
        targetsMap.set(`${colUid}@@@${entry.documentId}`, { uid: colUid, documentId: entry.documentId });
      }
    } catch {
      // Ignore count failures
    }
  }

  for (const item of selectedEntries) {
    if (!item.uid || !item.documentId) continue;
    const key = `${item.uid}@@@${item.documentId}`;
    if (!targetsMap.has(key)) {
      targetsMap.set(key, { uid: item.uid, documentId: item.documentId });
      const contentType = strapi.contentTypes[item.uid];
      const displayName = contentType?.info?.displayName || item.uid;
      breakdown[displayName] = (breakdown[displayName] || 0) + 1;
    }
  }

  return {
    totalTargets: targetsMap.size,
    collectionBreakdown: breakdown,
  };
}

async function executeBatchInternal(
  strapi: Core.Strapi,
  {
    attribute,
    value,
    selectedEntries = [],
    selectedCollections = [],
    isRegex = false,
    regexPattern = '',
    publishOnApproval = true,
  }: {
    attribute: string;
    value: string;
    selectedEntries?: Array<{ uid: string; documentId: string }>;
    selectedCollections?: string[];
    isRegex?: boolean;
    regexPattern?: string;
    publishOnApproval?: boolean;
  },
  currentUser?: any,
  existingBatchId?: string
) {
  if (!attribute) {
    throw new Error('Attribute name is required.');
  }



  const targetsMap = new Map<string, { uid: string; documentId: string }>();

  // 1. Add entire collections if selected
  for (const colUid of selectedCollections) {
    if (!strapi.contentTypes[colUid]) continue;
    const entries = await strapi.documents(colUid as any).findMany();
    for (const entry of (entries || []) as any[]) {
      const key = `${colUid}@@@${entry.documentId}`;
      targetsMap.set(key, { uid: colUid, documentId: entry.documentId });
    }
  }

  // 2. Add individually selected entries
  for (const item of selectedEntries) {
    if (!item.uid || !item.documentId) continue;
    const key = `${item.uid}@@@${item.documentId}`;
    targetsMap.set(key, { uid: item.uid, documentId: item.documentId });
  }

  if (targetsMap.size === 0) {
    throw new Error('No collections or entries were selected for update.');
  }

  const batchId = existingBatchId || `batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const results: any[] = [];
  let updatedCount = 0;
  let skippedCount = 0;

  let regexObj: RegExp | null = null;
  if (isRegex && regexPattern) {
    regexObj = new RegExp(regexPattern, 'g');
  }

  const targets = Array.from(targetsMap.values());
  const CHUNK_SIZE = 25; // 25 concurrent updates per batch window

  // Request-scoped DataLoader for deduplicating lookups during batch itemization
  const documentLoader = new Map<string, Promise<any>>();
  const getDocumentDeduplicated = (uid: string, documentId: string) => {
    const loaderKey = `${uid}@@@${documentId}`;
    if (!documentLoader.has(loaderKey)) {
      documentLoader.set(
        loaderKey,
        strapi.documents(uid as any).findOne({ documentId })
      );
    }
    return documentLoader.get(loaderKey);
  };

  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const chunk = targets.slice(i, i + CHUNK_SIZE);
    const chunkPromises = chunk.map(async (target) => {
      const contentType = strapi.contentTypes[target.uid];
      const displayName = contentType?.info?.displayName || target.uid;

      try {
        const currentEntry: any = await getDocumentDeduplicated(target.uid, target.documentId);

        const entryLabel =
          currentEntry?.name ||
          currentEntry?.title ||
          currentEntry?.email ||
          `Entry #${target.documentId}`;

        const isNested = attribute.includes('.');
        let isComponentNested = false;
        let parentKey = '';
        let childKey = '';

        if (isNested) {
          const parts = attribute.split('.');
          parentKey = parts[0];
          childKey = parts[1];
          const parentAttrDef = contentType?.attributes?.[parentKey];
          if (parentAttrDef?.type === 'component' && !parentAttrDef.repeatable && parentAttrDef.component) {
            const compSchema = strapi.components[parentAttrDef.component];
            if (compSchema?.attributes?.[childKey]) {
              isComponentNested = true;
            }
          }
        }

        const attrDef = contentType?.attributes?.[attribute];
        const hasAttribute = Boolean(attrDef) || isComponentNested;

        if (hasAttribute) {
          if (isComponentNested) {
            // Retrieve current component state with populate for safe deep merge
            const currentEntryWithPopulate: any = await strapi.documents(target.uid as any).findOne({
              documentId: target.documentId,
              populate: [parentKey],
            });
            const existingParent = currentEntryWithPopulate?.[parentKey] || {};
            const currentVal = existingParent?.[childKey];

            let newValue = value;
            if (regexObj && typeof currentVal === 'string') {
              newValue = currentVal.replace(regexObj, value);
            }

            const updatedParent = {
              ...existingParent,
              [childKey]: newValue,
            };

            await strapi.documents(target.uid as any).update({
              documentId: target.documentId,
              data: {
                [parentKey]: updatedParent,
              },
            });

            // If publishOnApproval is true and content type has draftAndPublish enabled, publish the document
            const isDraftAndPublishComp = Boolean(contentType?.options?.draftAndPublish);
            if (publishOnApproval && isDraftAndPublishComp) {
              try {
                await (strapi.documents(target.uid as any) as any).publish({
                  documentId: target.documentId,
                });
              } catch (publishErr) {
                strapi.log.warn(`[bulk-updater] Failed to auto-publish ${target.uid}/${target.documentId}:`, publishErr);
              }
            }

            invalidateCollectionCache(target.uid);

            return {
              uid: target.uid,
              collectionName: displayName,
              documentId: target.documentId,
              label: entryLabel,
              attribute,
              oldValue: currentVal ?? null,
              newValue,
              status: 'updated' as const,
              message: `Successfully updated nested field ${attribute}`,
            };
          }

          if (attrDef.type === 'relation') {
            const isMulti = attrDef.relation === 'oneToMany' || attrDef.relation === 'manyToMany';

            // Retrieve current relation state with populate for accurate audit logging
            const currentEntryWithPopulate: any = await strapi.documents(target.uid as any).findOne({
              documentId: target.documentId,
              populate: [attribute],
            });
            const currentRel = currentEntryWithPopulate?.[attribute];

            let oldDocIds: string[] = [];
            let oldDisplay = '';
            if (isMulti && Array.isArray(currentRel)) {
              oldDocIds = currentRel.map((r: any) => r.documentId).filter(Boolean);
              oldDisplay = currentRel.map((r: any) => r.name || r.title || r.email || r.documentId).join(', ') || '(empty)';
            } else if (currentRel) {
              oldDocIds = currentRel.documentId ? [currentRel.documentId] : [];
              oldDisplay = currentRel.name || currentRel.title || currentRel.email || currentRel.documentId || '(empty)';
            } else {
              oldDisplay = '(unlinked / none)';
            }

            // Parse relation command:
            let mode: 'set' | 'connect' | 'disconnect' | 'clear' = 'set';
            let targetDocIds: string[] = [];
            let newDisplay = '';

            if (value === '__clear__' || value === '') {
              mode = 'clear';
              newDisplay = '(cleared / unlinked)';
            } else {
              try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === 'object' && parsed.mode) {
                  mode = parsed.mode;
                  targetDocIds = Array.isArray(parsed.documentIds) ? parsed.documentIds : (parsed.documentId ? [parsed.documentId] : []);
                  newDisplay = parsed.label || targetDocIds.join(', ') || `[${mode}]`;
                } else if (Array.isArray(parsed)) {
                  targetDocIds = parsed;
                  newDisplay = targetDocIds.join(', ');
                } else {
                  targetDocIds = [value];
                  newDisplay = value;
                }
              } catch {
                targetDocIds = [value];
                newDisplay = value;
              }
            }

            // Construct Document Service relation mutation payload
            let relationPayload: any;
            if (mode === 'clear') {
              relationPayload = isMulti ? { set: [] } : null;
            } else if (mode === 'set') {
              relationPayload = isMulti ? { set: targetDocIds } : (targetDocIds[0] || null);
            } else if (mode === 'connect') {
              relationPayload = { connect: targetDocIds };
            } else if (mode === 'disconnect') {
              relationPayload = { disconnect: targetDocIds };
            }

            await strapi.documents(target.uid as any).update({
              documentId: target.documentId,
              data: {
                [attribute]: relationPayload,
              },
            });

            // If publishOnApproval is true and content type has draftAndPublish enabled, publish the document
            const isDraftAndPublishRel = Boolean(contentType?.options?.draftAndPublish);
            if (publishOnApproval && isDraftAndPublishRel) {
              try {
                await (strapi.documents(target.uid as any) as any).publish({
                  documentId: target.documentId,
                });
              } catch (publishErr) {
                strapi.log.warn(`[bulk-updater] Failed to auto-publish ${target.uid}/${target.documentId}:`, publishErr);
              }
            }

            invalidateCollectionCache(target.uid);
            if (attrDef.target) {
              invalidateCollectionCache(attrDef.target);
            }

            return {
              uid: target.uid,
              collectionName: displayName,
              documentId: target.documentId,
              label: entryLabel,
              attribute,
              oldValue: { isRelation: true, documentIds: oldDocIds, display: oldDisplay },
              newValue: { isRelation: true, mode, documentIds: targetDocIds, display: newDisplay },
              status: 'updated' as const,
              message: `Successfully updated relation "${attribute}"`,
            };
          }

          let newValue = value;
          const currentVal = currentEntry?.[attribute];

          if (regexObj && typeof currentVal === 'string') {
            newValue = currentVal.replace(regexObj, value);
          }

          await strapi.documents(target.uid as any).update({
            documentId: target.documentId,
            data: {
              [attribute]: newValue,
            },
          });

          // If publishOnApproval is true and content type has draftAndPublish enabled, publish the document
          const isDraftAndPublishScalar = Boolean(contentType?.options?.draftAndPublish);
          if (publishOnApproval && isDraftAndPublishScalar) {
            try {
              await (strapi.documents(target.uid as any) as any).publish({
                documentId: target.documentId,
              });
            } catch (publishErr) {
              strapi.log.warn(`[bulk-updater] Failed to auto-publish ${target.uid}/${target.documentId}:`, publishErr);
            }
          }

          return {
            uid: target.uid,
            collectionName: displayName,
            documentId: target.documentId,
            label: entryLabel,
            attribute,
            oldValue: currentVal ?? null,
            newValue,
            status: 'updated' as const,
            message: `Successfully updated ${attribute}`,
          };
        } else {
          return {
            uid: target.uid,
            collectionName: displayName,
            documentId: target.documentId,
            label: entryLabel,
            attribute,
            status: 'skipped' as const,
            message: `Skipped: Attribute "${attribute}" does not exist in schema for ${displayName}`,
          };
        }
      } catch (updateErr: any) {
        return {
          uid: target.uid,
          collectionName: displayName,
          documentId: target.documentId,
          label: `Entry #${target.documentId}`,
          attribute,
          status: 'error' as const,
          message: updateErr.message,
        };
      }
    });

    const chunkResults = await Promise.all(chunkPromises);
    for (const res of chunkResults) {
      if (res.status === 'updated') updatedCount++;
      else if (res.status === 'skipped') skippedCount++;
      results.push(res);
    }
  }

  // Invalidate local in-process cache for all affected collection UIDs
  const affectedUids = new Set(targets.map((t) => t.uid));
  affectedUids.forEach((uid) => {
    invalidateCollectionCache(uid);
  });

  const batchSummary = {
    batchId,
    attribute,
    value,
    updatedCount,
    skippedCount,
    totalTargets: targetsMap.size,
    publishOnApproval,
  };

  // Stateless audit recording via consumer's declared audit schema
  await strapi.plugin('bulk-updater').service('audit').recordBatch(
    batchSummary,
    results,
    currentUser
  );

  return {
    success: true,
    batchId,
    attribute,
    value,
    updatedCount,
    skippedCount,
    totalTargets: targetsMap.size,
    results,
  };
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  // Initialize periodic runner for off-peak queue execution
  if (!runnerInterval) {
    runnerInterval = setInterval(async () => {
      if (isRunnerRunning) return;
      isRunnerRunning = true;
      try {
        const config = getExecutionWindowConfig(strapi);
        const { isBusinessHours } = checkBusinessHours(config);

        for (const [id, batch] of pendingBatches.entries()) {
          if (batch.status === 'queued_offpeak' && !isBusinessHours) {
            strapi.log.info(`[bulk-updater] Executing off-peak queued batch: ${id}`);
            const result = await executeBatchInternal(strapi, batch.payload, batch.createdBy, id);
            batch.status = 'executed';
            batch.executionResult = result;
          }
        }
      } catch (err) {
        strapi.log.error('[bulk-updater] Scheduled runner error:', err);
      } finally {
        isRunnerRunning = false;
      }
    }, 30000);
  }

  return {
    /**
     * Lightweight Schema Discovery:
     * Returns schema definitions, valid attributes, and total counts (<15KB payload)
     * Previews up to 10 entries per collection to ensure instantaneous initial paint.
     * Utilizes in-memory schema memoization and database high-watermark signature caching.
     */
    async getModels() {
      const allContentTypes = strapi.contentTypes || {};
      const auditConfig = strapi.plugin('bulk-updater').service('audit').getAuditConfig();
      const auditContentType = auditConfig?.contentType;

      // 1. Static schema discovery memoized in-memory
      if (!staticSchemaCache) {
        const allAttributesSet = new Set<string>();
        const systemFields = [
          'createdAt',
          'updatedAt',
          'publishedAt',
          'createdBy',
          'updatedBy',
          'locale',
          'localizations',
        ];

        const configuredCollections = strapi.config.get(
          'plugin::bulk-updater.collections'
        ) as string[] | string | undefined;

        const isWildcard =
          configuredCollections === '*' ||
          configuredCollections === 'all' ||
          (Array.isArray(configuredCollections) &&
            (configuredCollections.includes('*') || configuredCollections.includes('all')));

        let targetUids: string[];
        if (
          !isWildcard &&
          configuredCollections &&
          Array.isArray(configuredCollections) &&
          configuredCollections.length > 0
        ) {
          targetUids = configuredCollections.filter((uid) => uid in allContentTypes);
        } else {
          targetUids = Object.keys(allContentTypes).filter(
            (uid) =>
              uid.startsWith('api::') &&
              !uid.includes('bulk-updater') &&
              uid !== auditContentType
          );
        }

        const metaByUid: Record<string, any> = {};
        const allRelationsMeta: Record<string, RelationMeta> = {};

        for (const uid of targetUids) {
          const contentType = allContentTypes[uid];
          if (!contentType || (contentType.kind !== 'collectionType' && contentType.kind !== 'singleType')) continue;

          const isSingleType = contentType.kind === 'singleType';
          const rawAttrs = contentType.attributes || {};
          const relationsByAttr: Record<string, RelationMeta> = {};

          const nestedComponentAttrs: string[] = [];

          const validAttrs = Object.keys(rawAttrs).filter((attrKey) => {
            if (systemFields.includes(attrKey)) return false;
            if (rawAttrs[attrKey].type === 'dynamiczone') return false;

            if (rawAttrs[attrKey].type === 'component') {
              const compDef = rawAttrs[attrKey];
              // Support non-repeatable components
              if (!compDef.repeatable && compDef.component) {
                const componentSchema = strapi.components[compDef.component];
                if (componentSchema && componentSchema.attributes) {
                  for (const [subKey, subAttr] of Object.entries(componentSchema.attributes) as any[]) {
                    if (systemFields.includes(subKey)) continue;
                    if (['component', 'dynamiczone', 'relation'].includes(subAttr.type)) continue;
                    nestedComponentAttrs.push(`${attrKey}.${subKey}`);
                  }
                }
              }
              return false;
            }

            if (rawAttrs[attrKey].type === 'relation') {
              const rel = rawAttrs[attrKey];
              const targetUid = rel.target;
              if (!targetUid || !allContentTypes[targetUid]) return false;
              const targetInfo = allContentTypes[targetUid]?.info;
              const isMulti = rel.relation === 'oneToMany' || rel.relation === 'manyToMany';
              const relMeta: RelationMeta = {
                isRelation: true,
                relationType: rel.relation,
                targetUid,
                targetDisplayName: targetInfo?.displayName || targetUid,
                isMulti,
              };
              relationsByAttr[attrKey] = relMeta;
              allRelationsMeta[attrKey] = relMeta;
              return true;
            }

            return true;
          });

          const allColAttrs = [...validAttrs, ...nestedComponentAttrs];
          allColAttrs.forEach((attr) => allAttributesSet.add(attr));

          metaByUid[uid] = {
            uid,
            kind: contentType.kind,
            isSingleType,
            singularName: contentType.info?.singularName || uid,
            pluralName: contentType.info?.pluralName || uid,
            displayName: contentType.info?.displayName || uid,
            attributes: allColAttrs,
            relations: relationsByAttr,
          };
        }

        staticSchemaCache = {
          attributes: Array.from(allAttributesSet),
          targetUids: Object.keys(metaByUid),
          metaByUid,
          relationsMeta: allRelationsMeta,
        };
      }

      const collections = [];
      const signatures: string[] = [];

      // 2. High-watermark check per collection in parallel
      const collectionResults = await Promise.all(
        staticSchemaCache.targetUids.map(async (uid) => {
          const meta = staticSchemaCache!.metaByUid[uid];
          if (!meta) return null;

          const signature = await getCollectionSignature(strapi, uid);
          const cached = modelsCache.get(uid);
          if (cached && cached.signature === signature) {
            return {
              collection: {
                ...meta,
                totalEntries: cached.totalCount,
                entries: cached.entries,
              },
              signature: `${uid}=${signature}`,
            };
          }

          let entries: any[] = [];
          let totalCount = 0;
          try {
            const ctAttrs = allContentTypes[uid]?.attributes || {};
            const relKeys = Object.keys(meta.relations || {});
            const compKeys = Object.keys(ctAttrs).filter((k) => ctAttrs[k].type === 'component');
            const populateOptionObj: Record<string, any> = {};
            relKeys.forEach((k) => { populateOptionObj[k] = true; });
            compKeys.forEach((k) => { populateOptionObj[k] = true; });
            const populateOption = Object.keys(populateOptionObj).length > 0 ? populateOptionObj : undefined;

            if (meta.isSingleType) {
              const singleDoc: any = await (strapi.documents(uid as any) as any).findFirst({
                populate: populateOption,
              });
              if (singleDoc) {
                entries = [singleDoc];
                totalCount = 1;
              }
            } else {
              totalCount = await strapi.documents(uid as any).count();
              entries = await strapi.documents(uid as any).findMany({
                limit: 10,
                sort: { createdAt: 'desc' },
                populate: populateOption,
              });
            }
          } catch (err) {
            strapi.log.error(`[bulk-updater] Failed to fetch entries for ${uid}:`, err);
            entries = [];
            totalCount = 0;
          }

          const formattedEntries = (entries || []).map((entry: any) => ({
            id: entry.id,
            documentId: entry.documentId,
            ...entry,
          }));

          modelsCache.set(uid, {
            signature,
            totalCount,
            entries: formattedEntries,
          });

          return {
            collection: {
              ...meta,
              totalEntries: totalCount,
              entries: formattedEntries,
            },
            signature: `${uid}=${signature}`,
          };
        })
      );

      for (const res of collectionResults) {
        if (res) {
          collections.push(res.collection);
          signatures.push(res.signature);
        }
      }

      const executionConfig = getExecutionWindowConfig(strapi);
      const windowStatus = checkBusinessHours(executionConfig);
      const pendingCount = Array.from(pendingBatches.values()).filter(
        (b) => b.status === 'pending_approval' || b.status === 'queued_offpeak'
      ).length;

      const etag = `W/"models-${crypto.createHash('md5').update(`${signatures.join('|')}:${pendingCount}:${windowStatus.isBusinessHours}:${windowStatus.currentServerTime}:${windowStatus.timeZone}`).digest('hex')}"`;

      return {
        success: true,
        attributes: staticSchemaCache.attributes,
        collections,
        relationsMeta: staticSchemaCache.relationsMeta,
        executionWindow: {
          ...executionConfig,
          ...windowStatus,
        },
        pendingBatchesCount: pendingCount,
        auditEnabled: Boolean(auditConfig?.enabled),
        etag,
      };
    },

    /**
     * On-Demand Paginated Collection Entries:
     * Supports server-side pagination (limit / start) and database query pushdown for filters.
     * Cached in-process with cross-pod high-watermark signature validation.
     */
    async getCollectionEntries(
      uid: string,
      {
        page = 1,
        pageSize = 10,
        attribute,
        filterOperator,
        filterQuery,
        search,
        sortField,
        sortOrder = 'desc',
      }: {
        page?: number;
        pageSize?: number;
        attribute?: string;
        filterOperator?: string;
        filterQuery?: string;
        search?: string;
        sortField?: string;
        sortOrder?: 'asc' | 'desc';
      }
    ) {
      const contentType = strapi.contentTypes[uid];
      if (!contentType) {
        throw new Error(`Collection with UID "${uid}" does not exist.`);
      }

      const limit = Math.min(Math.max(Number(pageSize) || 10, 1), 500);
      const currentPage = Math.max(Number(page) || 1, 1);
      const start = (currentPage - 1) * limit;

      const isSingleType = contentType.kind === 'singleType';

      // 1. Signature-based caching verification
      const signature = await getCollectionSignature(strapi, uid);
      const cacheKey = `${uid}:${limit}:${start}:${attribute || ''}:${filterOperator || ''}:${filterQuery || ''}:${search || ''}:${sortField || ''}:${sortOrder}`;
      const cached = queryCache.get(cacheKey);

      const etag = `W/"entry-${crypto.createHash('md5').update(`${cacheKey}:${signature}`).digest('hex')}"`;

      if (cached && cached.signature === signature && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return {
          ...cached.data,
          cached: true,
          etag,
        };
      }

      let result: any;

      // Build database filters pushdown
      const filters: Record<string, any> = {};

      const attrs = contentType.attributes || {};
      let colHasAttribute = false;
      let isNestedAttr = false;
      let parentKey = '';
      let childKey = '';

      if (attribute) {
        if (attribute.includes('.')) {
          [parentKey, childKey] = attribute.split('.');
          if (attrs[parentKey]?.type === 'component' && !attrs[parentKey].repeatable && attrs[parentKey].component) {
            const compSchema = strapi.components[attrs[parentKey].component];
            if (compSchema?.attributes?.[childKey]) {
              colHasAttribute = true;
              isNestedAttr = true;
            }
          }
        } else if (attrs[attribute]) {
          colHasAttribute = true;
        }
      }

      const normOp = (filterOperator || '').toLowerCase().replace(/_/g, '');

      // If a specific attribute filter is active, check if the collection actually has the attribute
      if (normOp && normOp !== 'none') {
        if (!colHasAttribute) {
          // Collection does not possess this attribute: return 0 matching entries
          result = {
            uid,
            displayName: contentType.info?.displayName || uid,
            isSingleType,
            entries: [],
            pagination: {
              page: 1,
              pageSize: limit,
              total: 0,
              pageCount: 0,
            },
          };
          queryCache.set(cacheKey, { signature, data: result, timestamp: Date.now() });
          return { ...result, cached: false, etag };
        }

        let condition: any = undefined;
        const q = (filterQuery || '').trim();

        if (normOp === 'empty') {
          condition = { $or: [{ $null: true }, { $eq: '' }] };
        } else if (normOp === 'notempty') {
          condition = { $and: [{ $notNull: true }, { $ne: '' }] };
        } else if (q !== '') {
          switch (normOp) {
            case 'equals':
              condition = { $containsi: q };
              break;
            case 'notequals':
              condition = { $notContainsi: q };
              break;
            case 'contains':
              condition = { $containsi: q };
              break;
            case 'notcontains':
              condition = { $notContainsi: q };
              break;
            case 'startswith':
              condition = { $startsWith: q };
              break;
            case 'endswith':
              condition = { $endsWith: q };
              break;
          }
        }

        if (condition !== undefined) {
          if (isNestedAttr) {
            filters[parentKey] = {
              [childKey]: condition,
            };
          } else {
            if (normOp === 'empty') {
              filters.$or = [
                { [attribute]: { $null: true } },
                { [attribute]: { $eq: '' } },
              ];
            } else if (normOp === 'notempty') {
              filters[attribute] = { $notNull: true, $ne: '' };
            } else {
              filters[attribute] = condition;
            }
          }
        }
      }

      if (search && search.trim() !== '') {
        const q = search.trim();
        const searchableAttrs = Object.keys(attrs).filter((k) =>
          ['string', 'text', 'email', 'uid'].includes(attrs[k]?.type)
        );

        if (searchableAttrs.length > 0) {
          const orList = searchableAttrs.slice(0, 6).map((k) => ({
            [k]: { $containsi: q },
          }));

          if (Object.keys(filters).length > 0) {
            const existingFilters = { ...filters };
            Object.keys(filters).forEach((k) => delete filters[k]);
            filters.$and = [existingFilters, { $or: orList }];
          } else {
            filters.$or = orList;
          }
        }
      }

      if (isSingleType) {
        let singleDoc: any = null;
        try {
          singleDoc = await (strapi.documents(uid as any) as any).findFirst({
            filters: Object.keys(filters).length > 0 ? filters : undefined,
          });
        } catch {
          singleDoc = null;
        }
        result = {
          uid,
          displayName: contentType.info?.displayName || uid,
          isSingleType: true,
          entries: singleDoc ? [singleDoc] : [],
          pagination: {
            page: 1,
            pageSize: 1,
            total: singleDoc ? 1 : 0,
            pageCount: singleDoc ? 1 : 0,
          },
        };
      } else {

        const sortClause: any = {};
        if (sortField && sortField.includes('.')) {
          const [parent, child] = sortField.split('.');
          if (contentType.attributes?.[parent]?.type === 'component') {
            sortClause[parent] = { [child]: sortOrder };
          } else {
            sortClause['createdAt'] = 'desc';
          }
        } else if (sortField && contentType.attributes?.[sortField]) {
          sortClause[sortField] = sortOrder;
        } else {
          sortClause['createdAt'] = 'desc';
        }

        const populateAttrs = Object.keys(contentType.attributes || {}).filter(
          (k) => contentType.attributes[k].type === 'relation' || contentType.attributes[k].type === 'component'
        );
        const populateOption = populateAttrs.length > 0
          ? populateAttrs.reduce((acc, k) => ({ ...acc, [k]: true }), {})
          : undefined;

        const [entries, totalEntries] = await Promise.all([
          strapi.documents(uid as any).findMany({
            start,
            limit,
            filters: Object.keys(filters).length > 0 ? filters : undefined,
            sort: sortClause,
            populate: populateOption,
          }),
          strapi.documents(uid as any).count({
            filters: Object.keys(filters).length > 0 ? filters : undefined,
          }),
        ]);

        const totalPages = Math.ceil(totalEntries / limit);

        result = {
          uid,
          displayName: contentType.info?.displayName || uid,
          isSingleType: false,
          entries: (entries || []).map((entry: any) => ({
            id: entry.id,
            documentId: entry.documentId,
            ...entry,
          })),
          pagination: {
            page: currentPage,
            pageSize: limit,
            total: totalEntries,
            pageCount: totalPages,
          },
        };
      }

      // Store in queryCache with bounding limit
      if (queryCache.size >= MAX_QUERY_CACHE_SIZE) {
        const toDelete = Array.from(queryCache.keys()).slice(0, 100);
        toDelete.forEach((k) => queryCache.delete(k));
      }
      queryCache.set(cacheKey, { signature, data: result, timestamp: Date.now() });

      return {
        ...result,
        cached: false,
        etag,
      };
    },

    /**
     * Get available target entities for a relation field:
     * Cached in-process with cross-pod signature validation.
     */
    async getRelationOptions(targetUid: string) {
      if (!targetUid || !strapi.contentTypes[targetUid]) {
        throw new Error(`Target content type "${targetUid}" does not exist.`);
      }

      const cacheKey = `rel_options:${targetUid}`;
      const signature = await getCollectionSignature(strapi, targetUid);
      const cached = queryCache.get(cacheKey);
      if (cached && cached.signature === signature) {
        return cached.data;
      }

      const docs = await strapi.documents(targetUid as any).findMany({
        limit: 100,
        sort: { createdAt: 'desc' },
      });

      const options = (docs || []).map((doc: any) => {
        const label = doc.name || doc.title || doc.email || doc.username || `Entry #${doc.id || doc.documentId}`;
        return {
          documentId: doc.documentId,
          label,
        };
      });

      const result = { targetUid, options };
      queryCache.set(cacheKey, { signature, data: result, timestamp: Date.now() });
      return result;
    },

    /**
     * Batch Update API with Maker-Checker and Off-Peak Scheduling:
     */
    async batchUpdate(
      {
        attribute,
        value,
        selectedEntries = [],
        selectedCollections = [],
        isRegex = false,
        regexPattern = '',
        executionMode = 'immediate',
        makerNotes = '',
        forceImmediate = false,
        publishOnApproval = true,
      }: {
        attribute: string;
        value: string;
        selectedEntries?: Array<{ uid: string; documentId: string }>;
        selectedCollections?: string[];
        isRegex?: boolean;
        regexPattern?: string;
        executionMode?: 'immediate' | 'queue_offpeak' | 'maker_checker';
        makerNotes?: string;
        forceImmediate?: boolean;
        publishOnApproval?: boolean;
      },
      currentUser?: any
    ) {
      if (!attribute) {
        throw new Error('Attribute name is required.');
      }

      const executionConfig = getExecutionWindowConfig(strapi);
      const { isBusinessHours, policyMessage } = checkBusinessHours(executionConfig);

      // 1. Enterprise Maker-Checker Flow:
      if (executionMode === 'maker_checker') {
        const summary = await computeTargetsSummary(strapi, { selectedCollections, selectedEntries });
        if (summary.totalTargets === 0) {
          throw new Error('No collections or entries were selected for update.');
        }

        const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const batch: PendingBatch = {
          id: batchId,
          createdAt: new Date().toISOString(),
          createdBy: currentUser
            ? {
                id: currentUser.id,
                email: currentUser.email,
                firstname: currentUser.firstname,
                lastname: currentUser.lastname,
                username: currentUser.username,
              }
            : { email: 'admin@system.local' },
          payload: { attribute, value, selectedEntries, selectedCollections, isRegex, regexPattern, publishOnApproval },
          summary: {
            attribute,
            value,
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval,
          },
          status: 'pending_approval',
          executionMode: 'maker_checker',
          makerNotes,
        };

        pendingBatches.set(batchId, batch);

        return {
          success: true,
          pending: true,
          batchId,
          status: 'pending_approval',
          message: 'Batch submitted for Checker authorization (4-Eyes Maker-Checker Workflow).',
          batch,
        };
      }

      // 2. Off-Peak Queued Batch:
      if (executionMode === 'queue_offpeak') {
        const summary = await computeTargetsSummary(strapi, { selectedCollections, selectedEntries });
        if (summary.totalTargets === 0) {
          throw new Error('No collections or entries were selected for update.');
        }

        const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const batch: PendingBatch = {
          id: batchId,
          createdAt: new Date().toISOString(),
          createdBy: currentUser
            ? {
                id: currentUser.id,
                email: currentUser.email,
                firstname: currentUser.firstname,
                lastname: currentUser.lastname,
                username: currentUser.username,
              }
            : { email: 'admin@system.local' },
          payload: { attribute, value, selectedEntries, selectedCollections, isRegex, regexPattern, publishOnApproval },
          summary: {
            attribute,
            value,
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval,
          },
          status: 'queued_offpeak',
          executionMode: 'queue_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          makerNotes,
        };

        pendingBatches.set(batchId, batch);

        return {
          success: true,
          pending: true,
          batchId,
          status: 'queued_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          message: `Batch queued for server off-peak maintenance window (${executionConfig.offPeakStartTime}).`,
          batch,
        };
      }

      // 3. Immediate execution request with Server Business Hours enforcement:
      if (executionConfig.enabled && executionConfig.autoQueueDuringBusinessHours && isBusinessHours && !forceImmediate) {
        const summary = await computeTargetsSummary(strapi, { selectedCollections, selectedEntries });
        if (summary.totalTargets === 0) {
          throw new Error('No collections or entries were selected for update.');
        }

        const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const batch: PendingBatch = {
          id: batchId,
          createdAt: new Date().toISOString(),
          createdBy: currentUser
            ? {
                id: currentUser.id,
                email: currentUser.email,
                firstname: currentUser.firstname,
                lastname: currentUser.lastname,
                username: currentUser.username,
              }
            : { email: 'admin@system.local' },
          payload: { attribute, value, selectedEntries, selectedCollections, isRegex, regexPattern, publishOnApproval },
          summary: {
            attribute,
            value,
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval,
          },
          status: 'queued_offpeak',
          executionMode: 'queue_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          makerNotes: 'Automatically queued due to peak business hours restriction.',
        };

        pendingBatches.set(batchId, batch);

        return {
          success: true,
          pending: true,
          batchId,
          status: 'queued_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          message: policyMessage,
          batch,
        };
      }

      // 4. Immediate execution
      return await executeBatchInternal(
        strapi,
        { attribute, value, selectedEntries, selectedCollections, isRegex, regexPattern, publishOnApproval },
        currentUser
      );
    },

    /**
     * Get Pending & Queued Batches
     */
    getPendingBatches() {
      const executionConfig = getExecutionWindowConfig(strapi);
      const windowStatus = checkBusinessHours(executionConfig);
      const batches = Array.from(pendingBatches.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      return {
        success: true,
        batches,
        executionWindow: {
          ...executionConfig,
          ...windowStatus,
        },
      };
    },

    /**
     * Checker Approves Batch
     */
    async approveBatch(batchId: string, checkerUser: any, options: { executeImmediately?: boolean } = { executeImmediately: true }) {
      const batch = pendingBatches.get(batchId);
      if (!batch) {
        throw new Error(`Pending batch ${batchId} not found.`);
      }
      if (batch.status !== 'pending_approval') {
        throw new Error(`Batch ${batchId} is not pending approval (current status: ${batch.status}).`);
      }

      batch.approval = {
        checkerUser: checkerUser
          ? {
              id: checkerUser.id,
              email: checkerUser.email,
              firstname: checkerUser.firstname,
              lastname: checkerUser.lastname,
              username: checkerUser.username,
            }
          : { email: 'checker@system.local' },
        decisionDate: new Date().toISOString(),
      };

      const config = getExecutionWindowConfig(strapi);
      const { isBusinessHours } = checkBusinessHours(config);

      if (options.executeImmediately || !isBusinessHours) {
        batch.status = 'approved';
        const result = await executeBatchInternal(strapi, batch.payload, checkerUser, batch.id);
        batch.status = 'executed';
        batch.executionResult = result;
        return {
          success: true,
          batchId,
          status: 'executed',
          message: 'Batch approved and executed successfully by Checker.',
          batch,
          result,
        };
      } else {
        batch.status = 'approved';
        return {
          success: true,
          batchId,
          status: 'approved',
          message: `Batch approved by Checker. Queued for execution during off-peak window (${config.offPeakStartTime}).`,
          batch,
        };
      }
    },

    /**
     * Checker Rejects Batch
     */
    rejectBatch(batchId: string, checkerUser: any, reason: string = 'Rejected by Checker') {
      const batch = pendingBatches.get(batchId);
      if (!batch) {
        throw new Error(`Pending batch ${batchId} not found.`);
      }
      batch.status = 'rejected';
      batch.approval = {
        checkerUser: checkerUser
          ? {
              id: checkerUser.id,
              email: checkerUser.email,
              firstname: checkerUser.firstname,
              lastname: checkerUser.lastname,
              username: checkerUser.username,
            }
          : { email: 'checker@system.local' },
        decisionDate: new Date().toISOString(),
        rejectionReason: reason,
      };

      return {
        success: true,
        batchId,
        status: 'rejected',
        message: `Batch rejected by Checker: ${reason}`,
        batch,
      };
    },

    /**
     * Run Batch Immediately
     */
    async executeNow(batchId: string, currentUser: any) {
      const batch = pendingBatches.get(batchId);
      if (!batch) {
        throw new Error(`Pending batch ${batchId} not found.`);
      }
      if (batch.status === 'executed') {
        throw new Error(`Batch ${batchId} has already been executed.`);
      }

      const result = await executeBatchInternal(strapi, batch.payload, currentUser, batch.id);
      batch.status = 'executed';
      batch.executionResult = result;

      return {
        success: true,
        batchId,
        status: 'executed',
        message: 'Batch executed immediately.',
        batch,
        result,
      };
    },

    invalidateCache(uid?: string) {
      if (uid) {
        invalidateCollectionCache(uid);
      } else {
        queryCache.clear();
        modelsCache.clear();
        staticSchemaCache = null;
      }
    },

    invalidateCollectionCache(uid: string) {
      invalidateCollectionCache(uid);
    },
  };
};
