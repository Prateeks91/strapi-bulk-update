import type { Core } from '@strapi/strapi';
import {
  DiscoveredSchema,
  DiscoveredField,
  discoverSchema,
  SYSTEM_ATTRIBUTES,
} from './schema-discovery';
import { METADATA_COLUMN_KEY, extractMetadataFromRow } from './serializer';
import {
  EXPLICIT_CLEAR_TOKENS,
  buildNestedComponentPatchFromDots,
  deepCloneValue,
  isPlainObject,
  parseFlattenedLeafValue,
  reconstructFlattenedJsonAttribute,
} from './object-flattening';

export interface PayloadBuilderOptions {
  isPartialUpdate?: boolean;
}

/**
 * Validates document ID string
 */
export function isValidDocumentId(val: any): boolean {
  if (!val || typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

/**
 * Parses numeric value safely
 */
export function parseNumeric(rawVal: any, isInteger: boolean): number | null {
  if (rawVal === null || rawVal === undefined || rawVal === '') return null;
  const cleanStr = String(rawVal).replace(/[$€£,\s]/g, '');
  if (isInteger) {
    const n = parseInt(cleanStr, 10);
    return isNaN(n) ? null : n;
  }
  const f = parseFloat(cleanStr);
  return isNaN(f) ? null : f;
}

/**
 * Parses boolean value safely
 */
export function parseBoolean(rawVal: any): boolean | null {
  if (rawVal === null || rawVal === undefined || rawVal === '') return null;
  const s = String(rawVal).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'n' || s === 'off') return false;
  return null;
}

/**
 * Resolves media file numeric IDs for Strapi 5 upload fields
 */
export async function resolveMediaIds(
  strapi: Core.Strapi,
  rawVal: any,
  isMultiple: boolean
): Promise<any> {
  if (rawVal === null || rawVal === undefined || rawVal === '') {
    return isMultiple ? [] : null;
  }

  let parsed: any = rawVal;
  if (typeof rawVal === 'string') {
    const trimmed = rawVal.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {}
    }
  }

  const numericIds: number[] = [];
  const candidateLookups: string[] = [];

  const inspectItem = (item: any) => {
    if (item === null || item === undefined) return;
    if (typeof item === 'number' && !isNaN(item)) {
      numericIds.push(item);
      return;
    }
    if (typeof item === 'object') {
      if (typeof item.id === 'number') {
        numericIds.push(item.id);
        return;
      }
      if (typeof item.id === 'string' && /^\d+$/.test(item.id)) {
        numericIds.push(parseInt(item.id, 10));
        return;
      }
      if (item.documentId) {
        candidateLookups.push(String(item.documentId));
        return;
      }
      if (item.url) {
        candidateLookups.push(String(item.url));
        return;
      }
    }
    const str = String(item).trim();
    if (/^\d+$/.test(str)) {
      numericIds.push(parseInt(str, 10));
    } else if (str) {
      candidateLookups.push(str);
    }
  };

  if (Array.isArray(parsed)) {
    for (const el of parsed) {
      inspectItem(el);
    }
  } else if (typeof parsed === 'object' && parsed !== null) {
    inspectItem(parsed);
  } else if (typeof rawVal === 'string' && (rawVal.includes(',') || rawVal.includes(';'))) {
    const parts = rawVal.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      inspectItem(part);
    }
  } else {
    inspectItem(parsed);
  }

  // If candidate lookups exist (e.g. url or documentId from an edited CSV), resolve to numeric ID
  if (candidateLookups.length > 0) {
    try {
      const fileQuery = strapi.db?.query('plugin::upload.file');
      if (fileQuery) {
        for (const candidate of candidateLookups) {
          const found = await fileQuery.findOne({
            where: {
              $or: [
                { documentId: candidate },
                { url: candidate },
                { hash: candidate },
                { name: candidate },
              ],
            },
            select: ['id'],
          });
          if (found?.id) {
            numericIds.push(found.id);
          }
        }
      }
    } catch {}
  }

  const uniqueNumericIds = Array.from(new Set(numericIds));
  if (isMultiple) {
    return uniqueNumericIds;
  }
  return uniqueNumericIds.length > 0 ? uniqueNumericIds[0] : null;
}

/**
 * Resolves relational operations ({ set, connect, disconnect }) for Strapi 5 Document Service
 */
export function resolveRelationPayload(
  rawVal: any,
  isToMany: boolean
): any {
  if (rawVal === null || rawVal === undefined || rawVal === '') {
    return isToMany ? { set: [] } : { set: [] };
  }

  let parsed: any = rawVal;
  if (typeof rawVal === 'string') {
    const trimmed = rawVal.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {}
    }
  }

  // If already contains explicit connect / disconnect / set operations
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    if (parsed.set || parsed.connect || parsed.disconnect) {
      return parsed;
    }
    const singleDocId = parsed.documentId || parsed.id;
    if (singleDocId && isValidDocumentId(String(singleDocId))) {
      return isToMany
        ? { set: [String(singleDocId).trim()] }
        : { set: [String(singleDocId).trim()] };
    }
  }

  const docIds: string[] = [];

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const id = item.documentId || item.id;
        if (id && isValidDocumentId(String(id))) {
          docIds.push(String(id).trim());
        }
      } else if (isValidDocumentId(String(item))) {
        docIds.push(String(item).trim());
      }
    }
  } else if (typeof rawVal === 'string') {
    if (rawVal.includes(',') || rawVal.includes(';')) {
      const parts = rawVal.split(/[;,]/).map((s) => s.trim()).filter((p) => isValidDocumentId(p));
      docIds.push(...parts);
    } else if (isValidDocumentId(rawVal.trim())) {
      docIds.push(rawVal.trim());
    }
  }

  const uniqueDocIds = Array.from(new Set(docIds));
  return { set: uniqueDocIds };
}

/**
 * Recursively cleans and validates component attributes against its registered schema
 */
export async function resolveComponentPayload(
  strapi: Core.Strapi,
  compUid: string,
  rawVal: any,
  existingVal: any = {}
): Promise<any> {
  const comp = strapi.components?.[compUid];
  if (!comp?.attributes) {
    return typeof rawVal === 'object' ? rawVal : {};
  }

  let sourceObj: Record<string, any> = {};
  if (typeof rawVal === 'string') {
    try {
      sourceObj = JSON.parse(rawVal);
    } catch {
      return existingVal || {};
    }
  } else if (typeof rawVal === 'object' && rawVal !== null) {
    sourceObj = rawVal;
  } else {
    return existingVal || {};
  }

  const result: Record<string, any> = { ...(existingVal || {}) };

  for (const [attrName, attrDef] of Object.entries(comp.attributes) as [string, any][]) {
    if (SYSTEM_ATTRIBUTES.has(attrName.toLowerCase().replace(/[\s_-]/g, ''))) continue;

    if (!(attrName in sourceObj)) {
      continue; // Unmodified in partial component update
    }

    const fieldVal = sourceObj[attrName];
    const type = String(attrDef.type || '').toLowerCase();

    if (type === 'component') {
      if (attrDef.repeatable) {
        const list = Array.isArray(fieldVal) ? fieldVal : [];
        const cleanedList: any[] = [];
        for (const item of list) {
          const subCleaned = await resolveComponentPayload(strapi, attrDef.component, item, {});
          cleanedList.push(subCleaned);
        }
        result[attrName] = cleanedList;
      } else {
        result[attrName] = await resolveComponentPayload(
          strapi,
          attrDef.component,
          fieldVal,
          existingVal?.[attrName] || {}
        );
      }
    } else if (type === 'relation') {
      const isToMany = String(attrDef.relation || '').toLowerCase().endsWith('many');
      result[attrName] = resolveRelationPayload(fieldVal, isToMany);
    } else if (type === 'media') {
      result[attrName] = await resolveMediaIds(strapi, fieldVal, Boolean(attrDef.multiple));
    } else if (type === 'integer' || type === 'biginteger') {
      result[attrName] = parseNumeric(fieldVal, true);
    } else if (type === 'float' || type === 'decimal') {
      result[attrName] = parseNumeric(fieldVal, false);
    } else if (type === 'boolean') {
      result[attrName] = parseBoolean(fieldVal);
    } else if (type === 'json') {
      if (isPlainObject(fieldVal) && isPlainObject(existingVal?.[attrName])) {
        const deepMergePlain = (base: any, patch: any): any => {
          if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
          const next = deepCloneValue(base);
          for (const [k, v] of Object.entries(patch)) {
            if (isPlainObject(v) && isPlainObject(next[k])) {
              next[k] = deepMergePlain(next[k], v);
            } else {
              next[k] = parseFlattenedLeafValue(v, undefined, next[k]);
            }
          }
          return next;
        };
        result[attrName] = deepMergePlain(existingVal[attrName], fieldVal);
      } else if (isPlainObject(fieldVal)) {
        const parsedObj: Record<string, any> = {};
        for (const [k, v] of Object.entries(fieldVal)) {
          parsedObj[k] = isPlainObject(v) ? deepCloneValue(v) : parseFlattenedLeafValue(v);
        }
        result[attrName] = parsedObj;
      } else if (typeof fieldVal === 'string') {
        try {
          result[attrName] = JSON.parse(fieldVal);
        } catch {
          result[attrName] = fieldVal;
        }
      } else {
        result[attrName] = fieldVal;
      }
    } else if (type === 'blocks') {
      if (typeof fieldVal === 'string') {
        try {
          result[attrName] = JSON.parse(fieldVal);
        } catch {
          result[attrName] = fieldVal;
        }
      } else {
        result[attrName] = fieldVal;
      }
    } else {
      result[attrName] = fieldVal === null || fieldVal === undefined ? null : String(fieldVal);
    }
  }

  return result;
}

/**
 * Validates and transforms dynamic zone items, preserving __component and ordering
 */
export async function resolveDynamicZonePayload(
  strapi: Core.Strapi,
  allowedComponents: string[],
  rawVal: any,
  existingVal: any = []
): Promise<any[]> {
  let list: any[] = [];
  if (typeof rawVal === 'string') {
    try {
      list = JSON.parse(rawVal);
    } catch {
      return existingVal || [];
    }
  } else if (Array.isArray(rawVal)) {
    list = rawVal;
  } else {
    return existingVal || [];
  }

  if (!Array.isArray(list)) return [];

  const allowedSet = new Set(allowedComponents || []);
  const resolvedBlocks: any[] = [];

  for (const block of list) {
    if (!block || typeof block !== 'object') continue;
    const compUid = block.__component;
    if (!compUid || typeof compUid !== 'string') {
      continue; // Missing required __component discriminator
    }

    if (allowedSet.size > 0 && !allowedSet.has(compUid)) {
      continue; // Component UID not allowed in this dynamic zone
    }

    const resolvedAttrs = await resolveComponentPayload(strapi, compUid, block, {});
    resolvedAttrs.__component = compUid;
    resolvedBlocks.push(resolvedAttrs);
  }

  return resolvedBlocks;
}

/**
 * Builds a 100% schema-aware update payload for Strapi 5 Document Service
 */
export async function buildDocumentUpdatePayload(
  strapi: Core.Strapi,
  uid: string,
  existingDoc: any,
  rawRow: Record<string, string>,
  options: PayloadBuilderOptions = {}
): Promise<Record<string, any>> {
  const schema = discoverSchema(strapi, uid);
  const payload: Record<string, any> = {};
  const isPartialUpdate = options.isPartialUpdate !== false;

  // Strip formula prefix if present
  const unescapedRow: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawRow)) {
    let cleanVal = v;
    if (typeof cleanVal === 'string' && /^'[=+@-]/.test(cleanVal)) {
      cleanVal = cleanVal.substring(1);
    }
    unescapedRow[k] = cleanVal;
  }

  const rowMeta = extractMetadataFromRow(unescapedRow);

  // Collect arbitrary-depth dot-notation columns grouped by top-level attribute name
  const dotEntriesByAttr: Record<string, Array<[string, any]>> = {};
  for (const [k, v] of Object.entries(unescapedRow)) {
    const firstDot = k.indexOf('.');
    if (firstDot > 0) {
      const parent = k.slice(0, firstDot);
      if (!dotEntriesByAttr[parent]) dotEntriesByAttr[parent] = [];
      dotEntriesByAttr[parent].push([k, v]);
    }
  }

  for (const [attrName, field] of Object.entries(schema.fields)) {
    const hasDirectKey = attrName in unescapedRow;
    const dotEntries = dotEntriesByAttr[attrName] || [];
    const hasDotKeys = dotEntries.length > 0;

    // If column was completely omitted from the CSV row, leave field unchanged (Partial Update guard)
    if (!hasDirectKey && !hasDotKeys) {
      continue;
    }

    const rawVal = hasDirectKey ? unescapedRow[attrName] : undefined;

    switch (field.category) {
      case 'scalar': {
        if (rawVal === undefined || rawVal === '' || rawVal === null) {
          payload[attrName] = null;
        } else if (field.rawType === 'integer' || field.rawType === 'biginteger') {
          payload[attrName] = parseNumeric(rawVal, true);
        } else if (field.rawType === 'float' || field.rawType === 'decimal') {
          payload[attrName] = parseNumeric(rawVal, false);
        } else if (field.rawType === 'boolean') {
          payload[attrName] = parseBoolean(rawVal);
        } else if (
          field.rawType === 'date' ||
          field.rawType === 'time' ||
          field.rawType === 'datetime' ||
          field.rawType === 'timestamp'
        ) {
          payload[attrName] = String(rawVal).trim() || null;
        } else if (field.rawType === 'enumeration') {
          const trimmed = String(rawVal).trim();
          if (field.enumOptions && field.enumOptions.length > 0) {
            const match = field.enumOptions.find((o) => o.toLowerCase() === trimmed.toLowerCase());
            payload[attrName] = match || trimmed;
          } else {
            payload[attrName] = trimmed;
          }
        } else {
          payload[attrName] = String(rawVal).trim();
        }
        break;
      }

      case 'blocks': {
        if (rawVal === undefined || rawVal === '' || rawVal === null) {
          payload[attrName] = [];
        } else {
          try {
            const parsed = JSON.parse(rawVal);
            payload[attrName] = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            payload[attrName] = [
              { type: 'paragraph', children: [{ type: 'text', text: String(rawVal).trim() }] },
            ];
          }
        }
        break;
      }

      case 'json': {
        const reconstructed = reconstructFlattenedJsonAttribute({
          attrName,
          existingVal: existingDoc?.[attrName],
          hasDirectKey,
          directRawVal: rawVal,
          dotEntries,
          rowMeta: rowMeta
            ? {
                applicableFields: rowMeta.applicableFields,
                flatTypes: rowMeta.flatTypes,
              }
            : null,
          isPartialUpdate,
        });
        if (reconstructed.shouldSet) {
          payload[attrName] = reconstructed.value;
        }
        break;
      }

      case 'component_single': {
        if (field.componentUid) {
          const directTrimmed = typeof rawVal === 'string' ? rawVal.trim() : '';
          if (hasDotKeys) {
            const { hasEffectiveEdits, patch } = buildNestedComponentPatchFromDots(
              attrName,
              dotEntries
            );
            if (hasEffectiveEdits) {
              payload[attrName] = await resolveComponentPayload(
                strapi,
                field.componentUid,
                patch,
                existingDoc?.[attrName] || {}
              );
            } else if (hasDirectKey && rawVal !== '' && rawVal !== undefined && rawVal !== null) {
              if (EXPLICIT_CLEAR_TOKENS.has(directTrimmed) || directTrimmed === 'null') {
                payload[attrName] = null;
              } else {
                payload[attrName] = await resolveComponentPayload(
                  strapi,
                  field.componentUid,
                  rawVal,
                  existingDoc?.[attrName] || {}
                );
              }
            }
          } else if (hasDirectKey) {
            if (EXPLICIT_CLEAR_TOKENS.has(directTrimmed) || directTrimmed === 'null') {
              payload[attrName] = null;
            } else if (rawVal !== '' && rawVal !== null && rawVal !== undefined) {
              payload[attrName] = await resolveComponentPayload(
                strapi,
                field.componentUid,
                rawVal,
                existingDoc?.[attrName] || {}
              );
            }
          }
        }
        break;
      }

      case 'component_repeatable': {
        if (field.componentUid) {
          if (rawVal === '' || rawVal === null || rawVal === undefined) {
            payload[attrName] = [];
          } else {
            let list: any[] = [];
            try {
              list = typeof rawVal === 'string' ? JSON.parse(rawVal) : rawVal;
            } catch {}
            if (Array.isArray(list)) {
              const cleanedItems: any[] = [];
              for (const item of list) {
                const cleaned = await resolveComponentPayload(
                  strapi,
                  field.componentUid,
                  item,
                  {}
                );
                cleanedItems.push(cleaned);
              }
              payload[attrName] = cleanedItems;
            } else {
              payload[attrName] = [];
            }
          }
        }
        break;
      }

      case 'dynamiczone': {
        const allowedComponents = field.dzComponents || [];
        if (rawVal === '' || rawVal === null || rawVal === undefined) {
          payload[attrName] = [];
        } else {
          payload[attrName] = await resolveDynamicZonePayload(
            strapi,
            allowedComponents,
            rawVal,
            existingDoc?.[attrName] || []
          );
        }
        break;
      }

      case 'relation_to_one': {
        payload[attrName] = resolveRelationPayload(rawVal, false);
        break;
      }

      case 'relation_to_many': {
        payload[attrName] = resolveRelationPayload(rawVal, true);
        break;
      }

      case 'media_single': {
        payload[attrName] = await resolveMediaIds(strapi, rawVal, false);
        break;
      }

      case 'media_to_many': {
        payload[attrName] = await resolveMediaIds(strapi, rawVal, true);
        break;
      }

      default:
        payload[attrName] = rawVal;
    }
  }

  return payload;
}
