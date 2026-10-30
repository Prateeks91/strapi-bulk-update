import type { Core } from '@strapi/strapi';
import crypto from 'crypto';
import { recordContentHistoryVersion } from './content-history';

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
 * Ensures consistent two-way mapping for timestamp aliases (updated_at <-> updatedAt,
 * created_at <-> createdAt, published_at <-> publishedAt) so columns in any collection
 * (such as st-feature with updated_at) are properly reflected regardless of source.
 */
export function formatEntryRecord(entry: any): any {
  if (!entry || typeof entry !== 'object') return entry;
  const formatted: any = {
    id: entry.id,
    documentId: entry.documentId,
    status: entry.status !== undefined ? entry.status : undefined,
    ...entry,
  };
  if (entry.updatedAt !== undefined && formatted.updated_at === undefined) {
    formatted.updated_at = entry.updatedAt;
  }
  if (entry.updated_at !== undefined && formatted.updatedAt === undefined) {
    formatted.updatedAt = entry.updated_at;
  }
  if (entry.createdAt !== undefined && formatted.created_at === undefined) {
    formatted.created_at = entry.createdAt;
  }
  if (entry.created_at !== undefined && formatted.createdAt === undefined) {
    formatted.createdAt = entry.created_at;
  }
  if (entry.publishedAt !== undefined && formatted.published_at === undefined) {
    formatted.published_at = entry.publishedAt;
  }
  if (entry.published_at !== undefined && formatted.publishedAt === undefined) {
    formatted.publishedAt = entry.published_at;
  }
  return formatted;
}

export type LifecycleStatus = 'draft' | 'published' | 'modified' | 'unknown';

export interface PreUpdateStatusResult {
  status: LifecycleStatus;
  hadPublishedVersion: boolean;
}

/**
 * Safely checks whether an entry or target object is in an unapproved editing / review stage.
 */
export function isRowInEditingStage(row: Record<string, any>): boolean {
  if (!row || typeof row !== 'object') return false;
  const candidates = [
    row.strapi_stage,
    row['strapi_stage'],
    row.strapiStage,
    row['Strapi Stage'],
    row['strapi-stage'],
    row.stage,
    row.Stage,
    row.review_stage,
    row.workflow_stage,
  ];
  if (row.status && typeof row.status === 'string') {
    const s = row.status.trim().toLowerCase();
    if (s === 'editing' || s === 'in review' || s === 'in_review' || s === 'pending review' || s === 'pending_review') {
      candidates.push(row.status);
    }
  }
  for (const c of candidates) {
    if (c !== undefined && c !== null) {
      let stageName = '';
      if (typeof c === 'object') {
        stageName = String(c.name || c.title || c.status || c.documentId || c.id || '').trim();
      } else if (typeof c === 'string') {
        const trimmed = c.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'object' && parsed !== null) {
              stageName = String(parsed.name || parsed.title || parsed.status || parsed.documentId || parsed.id || '').trim();
            }
          } catch {}
        }
        if (!stageName) {
          stageName = trimmed;
        }
      } else {
        stageName = String(c).trim();
      }

      if (stageName) {
        const s = stageName.toLowerCase();
        if (
          s === 'editing' ||
          s === 'in review' ||
          s === 'in_review' ||
          s === 'pending review' ||
          s === 'pending_review'
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Accurately determines the pre-update publication state of a record.
 * Handles casing variations ('Published', 'published', 'Modified', 'modified', 'Draft', 'draft').
 * Distinguishes:
 * - True Draft: no published version exists (hadPublishedVersion: false)
 * - Published: published version exists and draft is not newer than published version (hadPublishedVersion: true)
 * - Modified: published version exists and draft is newer than published version (hadPublishedVersion: true)
 */
export function resolveRecordPublicationStatus(
  entry: any,
  publishedRecord?: any,
  isDraftAndPublish?: boolean
): PreUpdateStatusResult {
  if (isDraftAndPublish === false) {
    return { status: 'published', hadPublishedVersion: true };
  }

  if (!entry || typeof entry !== 'object') {
    return { status: 'unknown', hadPublishedVersion: false };
  }

  // 1. Explicit status string check on entry or target (case-insensitive)
  if (typeof entry.status === 'string' && entry.status.trim()) {
    const s = entry.status.trim().toLowerCase();
    if (s === 'published') {
      return { status: 'published', hadPublishedVersion: true };
    }
    if (s === 'modified') {
      return { status: 'modified', hadPublishedVersion: true };
    }
    if (s === 'draft') {
      return { status: 'draft', hadPublishedVersion: false };
    }
  }

  // 2. Published counterpart evaluation
  const pub = publishedRecord || (entry.publishedAt ? entry : null);
  if (!pub) {
    return { status: 'draft', hadPublishedVersion: false };
  }

  const draftUpdatedTime = new Date(entry.updatedAt || entry.updated_at || 0).getTime();
  const pubUpdatedTime = new Date(pub.updatedAt || pub.updated_at || 0).getTime();
  const pubPublishedTime = new Date(pub.publishedAt || pub.published_at || 0).getTime();
  const lastPublishedTime = Math.max(
    isNaN(pubUpdatedTime) ? 0 : pubUpdatedTime,
    isNaN(pubPublishedTime) ? 0 : pubPublishedTime
  );

  if (isNaN(draftUpdatedTime) || lastPublishedTime === 0) {
    if (pub.publishedAt || pub.published_at) {
      return { status: 'published', hadPublishedVersion: true };
    }
    return { status: 'unknown', hadPublishedVersion: false };
  }

  if (draftUpdatedTime > lastPublishedTime) {
    return { status: 'modified', hadPublishedVersion: true };
  }

  return { status: 'published', hadPublishedVersion: true };
}

/**
 * Determines whether a document should be published after an update according to the publication status rules:
 * - Records that were Published or Modified before update MUST end up Published.
 * - Records that were Draft before update MUST remain Draft (never published by bulk update).
 * - Records in an unreviewed/editing stage under safe mode are not published.
 */
export function evaluateShouldPublish({
  isDraftAndPublish,
  hadPublishedVersion,
  isEditing,
  publishOnApproval = true,
  publishStrategy = 'safe',
  unreviewedConsent = false,
}: {
  isDraftAndPublish: boolean;
  hadPublishedVersion: boolean;
  isEditing: boolean;
  publishOnApproval?: boolean;
  publishStrategy?: 'safe' | 'all';
  unreviewedConsent?: boolean;
}): boolean {
  if (!isDraftAndPublish) return false;
  if (!hadPublishedVersion) return false; // Pure Draft records must NEVER be published!
  if (!publishOnApproval) return false;
  if (isEditing) return false; // Records in Editing or Review stage must never be published!

  return true;
}

/**
 * Resolves each entry's lifecycle status against the Strapi v5 Document Service.
 * - For non-draftAndPublish collections: returns 'published' for all entries.
 * - For draftAndPublish collections: executes a single batched query for the published
 *   counterparts corresponding to the draft entries (using documentId as primary canonical
 *   identifier, falling back to slug only if present in schema).
 * - Distinguishes:
 *     'draft': no published counterpart exists.
 *     'published': published counterpart exists and draft has not been modified since publication.
 *     'modified': published counterpart exists and draft updatedAt is strictly newer than published updatedAt / publishedAt.
 *     'unknown': ambiguous or missing required identifier, or publication query failure.
 * Ensures zero N+1 queries.
 */
export async function populateDocumentLifecycleStatus(
  strapi: any,
  uid: string,
  entries: any[]
): Promise<any[]> {
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return entries;
  }

  const contentType = strapi?.contentTypes?.[uid];
  if (!contentType) {
    return entries;
  }

  const hasDraftAndPublish = Boolean(contentType.options?.draftAndPublish);
  if (!hasDraftAndPublish) {
    for (const entry of entries) {
      if (entry && typeof entry === 'object') {
        entry.status = 'published';
      }
    }
    return entries;
  }

  const hasSlugInSchema = Boolean(contentType.attributes?.slug);
  const docIds: string[] = [];
  const slugs: string[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.documentId) {
      docIds.push(String(entry.documentId));
    } else if (hasSlugInSchema && entry.slug) {
      slugs.push(String(entry.slug));
    } else {
      entry.status = 'unknown';
    }
  }

  if (docIds.length === 0 && slugs.length === 0) {
    return entries;
  }

  let filterClause: any;
  if (docIds.length > 0 && slugs.length > 0) {
    filterClause = {
      $or: [
        { documentId: { $in: docIds } },
        { slug: { $in: slugs } },
      ],
    };
  } else if (docIds.length > 0) {
    filterClause = { documentId: { $in: docIds } };
  } else {
    filterClause = { slug: { $in: slugs } };
  }

  const queryFields = ['documentId', 'updatedAt', 'publishedAt'];
  if (hasSlugInSchema) {
    queryFields.push('slug');
  }

  let publishedRecords: any[] = [];
  try {
    const docService = strapi?.documents?.(uid as any);
    if (docService?.findMany) {
      publishedRecords = await docService.findMany({
        status: 'published',
        filters: filterClause,
        fields: queryFields,
        limit: Math.max(entries.length, 100),
      });
    }
  } catch (err: any) {
    strapi?.log?.warn?.(`[bulk-updater] Failed to fetch published status for ${uid}: ${err?.message || err}`);
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && entry.status !== 'unknown') {
        entry.status = 'unknown';
      }
    }
    return entries;
  }

  const publishedByDocId = new Map<string, any>();
  const publishedBySlug = new Map<string, any>();

  for (const pub of (publishedRecords || [])) {
    if (pub?.documentId) {
      publishedByDocId.set(String(pub.documentId), pub);
    }
    if (pub?.slug && hasSlugInSchema) {
      publishedBySlug.set(String(pub.slug), pub);
    }
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.status === 'unknown') continue;

    const pub =
      (entry.documentId && publishedByDocId.get(String(entry.documentId))) ||
      (hasSlugInSchema && entry.slug && publishedBySlug.get(String(entry.slug)));

    if (!pub) {
      entry.status = 'draft';
      entry.publishedAt = null;
      entry.published_at = null;
    } else {
      entry.publishedAt = pub.publishedAt || pub.published_at || null;
      entry.published_at = entry.publishedAt;

      const draftUpdatedTime = new Date(entry.updatedAt || entry.updated_at || 0).getTime();
      const pubUpdatedTime = new Date(pub.updatedAt || pub.updated_at || 0).getTime();
      const pubPublishedTime = new Date(pub.publishedAt || pub.published_at || 0).getTime();
      const lastPublishedTime = Math.max(
        isNaN(pubUpdatedTime) ? 0 : pubUpdatedTime,
        isNaN(pubPublishedTime) ? 0 : pubPublishedTime
      );

      if (isNaN(draftUpdatedTime) || lastPublishedTime === 0) {
        if (pub.publishedAt) {
          entry.status = 'published';
        } else {
          entry.status = 'unknown';
        }
      } else if (draftUpdatedTime > lastPublishedTime) {
        entry.status = 'modified';
      } else {
        entry.status = 'published';
      }
    }
  }

  return entries;
}

/**
 * Resolves a sort or filter field name against a content type schema,
 * checking system timestamps (updatedAt <-> updated_at, createdAt <-> created_at, publishedAt <-> published_at),
 * standard identifiers (id, documentId), and snake_case <-> camelCase attribute variants.
 */
export function resolveContentTypeField(contentType: any, field: string): string | null {
  if (!field) return null;
  const attrs = contentType?.attributes || {};
  if (attrs[field]) return field;

  // 1. System timestamp & identifier resolution
  if (field === 'updated_at' || field === 'updatedAt') {
    return attrs['updated_at'] ? 'updated_at' : 'updatedAt';
  }
  if (field === 'created_at' || field === 'createdAt') {
    return attrs['created_at'] ? 'created_at' : 'createdAt';
  }
  if (field === 'published_at' || field === 'publishedAt') {
    return attrs['published_at'] ? 'published_at' : 'publishedAt';
  }
  if (field === 'id' || field === 'documentId') {
    return field;
  }

  // 2. snake_case -> camelCase
  const camel = field.replace(/_([a-z0-9])/g, (_, l) => l.toUpperCase());
  if (attrs[camel]) return camel;

  // 3. camelCase -> snake_case
  const snake = field.replace(/([A-Z])/g, '_$1').toLowerCase();
  if (attrs[snake]) return snake;

  // 4. Case-insensitive / underscore-insensitive match across attributes
  const lower = field.toLowerCase().replace(/_/g, '');
  const matched = Object.keys(attrs).find(
    (k) => k.toLowerCase().replace(/_/g, '') === lower
  );
  if (matched) return matched;

  return null;
}

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
      populate[key] = {
        populate: '*',
      };
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
    const fullPath = prefix ? `${prefix}.${subKey}` : subKey;

    if (subAttr.type === 'dynamiczone') {
      const dzComps = Array.isArray(subAttr.components) ? subAttr.components : [];
      for (const dzCompUid of dzComps) {
        const deeper = discoverComponentAttributes(
          strapi,
          dzCompUid,
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
      continue;
    }

    if (subAttr.type === 'component') {
      if (subAttr.component) {
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

  return Array.from(new Set(discoveredAttrs));
}

/**
 * Parses dynamic zone dot or bracket notation paths:
 * e.g. "blocks.title", "blocks[shared.heading].title", or "blocks[0].title"
 */
export function parseDynamicZonePath(path: string): {
  cleanPath: string;
  rootKey: string;
  subPath: string;
  targetComponentUid?: string;
  targetIndex?: number;
} {
  if (!path) return { cleanPath: '', rootKey: '', subPath: '' };
  const bracketMatch = path.match(/^([^.[]+)\[([^\]]+)\](?:\.(.+))?$/);
  if (bracketMatch) {
    const rootKey = bracketMatch[1];
    const selector = bracketMatch[2].trim();
    const subPath = bracketMatch[3] || '';
    const cleanPath = subPath ? `${rootKey}.${subPath}` : rootKey;
    const numMatch = selector.match(/^#?(\d+)/);
    if (numMatch) {
      return { cleanPath, rootKey, subPath, targetIndex: parseInt(numMatch[1], 10) };
    }
    return { cleanPath, rootKey, subPath, targetComponentUid: selector };
  }

  const parts = path.split('.');
  return {
    cleanPath: path,
    rootKey: parts[0] || '',
    subPath: parts.slice(1).join('.'),
  };
}

/**
 * Formats a component UID into a friendly readable label (e.g. "shared.featured-section" -> "Featured Section")
 */
export function formatComponentName(compUid?: string): string {
  if (!compUid) return 'Component';
  const name = compUid.includes('.') ? compUid.split('.')[1] : compUid;
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface DynamicZoneItemMatch {
  index: number;
  componentUid?: string;
  componentName?: string;
  value: any;
  path: string;
}

/**
 * Extracts all matching instances of a nested property across dynamic zone components or repeatable arrays.
 */
export function getAllNestedValues(obj: any, path: string): DynamicZoneItemMatch[] {
  if (!obj || !path) return [];
  const parsed = parseDynamicZonePath(path);
  const parts = parsed.cleanPath.split('.');
  const [head, ...tail] = parts;

  const rootTarget = obj[head];

  // If rootTarget is an Array (Dynamic Zone or Repeatable Component)
  if (Array.isArray(rootTarget)) {
    const results: DynamicZoneItemMatch[] = [];
    rootTarget.forEach((item, idx) => {
      if (!item || typeof item !== 'object') return;
      if (parsed.targetIndex !== undefined && idx !== parsed.targetIndex) return;
      if (parsed.targetComponentUid && item.__component !== parsed.targetComponentUid) return;

      const compSchema = (global as any).strapi?.components?.[item.__component];
      const fieldInSchema = tail.length > 0 && compSchema?.attributes
        ? tail[0] in compSchema.attributes
        : false;

      const subVal = tail.length > 0 ? getDeepProperty(item, tail.join('.')) : item;
      if (subVal !== undefined || fieldInSchema) {
        results.push({
          index: idx,
          componentUid: item.__component,
          componentName: formatComponentName(item.__component),
          value: subVal !== undefined ? subVal : null,
          path: `${head}[#${idx}${item.__component ? ` ${formatComponentName(item.__component)}` : ''}].${tail.join('.')}`,
        });
      }
    });
    return results;
  }

  // Not an array, standard object resolution
  const singleVal = getDeepProperty(obj, parsed.cleanPath);
  if (singleVal !== undefined) {
    return [
      {
        index: 0,
        value: singleVal,
        path: parsed.cleanPath,
      },
    ];
  }

  return [];
}

/**
 * Validates whether an attribute corresponds to a valid deep component hierarchy
 */
export function isDeepComponentField(contentType: any, allComponents: Record<string, any>, attribute: string): boolean {
  if (!attribute || (!attribute.includes('.') && !attribute.includes('['))) return false;
  const parsed = parseDynamicZonePath(attribute);
  const parts = parsed.cleanPath.split('.');

  function checkPath(currentSchema: any, pathParts: string[]): boolean {
    if (pathParts.length === 0) return true;
    if (!currentSchema || !currentSchema.attributes) return false;
    const [head, ...tail] = pathParts;
    const attrDef = currentSchema.attributes[head];
    if (!attrDef) return false;

    if (tail.length === 0) {
      return true;
    }

    if (attrDef.type === 'component' && attrDef.component) {
      const comp = allComponents[attrDef.component];
      return checkPath(comp, tail);
    }

    if (attrDef.type === 'dynamiczone') {
      const compUids = Array.isArray(attrDef.components) ? attrDef.components : [];
      if (parsed.targetComponentUid) {
        const comp = allComponents[parsed.targetComponentUid];
        return comp ? checkPath(comp, tail) : false;
      }
      return compUids.some((compUid: string) => {
        const comp = allComponents[compUid];
        return checkPath(comp, tail);
      });
    }

    return false;
  }

  return checkPath(contentType, parts);
}

/**
 * Retrieves the schema definition of a leaf attribute from a deep dot-notation or bracket path
 */
export function getLeafAttributeSchema(contentType: any, allComponents: Record<string, any>, attribute: string): any {
  if (!attribute) return null;
  const parsed = parseDynamicZonePath(attribute);
  if (!parsed.cleanPath.includes('.')) return contentType?.attributes?.[parsed.cleanPath] || null;
  const parts = parsed.cleanPath.split('.');

  function resolveLeaf(currentSchema: any, pathParts: string[]): any {
    if (!currentSchema || !currentSchema.attributes) return null;
    const [head, ...tail] = pathParts;
    const attrDef = currentSchema.attributes[head];
    if (!attrDef) return null;

    if (tail.length === 0) {
      return attrDef;
    }

    if (attrDef.type === 'component' && attrDef.component) {
      return resolveLeaf(allComponents[attrDef.component], tail);
    }

    if (attrDef.type === 'dynamiczone') {
      const compUids = Array.isArray(attrDef.components) ? attrDef.components : [];
      if (parsed.targetComponentUid) {
        return resolveLeaf(allComponents[parsed.targetComponentUid], tail);
      }
      for (const compUid of compUids) {
        const found = resolveLeaf(allComponents[compUid], tail);
        if (found) return found;
      }
    }

    return null;
  }

  return resolveLeaf(contentType, parts);
}

/**
 * Immutably sets a nested property at an arbitrary depth while preserving all sibling properties.
 * Fully supports selective targeting of specific dynamic zone indices or component types.
 */
export function setDeepProperty(
  obj: any,
  pathParts: string[],
  value: any,
  options?: {
    targetIndexes?: number[];
    targetComponentUid?: string;
  }
): any {
  if (pathParts.length === 0) return value;
  const [head, ...tail] = pathParts;

  // Case 1: If current obj is an Array (e.g. Dynamic Zone or Repeatable Component)
  if (Array.isArray(obj)) {
    // If head is a numeric index, update only that specific index
    if (/^\d+$/.test(head)) {
      const idx = parseInt(head, 10);
      const copy = [...obj];
      copy[idx] = setDeepProperty(copy[idx] || {}, tail, value, options);
      return copy;
    }

    // Otherwise, head is a property name inside the array items!
    // Update items according to options.targetIndexes / options.targetComponentUid
    return obj.map((item, idx) => {
      if (!item || typeof item !== 'object') return item;

      if (options?.targetIndexes && options.targetIndexes.length > 0) {
        if (!options.targetIndexes.includes(idx)) return item;
      }

      if (options?.targetComponentUid) {
        if (item.__component !== options.targetComponentUid) return item;
      }

      const compSchema = (global as any).strapi?.components?.[item.__component];
      const fieldExistsInSchema = compSchema?.attributes ? head in compSchema.attributes : true;

      if (head in item || fieldExistsInSchema || tail.length === 0) {
        return {
          ...item,
          [head]: setDeepProperty(item[head], tail, value, options),
        };
      }
      return item;
    });
  }

  // Case 2: obj is an Object
  const current = { ...(obj || {}) };
  if (tail.length === 0) {
    current[head] = value;
  } else {
    const subTarget = current[head];
    if (Array.isArray(subTarget)) {
      current[head] = setDeepProperty(subTarget, tail, value, options);
    } else {
      current[head] = setDeepProperty(subTarget || {}, tail, value, options);
    }
  }
  return current;
}

/**
 * Safely resolves a nested dot-notation property (e.g. "a.b.c.d" or bracket notation) across objects and dynamic zone arrays
 */
export function getDeepProperty(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  const parsed = parseDynamicZonePath(path);
  const parts = parsed.cleanPath.split('.');

  function extract(current: any, remainingParts: string[]): any {
    if (current === undefined || current === null) return undefined;
    if (remainingParts.length === 0) return current;

    const [head, ...tail] = remainingParts;

    if (Array.isArray(current)) {
      if (/^\d+$/.test(head)) {
        return extract(current[parseInt(head, 10)], tail);
      }
      for (let idx = 0; idx < current.length; idx++) {
        const item = current[idx];
        if (parsed.targetIndex !== undefined && idx !== parsed.targetIndex) continue;
        if (parsed.targetComponentUid && item?.__component !== parsed.targetComponentUid) continue;
        const found = extract(item?.[head], tail);
        if (found !== undefined && found !== null) return found;
      }
      return undefined;
    }

    return extract(current[head], tail);
  }

  return extract(obj, parts);
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
    action?: string;
    attribute: string;
    value: string;
    selectedEntries?: Array<{ uid: string; documentId: string; dynamicZoneIndexes?: number[]; targetComponentUid?: string }>;
    selectedCollections?: string[];
    isRegex?: boolean;
    regexPattern?: string;
    publishOnApproval?: boolean;
    publishStrategy?: 'safe' | 'all';
    unreviewedConsent?: boolean;
    unreviewedCount?: number;
    rows?: any[];
    uid?: string;
    options?: any;
  };
  summary: {
    attribute: string;
    value: string;
    totalTargets: number;
    collectionBreakdown: Record<string, number>;
    publishOnApproval?: boolean;
    publishStrategy?: 'safe' | 'all';
    unreviewedConsent?: boolean;
    unreviewedCount?: number;
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
  publishStrategy?: 'safe' | 'all';
  unreviewedConsent?: boolean;
  unreviewedCount?: number;
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

export function registerPendingBatch(batch: PendingBatch, jobState?: BatchJobState) {
  pendingBatches.set(batch.id, batch);
  if (jobState) {
    batchJobsMap.set(batch.id, jobState);
  }
}

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
    publishStrategy = 'safe',
    unreviewedConsent = false,
  }: {
    attribute: string;
    value: string;
    selectedEntries?: Array<{ uid: string; documentId: string; dynamicZoneIndexes?: number[]; targetComponentUid?: string }>;
    selectedCollections?: string[];
    isRegex?: boolean;
    regexPattern?: string;
    publishOnApproval?: boolean;
    publishStrategy?: 'safe' | 'all';
    unreviewedConsent?: boolean;
  },
  currentUser?: any,
  existingBatchId?: string
) {
  if (!attribute) {
    throw new Error('Attribute name is required.');
  }

  const targetsMap = new Map<string, { uid: string; documentId: string; dynamicZoneIndexes?: number[]; targetComponentUid?: string }>();

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
    targetsMap.set(key, {
      uid: item.uid,
      documentId: item.documentId,
      dynamicZoneIndexes: item.dynamicZoneIndexes,
      targetComponentUid: item.targetComponentUid,
    });
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
    publishStrategy,
    unreviewedConsent,
    results: [],
  };
  batchJobsMap.set(batchId, jobState);

  let regexObj: RegExp | null = null;
  if (isRegex && regexPattern) {
    regexObj = new RegExp(regexPattern, 'g');
  }

  const targets = Array.from(targetsMap.values());
  const CHUNK_SIZE = 25; // 25 concurrent updates per batch window

  // Pre-fetch published counterparts for all draftAndPublish targets in a single batched query per collection
  const publishedCounterparts = new Map<string, any>();
  const uidsWithDraftAndPublish = new Set<string>();
  const docIdsByUid = new Map<string, string[]>();
  for (const target of targets) {
    if (target.uid && target.documentId) {
      const ct = strapi.contentTypes[target.uid];
      if (ct?.options?.draftAndPublish) {
        uidsWithDraftAndPublish.add(target.uid);
        if (!docIdsByUid.has(target.uid)) {
          docIdsByUid.set(target.uid, []);
        }
        docIdsByUid.get(target.uid)!.push(target.documentId);
      }
    }
  }

  for (const colUid of uidsWithDraftAndPublish) {
    const docIds = docIdsByUid.get(colUid) || [];
    if (docIds.length > 0) {
      try {
        const pubDocs = await (strapi.documents(colUid as any) as any).findMany({
          status: 'published',
          filters: { documentId: { $in: docIds } },
          fields: ['documentId', 'updatedAt', 'publishedAt', 'locale'],
          limit: Math.max(docIds.length, 100),
        });
        for (const pub of (pubDocs || [])) {
          if (pub?.documentId) {
            publishedCounterparts.set(`${colUid}@@@${pub.documentId}`, pub);
            if (pub.locale) {
              publishedCounterparts.set(`${colUid}@@@${pub.documentId}@@@${pub.locale}`, pub);
            }
          }
        }
      } catch {}
    }
  }

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

        const parsed = parseDynamicZonePath(attribute);
        const isNested = attribute.includes('.') || attribute.includes('[');
        const isComponentNested = isNested && isDeepComponentField(contentType, strapi.components, attribute);
        const parts = isNested ? parsed.cleanPath.split('.') : [];
        const rootKey = parsed.rootKey;
        const targetComponentUid = target.targetComponentUid || parsed.targetComponentUid;
        const targetIndexes = target.dynamicZoneIndexes;

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
            const isRootDz = contentType?.attributes?.[rootKey]?.type === 'dynamiczone';
            const existingRoot = currentEntryWithPopulate?.[rootKey] || (isRootDz ? [] : {});

            let affectedMatches: DynamicZoneItemMatch[] = [];
            if (isRootDz && Array.isArray(existingRoot)) {
              affectedMatches = getAllNestedValues({ [rootKey]: existingRoot }, attribute);
              if (targetIndexes && targetIndexes.length > 0) {
                affectedMatches = affectedMatches.filter((m) => targetIndexes.includes(m.index));
              }
              if (targetComponentUid) {
                affectedMatches = affectedMatches.filter((m) => m.componentUid === targetComponentUid);
              }
            }

            const currentVal = isRootDz
              ? (affectedMatches.length > 0 ? affectedMatches.map((m) => m.value).join(', ') : getDeepProperty(existingRoot, parts.slice(1).join('.')))
              : getDeepProperty(existingRoot, parts.slice(1).join('.'));

            let newValue = value;
            if (regexObj && typeof currentVal === 'string') {
              newValue = currentVal.replace(regexObj, value);
            }

            const updatedRoot = setDeepProperty(existingRoot, parts.slice(1), newValue, {
              targetIndexes,
              targetComponentUid,
            });

            const isDraftAndPublishComp = Boolean(contentType?.options?.draftAndPublish);
            const candLocaleComp = (target as any).locale || currentEntry?.locale;
            let pubRecordComp = (candLocaleComp && publishedCounterparts.get(`${target.uid}@@@${target.documentId}@@@${candLocaleComp}`)) ||
              publishedCounterparts.get(`${target.uid}@@@${target.documentId}`);
            if (!pubRecordComp && isDraftAndPublishComp && target.documentId) {
              try {
                const singlePub = await (strapi.documents(target.uid as any) as any).findMany({
                  status: 'published',
                  filters: { documentId: target.documentId },
                  fields: ['documentId', 'updatedAt', 'publishedAt', 'locale'],
                  limit: 1,
                });
                if (singlePub && singlePub.length > 0) {
                  pubRecordComp = singlePub[0];
                  publishedCounterparts.set(`${target.uid}@@@${target.documentId}`, pubRecordComp);
                }
              } catch {}
            }

            const inspectionTargetComp = ((target as any).status || (target as any).publishedAt)
              ? { ...currentEntry, status: (target as any).status, publishedAt: (target as any).publishedAt }
              : currentEntry;

            const { hadPublishedVersion: hadPubComp } = resolveRecordPublicationStatus(
              inspectionTargetComp,
              pubRecordComp,
              isDraftAndPublishComp
            );

            const isEditingComp = isRowInEditingStage(inspectionTargetComp) || isRowInEditingStage(target as any);
            const shouldPublishComp = evaluateShouldPublish({
              isDraftAndPublish: isDraftAndPublishComp,
              hadPublishedVersion: hadPubComp,
              isEditing: isEditingComp,
              publishOnApproval: Boolean(publishOnApproval),
              publishStrategy,
              unreviewedConsent,
            });

            const updateArgsComp: any = {
              documentId: target.documentId,
              data: {
                [rootKey]: updatedRoot,
              },
            };
            if (Boolean(contentType?.pluginOptions?.i18n?.localized) && candLocaleComp && candLocaleComp !== 'null' && candLocaleComp !== 'undefined') {
              updateArgsComp.locale = candLocaleComp;
            }

            await strapi.documents(target.uid as any).update(updateArgsComp);

            if (shouldPublishComp) {
              try {
                const pubArgs: any = {
                  documentId: target.documentId,
                };
                if (Boolean(contentType?.pluginOptions?.i18n?.localized) && candLocaleComp && candLocaleComp !== 'null' && candLocaleComp !== 'undefined') {
                  pubArgs.locale = candLocaleComp;
                }
                await (strapi.documents(target.uid as any) as any).publish(pubArgs);
              } catch (publishErr) {
                strapi.log.warn(`[bulk-updater] Failed to auto-publish ${target.uid}/${target.documentId}:`, publishErr);
              }
            }

            invalidateCollectionCache(target.uid);

            await recordContentHistoryVersion(strapi, {
              uid: target.uid,
              documentId: target.documentId,
              userId: currentUser?.id,
              statusOverride: shouldPublishComp ? 'published' : (isDraftAndPublishComp ? (hadPubComp ? 'modified' : 'draft') : undefined),
            });

            const dzDiffs = isRootDz && affectedMatches.length > 0
              ? affectedMatches.map((m) => ({
                  index: m.index,
                  componentUid: m.componentUid,
                  componentName: m.componentName,
                  attribute: `${rootKey}[#${m.index} ${m.componentName}].${parts.slice(1).join('.')}`,
                  oldValue: m.value,
                  newValue: regexObj && typeof m.value === 'string' ? m.value.replace(regexObj, value) : value,
                }))
              : [];

            return {
              uid: target.uid,
              collectionName: displayName,
              documentId: target.documentId,
              label: entryLabel,
              attribute,
              oldValue: currentVal ?? null,
              newValue,
              status: 'updated' as const,
              message: isRootDz
                ? `Successfully updated ${affectedMatches.length} dynamic zone item(s) in ${attribute}`
                : `Successfully updated nested field ${attribute}`,
              dynamicZoneDiffs: dzDiffs,
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

            const isDraftAndPublishRel = Boolean(contentType?.options?.draftAndPublish);
            const candLocaleRel = (target as any).locale || currentEntry?.locale;
            let pubRecordRel = (candLocaleRel && publishedCounterparts.get(`${target.uid}@@@${target.documentId}@@@${candLocaleRel}`)) ||
              publishedCounterparts.get(`${target.uid}@@@${target.documentId}`);
            if (!pubRecordRel && isDraftAndPublishRel && target.documentId) {
              try {
                const singlePub = await (strapi.documents(target.uid as any) as any).findMany({
                  status: 'published',
                  filters: { documentId: target.documentId },
                  fields: ['documentId', 'updatedAt', 'publishedAt', 'locale'],
                  limit: 1,
                });
                if (singlePub && singlePub.length > 0) {
                  pubRecordRel = singlePub[0];
                  publishedCounterparts.set(`${target.uid}@@@${target.documentId}`, pubRecordRel);
                }
              } catch {}
            }

            const inspectionTargetRel = ((target as any).status || (target as any).publishedAt)
              ? { ...currentEntry, status: (target as any).status, publishedAt: (target as any).publishedAt }
              : currentEntry;

            const { hadPublishedVersion: hadPubRel } = resolveRecordPublicationStatus(
              inspectionTargetRel,
              pubRecordRel,
              isDraftAndPublishRel
            );

            const isEditingRel = isRowInEditingStage(inspectionTargetRel) || isRowInEditingStage(target as any);
            const shouldPublishRel = evaluateShouldPublish({
              isDraftAndPublish: isDraftAndPublishRel,
              hadPublishedVersion: hadPubRel,
              isEditing: isEditingRel,
              publishOnApproval: Boolean(publishOnApproval),
              publishStrategy,
              unreviewedConsent,
            });

            const updateArgsRel: any = {
              documentId: target.documentId,
              data: {
                [attribute]: relationPayload,
              },
            };
            if (Boolean(contentType?.pluginOptions?.i18n?.localized) && candLocaleRel && candLocaleRel !== 'null' && candLocaleRel !== 'undefined') {
              updateArgsRel.locale = candLocaleRel;
            }

            await strapi.documents(target.uid as any).update(updateArgsRel);

            if (shouldPublishRel) {
              try {
                const pubArgs: any = {
                  documentId: target.documentId,
                };
                if (Boolean(contentType?.pluginOptions?.i18n?.localized) && candLocaleRel && candLocaleRel !== 'null' && candLocaleRel !== 'undefined') {
                  pubArgs.locale = candLocaleRel;
                }
                await (strapi.documents(target.uid as any) as any).publish(pubArgs);
              } catch (publishErr) {
                strapi.log.warn(`[bulk-updater] Failed to auto-publish ${target.uid}/${target.documentId}:`, publishErr);
              }
            }

            invalidateCollectionCache(target.uid);
            if (attrDef.target) {
              invalidateCollectionCache(attrDef.target);
            }

            await recordContentHistoryVersion(strapi, {
              uid: target.uid,
              documentId: target.documentId,
              userId: currentUser?.id,
              statusOverride: shouldPublishRel ? 'published' : (isDraftAndPublishRel ? (hadPubRel ? 'modified' : 'draft') : undefined),
            });

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

          const isDraftAndPublishScalar = Boolean(contentType?.options?.draftAndPublish);
          const candLocaleScalar = (target as any).locale || currentEntry?.locale;
          let pubRecordScalar = (candLocaleScalar && publishedCounterparts.get(`${target.uid}@@@${target.documentId}@@@${candLocaleScalar}`)) ||
            publishedCounterparts.get(`${target.uid}@@@${target.documentId}`);
          if (!pubRecordScalar && isDraftAndPublishScalar && target.documentId) {
            try {
              const singlePub = await (strapi.documents(target.uid as any) as any).findMany({
                status: 'published',
                filters: { documentId: target.documentId },
                fields: ['documentId', 'updatedAt', 'publishedAt', 'locale'],
                limit: 1,
              });
              if (singlePub && singlePub.length > 0) {
                pubRecordScalar = singlePub[0];
                publishedCounterparts.set(`${target.uid}@@@${target.documentId}`, pubRecordScalar);
              }
            } catch {}
          }

          const inspectionTargetScalar = ((target as any).status || (target as any).publishedAt)
            ? { ...currentEntry, status: (target as any).status, publishedAt: (target as any).publishedAt }
            : currentEntry;

          const { hadPublishedVersion: hadPubScalar } = resolveRecordPublicationStatus(
            inspectionTargetScalar,
            pubRecordScalar,
            isDraftAndPublishScalar
          );

          const isEditingScalar = isRowInEditingStage(inspectionTargetScalar) || isRowInEditingStage(target as any);
          const shouldPublishScalar = evaluateShouldPublish({
            isDraftAndPublish: isDraftAndPublishScalar,
            hadPublishedVersion: hadPubScalar,
            isEditing: isEditingScalar,
            publishOnApproval: Boolean(publishOnApproval),
            publishStrategy,
            unreviewedConsent,
          });

          const updateArgsScalar: any = {
            documentId: target.documentId,
            data: {
              [attribute]: newValue,
            },
          };
          if (Boolean(contentType?.pluginOptions?.i18n?.localized) && candLocaleScalar && candLocaleScalar !== 'null' && candLocaleScalar !== 'undefined') {
            updateArgsScalar.locale = candLocaleScalar;
          }

          await strapi.documents(target.uid as any).update(updateArgsScalar);

          if (shouldPublishScalar) {
            try {
              const pubArgs: any = {
                documentId: target.documentId,
              };
              if (Boolean(contentType?.pluginOptions?.i18n?.localized) && candLocaleScalar && candLocaleScalar !== 'null' && candLocaleScalar !== 'undefined') {
                pubArgs.locale = candLocaleScalar;
              }
              await (strapi.documents(target.uid as any) as any).publish(pubArgs);
            } catch (publishErr) {
              strapi.log.warn(`[bulk-updater] Failed to auto-publish ${target.uid}/${target.documentId}:`, publishErr);
            }
          }

          await recordContentHistoryVersion(strapi, {
            uid: target.uid,
            documentId: target.documentId,
            userId: currentUser?.id,
            statusOverride: shouldPublishScalar ? 'published' : (isDraftAndPublishScalar ? (hadPubScalar ? 'modified' : 'draft') : undefined),
          });

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

  const flattenedDiffs: any[] = [];
  for (const r of results) {
    if (r.dynamicZoneDiffs && r.dynamicZoneDiffs.length > 0) {
      for (const dz of r.dynamicZoneDiffs) {
        flattenedDiffs.push({
          uid: r.uid,
          collectionName: r.collectionName,
          documentId: r.documentId,
          label: `${r.label} [Block #${dz.index} (${dz.componentName})]`,
          attribute: dz.attribute,
          oldValue: dz.oldValue,
          newValue: dz.newValue,
          status: 'updated',
          message: `Updated ${dz.attribute}`,
        });
      }
    } else {
      flattenedDiffs.push(r);
    }
  }

  const batchSummary = {
    batchId,
    attribute,
    value,
    updatedCount,
    skippedCount,
    totalTargets: targetsMap.size,
    publishOnApproval,
    publishStrategy,
    unreviewedConsent,
  };

  // Stateless audit recording via consumer's declared audit schema
  await strapi.plugin('bulk-updater').service('audit').recordBatch(
    batchSummary,
    flattenedDiffs,
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
    unreviewedConsent = false,
  }: {
    selectedEntries?: Array<{ uid: string; documentId: string }>;
    selectedCollections?: string[];
    unreviewedConsent?: boolean;
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
    unreviewedConsent,
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

        await recordContentHistoryVersion(strapi, {
          uid: target.uid,
          documentId: target.documentId,
          userId: currentUser?.id,
          statusOverride: 'published',
        });

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
    unreviewedConsent,
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

async function executeBatchByPayload(
  strapi: Core.Strapi,
  batch: PendingBatch,
  currentUser: any
) {
  if (batch.payload?.action === 'csv_import') {
    const csvService = strapi.plugin('bulk-updater').service('csv');
    return await csvService.executeCsvPendingBatch(
      batch.payload.uid,
      batch.payload.rows,
      batch.id,
      batch.payload.options,
      currentUser
    );
  } else if (batch.payload?.action === 'publish') {
    return await executePublishBatchInternal(strapi, batch.payload, currentUser, batch.id);
  } else {
    return await executeBatchInternal(strapi, batch.payload, currentUser, batch.id);
  }
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
            const result = await executeBatchByPayload(strapi, batch, batch.createdBy);
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
    if (typeof runnerInterval.unref === 'function') {
      runnerInterval.unref();
    }
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

            if (rawAttrs[attrKey].type === 'dynamiczone') {
              const dzDef = rawAttrs[attrKey];
              const dzComponents = Array.isArray(dzDef.components) ? dzDef.components : [];
              for (const compUid of dzComponents) {
                // Generic path across all components (e.g. blocks.title)
                const compAttrs = discoverComponentAttributes(
                  strapi,
                  compUid,
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

                // Component-scoped path (e.g. blocks[shared.heading].title)
                const scopedAttrs = discoverComponentAttributes(
                  strapi,
                  compUid,
                  `${attrKey}[${compUid}]`,
                  1,
                  5,
                  systemFields,
                  allContentTypes,
                  relationsByAttr,
                  allRelationsMeta,
                  colAttributesMeta
                );
                nestedComponentAttrs.push(...scopedAttrs);
              }
              return false;
            }

            if (rawAttrs[attrKey].type === 'component') {
              const compDef = rawAttrs[attrKey];
              if (compDef.component) {
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

          const allColAttrs = Array.from(new Set([...validAttrs, ...nestedComponentAttrs]));
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

            const formattedEntries = (entries || []).map(formatEntryRecord);
            await populateDocumentLifecycleStatus(strapi, uid, formattedEntries);

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
      let isRootDz = false;
      let parts: string[] = [];

      let resolvedFilterAttr = targetFilterAttr;
      if (targetFilterAttr) {
        const resolvedField = resolveContentTypeField(contentType, targetFilterAttr);
        if (resolvedField) {
          resolvedFilterAttr = resolvedField;
          colHasAttribute = true;
        } else {
          const parsed = parseDynamicZonePath(targetFilterAttr);
          if (parsed.rootKey && contentType.attributes?.[parsed.rootKey]?.type === 'dynamiczone') {
            isRootDz = true;
            colHasAttribute = true;
            isNestedAttr = true;
            parts = parsed.cleanPath.split('.');
          } else if (targetFilterAttr.includes('.') || targetFilterAttr.includes('[')) {
            isNestedAttr = isDeepComponentField(contentType, strapi.components, targetFilterAttr);
            if (isNestedAttr) {
              colHasAttribute = true;
              parts = parsed.cleanPath.split('.');
            }
          }
        }
      }

      const normOp = (filterOperator || '').toLowerCase().replace(/_/g, '');

      // If a specific attribute filter is active, check if the collection actually has the attribute
      if (normOp && normOp !== 'none') {
        if (!colHasAttribute) {
          // Collection does not possess this attribute: return 0 matching entries
          result = {
            uid,
            status: 'success',
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
          : attrs[resolvedFilterAttr];
        const isRelation = targetAttrSchema?.type === 'relation';
        const isStringLike = ['string', 'text', 'email', 'richtext', 'uid'].includes(targetAttrSchema?.type);

        if (isRelation) {
          const targetUid = targetAttrSchema?.target;
          const targetContentType = targetUid ? strapi.contentTypes[targetUid] : undefined;
          const targetAttrs = targetContentType?.attributes || {};
          const targetStringAttrs = Object.keys(targetAttrs).filter((k) =>
            ['string', 'text', 'email', 'uid'].includes(targetAttrs[k]?.type)
          );

          if (normOp === 'empty') {
            condition = { documentId: { $null: true } };
          } else if (normOp === 'notempty') {
            condition = { documentId: { $notNull: true } };
          } else if (q !== '') {
            const orConditions: any[] = [];
            targetStringAttrs.slice(0, 5).forEach((k) => {
              if (normOp === 'equals') {
                orConditions.push({ [k]: { $eqi: q } });
              } else if (normOp === 'startswith') {
                orConditions.push({ [k]: { $startsWithi: q } });
              } else if (normOp === 'endswith') {
                orConditions.push({ [k]: { $endsWithi: q } });
              } else if (normOp === 'notequals') {
                orConditions.push({ [k]: { $nei: q } });
              } else if (normOp === 'notcontains') {
                orConditions.push({ [k]: { $notContainsi: q } });
              } else {
                orConditions.push({ [k]: { $containsi: q } });
              }
            });
            orConditions.push({ documentId: { $eq: q } });
            if (/^\d+$/.test(q)) {
              orConditions.push({ id: { $eq: Number(q) } });
            }
            condition = orConditions.length === 1 ? orConditions[0] : { $or: orConditions };
          }
        } else if (normOp === 'empty') {
          condition = isStringLike ? { $or: [{ $null: true }, { $eq: '' }] } : { $null: true };
        } else if (normOp === 'notempty') {
          condition = isStringLike ? { $and: [{ $notNull: true }, { $ne: '' }] } : { $notNull: true };
        } else if (q !== '') {
          let typedVal: any = q;
          const isNumeric = ['integer', 'biginteger', 'float', 'decimal', 'number'].includes(targetAttrSchema?.type);
          const isBoolean = targetAttrSchema?.type === 'boolean';
          if (isNumeric && /^-?\d+(\.\d+)?$/.test(q)) {
            typedVal = Number(q);
          } else if (isBoolean) {
            if (q.toLowerCase() === 'true') typedVal = true;
            else if (q.toLowerCase() === 'false') typedVal = false;
          }

          switch (normOp) {
            case 'equals':
              condition = isStringLike ? { $eqi: q } : { $eq: typedVal };
              break;
            case 'notequals':
              condition = isStringLike ? { $nei: q } : { $ne: typedVal };
              break;
            case 'contains':
              condition = { $containsi: q };
              break;
            case 'notcontains':
              condition = { $notContainsi: q };
              break;
            case 'startswith':
              condition = { $startsWithi: q };
              break;
            case 'endswith':
              condition = { $endsWithi: q };
              break;
          }
        }

        if (condition !== undefined) {
          if (isNestedAttr) {
            if (isRootDz) {
              // Dynamic zones cannot be filtered via database pushdown in Strapi 5 (causes "Invalid key <zone>").
              // Evaluated in-memory across all components after fetching entries.
            } else {
              const deepFilter = buildDeepFilter(parts, condition);
              Object.assign(filters, deepFilter);
            }
          } else {
            if (normOp === 'empty' && isStringLike) {
              filters.$or = [
                { [resolvedFilterAttr]: { $null: true } },
                { [resolvedFilterAttr]: { $eq: '' } },
              ];
            } else if (normOp === 'notempty' && isStringLike) {
              filters[resolvedFilterAttr] = { $notNull: true, $ne: '' };
            } else {
              filters[resolvedFilterAttr] = condition;
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
        const formattedEntries = singleDoc ? [formatEntryRecord(singleDoc)] : [];
        await populateDocumentLifecycleStatus(strapi, uid, formattedEntries);
        result = {
          uid,
          status: 'success',
          displayName: contentType.info?.displayName || uid,
          isSingleType: true,
          draftAndPublish: Boolean(contentType.options?.draftAndPublish),
          entries: formattedEntries,
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
        } else if (sortField) {
          const resolvedField = resolveContentTypeField(contentType, sortField);
          if (resolvedField) {
            sortClause[resolvedField] = sortOrder;
          } else {
            sortClause['createdAt'] = 'desc';
          }
        } else {
          sortClause['createdAt'] = 'desc';
        }

        if (isRootDz && normOp && normOp !== 'none') {
          // Dynamic zone filter active: fetch candidates safely and filter in-memory across all components
          const findManyArgs: any = {
            limit: 500,
            filters: Object.keys(filters).length > 0 ? filters : undefined,
            sort: sortClause,
          };
          if (populateOption) {
            findManyArgs.populate = populateOption;
          }

          const rawEntries = await strapi.documents(uid as any).findMany(findManyArgs);
          const qVal = (filterQuery || '').trim().toLowerCase();

          const passesDzFilter = (entry: any) => {
            const matches = getAllNestedValues(entry, targetFilterAttr);
            if (normOp === 'empty') {
              return matches.length === 0 || matches.every((m) => {
                const v = m.value;
                if (v === undefined || v === null) return true;
                if (Array.isArray(v)) return v.length === 0;
                if (typeof v === 'object') return Object.keys(v).length === 0;
                return String(v).trim() === '';
              });
            }
            if (normOp === 'notempty') {
              return matches.some((m) => {
                const v = m.value;
                if (v === undefined || v === null) return false;
                if (Array.isArray(v)) return v.length > 0;
                if (typeof v === 'object') return Object.keys(v).length > 0;
                return String(v).trim() !== '';
              });
            }

            const testSingleValue = (v: any): boolean => {
              if (v === undefined || v === null) return false;
              if (Array.isArray(v)) return v.some(testSingleValue);
              if (typeof v === 'object') {
                return (
                  testSingleValue(v.name) ||
                  testSingleValue(v.title) ||
                  testSingleValue(v.email) ||
                  testSingleValue(v.username) ||
                  testSingleValue(v.documentId) ||
                  testSingleValue(v.id) ||
                  testSingleValue(v.slug)
                );
              }
              const valStr = String(v).trim().toLowerCase();
              switch (normOp) {
                case 'equals': return valStr === qVal;
                case 'notequals': return valStr !== qVal;
                case 'contains': return valStr.includes(qVal);
                case 'notcontains': return !valStr.includes(qVal);
                case 'startswith': return valStr.startsWith(qVal);
                case 'endswith': return valStr.endsWith(qVal);
                default: return true;
              }
            };

            return matches.some((m) => testSingleValue(m.value));
          };

          const matchedEntries = (rawEntries || []).filter(passesDzFilter);
          const totalEntries = matchedEntries.length;
          const paginatedEntries = matchedEntries.slice(start, start + limit);
          const formattedEntries = paginatedEntries.map(formatEntryRecord);
          await populateDocumentLifecycleStatus(strapi, uid, formattedEntries);

          result = {
            uid,
            status: 'success',
            displayName: contentType.info?.displayName || uid,
            isSingleType: false,
            draftAndPublish: Boolean(contentType.options?.draftAndPublish),
            entries: formattedEntries,
            pagination: {
              page: currentPage,
              pageSize: limit,
              total: totalEntries,
              pageCount: Math.ceil(totalEntries / limit) || 1,
            },
          };
        } else {
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

          const formattedEntries = (entries || []).map(formatEntryRecord);
          await populateDocumentLifecycleStatus(strapi, uid, formattedEntries);

          result = {
            uid,
            status: 'success',
            displayName: contentType.info?.displayName || uid,
            isSingleType: false,
            draftAndPublish: Boolean(contentType.options?.draftAndPublish),
            entries: formattedEntries,
            pagination: {
              page: currentPage,
              pageSize: limit,
              total: totalEntries,
              pageCount: Math.ceil(totalEntries / limit) || 1,
            },
          };
        }
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
      selectedEntries?: Array<{ uid: string; documentId: string; dynamicZoneIndexes?: number[]; targetComponentUid?: string }>;
      selectedCollections?: string[];
      isRegex?: boolean;
      regexPattern?: string;
    }) {
      if (!attribute) {
        throw new Error('Attribute name is required.');
      }

      const targetsMap = new Map<string, { uid: string; documentId: string; dynamicZoneIndexes?: number[]; targetComponentUid?: string }>();

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
        targetsMap.set(key, {
          uid: item.uid,
          documentId: item.documentId,
          dynamicZoneIndexes: item.dynamicZoneIndexes,
          targetComponentUid: item.targetComponentUid,
        });
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
            const parsed = parseDynamicZonePath(attribute);
            const rootKey = parsed.rootKey;
            const isRootDz = contentType?.attributes?.[rootKey]?.type === 'dynamiczone';
            const targetIndexes = target.dynamicZoneIndexes;
            const targetComponentUid = target.targetComponentUid || parsed.targetComponentUid;

            if (isRootDz && currentEntry?.[rootKey] && Array.isArray(currentEntry[rootKey])) {
              let affectedMatches = getAllNestedValues({ [rootKey]: currentEntry[rootKey] }, attribute);
              if (targetIndexes && targetIndexes.length > 0) {
                affectedMatches = affectedMatches.filter((m) => targetIndexes.includes(m.index));
              }
              if (targetComponentUid) {
                affectedMatches = affectedMatches.filter((m) => m.componentUid === targetComponentUid);
              }

              if (affectedMatches.length > 0) {
                for (const match of affectedMatches) {
                  let blockNewVal = value;
                  if (regexObj && typeof match.value === 'string') {
                    blockNewVal = match.value.replace(regexObj, value);
                  }
                  const hasChange = String(match.value ?? '') !== String(blockNewVal ?? '');
                  if (hasChange) {
                    willUpdateCount++;
                  } else {
                    unchangedCount++;
                  }

                  diffs.push({
                    uid: target.uid,
                    collectionName: displayName,
                    documentId: target.documentId,
                    label: `${entryLabel} [Block #${match.index} (${match.componentName})]`,
                    attribute: `${rootKey}[#${match.index} ${match.componentName}].${parsed.subPath}`,
                    oldValue: match.value ?? null,
                    newValue: blockNewVal,
                    oldDisplay: match.value !== undefined && match.value !== null && String(match.value).trim() !== '' ? String(match.value) : '(empty)',
                    newDisplay: String(blockNewVal ?? ''),
                    hasChange,
                    status: hasChange ? 'will_update' : 'unchanged',
                    message: hasChange ? 'Block value will be updated' : 'Block already has target value',
                  });
                }
                continue;
              }
            }

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
        publishStrategy = 'safe',
        unreviewedConsent = false,
        unreviewedCount = 0,
      }: {
        attribute: string;
        value: string;
        selectedEntries?: Array<{ uid: string; documentId: string; dynamicZoneIndexes?: number[]; targetComponentUid?: string }>;
        selectedCollections?: string[];
        isRegex?: boolean;
        regexPattern?: string;
        executionMode?: 'immediate' | 'queue_offpeak' | 'maker_checker';
        makerNotes?: string;
        forceImmediate?: boolean;
        publishOnApproval?: boolean;
        publishStrategy?: 'safe' | 'all';
        unreviewedConsent?: boolean;
        unreviewedCount?: number;
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
          payload: { attribute, value, selectedEntries, selectedCollections, isRegex, regexPattern, publishOnApproval, publishStrategy, unreviewedConsent, unreviewedCount },
          summary: {
            attribute,
            value,
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval,
            publishStrategy,
            unreviewedConsent,
            unreviewedCount,
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
          publishStrategy,
          unreviewedConsent,
          unreviewedCount,
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
          payload: { attribute, value, selectedEntries, selectedCollections, isRegex, regexPattern, publishOnApproval, publishStrategy, unreviewedConsent, unreviewedCount },
          summary: {
            attribute,
            value,
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval,
            publishStrategy,
            unreviewedConsent,
            unreviewedCount,
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
          publishStrategy,
          unreviewedConsent,
          unreviewedCount,
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
          payload: { attribute, value, selectedEntries, selectedCollections, isRegex, regexPattern, publishOnApproval, publishStrategy, unreviewedConsent, unreviewedCount },
          summary: {
            attribute,
            value,
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval,
            publishStrategy,
            unreviewedConsent,
            unreviewedCount,
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
          publishStrategy,
          unreviewedConsent,
          unreviewedCount,
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
        { attribute, value, selectedEntries, selectedCollections, isRegex, regexPattern, publishOnApproval, publishStrategy, unreviewedConsent },
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
        unreviewedConsent = false,
        unreviewedCount = 0,
      }: {
        selectedEntries?: Array<{ uid: string; documentId: string }>;
        selectedCollections?: string[];
        executionMode?: 'immediate' | 'queue_offpeak' | 'maker_checker';
        makerNotes?: string;
        forceImmediate?: boolean;
        unreviewedConsent?: boolean;
        unreviewedCount?: number;
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
          payload: { action: 'publish', attribute: '(publish)', value: 'published', selectedEntries, selectedCollections, publishOnApproval: true, unreviewedConsent, unreviewedCount },
          summary: {
            attribute: '(publish)',
            value: 'published',
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval: true,
            unreviewedConsent,
            unreviewedCount,
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
          unreviewedConsent,
          unreviewedCount,
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
          payload: { action: 'publish', attribute: '(publish)', value: 'published', selectedEntries, selectedCollections, publishOnApproval: true, unreviewedConsent, unreviewedCount },
          summary: {
            attribute: '(publish)',
            value: 'published',
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval: true,
            unreviewedConsent,
            unreviewedCount,
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
          unreviewedConsent,
          unreviewedCount,
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
          payload: { action: 'publish', attribute: '(publish)', value: 'published', selectedEntries, selectedCollections, publishOnApproval: true, unreviewedConsent, unreviewedCount },
          summary: {
            attribute: '(publish)',
            value: 'published',
            totalTargets: summary.totalTargets,
            collectionBreakdown: summary.collectionBreakdown,
            publishOnApproval: true,
            unreviewedConsent,
            unreviewedCount,
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
          unreviewedConsent,
          unreviewedCount,
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
        { selectedEntries, selectedCollections, unreviewedConsent },
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
        const result = await executeBatchByPayload(strapi, batch, checkerUser);
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

      const result = await executeBatchByPayload(strapi, batch, currentUser);
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
     * Inspect batch changes item-by-item for Maker-Checker 4-Eyes review
     */
    async getPendingBatchDiffs(batchId: string) {
      if (!batchId) throw new Error('batchId is required');
      const batch = pendingBatches.get(batchId);
      if (!batch) {
        throw new Error(`Pending batch "${batchId}" not found.`);
      }

      let previewRes: any = null;

      if (batch.payload?.action === 'csv_import' || batch.id.startsWith('csv_')) {
        const csvService = strapi.plugin('bulk-updater').service('csv');
        previewRes = await csvService.previewCsvBatch(
          batch.payload.uid,
          batch.payload.rows || [],
          batch.payload.options || {}
        );
      } else if (batch.payload?.action === 'publish') {
        const selectedEntries = batch.payload.selectedEntries || [];
        const selectedCollections = batch.payload.selectedCollections || [];
        const targetsMap = new Map<string, { uid: string; documentId: string }>();

        for (const colUid of selectedCollections) {
          if (!strapi.contentTypes[colUid]) continue;
          const entries = await (strapi.documents(colUid as any) as any).findMany();
          for (const entry of (entries || []) as any[]) {
            targetsMap.set(`${colUid}@@@${entry.documentId}`, { uid: colUid, documentId: entry.documentId });
          }
        }

        for (const item of selectedEntries) {
          if (!item.uid || !item.documentId) continue;
          targetsMap.set(`${item.uid}@@@${item.documentId}`, { uid: item.uid, documentId: item.documentId });
        }

        const diffs: any[] = [];
        let willUpdate = 0;
        let unchanged = 0;

        for (const target of targetsMap.values()) {
          const ct = strapi.contentTypes[target.uid];
          const displayName = ct?.info?.displayName || target.uid;
          try {
            const doc: any = await (strapi.documents(target.uid as any) as any).findOne({
              documentId: target.documentId,
            });
            const label = doc ? doc.title || doc.name || doc.slug || doc.documentId : target.documentId;
            const isLive = Boolean(doc?.publishedAt) && doc?.status !== 'modified';
            const currentStatus = isLive ? 'published' : (doc?.status === 'modified' ? 'modified draft' : 'draft');
            const hasChange = !isLive;
            if (hasChange) willUpdate++;
            else unchanged++;

            diffs.push({
              uid: target.uid,
              collectionName: displayName,
              documentId: target.documentId,
              label,
              attribute: 'status',
              oldValue: currentStatus,
              newValue: 'published',
              oldDisplay: currentStatus,
              newDisplay: 'published live',
              hasChange,
              status: hasChange ? 'will_update' : 'unchanged',
              action: 'publish',
              message: hasChange ? 'Record will be published live' : 'Already published live',
            });
          } catch (err: any) {
            diffs.push({
              uid: target.uid,
              collectionName: displayName,
              documentId: target.documentId,
              label: target.documentId,
              attribute: 'status',
              oldValue: null,
              newValue: null,
              oldDisplay: '—',
              newDisplay: '—',
              hasChange: false,
              status: 'will_skip',
              action: 'skip',
              message: `Error inspecting document: ${err.message}`,
            });
          }
        }

        previewRes = {
          success: true,
          summary: {
            total: targetsMap.size,
            willUpdate,
            willCreate: 0,
            unchanged,
            skipped: 0,
          },
          diffs,
        };
      } else {
        // Standard Bulk Update
        const preview = await this.previewBatch({
          attribute: batch.payload.attribute,
          value: batch.payload.value,
          selectedEntries: batch.payload.selectedEntries,
          selectedCollections: batch.payload.selectedCollections,
          isRegex: batch.payload.isRegex,
          regexPattern: batch.payload.regexPattern,
        });

        previewRes = {
          success: true,
          summary: {
            total: preview.summary?.total ?? 0,
            willUpdate: preview.summary?.willUpdate ?? 0,
            willCreate: 0,
            unchanged: preview.summary?.unchanged ?? 0,
            skipped: preview.summary?.skipped ?? 0,
          },
          diffs: (preview.diffs || []).map((d: any) => ({
            ...d,
            action: 'update',
          })),
        };
      }

      return {
        success: true,
        batchId: batch.id,
        createdAt: batch.createdAt,
        createdBy: batch.createdBy,
        makerNotes: batch.makerNotes,
        batchSummary: batch.summary,
        payload: {
          action: batch.payload?.action || 'bulk_update',
          attribute: batch.payload?.attribute,
          value: batch.payload?.value,
          publishOnApproval: batch.summary?.publishOnApproval,
          publishStrategy: batch.summary?.publishStrategy,
        },
        summary: previewRes.summary,
        diffs: previewRes.diffs,
      };
    },

    /**
     * Export batch diffs to CSV for offline audit review
     */
    async getPendingBatchDiffsCsv(batchId: string) {
      const data = await this.getPendingBatchDiffs(batchId);

      function escapeVal(val: any): string {
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
        'Action',
        'Collection UID',
        'Collection Name',
        'Document ID',
        'Record Identifier',
        'Attribute Name',
        'Original Value (Before)',
        'Proposed Value (After)',
        'Change Status',
        'Details / Message',
      ];

      const rows: string[] = [headers.join(',')];

      for (const diff of data.diffs || []) {
        const row = [
          escapeVal(data.batchId),
          escapeVal(diff.action || 'update'),
          escapeVal(diff.uid),
          escapeVal(diff.collectionName),
          escapeVal(diff.documentId),
          escapeVal(diff.label),
          escapeVal(diff.attribute),
          escapeVal(diff.oldDisplay ?? diff.oldValue),
          escapeVal(diff.newDisplay ?? diff.newValue),
          escapeVal(
            diff.status === 'will_update'
              ? 'Will Update'
              : diff.status === 'will_create'
              ? 'Will Create'
              : diff.status === 'unchanged'
              ? 'Unchanged'
              : 'Skipped'
          ),
          escapeVal(diff.message),
        ];
        rows.push(row.join(','));
      }

      const safeBatchId = batchId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `pending_batch_review_${safeBatchId}_${new Date().toISOString().slice(0, 10)}.csv`;

      return {
        success: true,
        filename,
        csvContent: '\uFEFF' + rows.join('\r\n') + '\r\n',
        count: data.diffs?.length || 0,
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

    registerPendingBatch(batch: PendingBatch, jobState?: BatchJobState) {
      pendingBatches.set(batch.id, batch);
      if (jobState) {
        batchJobsMap.set(batch.id, jobState);
      }
      return batch;
    },

    getExecutionWindowConfig() {
      return getExecutionWindowConfig(strapi);
    },

    checkBusinessHours(config?: ExecutionWindowConfig) {
      const cfg = config || getExecutionWindowConfig(strapi);
      return checkBusinessHours(cfg);
    },
  };
};
