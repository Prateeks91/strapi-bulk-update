import type { Core } from '@strapi/strapi';
import {
  DiscoveredSchema,
  DiscoveredField,
  discoverSchema,
  SYSTEM_ATTRIBUTES,
} from './schema-discovery';
import { METADATA_COLUMN_KEY, extractMetadataFromRow } from './serializer';
import {
  DetectedCsvExportMode,
  EXPLICIT_CLEAR_TOKENS,
  EXPLICIT_DELETE_KEY_TOKEN,
  EXPLICIT_EMPTY_STRING_TOKEN,
  deepCloneValue,
  deepEqualValues,
  getDeepProp,
  setDeepProp,
  inspectRowMetadataMode,
  isPlainObject,
  parseFirstLevelCellValue,
  reconstructTargetedFirstLevelObject,
  resolveTargetObjectField,
  validateRecordSchemaConstraints,
} from './object-flattening';
import { getAllNestedValues } from '../bulk-updater';

export interface PayloadBuilderOptions {
  isPartialUpdate?: boolean;
  isCreate?: boolean;
  expectedExportMode?: DetectedCsvExportMode;
  docIdForError?: string;
}

export interface CsvRowMutationPlan {
  payload: Record<string, any>;
  errors: string[];
  warnings: string[];
  detectedMode: DetectedCsvExportMode;
  targetObjectField?: string;
  rowMeta: ReturnType<typeof inspectRowMetadataMode>;
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
              next[k] = parseFirstLevelCellValue(v, undefined, next[k]).value;
            }
          }
          return next;
        };
        result[attrName] = deepMergePlain(existingVal[attrName], fieldVal);
      } else if (isPlainObject(fieldVal)) {
        const parsedObj: Record<string, any> = {};
        for (const [k, v] of Object.entries(fieldVal)) {
          parsedObj[k] = isPlainObject(v)
            ? deepCloneValue(v)
            : parseFirstLevelCellValue(v).value;
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

const UNSAFE_PROP_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Legacy helper: builds a recursive patch from arbitrary dot-notation entries for backward
 * compatibility with older exported CSVs that contain component/json dot columns without a target mode.
 */
function buildLegacyNestedPatchFromDots(
  attrName: string,
  dotEntries: Array<[string, any]>
): { hasEffectiveEdits: boolean; patch: Record<string, any> } {
  const patch: Record<string, any> = {};
  let hasEffectiveEdits = false;
  const prefix = `${attrName}.`;

  for (const [fullKey, rawVal] of dotEntries) {
    if (!fullKey.startsWith(prefix)) continue;
    if (rawVal === undefined || rawVal === null || rawVal === '') continue;

    const segments = fullKey.slice(prefix.length).split('.').filter(Boolean);
    if (segments.length === 0 || segments.some((s) => UNSAFE_PROP_NAMES.has(s))) continue;

    const strVal = String(rawVal);
    const trimmed = strVal.trim();
    if (trimmed === EXPLICIT_DELETE_KEY_TOKEN) continue;

    const parsedValue = EXPLICIT_CLEAR_TOKENS.has(trimmed)
      ? null
      : trimmed === EXPLICIT_EMPTY_STRING_TOKEN
        ? ''
        : parseFirstLevelCellValue(strVal).value;

    let cursor = patch;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!isPlainObject(cursor[seg])) {
        cursor[seg] = {};
      }
      cursor = cursor[seg];
    }
    cursor[segments[segments.length - 1]] = parsedValue;
    hasEffectiveEdits = true;
  }

  return { hasEffectiveEdits, patch };
}

/**
 * Single shared source of truth for CSV row reconstruction, applicability validation,
 * and schema constraint checking used across preflight validation, preview, and import execution.
 */
export async function prepareCsvRowMutation(
  strapi: Core.Strapi,
  uid: string,
  existingDoc: any,
  rawRow: Record<string, string>,
  options: PayloadBuilderOptions = {}
): Promise<CsvRowMutationPlan> {
  const schema = discoverSchema(strapi, uid);
  const payload: Record<string, any> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  const isPartialUpdate = options.isPartialUpdate !== false;
  const isCreate = options.isCreate !== undefined ? options.isCreate : !existingDoc;

  // Strip formula prefix if present
  const unescapedRow: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawRow || {})) {
    let cleanVal = v;
    if (typeof cleanVal === 'string' && /^'[=+@-]/.test(cleanVal)) {
      cleanVal = cleanVal.substring(1);
    }
    unescapedRow[k] = cleanVal;
  }

  const rowInfo = inspectRowMetadataMode(unescapedRow);
  if (rowInfo.error) {
    errors.push(rowInfo.error);
  }

  const detectedMode = rowInfo.mode;
  if (options.expectedExportMode && detectedMode !== options.expectedExportMode) {
    errors.push(
      `Row exportMode "${detectedMode}" conflicts with batch exportMode "${options.expectedExportMode}".`
    );
  }

  const isTargetedMode = detectedMode === 'metafields' || detectedMode === 'topbarconfig';
  const targetAttr = isTargetedMode
    ? rowInfo.targetObjectField || resolveTargetObjectField(schema, detectedMode) || detectedMode
    : undefined;

  // Targeted 1-level update mode: update ONLY the chosen object (metafields or topbarconfig),
  // leaving all unrelated fields, objects, relations, media, components, and dynamic zones untouched.
  if (isTargetedMode && targetAttr && !isCreate) {
    const targetField = schema.fields[targetAttr];
    if (!targetField || (targetField.category !== 'json' && targetField.category !== 'component_single')) {
      errors.push(
        `Target object field "${targetAttr}" for exportMode "${detectedMode}" was not found as an object/component attribute on "${uid}".`
      );
      return {
        payload,
        errors,
        warnings,
        detectedMode,
        targetObjectField: targetAttr,
        rowMeta: rowInfo,
      };
    }

    const ctAttr = strapi.contentTypes?.[uid]?.attributes?.[targetAttr];
    const reconstructed = reconstructTargetedFirstLevelObject({
      targetAttr,
      exportMode: detectedMode,
      existingDoc,
      docIdForError: options.docIdForError,
      rawRow: unescapedRow,
      rowMeta: rowInfo,
      isAttrRequired: Boolean(ctAttr?.required),
    });

    if (reconstructed.errors.length > 0) {
      errors.push(...reconstructed.errors);
    }

    if (reconstructed.shouldSet) {
      if (
        targetField.category === 'component_single' &&
        targetField.componentUid &&
        isPlainObject(reconstructed.value)
      ) {
        payload[targetAttr] = await resolveComponentPayload(
          strapi,
          targetField.componentUid,
          reconstructed.value,
          existingDoc?.[targetAttr] || {}
        );
      } else {
        payload[targetAttr] = reconstructed.value;
      }
    }

    const schemaCheck = validateRecordSchemaConstraints(
      strapi,
      uid,
      existingDoc,
      payload,
      unescapedRow,
      {
        isCreate: false,
        detectedMode,
        targetObjectField: targetAttr,
        rowMeta: rowInfo,
      }
    );
    errors.push(...schemaCheck.errors);
    warnings.push(...schemaCheck.warnings);

    return {
      payload,
      errors,
      warnings,
      detectedMode,
      targetObjectField: targetAttr,
      rowMeta: rowInfo,
    };
  }

  // Selective update mode (Enhancement 2):
  // Headers in CSV minus metadata/identifiers form the strict allowlist of updateable fields.
  // We compare imported values against current persisted values, update only changed fields,
  // skip unchanged records, and preserve unselected fields, sibling properties, and component identities.
  if (detectedMode === 'selective' && !isCreate) {
    const allowlistedHeaders = Object.keys(unescapedRow).filter(
      (k) =>
        k !== METADATA_COLUMN_KEY &&
        k !== '__bulk_updater_metadata' &&
        k !== '_bulk_updater_metadata' &&
        k !== 'documentId' &&
        k !== 'slug'
    );

    if (allowlistedHeaders.length === 0) {
      return {
        payload: {},
        errors: [],
        warnings: [],
        detectedMode,
        rowMeta: rowInfo,
      };
    }

    let hasRowChanges = false;
    const modifiedContainers: Record<string, any> = {};
    const containerChanged: Record<string, boolean> = {};

    for (const colKey of allowlistedHeaders) {
      const rawCell = unescapedRow[colKey];
      if (rawCell === undefined || rawCell === null) {
        continue;
      }
      const strCell = typeof rawCell === 'string' ? rawCell : String(rawCell);
      const trimmed = strCell.trim();

      // Blank cell NEVER deletes or overwrites existing property (Section 1 & 6.2)
      if (strCell === '') {
        continue;
      }

      const isExplicitClear = EXPLICIT_CLEAR_TOKENS.has(trimmed) || trimmed === 'null';
      const isExplicitEmptyString = trimmed === EXPLICIT_EMPTY_STRING_TOKEN;

      const firstDot = colKey.indexOf('.');
      if (firstDot === -1) {
        // Root-level attribute (e.g. title, description, price)
        const field = schema.fields[colKey];
        const currentVal = existingDoc ? existingDoc[colKey] : undefined;
        let targetVal: any;

        if (isExplicitClear) {
          targetVal = null;
        } else if (isExplicitEmptyString) {
          targetVal = '';
        } else if (!field) {
          targetVal = strCell;
        } else if (field.category === 'scalar') {
          if (field.rawType === 'integer' || field.rawType === 'biginteger') {
            targetVal = parseNumeric(strCell, true);
          } else if (field.rawType === 'float' || field.rawType === 'decimal') {
            targetVal = parseNumeric(strCell, false);
          } else if (field.rawType === 'boolean') {
            targetVal = parseBoolean(strCell);
          } else if (field.rawType === 'enumeration') {
            if (field.enumOptions && field.enumOptions.length > 0) {
              const match = field.enumOptions.find((o) => o.toLowerCase() === trimmed.toLowerCase());
              targetVal = match || trimmed;
            } else {
              targetVal = trimmed;
            }
          } else {
            targetVal = strCell;
          }
        } else if (field.category === 'json') {
          targetVal = parseFirstLevelCellValue(strCell, 'object', currentVal).value;
        } else if (field.category === 'relation_to_one') {
          targetVal = resolveRelationPayload(strCell, false);
        } else if (field.category === 'relation_to_many') {
          targetVal = resolveRelationPayload(strCell, true);
        } else if (field.category === 'media_single') {
          targetVal = await resolveMediaIds(strapi, strCell, false);
        } else if (field.category === 'media_to_many') {
          targetVal = await resolveMediaIds(strapi, strCell, true);
        } else {
          targetVal = strCell;
        }

        if (!deepEqualValues(targetVal, currentVal)) {
          payload[colKey] = targetVal;
          hasRowChanges = true;
        }
      } else {
        // Dotted path attribute (e.g. metafields.metatitle or content.titleheadingstyle.titlestyle)
        const rootKey = colKey.slice(0, firstDot);
        const nestedPath = colKey.slice(firstDot + 1);
        const rootField = schema.fields[rootKey];
        const isRepeatableOrDz =
          rootField?.category === 'component_repeatable' ||
          rootField?.category === 'dynamiczone' ||
          rootField?.rawType === 'dynamiczone' ||
          Array.isArray(existingDoc?.[rootKey]);

        if (isRepeatableOrDz) {
          const existingList: any[] = Array.isArray(existingDoc?.[rootKey]) ? existingDoc[rootKey] : [];
          let cellOccurrences: any[] = [];

          if (trimmed.startsWith('[')) {
            try {
              const parsed = JSON.parse(trimmed);
              cellOccurrences = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              errors.push(`Column "${colKey}" contains invalid JSON array: "${strCell}"`);
              continue;
            }
          } else {
            const existingMatches = getAllNestedValues(existingDoc, colKey);
            if (existingMatches.length > 1) {
              errors.push(
                `Ambiguous update: multiple occurrences (${existingMatches.length}) of "${colKey}" exist on document "${options.docIdForError || existingDoc.documentId}", but CSV provided an ambiguous scalar without occurrence IDs.`
              );
              continue;
            } else if (existingMatches.length === 1) {
              cellOccurrences = [
                {
                  id: existingMatches[0].componentId,
                  index: existingMatches[0].index,
                  __component: existingMatches[0].componentUid,
                  value: isExplicitClear ? null : (isExplicitEmptyString ? '' : strCell),
                },
              ];
            } else {
              errors.push(
                `Field "${colKey}" is not applicable or has no matching components on document "${options.docIdForError || existingDoc.documentId}".`
              );
              continue;
            }
          }

          if (!modifiedContainers[rootKey]) {
            modifiedContainers[rootKey] = deepCloneValue(existingList);
            containerChanged[rootKey] = false;
          }
          const workingList: any[] = modifiedContainers[rootKey];

          for (const occ of cellOccurrences) {
            if (!occ || typeof occ !== 'object') continue;
            let targetItem: any = undefined;

            if (occ.id !== undefined && occ.id !== null) {
              targetItem = workingList.find((it) => it && String(it.id) === String(occ.id));
              if (!targetItem) {
                errors.push(
                  `Component occurrence with id "${occ.id}" not found in "${rootKey}" on document "${options.docIdForError || existingDoc.documentId}".`
                );
                continue;
              }
            } else if (occ.index !== undefined && occ.index >= 0 && occ.index < workingList.length) {
              targetItem = workingList[occ.index];
              if (occ.__component && targetItem && targetItem.__component !== occ.__component) {
                errors.push(
                  `Component occurrence at index ${occ.index} expected type "${occ.__component}" but found "${targetItem.__component}".`
                );
                continue;
              }
            } else if (workingList.length === 1) {
              targetItem = workingList[0];
            } else {
              errors.push(
                `Ambiguous component occurrence in column "${colKey}" on document "${options.docIdForError || existingDoc.documentId}": missing occurrence id.`
              );
              continue;
            }

            if (targetItem) {
              let targetVal = occ.value !== undefined ? occ.value : occ;
              if (typeof targetVal === 'string') {
                const normVal = targetVal.trim().toLowerCase();
                if (EXPLICIT_CLEAR_TOKENS.has(normVal)) {
                  targetVal = null;
                } else if (targetVal === EXPLICIT_EMPTY_STRING_TOKEN) {
                  targetVal = '';
                }
              }
              const currentItemVal = getDeepProp(targetItem, nestedPath);
              if (!deepEqualValues(targetVal, currentItemVal)) {
                setDeepProp(targetItem, nestedPath, targetVal);
                containerChanged[rootKey] = true;
                hasRowChanges = true;
              }
            }
          }
        } else {
          // Single component or JSON object
          if (existingDoc && !isPlainObject(existingDoc[rootKey])) {
            const isAttrRequired = Boolean(strapi.contentTypes?.[uid]?.attributes?.[rootKey]?.required);
            if (!isAttrRequired) {
              errors.push(
                `Field "${rootKey}" is not applicable or absent on document "${options.docIdForError || existingDoc.documentId}". Selective import will not create a new "${rootKey}" object automatically.`
              );
              continue;
            }
          }

          if (!modifiedContainers[rootKey]) {
            modifiedContainers[rootKey] = isPlainObject(existingDoc?.[rootKey])
              ? deepCloneValue(existingDoc[rootKey])
              : {};
            containerChanged[rootKey] = false;
          }
          const workingObj = modifiedContainers[rootKey];
          const currentVal = getDeepProp(existingDoc?.[rootKey], nestedPath);
          let targetVal: any;

          if (isExplicitClear) {
            targetVal = null;
          } else if (isExplicitEmptyString) {
            targetVal = '';
          } else {
            targetVal = parseFirstLevelCellValue(strCell, undefined, currentVal).value;
          }

          if (!deepEqualValues(targetVal, currentVal)) {
            setDeepProp(workingObj, nestedPath, targetVal);
            containerChanged[rootKey] = true;
            hasRowChanges = true;
          }
        }
      }
    }

    for (const [rKey, changed] of Object.entries(containerChanged)) {
      if (changed) {
        payload[rKey] = modifiedContainers[rKey];
      }
    }

    if (errors.length > 0) {
      return {
        payload: {},
        errors,
        warnings,
        detectedMode: 'selective',
        rowMeta: rowInfo,
      };
    }

    if (!hasRowChanges || Object.keys(payload).length === 0) {
      return {
        payload: {},
        errors: [],
        warnings: [],
        detectedMode: 'selective',
        rowMeta: rowInfo,
      };
    }

    const schemaCheck = validateRecordSchemaConstraints(
      strapi,
      uid,
      existingDoc,
      payload,
      unescapedRow,
      {
        isCreate: false,
        detectedMode: 'selective',
        rowMeta: rowInfo,
      }
    );
    errors.push(...schemaCheck.errors);
    warnings.push(...schemaCheck.warnings);

    return {
      payload,
      errors,
      warnings,
      detectedMode: 'selective',
      rowMeta: rowInfo,
    };
  }

  // Legacy / All mode (or Create): collect dot-notation columns for backward compatibility
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

    // Targeted create for the target object uses 1-level targeted reconstruction
    if (isTargetedMode && isCreate && targetAttr === attrName) {
      const ctAttr = strapi.contentTypes?.[uid]?.attributes?.[targetAttr];
      const reconstructed = reconstructTargetedFirstLevelObject({
        targetAttr,
        exportMode: detectedMode,
        existingDoc: null,
        docIdForError: options.docIdForError,
        rawRow: unescapedRow,
        rowMeta: rowInfo,
        isAttrRequired: Boolean(ctAttr?.required),
      });
      if (reconstructed.errors.length > 0) {
        errors.push(...reconstructed.errors);
      }
      if (reconstructed.shouldSet) {
        if (
          field.category === 'component_single' &&
          field.componentUid &&
          isPlainObject(reconstructed.value)
        ) {
          payload[attrName] = await resolveComponentPayload(
            strapi,
            field.componentUid,
            reconstructed.value,
            {}
          );
        } else {
          payload[attrName] = reconstructed.value;
        }
      }
      continue;
    }

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
        if (hasDotKeys) {
          const { hasEffectiveEdits, patch } = buildLegacyNestedPatchFromDots(
            attrName,
            dotEntries
          );
          if (hasEffectiveEdits) {
            const mergeDeep = (base: any, p: any): any => {
              if (!isPlainObject(base) || !isPlainObject(p)) return p;
              const next = deepCloneValue(base);
              for (const [k, v] of Object.entries(p)) {
                if (isPlainObject(v) && isPlainObject(next[k])) {
                  next[k] = mergeDeep(next[k], v);
                } else {
                  next[k] = deepCloneValue(v);
                }
              }
              return next;
            };
            payload[attrName] = isPlainObject(existingDoc?.[attrName])
              ? mergeDeep(existingDoc[attrName], patch)
              : patch;
            break;
          }
        }

        if (hasDirectKey) {
          const trimmed = typeof rawVal === 'string' ? rawVal.trim() : '';
          if (rawVal === undefined || rawVal === null || rawVal === '') {
            if (!isPartialUpdate) {
              payload[attrName] = null;
            }
          } else if (EXPLICIT_CLEAR_TOKENS.has(trimmed) || trimmed === 'null') {
            payload[attrName] = null;
          } else if (typeof rawVal === 'string') {
            try {
              payload[attrName] = JSON.parse(rawVal);
            } catch {
              payload[attrName] = rawVal;
            }
          } else {
            payload[attrName] = rawVal;
          }
        }
        break;
      }

      case 'component_single': {
        if (field.componentUid) {
          const directTrimmed = typeof rawVal === 'string' ? rawVal.trim() : '';
          if (hasDotKeys) {
            const { hasEffectiveEdits, patch } = buildLegacyNestedPatchFromDots(
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

  const schemaCheck = validateRecordSchemaConstraints(
    strapi,
    uid,
    existingDoc,
    payload,
    unescapedRow,
    {
      isCreate,
      detectedMode,
      targetObjectField: targetAttr,
      rowMeta: rowInfo,
    }
  );
  errors.push(...schemaCheck.errors);
  warnings.push(...schemaCheck.warnings);

  return {
    payload,
    errors,
    warnings,
    detectedMode,
    targetObjectField: targetAttr,
    rowMeta: rowInfo,
  };
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
  const plan = await prepareCsvRowMutation(strapi, uid, existingDoc, rawRow, options);
  return plan.payload;
}
