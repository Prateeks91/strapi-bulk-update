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

export interface AttributeMeta {
  depth: number;
  type: string;
  component?: string;
  isRelation?: boolean;
}

let staticSchemaCache: {
  attributes: string[];
  attributesMeta: Record<string, AttributeMeta>;
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
      attributesMeta: Record<string, AttributeMeta>;
      relations: Record<string, RelationMeta>;
    }
  >;
  relationsMeta: Record<string, RelationMeta>;
} | null = null;

/**
 * Builds a recursive Strapi 5 populate tree for deep nested components, relations, and media
 */
export function buildDeepPopulate(
  attributes: Record<string, any>,
  allComponents: Record<string, any>,
  depth = 0
): Record<string, any> | undefined {
  if (depth > 5) return undefined;
  const populate: Record<string, any> = {};

  for (const [key, def] of Object.entries(attributes || {}) as any[]) {
    if (def.type === 'component' && def.component) {
      const comp = allComponents[def.component];
      if (comp?.attributes) {
        const subPopulate = buildDeepPopulate(comp.attributes, allComponents, depth + 1);
        if (subPopulate && Object.keys(subPopulate).length > 0) {
          populate[key] = {
            populate: subPopulate,
          };
        } else {
          populate[key] = true;
        }
      } else {
        populate[key] = true;
      }
    } else if (def.type === 'dynamiczone') {
      populate[key] = true;
    } else if (def.type === 'relation' || def.type === 'media') {
      populate[key] = true;
    }
  }

  return Object.keys(populate).length > 0 ? populate : undefined;
}

/**
 * Recursively discovers component fields down to a specified maxDepth (up to 5 levels)
 */
export function discoverComponentAttributes(
  strapi: any,
  compUid: string,
  prefix: string,
  currentDepth: number,
  maxDepth: number,
  systemFields: string[],
  allContentTypes: Record<string, any>,
  relationsByAttr: Record<string, RelationMeta>,
  allRelationsMeta: Record<string, RelationMeta>,
  attributesMeta: Record<string, AttributeMeta>
): string[] {
  if (currentDepth > maxDepth || !compUid) return [];
  const compSchema = strapi.components[compUid];
  if (!compSchema?.attributes) return [];

  const discoveredAttrs: string[] = [];

  for (const [subKey, subAttr] of Object.entries(compSchema.attributes) as any[]) {
    if (systemFields.includes(subKey)) continue;
    if (subAttr.type === 'dynamiczone') continue;
    const fullPath = prefix ? `${prefix}.${subKey}` : subKey;

    if (subAttr.type === 'component') {
      if (!subAttr.repeatable && subAttr.component) {
        const deeper = discoverComponentAttributes(
          strapi,
          subAttr.component,
          fullPath,
          currentDepth + 1,
          maxDepth,
          systemFields,
          allContentTypes,
          relationsByAttr,
          allRelationsMeta,
          attributesMeta
        );
        discoveredAttrs.push(...deeper);
      }
    } else if (subAttr.type === 'relation') {
      const targetUid = subAttr.target;
      if (targetUid && allContentTypes[targetUid]) {
        const targetInfo = allContentTypes[targetUid]?.info;
        const isMulti = subAttr.relation === 'oneToMany' || subAttr.relation === 'manyToMany';
        const relMeta: RelationMeta = {
          isRelation: true,
          relationType: subAttr.relation,
          targetUid,
          targetDisplayName: targetInfo?.displayName || targetUid,
          isMulti,
        };
        relationsByAttr[fullPath] = relMeta;
        allRelationsMeta[fullPath] = relMeta;
        attributesMeta[fullPath] = { depth: currentDepth, type: 'relation', component: compUid, isRelation: true };
        discoveredAttrs.push(fullPath);
      }
    } else {
      attributesMeta[fullPath] = { depth: currentDepth, type: subAttr.type, component: compUid };
      discoveredAttrs.push(fullPath);
    }
  }

  return discoveredAttrs;
}

/**
 * Validates whether a dot-notation attribute corresponds to a valid deep component hierarchy
 */
export function isDeepComponentField(contentType: any, allComponents: Record<string, any>, attribute: string): boolean {
  if (!attribute || !attribute.includes('.')) return false;
  const parts = attribute.split('.');
  let currentSchema = contentType;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const attrDef = currentSchema?.attributes?.[part];
    if (!attrDef || attrDef.type !== 'component' || !attrDef.component) return false;
    currentSchema = allComponents[attrDef.component];
    if (!currentSchema) return false;
  }
  const leafField = parts[parts.length - 1];
  return Boolean(currentSchema?.attributes?.[leafField]);
}

/**
 * Retrieves the schema definition of a leaf attribute from a deep dot-notation path
 */
export function getLeafAttributeSchema(contentType: any, allComponents: Record<string, any>, attribute: string): any {
  if (!attribute) return null;
  if (!attribute.includes('.')) return contentType?.attributes?.[attribute] || null;
  const parts = attribute.split('.');
  let currentSchema = contentType;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const attrDef = currentSchema?.attributes?.[part];
    if (!attrDef || attrDef.type !== 'component' || !attrDef.component) return null;
    currentSchema = allComponents[attrDef.component];
    if (!currentSchema) return null;
  }
  return currentSchema?.attributes?.[parts[parts.length - 1]] || null;
}

/**
 * Immutably sets a nested property at an arbitrary depth while preserving all sibling properties
 */
export function setDeepProperty(obj: any, pathParts: string[], value: any): any {
  if (pathParts.length === 0) return value;
  const current = { ...(obj || {}) };
  const [head, ...tail] = pathParts;
  if (tail.length === 0) {
    current[head] = value;
  } else {
    current[head] = setDeepProperty(current[head] || {}, tail, value);
  }
  return current;
}

/**
 * Safely resolves a nested dot-notation property (e.g. "a.b.c.d")
 */
export function getDeepProperty(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  if (!path.includes('.')) return obj[path];
  return path.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
}

/**
 * Constructs a nested filter object for Strapi 5 Document queries (e.g. { a: { b: { c: condition } } })
 */
export function buildDeepFilter(pathParts: string[], condition: any): any {
  if (pathParts.length === 0) return condition;
  const [head, ...tail] = pathParts;
  return {
    [head]: buildDeepFilter(tail, condition),
  };
}

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

export interface BatchJobState {
  id: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  createdBy: { id?: string | number; email?: string; firstname?: string; lastname?: string; username?: string };
  status: 'pending_approval' | 'queued_offpeak' | 'processing' | 'successful' | 'partial_failure' | 'failed';
  executionMode: 'immediate' | 'maker_checker' | 'queue_offpeak';
  scheduledFor?: string;
  attribute: string;
  value: string;
  totalTargets: number;
  processedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  isLive: boolean;
  publishOnApproval: boolean;
  policyMessage?: string;
  makerNotes?: string;
  results: Array<{
    uid: string;
    collectionName: string;
    documentId: string;
    label: string;
    attribute: string;
    oldValue: any;
    newValue: any;
    status: 'updated' | 'skipped' | 'error';
    message: string;
    isLive?: boolean;
  }>;
  error?: string;
}

const pendingBatches = new Map<string, PendingBatch>();
const batchJobsMap = new Map<string, BatchJobState>();
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

  const jobState: BatchJobState = {
    id: batchId,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    createdBy: currentUser
      ? {
          id: currentUser.id,
          email: currentUser.email,
          firstname: currentUser.firstname,
          lastname: currentUser.lastname,
          username: currentUser.username,
        }
      : { email: 'admin@system.local' },
    status: 'processing',
    executionMode: 'immediate',
    attribute,
    value,
    totalTargets: targetsMap.size,
    processedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    isLive: false,
    publishOnApproval: Boolean(publishOnApproval),
    results: [],
  };
  batchJobsMap.set(batchId, jobState);

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
        const isComponentNested = isNested && isDeepComponentField(contentType, strapi.components, attribute);
        const parts = isNested ? attribute.split('.') : [];
        const rootKey = isNested ? parts[0] : '';

        const attrDef = contentType?.attributes?.[attribute];
        const hasAttribute = Boolean(attrDef) || isComponentNested;

        if (hasAttribute) {
          if (isComponentNested) {
            // Retrieve current component state with deep populate for safe recursive merge
            const populateOption = buildDeepPopulate(contentType.attributes, strapi.components);
            const findOneArgs: any = { documentId: target.documentId };
            if (populateOption) {
              findOneArgs.populate = populateOption;
            }
            const currentEntryWithPopulate: any = await strapi.documents(target.uid as any).findOne(findOneArgs);
            const existingRoot = currentEntryWithPopulate?.[rootKey] || {};
            const currentVal = getDeepProperty(existingRoot, parts.slice(1).join('.'));

            let newValue = value;
            if (regexObj && typeof currentVal === 'string') {
              newValue = currentVal.replace(regexObj, value);
            }

            const updatedRoot = setDeepProperty(existingRoot, parts.slice(1), newValue);

            await strapi.documents(target.uid as any).update({
              documentId: target.documentId,
              data: {
                [rootKey]: updatedRoot,
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
    jobState.processedCount = results.length;
    jobState.updatedCount = updatedCount;
    jobState.skippedCount = skippedCount;
    jobState.failedCount = results.filter((r) => r.status === 'error').length;
  }

  // Invalidate local in-process cache for all affected collection UIDs
  const affectedUids = new Set(targets.map((t) => t.uid));
  affectedUids.forEach((uid) => {
    invalidateCollectionCache(uid);
  });

  const failedCount = results.filter((r) => r.status === 'error').length;
  jobState.failedCount = failedCount;
  jobState.completedAt = new Date().toISOString();
  jobState.isLive = updatedCount > 0;
  jobState.status =
    failedCount === 0 && updatedCount > 0
      ? 'successful'
      : failedCount > 0 && updatedCount > 0
      ? 'partial_failure'
      : failedCount > 0
      ? 'failed'
      : 'successful';
  jobState.results = results.map((r) => ({
    ...r,
    isLive: r.status === 'updated',
  }));

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
    failedCount,
    totalTargets: targetsMap.size,
    isLive: jobState.isLive,
    status: jobState.status,
    results,
  };
}

/**
 * Executes a bulk publish operation directly across selected entries and collections.
 */
async function executePublishBatchInternal(
  strapi: Core.Strapi,
  {
    selectedEntries = [],
    selectedCollections = [],
  }: {
    selectedEntries?: Array<{ uid: string; documentId: string }>;
    selectedCollections?: string[];
  },
  currentUser?: any,
  existingBatchId?: string
) {
  const targetsMap = new Map<string, { uid: string; documentId: string }>();

  // 1. Add entire collections if selected
  for (const colUid of selectedCollections) {
    if (!strapi.contentTypes[colUid]) continue;
    const entries = await (strapi.documents(colUid as any) as any).findMany();
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
    throw new Error('No collections or entries were selected to publish.');
  }

  const batchId = existingBatchId || `batch_pub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const results: any[] = [];
  let publishedCount = 0;
  let skippedCount = 0;

  const jobState: BatchJobState = {
    id: batchId,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    createdBy: currentUser
      ? {
          id: currentUser.id,
          email: currentUser.email,
          firstname: currentUser.firstname,
          lastname: currentUser.lastname,
          username: currentUser.username,
        }
      : { email: 'admin@system.local' },
    status: 'processing',
    executionMode: 'immediate',
    attribute: '(publish)',
    value: 'published',
    totalTargets: targetsMap.size,
    processedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    isLive: false,
    publishOnApproval: true,
    results: [],
  };
  batchJobsMap.set(batchId, jobState);

  const targets = Array.from(targetsMap.values());
  const CHUNK_SIZE = 25;

  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const chunk = targets.slice(i, i + CHUNK_SIZE);

    const chunkPromises = chunk.map(async (target) => {
      try {
        const contentType = strapi.contentTypes[target.uid];
        const displayName = contentType?.info?.displayName || target.uid;
        const isDraftAndPublish = Boolean(contentType?.options?.draftAndPublish);

        let existingDoc: any = null;
        try {
          existingDoc = await (strapi.documents(target.uid as any) as any).findOne({
            documentId: target.documentId,
          });
        } catch {
          existingDoc = null;
        }

        const entryLabel =
          existingDoc?.name ||
          existingDoc?.title ||
          existingDoc?.label ||
          existingDoc?.documentId ||
          `Entry #${target.documentId}`;

        if (!isDraftAndPublish) {
          return {
            uid: target.uid,
            collectionName: displayName,
            documentId: target.documentId,
            label: entryLabel,
            attribute: '(publish)',
            status: 'skipped' as const,
            message: `Skipped: Draft & Publish is disabled for collection ${displayName}`,
          };
        }

        const isAlreadyPublished = Boolean(existingDoc?.publishedAt);

        await (strapi.documents(target.uid as any) as any).publish({
          documentId: target.documentId,
        });

        invalidateCollectionCache(target.uid);

        return {
          uid: target.uid,
          collectionName: displayName,
          documentId: target.documentId,
          label: entryLabel,
          attribute: '(publish)',
          oldValue: isAlreadyPublished ? 'published' : 'draft',
          newValue: 'published',
          status: 'updated' as const,
          message: isAlreadyPublished
            ? 'Re-published latest version live'
            : 'Successfully published to live',
        };
      } catch (pubErr: any) {
        return {
          uid: target.uid,
          collectionName: strapi.contentTypes[target.uid]?.info?.displayName || target.uid,
          documentId: target.documentId,
          label: `Entry #${target.documentId}`,
          attribute: '(publish)',
          status: 'error' as const,
          message: pubErr.message || 'Failed to publish entry',
        };
      }
    });

    const chunkResults = await Promise.all(chunkPromises);
    for (const res of chunkResults) {
      if (res.status === 'updated') publishedCount++;
      else if (res.status === 'skipped') skippedCount++;
      results.push(res);
    }
    jobState.processedCount = results.length;
    jobState.updatedCount = publishedCount;
    jobState.skippedCount = skippedCount;
    jobState.failedCount = results.filter((r) => r.status === 'error').length;
  }

  const affectedUids = new Set(targets.map((t) => t.uid));
  affectedUids.forEach((uid) => {
    invalidateCollectionCache(uid);
  });

  const failedCount = results.filter((r) => r.status === 'error').length;
  jobState.failedCount = failedCount;
  jobState.completedAt = new Date().toISOString();
  jobState.isLive = publishedCount > 0;
  jobState.status =
    failedCount === 0 && publishedCount > 0
      ? 'successful'
      : failedCount > 0 && publishedCount > 0
      ? 'partial_failure'
      : failedCount > 0
      ? 'failed'
      : 'successful';
  jobState.results = results.map((r) => ({
    ...r,
    isLive: r.status === 'updated',
  }));

  const batchSummary = {
    batchId,
    attribute: '(publish)',
    value: 'published',
    updatedCount: publishedCount,
    skippedCount,
    totalTargets: targetsMap.size,
    publishOnApproval: true,
  };

  // Stateless audit recording
  await strapi.plugin('bulk-updater').service('audit').recordBatch(
    batchSummary,
    results,
    currentUser
  );

  return {
    success: true,
    batchId,
    publishedCount,
    updatedCount: publishedCount,
    skippedCount,
    failedCount,
    totalTargets: targetsMap.size,
    isLive: publishedCount > 0,
    status: jobState.status,
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
            const result = batch.payload?.action === 'publish'
              ? await executePublishBatchInternal(strapi, batch.payload, batch.createdBy, id)
              : await executeBatchInternal(strapi, batch.payload, batch.createdBy, id);
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
        const allAttributesMeta: Record<string, AttributeMeta> = {};

        for (const uid of targetUids) {
          const contentType = allContentTypes[uid];
          if (!contentType || (contentType.kind !== 'collectionType' && contentType.kind !== 'singleType')) continue;

          const isSingleType = contentType.kind === 'singleType';
          const rawAttrs = contentType.attributes || {};
          const relationsByAttr: Record<string, RelationMeta> = {};
          const colAttributesMeta: Record<string, AttributeMeta> = {};
          const nestedComponentAttrs: string[] = [];

          const validAttrs = Object.keys(rawAttrs).filter((attrKey) => {
            if (systemFields.includes(attrKey)) return false;
            if (rawAttrs[attrKey].type === 'dynamiczone') return false;

            if (rawAttrs[attrKey].type === 'component') {
              const compDef = rawAttrs[attrKey];
              // Support non-repeatable components recursively up to depth 5
              if (!compDef.repeatable && compDef.component) {
                const compAttrs = discoverComponentAttributes(
                  strapi,
                  compDef.component,
                  attrKey,
                  1,
                  5,
                  systemFields,
                  allContentTypes,
                  relationsByAttr,
                  allRelationsMeta,
                  colAttributesMeta
                );
                nestedComponentAttrs.push(...compAttrs);
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
              colAttributesMeta[attrKey] = { depth: 0, type: 'relation', isRelation: true };
              return true;
            }

            colAttributesMeta[attrKey] = { depth: 0, type: rawAttrs[attrKey].type };
            return true;
          });

          const allColAttrs = [...validAttrs, ...nestedComponentAttrs];
          allColAttrs.forEach((attr) => {
            allAttributesSet.add(attr);
            if (colAttributesMeta[attr]) {
              allAttributesMeta[attr] = colAttributesMeta[attr];
            }
          });

          metaByUid[uid] = {
            uid,
            kind: contentType.kind,
            isSingleType,
            draftAndPublish: Boolean(contentType.options?.draftAndPublish),
            singularName: contentType.info?.singularName || uid,
            pluralName: contentType.info?.pluralName || uid,
            displayName: contentType.info?.displayName || uid,
            attributes: allColAttrs,
            attributesMeta: colAttributesMeta,
            relations: relationsByAttr,
          };
        }

        staticSchemaCache = {
          attributes: Array.from(allAttributesSet),
          attributesMeta: allAttributesMeta,
          targetUids: Object.keys(metaByUid),
          metaByUid,
          relationsMeta: allRelationsMeta,
        };
      }

      const collections = [];
      const signatures: string[] = [];

      // 2. High-watermark check per collection with throttled concurrency (batches of 10)
      // Prevents database connection pool exhaustion and file locks on 100+ collection schemas
      const BATCH_CONCURRENCY = 10;
      const collectionResults: Array<any> = [];

      for (let i = 0; i < staticSchemaCache.targetUids.length; i += BATCH_CONCURRENCY) {
        const batchUids = staticSchemaCache.targetUids.slice(i, i + BATCH_CONCURRENCY);
        const batchRes = await Promise.all(
          batchUids.map(async (uid) => {
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
              const populateOption = buildDeepPopulate(allContentTypes[uid]?.attributes || {}, strapi.components);

              if (meta.isSingleType) {
                const singleArgs: any = {};
                if (populateOption) {
                  singleArgs.populate = populateOption;
                }
                const singleDoc: any = await (strapi.documents(uid as any) as any).findFirst(singleArgs);
                if (singleDoc) {
                  entries = [singleDoc];
                  totalCount = 1;
                }
              } else {
                totalCount = await strapi.documents(uid as any).count();
                const findArgs: any = {
                  limit: 10,
                  sort: { createdAt: 'desc' },
                };
                if (populateOption) {
                  findArgs.populate = populateOption;
                }
                entries = await strapi.documents(uid as any).findMany(findArgs);
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
        collectionResults.push(...batchRes);
      }

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
        attributesMeta: staticSchemaCache.attributesMeta,
        collections,
        relationsMeta: staticSchemaCache.relationsMeta,
        maxDiscoveredDepth: 5,
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
        searchAttribute,
        filterOperator,
        filterQuery,
        search,
        sortField,
        sortOrder = 'desc',
      }: {
        page?: number;
        pageSize?: number;
        attribute?: string;
        searchAttribute?: string;
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
      const targetFilterAttr = searchAttribute || attribute;

      // 1. Signature-based caching verification
      const signature = await getCollectionSignature(strapi, uid);
      const cacheKey = `${uid}:${limit}:${start}:${attribute || ''}:${searchAttribute || ''}:${filterOperator || ''}:${filterQuery || ''}:${search || ''}:${sortField || ''}:${sortOrder}`;
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
      let parts: string[] = [];

      if (targetFilterAttr) {
        if (targetFilterAttr.includes('.')) {
          isNestedAttr = isDeepComponentField(contentType, strapi.components, targetFilterAttr);
          if (isNestedAttr) {
            colHasAttribute = true;
            parts = targetFilterAttr.split('.');
          }
        } else if (attrs[targetFilterAttr]) {
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
            draftAndPublish: Boolean(contentType.options?.draftAndPublish),
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

        const targetAttrSchema = isNestedAttr
          ? getLeafAttributeSchema(contentType, strapi.components, targetFilterAttr)
          : attrs[targetFilterAttr];
        const isStringLike = ['string', 'text', 'email', 'richtext', 'uid'].includes(targetAttrSchema?.type);

        if (normOp === 'empty') {
          condition = isStringLike ? { $or: [{ $null: true }, { $eq: '' }] } : { $null: true };
        } else if (normOp === 'notempty') {
          condition = isStringLike ? { $and: [{ $notNull: true }, { $ne: '' }] } : { $notNull: true };
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
            const deepFilter = buildDeepFilter(parts, condition);
            Object.assign(filters, deepFilter);
          } else {
            if (normOp === 'empty' && isStringLike) {
              filters.$or = [
                { [targetFilterAttr]: { $null: true } },
                { [targetFilterAttr]: { $eq: '' } },
              ];
            } else if (normOp === 'notempty' && isStringLike) {
              filters[targetFilterAttr] = { $notNull: true, $ne: '' };
            } else {
              filters[targetFilterAttr] = condition;
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

      const populateOption = buildDeepPopulate(contentType.attributes, strapi.components);

      if (isSingleType) {
        let singleDoc: any = null;
        try {
          const singleArgs: any = {
            filters: Object.keys(filters).length > 0 ? filters : undefined,
          };
          if (populateOption) {
            singleArgs.populate = populateOption;
          }
          singleDoc = await (strapi.documents(uid as any) as any).findFirst(singleArgs);
        } catch {
          singleDoc = null;
        }
        result = {
          uid,
          displayName: contentType.info?.displayName || uid,
          isSingleType: true,
          draftAndPublish: Boolean(contentType.options?.draftAndPublish),
          entries: singleDoc ? [singleDoc] : [],
          pagination: {
            page: 1,
            pageSize: 1,
            total: singleDoc ? 1 : 0,
            pageCount: singleDoc ? 1 : 0,
          },
        };
      } else {

        let sortClause: any = {};
        if (sortField && sortField.includes('.')) {
          const sortParts = sortField.split('.');
          if (isDeepComponentField(contentType, strapi.components, sortField)) {
            sortClause = buildDeepFilter(sortParts, sortOrder);
          } else {
            sortClause['createdAt'] = 'desc';
          }
        } else if (sortField && contentType.attributes?.[sortField]) {
          sortClause[sortField] = sortOrder;
        } else {
          sortClause['createdAt'] = 'desc';
        }

        const findManyArgs: any = {
          start,
          limit,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
          sort: sortClause,
        };
        if (populateOption) {
          findManyArgs.populate = populateOption;
        }

        const [entries, totalEntries] = await Promise.all([
          strapi.documents(uid as any).findMany(findManyArgs),
          strapi.documents(uid as any).count({
            filters: Object.keys(filters).length > 0 ? filters : undefined,
          }),
        ]);

        const totalPages = Math.ceil(totalEntries / limit);

        result = {
          uid,
          displayName: contentType.info?.displayName || uid,
          isSingleType: false,
          draftAndPublish: Boolean(contentType.options?.draftAndPublish),
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
     * Preview bulk update changes before execution:
     * Reads current values and computes proposed new values without mutating data.
     */
    async previewBatch({
      attribute,
      value,
      selectedEntries = [],
      selectedCollections = [],
      isRegex = false,
      regexPattern = '',
    }: {
      attribute: string;
      value: string;
      selectedEntries?: Array<{ uid: string; documentId: string }>;
      selectedCollections?: string[];
      isRegex?: boolean;
      regexPattern?: string;
    }) {
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
        throw new Error('No collections or entries were selected for preview.');
      }

      let regexObj: RegExp | null = null;
      if (isRegex && regexPattern) {
        try {
          regexObj = new RegExp(regexPattern, 'g');
        } catch (e: any) {
          throw new Error(`Invalid regular expression: ${e.message}`);
        }
      }

      const targets = Array.from(targetsMap.values());
      const diffs: any[] = [];
      let willUpdateCount = 0;
      let unchangedCount = 0;
      let skippedCount = 0;

      for (const target of targets) {
        const contentType = strapi.contentTypes[target.uid];
        const displayName = contentType?.info?.displayName || target.uid;

        try {
          const isNested = attribute.includes('.');
          const isComponentNested = isNested && isDeepComponentField(contentType, strapi.components, attribute);

          const attrDef = contentType?.attributes?.[attribute];
          const hasAttribute = Boolean(attrDef) || isComponentNested;

          if (!hasAttribute) {
            skippedCount++;
            diffs.push({
              uid: target.uid,
              collectionName: displayName,
              documentId: target.documentId,
              label: `Entry #${target.documentId}`,
              attribute,
              oldValue: null,
              newValue: null,
              oldDisplay: '—',
              newDisplay: '—',
              hasChange: false,
              status: 'will_skip',
              message: `Attribute "${attribute}" does not exist in schema for ${displayName}`,
            });
            continue;
          }

          let currentEntry: any;
          if (isComponentNested) {
            const findOneArgs: any = { documentId: target.documentId };
            const populateOption = buildDeepPopulate(contentType.attributes, strapi.components);
            if (populateOption) {
              findOneArgs.populate = populateOption;
            }
            currentEntry = await strapi.documents(target.uid as any).findOne(findOneArgs);
          } else if (attrDef?.type === 'relation') {
            currentEntry = await strapi.documents(target.uid as any).findOne({
              documentId: target.documentId,
              populate: [attribute],
            });
          } else {
            currentEntry = await strapi.documents(target.uid as any).findOne({
              documentId: target.documentId,
            });
          }

          const entryLabel =
            currentEntry?.name ||
            currentEntry?.title ||
            currentEntry?.email ||
            `Entry #${target.documentId}`;

          if (isComponentNested) {
            const currentVal = getDeepProperty(currentEntry, attribute);

            let newValue = value;
            if (regexObj && typeof currentVal === 'string') {
              newValue = currentVal.replace(regexObj, value);
            }

            const hasChange = String(currentVal ?? '') !== String(newValue ?? '');
            if (hasChange) {
              willUpdateCount++;
            } else {
              unchangedCount++;
            }

            diffs.push({
              uid: target.uid,
              collectionName: displayName,
              documentId: target.documentId,
              label: entryLabel,
              attribute,
              oldValue: currentVal ?? null,
              newValue,
              oldDisplay: currentVal !== undefined && currentVal !== null ? String(currentVal) : '(empty)',
              newDisplay: String(newValue ?? ''),
              hasChange,
              status: hasChange ? 'will_update' : 'unchanged',
              message: hasChange ? 'Value will be updated' : 'Already has target value',
            });
            continue;
          }

          if (attrDef?.type === 'relation') {
            const isMulti = attrDef.relation === 'oneToMany' || attrDef.relation === 'manyToMany';
            const currentRel = currentEntry?.[attribute];

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

            const hasChange = oldDisplay !== newDisplay;
            if (hasChange) {
              willUpdateCount++;
            } else {
              unchangedCount++;
            }

            diffs.push({
              uid: target.uid,
              collectionName: displayName,
              documentId: target.documentId,
              label: entryLabel,
              attribute,
              oldValue: { isRelation: true, documentIds: oldDocIds, display: oldDisplay },
              newValue: { isRelation: true, mode, documentIds: targetDocIds, display: newDisplay },
              oldDisplay,
              newDisplay,
              hasChange,
              status: hasChange ? 'will_update' : 'unchanged',
              message: hasChange ? `Relation will be modified (${mode})` : 'Relation already set to this target',
            });
            continue;
          }

          // Scalar attributes
          let newValue = value;
          const currentVal = currentEntry?.[attribute];

          if (regexObj && typeof currentVal === 'string') {
            newValue = currentVal.replace(regexObj, value);
          }

          const hasChange = String(currentVal ?? '') !== String(newValue ?? '');
          if (hasChange) {
            willUpdateCount++;
          } else {
            unchangedCount++;
          }

          diffs.push({
            uid: target.uid,
            collectionName: displayName,
            documentId: target.documentId,
            label: entryLabel,
            attribute,
            oldValue: currentVal ?? null,
            newValue,
            oldDisplay: currentVal !== undefined && currentVal !== null ? String(currentVal) : '(empty)',
            newDisplay: String(newValue ?? ''),
            hasChange,
            status: hasChange ? 'will_update' : 'unchanged',
            message: hasChange ? 'Value will be updated' : 'Already matches target value',
          });
        } catch (err: any) {
          skippedCount++;
          diffs.push({
            uid: target.uid,
            collectionName: displayName,
            documentId: target.documentId,
            label: `Entry #${target.documentId}`,
            attribute,
            oldValue: null,
            newValue: null,
            oldDisplay: '—',
            newDisplay: '—',
            hasChange: false,
            status: 'will_skip',
            message: `Error inspecting entry: ${err.message}`,
          });
        }
      }

      return {
        success: true,
        summary: {
          total: targets.length,
          willUpdate: willUpdateCount,
          unchanged: unchangedCount,
          skipped: skippedCount,
        },
        diffs,
      };
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
        batchJobsMap.set(batchId, {
          id: batchId,
          createdAt: batch.createdAt,
          createdBy: batch.createdBy,
          status: 'pending_approval',
          executionMode: 'maker_checker',
          attribute,
          value,
          totalTargets: summary.totalTargets,
          processedCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          isLive: false,
          publishOnApproval: Boolean(publishOnApproval),
          makerNotes,
          results: [],
        });

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
        batchJobsMap.set(batchId, {
          id: batchId,
          createdAt: batch.createdAt,
          createdBy: batch.createdBy,
          status: 'queued_offpeak',
          executionMode: 'queue_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          attribute,
          value,
          totalTargets: summary.totalTargets,
          processedCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          isLive: false,
          publishOnApproval: Boolean(publishOnApproval),
          makerNotes,
          results: [],
        });

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
        batchJobsMap.set(batchId, {
          id: batchId,
          createdAt: batch.createdAt,
          createdBy: batch.createdBy,
          status: 'queued_offpeak',
          executionMode: 'queue_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          attribute,
          value,
          totalTargets: summary.totalTargets,
          processedCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          isLive: false,
          publishOnApproval: Boolean(publishOnApproval),
          policyMessage,
          makerNotes: 'Automatically queued due to peak business hours restriction.',
          results: [],
        });

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
     * Bulk Publish selected entries or collections
     */
    async batchPublish(
      {
        selectedEntries = [],
        selectedCollections = [],
        executionMode = 'immediate',
        makerNotes = '',
        forceImmediate = false,
      }: {
        selectedEntries?: Array<{ uid: string; documentId: string }>;
        selectedCollections?: string[];
        executionMode?: 'immediate' | 'queue_offpeak' | 'maker_checker';
        makerNotes?: string;
        forceImmediate?: boolean;
      },
      currentUser?: any
    ) {
      const executionConfig = getExecutionWindowConfig(strapi);
      const { isBusinessHours, policyMessage } = checkBusinessHours(executionConfig);

      // 1. Enterprise Maker-Checker Flow:
      if (executionMode === 'maker_checker') {
        const summary = await computeTargetsSummary(strapi, { selectedCollections, selectedEntries });
        if (summary.totalTargets === 0) {
          throw new Error('No collections or entries were selected to publish.');
        }

        const batchId = `batch_pub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
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
          payload: { action: 'publish', attribute: '(publish)', value: 'published', selectedEntries, selectedCollections, publishOnApproval: true },
          summary: {
            attribute: '(publish)',
            value: 'published',
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval: true,
          },
          status: 'pending_approval',
          executionMode: 'maker_checker',
          makerNotes,
        };

        pendingBatches.set(batchId, batch);
        batchJobsMap.set(batchId, {
          id: batchId,
          createdAt: batch.createdAt,
          createdBy: batch.createdBy,
          status: 'pending_approval',
          executionMode: 'maker_checker',
          attribute: '(publish)',
          value: 'published',
          totalTargets: summary.totalTargets,
          processedCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          isLive: false,
          publishOnApproval: true,
          makerNotes,
          results: [],
        });

        return {
          success: true,
          pending: true,
          batchId,
          status: 'pending_approval',
          message: 'Bulk publish batch submitted for Checker authorization (4-Eyes Maker-Checker Workflow).',
          batch,
        };
      }

      // 2. Off-Peak Queued Batch:
      if (executionMode === 'queue_offpeak') {
        const summary = await computeTargetsSummary(strapi, { selectedCollections, selectedEntries });
        if (summary.totalTargets === 0) {
          throw new Error('No collections or entries were selected to publish.');
        }

        const batchId = `batch_pub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
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
          payload: { action: 'publish', attribute: '(publish)', value: 'published', selectedEntries, selectedCollections, publishOnApproval: true },
          summary: {
            attribute: '(publish)',
            value: 'published',
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval: true,
          },
          status: 'queued_offpeak',
          executionMode: 'queue_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          makerNotes,
        };

        pendingBatches.set(batchId, batch);
        batchJobsMap.set(batchId, {
          id: batchId,
          createdAt: batch.createdAt,
          createdBy: batch.createdBy,
          status: 'queued_offpeak',
          executionMode: 'queue_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          attribute: '(publish)',
          value: 'published',
          totalTargets: summary.totalTargets,
          processedCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          isLive: false,
          publishOnApproval: true,
          makerNotes,
          results: [],
        });

        return {
          success: true,
          pending: true,
          batchId,
          status: 'queued_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          message: `Bulk publish batch queued for server off-peak maintenance window (${executionConfig.offPeakStartTime}).`,
          batch,
        };
      }

      // 3. Peak hours auto-queue check
      if (executionConfig.enabled && executionConfig.autoQueueDuringBusinessHours && isBusinessHours && !forceImmediate) {
        const summary = await computeTargetsSummary(strapi, { selectedCollections, selectedEntries });
        if (summary.totalTargets === 0) {
          throw new Error('No collections or entries were selected to publish.');
        }

        const batchId = `batch_pub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
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
          payload: { action: 'publish', attribute: '(publish)', value: 'published', selectedEntries, selectedCollections, publishOnApproval: true },
          summary: {
            attribute: '(publish)',
            value: 'published',
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval: true,
          },
          status: 'queued_offpeak',
          executionMode: 'queue_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          makerNotes: 'Automatically queued due to peak business hours restriction.',
        };

        pendingBatches.set(batchId, batch);
        batchJobsMap.set(batchId, {
          id: batchId,
          createdAt: batch.createdAt,
          createdBy: batch.createdBy,
          status: 'queued_offpeak',
          executionMode: 'queue_offpeak',
          scheduledFor: executionConfig.offPeakStartTime,
          attribute: '(publish)',
          value: 'published',
          totalTargets: summary.totalTargets,
          processedCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          isLive: false,
          publishOnApproval: true,
          policyMessage,
          makerNotes: 'Automatically queued due to peak business hours restriction.',
          results: [],
        });

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
      return await executePublishBatchInternal(
        strapi,
        { selectedEntries, selectedCollections },
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
        const result = batch.payload?.action === 'publish'
          ? await executePublishBatchInternal(strapi, batch.payload, checkerUser, batch.id)
          : await executeBatchInternal(strapi, batch.payload, checkerUser, batch.id);
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

      const result = batch.payload?.action === 'publish'
        ? await executePublishBatchInternal(strapi, batch.payload, currentUser, batch.id)
        : await executeBatchInternal(strapi, batch.payload, currentUser, batch.id);
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

    /**
     * Get real-time or historical processing status of a batch job
     */
    async getBatchStatus(batchId: string) {
      if (!batchId) throw new Error('batchId is required');

      let job = batchJobsMap.get(batchId);
      if (job) {
        return { success: true, batch: job };
      }

      const pending = pendingBatches.get(batchId);
      if (pending) {
        const pendingJob: BatchJobState = {
          id: pending.id,
          createdAt: pending.createdAt,
          createdBy: pending.createdBy,
          status: pending.status as any,
          executionMode: pending.executionMode,
          scheduledFor: pending.scheduledFor,
          attribute: pending.payload.attribute,
          value: pending.payload.value,
          totalTargets: pending.summary.totalTargets,
          processedCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          isLive: false,
          publishOnApproval: Boolean(pending.payload.publishOnApproval),
          policyMessage: pending.makerNotes,
          results: [],
        };
        return { success: true, batch: pendingJob };
      }

      // Fallback: Query historical audit log
      try {
        const auditService = strapi.plugin('bulk-updater').service('audit');
        const historyData = await auditService.getHistory();
        const records = Array.isArray(historyData?.history) ? historyData.history : [];
        const found = records.find((r: any) => r.batchId === batchId);

        if (found) {
          const total = found.totalTargets || (found.updatedCount + found.skippedCount) || 1;
          const historicalJob: BatchJobState = {
            id: found.batchId,
            createdAt: found.executedAt || found.createdAt || new Date().toISOString(),
            startedAt: found.executedAt || found.createdAt,
            completedAt: found.executedAt || found.createdAt,
            createdBy: {
              email: found.userEmail || 'admin@strapi.io',
              firstname: found.userName || 'Admin',
            },
            status: found.isRolledBack ? 'failed' : 'successful',
            executionMode: 'immediate',
            attribute: found.attribute,
            value: found.value,
            totalTargets: total,
            processedCount: total,
            updatedCount: found.updatedCount || 0,
            skippedCount: found.skippedCount || 0,
            failedCount: 0,
            isLive: !found.isRolledBack && found.updatedCount > 0,
            publishOnApproval: true,
            results: (found.diffs || []).map((d: any) => ({
              uid: d.uid,
              collectionName: d.collectionName || d.uid,
              documentId: d.documentId,
              label: d.label || `Entry #${d.documentId}`,
              attribute: d.attribute || found.attribute,
              oldValue: d.oldValue,
              newValue: d.newValue,
              status: d.status || 'updated',
              isLive: !found.isRolledBack,
              message: d.message || 'Updated via bulk update',
            })),
          };
          batchJobsMap.set(batchId, historicalJob);
          return { success: true, batch: historicalJob };
        }
      } catch (err) {
        // Fallthrough
      }

      throw new Error(`Batch with ID "${batchId}" was not found.`);
    },

    /**
     * Downloadable execution report (CSV or JSON)
     */
    async getBatchReport(batchId: string, format: string = 'csv') {
      const statusRes = await this.getBatchStatus(batchId);
      const batch = statusRes.batch;

      function escapeCsvVal(val: any): string {
        if (val === null || val === undefined) return '';
        let str = typeof val === 'object' ? JSON.stringify(val) : String(val);
        str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (/^[=+@-]$/.test(str.charAt(0))) {
          str = `'${str}`;
        }
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }

      const headers = [
        'Batch ID',
        'Collection UID',
        'Collection Name',
        'Document ID',
        'Record Title / Identifier',
        'Attribute Name',
        'Previous Value',
        'New Live Value',
        'Processing Status',
        'Live On Server',
        'Details / Message',
        'Executed At',
        'Operator',
      ];

      const rows: string[] = [headers.join(',')];

      for (const item of batch.results || []) {
        const row = [
          escapeCsvVal(batch.id),
          escapeCsvVal(item.uid),
          escapeCsvVal(item.collectionName),
          escapeCsvVal(item.documentId),
          escapeCsvVal(item.label),
          escapeCsvVal(item.attribute),
          escapeCsvVal(item.oldValue),
          escapeCsvVal(item.newValue),
          escapeCsvVal(item.status === 'updated' ? 'Updated' : item.status === 'error' ? 'Failed' : 'Skipped'),
          escapeCsvVal(item.isLive ? 'YES (Live on Site)' : 'NO'),
          escapeCsvVal(item.message),
          escapeCsvVal(batch.completedAt || batch.createdAt),
          escapeCsvVal(batch.createdBy?.email || 'admin@strapi.io'),
        ];
        rows.push(row.join(','));
      }

      const safeBatchId = batch.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `bulk_update_report_${safeBatchId}_${new Date().toISOString().slice(0, 10)}.csv`;

      return {
        success: true,
        filename,
        csvContent: '\uFEFF' + rows.join('\r\n') + '\r\n',
        summary: {
          batchId: batch.id,
          status: batch.status,
          isLive: batch.isLive,
          totalTargets: batch.totalTargets,
          updatedCount: batch.updatedCount,
          skippedCount: batch.skippedCount,
          failedCount: batch.failedCount,
          executedAt: batch.completedAt || batch.createdAt,
          operator: batch.createdBy?.email || 'admin@strapi.io',
        },
        batch,
      };
    },

    /**
     * Get recent batch jobs for the processing dashboard
     */
    async getRecentBatches() {
      const mergedMap = new Map<string, any>();

      // 1. From in-memory batchJobsMap
      for (const [id, job] of batchJobsMap.entries()) {
        mergedMap.set(id, {
          id: job.id,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
          status: job.status,
          isLive: job.isLive,
          executionMode: job.executionMode,
          attribute: job.attribute,
          value: job.value,
          totalTargets: job.totalTargets,
          updatedCount: job.updatedCount,
          skippedCount: job.skippedCount,
          failedCount: job.failedCount,
          operator: job.createdBy?.email || 'admin@strapi.io',
        });
      }

      // 2. From pendingBatches
      for (const [id, p] of pendingBatches.entries()) {
        if (!mergedMap.has(id)) {
          mergedMap.set(id, {
            id: p.id,
            createdAt: p.createdAt,
            status: p.status,
            isLive: false,
            executionMode: p.executionMode,
            attribute: p.payload.attribute,
            value: p.payload.value,
            totalTargets: p.summary.totalTargets,
            updatedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            operator: p.createdBy?.email || 'admin@strapi.io',
          });
        }
      }

      // 3. From audit history
      try {
        const auditService = strapi.plugin('bulk-updater').service('audit');
        const historyData = await auditService.getHistory();
        const records = Array.isArray(historyData?.history) ? historyData.history : [];
        for (const r of records) {
          if (!mergedMap.has(r.batchId)) {
            mergedMap.set(r.batchId, {
              id: r.batchId,
              createdAt: r.executedAt || r.createdAt,
              completedAt: r.executedAt,
              status: r.isRolledBack ? 'failed' : 'successful',
              isLive: !r.isRolledBack && r.updatedCount > 0,
              executionMode: 'immediate',
              attribute: r.attribute,
              value: r.value,
              totalTargets: r.totalTargets || (r.updatedCount + r.skippedCount) || 1,
              updatedCount: r.updatedCount || 0,
              skippedCount: r.skippedCount || 0,
              failedCount: 0,
              operator: r.userEmail || 'admin@strapi.io',
            });
          }
        }
      } catch {
        // Ignore
      }

      const batches = Array.from(mergedMap.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      return {
        success: true,
        batches: batches.slice(0, 50),
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
