import type { Core } from '@strapi/strapi';
import {
  DiscoveredField,
  DiscoveredSchema,
  discoverSchema,
  SYSTEM_ATTRIBUTES,
} from './schema-discovery';

export const EXPLICIT_CLEAR_TOKENS = new Set(['__CLEAR__', '__NULL__']);
export const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type FlattenedLeafType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface FlattenedRowMeta {
  applicableFields?: string[];
  flatTypes?: Record<string, FlattenedLeafType>;
}

export type ExportColumnKind =
  | 'system'
  | 'field'
  | 'flattened_json_leaf'
  | 'flattened_component_leaf';

export interface ExportColumnDescriptor {
  header: string;
  kind: ExportColumnKind;
  rootKey: string;
  pathSegments: string[];
  field?: DiscoveredField;
  componentSubDef?: Record<string, any>;
}

export interface ExportColumnPlan {
  columns: ExportColumnDescriptor[];
  headers: string[];
  flattenedJsonRoots: Set<string>;
  flattenedComponentRoots: Set<string>;
}

export function isPlainObject(val: any): val is Record<string, any> {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return false;
  if (val instanceof Date || val instanceof RegExp) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

export function deepCloneValue<T>(val: T): T {
  if (val === null || val === undefined || typeof val !== 'object') {
    return val;
  }
  if (val instanceof Date) {
    return new Date(val.getTime()) as unknown as T;
  }
  if (Array.isArray(val)) {
    return val.map((item) => deepCloneValue(item)) as unknown as T;
  }
  if (isPlainObject(val)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (FORBIDDEN_OBJECT_KEYS.has(k)) continue;
      out[k] = deepCloneValue(v);
    }
    return out as T;
  }
  return val;
}

function isSafePathSegment(segment: string): boolean {
  return Boolean(segment) && !FORBIDDEN_OBJECT_KEYS.has(segment);
}

/**
 * Resolves a nested property along pathSegments while reporting whether the key actually exists on the object.
 */
export function getValueAtPath(
  rootObj: any,
  pathSegments: string[]
): { exists: boolean; value: any } {
  let cursor = rootObj;
  for (let i = 0; i < pathSegments.length; i++) {
    const seg = pathSegments[i];
    if (!isSafePathSegment(seg) || cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return { exists: false, value: undefined };
    }
    if (Array.isArray(cursor) || !Object.prototype.hasOwnProperty.call(cursor, seg)) {
      return { exists: false, value: undefined };
    }
    cursor = cursor[seg];
  }
  return { exists: true, value: cursor };
}

/**
 * Sets a nested property safely into a cloned/mutable plain object target without mutating sibling keys.
 */
export function setValueAtPath(
  target: Record<string, any>,
  pathSegments: string[],
  value: any
): void {
  if (pathSegments.length === 0) return;
  let cursor: Record<string, any> = target;

  for (let i = 0; i < pathSegments.length - 1; i++) {
    const seg = pathSegments[i];
    if (!isSafePathSegment(seg)) return;
    if (!isPlainObject(cursor[seg])) {
      cursor[seg] = {};
    }
    cursor = cursor[seg];
  }

  const leafKey = pathSegments[pathSegments.length - 1];
  if (!isSafePathSegment(leafKey)) return;
  cursor[leafKey] = value;
}

function classifyLeafType(val: any): FlattenedLeafType {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  if (isPlainObject(val)) return 'object';
  if (typeof val === 'number') return 'number';
  if (typeof val === 'boolean') return 'boolean';
  return 'string';
}

function needsTypeAnnotation(val: any): boolean {
  if (val === null) return true;
  if (Array.isArray(val) || isPlainObject(val)) return true;
  if (typeof val === 'number' || typeof val === 'boolean') return true;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (
      val === '' ||
      trimmed === 'null' ||
      trimmed === 'true' ||
      trimmed === 'false' ||
      trimmed.startsWith('[') ||
      trimmed.startsWith('{') ||
      /^-?\d+(?:\.\d+)?$/.test(trimmed)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Collects unique dotted leaf paths for plain objects across a dataset, stopping at arrays, primitives, and empty objects.
 */
function collectDynamicPlainObjectPaths(
  values: any[],
  baseSegments: string[],
  blockedRootNames: Set<string>
): { canFlatten: boolean; paths: string[][] } {
  const leafPaths: string[][] = [];
  const seenJoined = new Set<string>();
  let hasAnyNonNullValue = false;

  for (const val of values) {
    if (val === null || val === undefined) continue;
    hasAnyNonNullValue = true;
    if (!isPlainObject(val)) {
      return { canFlatten: false, paths: [] };
    }
  }

  if (!hasAnyNonNullValue) {
    return { canFlatten: false, paths: [] };
  }

  const walk = (node: Record<string, any>, relSegments: string[], seenObjects: WeakSet<object>) => {
    if (relSegments.length > 25 || seenObjects.has(node)) return;
    seenObjects.add(node);

    for (const [key, child] of Object.entries(node)) {
      if (!isSafePathSegment(key) || key.includes('.')) {
        continue;
      }
      const nextRel = [...relSegments, key];
      const fullPath = [...baseSegments, ...nextRel].join('.');
      if (blockedRootNames.has(fullPath)) continue;

      if (isPlainObject(child)) {
        const childKeys = Object.keys(child).filter((ck) => isSafePathSegment(ck) && !ck.includes('.'));
        if (childKeys.length === 0) {
          if (!seenJoined.has(fullPath)) {
            seenJoined.add(fullPath);
            leafPaths.push(nextRel);
          }
        } else {
          // If an earlier doc treated this path as an empty object leaf, replace with child leaves cleanly
          if (seenJoined.has(fullPath)) {
            seenJoined.delete(fullPath);
            const idx = leafPaths.findIndex((p) => [...baseSegments, ...p].join('.') === fullPath);
            if (idx >= 0) leafPaths.splice(idx, 1);
          }
          walk(child, nextRel, seenObjects);
        }
      } else {
        if (!seenJoined.has(fullPath)) {
          seenJoined.add(fullPath);
          leafPaths.push(nextRel);
        }
      }
    }

    seenObjects.delete(node);
  };

  for (const val of values) {
    if (isPlainObject(val)) {
      walk(val, [], new WeakSet<object>());
    }
  }

  return { canFlatten: leafPaths.length > 0, paths: leafPaths };
}

function collectComponentExportColumns(
  strapi: Core.Strapi,
  compUid: string,
  baseSegments: string[],
  documents: any[],
  blockedRootNames: Set<string>,
  visitedComps: Set<string>
): ExportColumnDescriptor[] {
  const comp = strapi.components?.[compUid];
  if (!comp?.attributes || visitedComps.has(compUid)) {
    return [];
  }

  const nextVisited = new Set(visitedComps);
  nextVisited.add(compUid);
  const rootKey = baseSegments[0];
  const result: ExportColumnDescriptor[] = [];

  for (const [attrName, attrDef] of Object.entries(comp.attributes) as [string, any][]) {
    if (!isSafePathSegment(attrName)) continue;
    const norm = attrName.toLowerCase().replace(/[\s_-]/g, '');
    if (SYSTEM_ATTRIBUTES.has(norm) || attrName === 'id' || attrName === '__component') continue;

    const attrType = String(attrDef?.type || '').toLowerCase();
    const nextSegments = [...baseSegments, attrName];
    const header = nextSegments.join('.');
    if (blockedRootNames.has(header)) continue;

    if (attrType === 'component' && !attrDef.repeatable && attrDef.component) {
      const nested = collectComponentExportColumns(
        strapi,
        attrDef.component,
        nextSegments,
        documents,
        blockedRootNames,
        nextVisited
      );
      if (nested.length > 0) {
        result.push(...nested);
      } else {
        result.push({
          header,
          kind: 'flattened_component_leaf',
          rootKey,
          pathSegments: nextSegments,
          componentSubDef: attrDef,
        });
      }
    } else if (attrType === 'json') {
      const vals = documents.map((d) => getValueAtPath(d, nextSegments).value);
      const { canFlatten, paths } = collectDynamicPlainObjectPaths(vals, nextSegments, blockedRootNames);
      if (canFlatten) {
        for (const relPath of paths) {
          const fullSegments = [...nextSegments, ...relPath];
          result.push({
            header: fullSegments.join('.'),
            kind: 'flattened_component_leaf',
            rootKey,
            pathSegments: fullSegments,
            componentSubDef: { type: 'json_leaf' },
          });
        }
      } else {
        result.push({
          header,
          kind: 'flattened_component_leaf',
          rootKey,
          pathSegments: nextSegments,
          componentSubDef: attrDef,
        });
      }
    } else {
      result.push({
        header,
        kind: 'flattened_component_leaf',
        rootKey,
        pathSegments: nextSegments,
        componentSubDef: attrDef,
      });
    }
  }

  return result;
}

/**
 * Builds the deterministic CSV column plan for a content type + document batch,
 * splitting plain-object JSON fields and single components into dotted columns.
 */
export function buildExportColumnPlan(
  strapi: Core.Strapi,
  uid: string,
  documents: any[],
  schemaOverride?: DiscoveredSchema
): ExportColumnPlan {
  const schema = schemaOverride || discoverSchema(strapi, uid);
  const topLevelNames = new Set(schema.allExportKeys);
  const columns: ExportColumnDescriptor[] = [];
  const flattenedJsonRoots = new Set<string>();
  const flattenedComponentRoots = new Set<string>();

  for (const key of schema.allExportKeys) {
    if (key === 'documentId' || key === 'locale') {
      columns.push({
        header: key,
        kind: 'system',
        rootKey: key,
        pathSegments: [key],
      });
      continue;
    }

    const field = schema.fields[key];
    if (!field) {
      columns.push({
        header: key,
        kind: 'field',
        rootKey: key,
        pathSegments: [key],
      });
      continue;
    }

    if (field.category === 'json') {
      const values = documents.map((d) => d?.[key]);
      const { canFlatten, paths } = collectDynamicPlainObjectPaths(values, [key], topLevelNames);
      if (canFlatten) {
        flattenedJsonRoots.add(key);
        for (const relPath of paths) {
          const fullSegments = [key, ...relPath];
          columns.push({
            header: fullSegments.join('.'),
            kind: 'flattened_json_leaf',
            rootKey: key,
            pathSegments: fullSegments,
            field,
          });
        }
        continue;
      }
    }

    if (field.category === 'component_single' && field.componentUid) {
      const compColumns = collectComponentExportColumns(
        strapi,
        field.componentUid,
        [key],
        documents,
        topLevelNames,
        new Set<string>()
      );
      if (compColumns.length > 0) {
        flattenedComponentRoots.add(key);
        columns.push(...compColumns);
        continue;
      }
    }

    columns.push({
      header: key,
      kind: 'field',
      rootKey: key,
      pathSegments: [key],
      field,
    });
  }

  return {
    columns,
    headers: columns.map((c) => c.header),
    flattenedJsonRoots,
    flattenedComponentRoots,
  };
}

/**
 * Extracts per-row applicability and lossless leaf type hints for CSV metadata.
 */
export function extractRowFlattenedMetadata(
  plan: ExportColumnPlan,
  doc: any
): FlattenedRowMeta {
  const applicableFields: string[] = [];
  const flatTypes: Record<string, FlattenedLeafType> = {};

  const flattenedRoots = new Set([
    ...plan.flattenedJsonRoots,
    ...plan.flattenedComponentRoots,
  ]);

  for (const rootKey of flattenedRoots) {
    const val = doc?.[rootKey];
    if (val !== null && val !== undefined) {
      applicableFields.push(rootKey);
      if (plan.flattenedJsonRoots.has(rootKey) && isPlainObject(val) && Object.keys(val).length === 0) {
        flatTypes[rootKey] = 'object';
      }
    }
  }

  for (const col of plan.columns) {
    if (col.kind !== 'flattened_json_leaf') continue;
    const { exists, value } = getValueAtPath(doc, col.pathSegments);
    if (!exists || value === undefined) continue;
    if (needsTypeAnnotation(value)) {
      flatTypes[col.header] = classifyLeafType(value);
    }
  }

  const out: FlattenedRowMeta = {};
  if (flattenedRoots.size > 0) {
    out.applicableFields = applicableFields;
  }
  if (Object.keys(flatTypes).length > 0) {
    out.flatTypes = flatTypes;
  }
  return out;
}

/**
 * Serializes a single flattened leaf value safely to its CSV string cell representation.
 */
export function serializeFlattenedLeafValue(val: any): string {
  if (val === undefined || val === null) return '';
  if (val instanceof Date) return val.toISOString();
  if (Array.isArray(val) || isPlainObject(val)) {
    return JSON.stringify(val);
  }
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : '';
  return String(val);
}

/**
 * Serializes a planned CSV column value for a document, delegating complex non-flattened fields.
 */
export function serializePlannedCell(
  col: ExportColumnDescriptor,
  doc: any,
  serializeFieldFallback: (val: any, field: DiscoveredField) => any
): any {
  if (col.kind === 'system') {
    if (col.header === 'documentId') return doc?.documentId || doc?.id || '';
    if (col.header === 'locale') return doc?.locale || '';
    return doc?.[col.header] ?? '';
  }

  if (col.kind === 'flattened_json_leaf') {
    const { exists, value } = getValueAtPath(doc, col.pathSegments);
    if (!exists) return '';
    // Keep empty object distinct via metadata while exporting clean blank cell
    if (isPlainObject(value) && Object.keys(value).length === 0) return '';
    return serializeFlattenedLeafValue(value);
  }

  if (col.kind === 'flattened_component_leaf') {
    const { exists, value } = getValueAtPath(doc, col.pathSegments);
    if (!exists || value === undefined || value === null) return '';

    const subDef = col.componentSubDef || {};
    const subType = String(subDef.type || '').toLowerCase();

    if (subType === 'media') {
      return serializeFieldFallback(value, {
        key: col.header,
        label: col.header,
        category: subDef.multiple ? 'media_to_many' : 'media_single',
        rawType: 'media',
        multiple: Boolean(subDef.multiple),
      });
    }
    if (subType === 'relation') {
      const isToMany = String(subDef.relation || '').toLowerCase().endsWith('many');
      return serializeFieldFallback(value, {
        key: col.header,
        label: col.header,
        category: isToMany ? 'relation_to_many' : 'relation_to_one',
        rawType: 'relation',
        relationType: subDef.relation,
      });
    }
    if (subType === 'component' && subDef.repeatable) {
      return Array.isArray(value) ? JSON.stringify(value) : '';
    }
    if (subType === 'blocks' || subType === 'json') {
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return serializeFlattenedLeafValue(value);
  }

  const rawValue = doc?.[col.rootKey];
  if (col.field) {
    return serializeFieldFallback(rawValue, col.field);
  }
  return rawValue;
}

/**
 * Parses a flattened leaf string into an accurately typed JSON value using metadata,
 * existing document type hints, or strict lossless heuristics.
 */
export function parseFlattenedLeafValue(
  rawCell: any,
  annotatedType?: FlattenedLeafType,
  existingLeafValue?: any
): any {
  if (rawCell === null || rawCell === undefined) return null;
  if (typeof rawCell !== 'string') return rawCell;

  const trimmed = rawCell.trim();
  if (EXPLICIT_CLEAR_TOKENS.has(trimmed)) {
    return null;
  }

  if (annotatedType === 'string') {
    return rawCell;
  }

  if (annotatedType === 'number' || typeof existingLeafValue === 'number') {
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num)) return num;
    }
  }

  if (annotatedType === 'boolean' || typeof existingLeafValue === 'boolean') {
    const low = trimmed.toLowerCase();
    if (low === 'true') return true;
    if (low === 'false') return false;
  }

  if (annotatedType === 'array' || Array.isArray(existingLeafValue)) {
    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {}
    }
  }

  if (annotatedType === 'object' || isPlainObject(existingLeafValue)) {
    if (trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed);
      } catch {}
    }
  }

  // Fallback inference when no existing value or metadata exists
  if (typeof existingLeafValue === 'string') {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {}
    }
    return rawCell;
  }

  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }

  return rawCell;
}

/**
 * Reconstructs a `json` attribute from direct CSV value + dotted flattened columns
 * via lossless deep merge, avoiding phantom empty objects on inapplicable rows.
 */
export function reconstructFlattenedJsonAttribute(params: {
  attrName: string;
  existingVal: any;
  hasDirectKey: boolean;
  directRawVal: any;
  dotEntries: Array<[string, any]>;
  rowMeta: FlattenedRowMeta | null;
  isPartialUpdate: boolean;
}): { shouldSet: boolean; value: any } {
  const {
    attrName,
    existingVal,
    hasDirectKey,
    directRawVal,
    dotEntries,
    rowMeta,
    isPartialUpdate,
  } = params;

  const hasExistingPlainObj = isPlainObject(existingVal);
  const directTrimmed = typeof directRawVal === 'string' ? directRawVal.trim() : '';

  if (dotEntries.length === 0) {
    if (!hasDirectKey) return { shouldSet: false, value: undefined };

    if (EXPLICIT_CLEAR_TOKENS.has(directTrimmed) || directTrimmed === 'null') {
      return { shouldSet: true, value: null };
    }

    if (directRawVal === '' || directRawVal === undefined || directRawVal === null) {
      // Do not overwrite existing JSON object/data with null on blank CSV cell
      return { shouldSet: false, value: undefined };
    }

    if (typeof directRawVal === 'string') {
      try {
        return { shouldSet: true, value: JSON.parse(directRawVal) };
      } catch {
        return { shouldSet: true, value: directRawVal };
      }
    }
    return { shouldSet: true, value: directRawVal };
  }

  // Merge base from direct JSON column (if provided non-empty) or cloned existing plain object
  let baseObj: Record<string, any> | null = hasExistingPlainObj ? deepCloneValue(existingVal) : null;
  let hasEffectiveChange = false;

  if (hasDirectKey && directRawVal !== '' && directRawVal !== undefined && directRawVal !== null) {
    if (EXPLICIT_CLEAR_TOKENS.has(directTrimmed) || directTrimmed === 'null') {
      return { shouldSet: true, value: null };
    }
    try {
      const parsedDirect = typeof directRawVal === 'string' ? JSON.parse(directRawVal) : directRawVal;
      if (isPlainObject(parsedDirect)) {
        baseObj = { ...(baseObj || {}), ...deepCloneValue(parsedDirect) };
        hasEffectiveChange = true;
      } else {
        return { shouldSet: true, value: parsedDirect };
      }
    } catch {
      return { shouldSet: true, value: directRawVal };
    }
  }

  for (const [fullKey, rawCell] of dotEntries) {
    const prefix = `${attrName}.`;
    if (!fullKey.startsWith(prefix)) continue;
    const relPathStr = fullKey.slice(prefix.length);
    const relSegments = relPathStr.split('.').filter(Boolean);
    if (relSegments.length === 0 || relSegments.some((s) => !isSafePathSegment(s))) {
      continue;
    }

    const strCell = rawCell === null || rawCell === undefined ? '' : String(rawCell);
    const trimmed = strCell.trim();
    const annotatedType = rowMeta?.flatTypes?.[fullKey];

    if (EXPLICIT_CLEAR_TOKENS.has(trimmed)) {
      if (!baseObj) baseObj = {};
      setValueAtPath(baseObj, relSegments, null);
      hasEffectiveChange = true;
      continue;
    }

    if (strCell === '') {
      // Check if existing doc already has '', null, or {} explicitly recorded in metadata
      if (
        hasExistingPlainObj &&
        annotatedType &&
        (annotatedType === 'string' || annotatedType === 'null' || annotatedType === 'object')
      ) {
        const existingAtPath = getValueAtPath(existingVal, relSegments);
        if (existingAtPath.exists) {
          if (annotatedType === 'object' && isPlainObject(existingAtPath.value)) {
            if (!isPartialUpdate) hasEffectiveChange = true;
          } else if (annotatedType === 'null' && existingAtPath.value === null) {
            if (!isPartialUpdate) hasEffectiveChange = true;
          } else if (annotatedType === 'string' && existingAtPath.value === '') {
            if (!isPartialUpdate) hasEffectiveChange = true;
          }
        }
      }
      // Ambiguous empty cell NEVER creates keys, NEVER creates {}, NEVER clears non-empty existing properties
      continue;
    }

    const existingLeaf = hasExistingPlainObj
      ? getValueAtPath(existingVal, relSegments).value
      : undefined;
    const parsedVal = parseFlattenedLeafValue(strCell, annotatedType, existingLeaf);
    if (!baseObj) baseObj = {};
    setValueAtPath(baseObj, relSegments, parsedVal);
    hasEffectiveChange = true;
  }

  if (!hasEffectiveChange) {
    // Preserve full object during non-partial round trip when doc actually had an empty object `{}`
    if (
      !isPartialUpdate &&
      hasExistingPlainObj &&
      (rowMeta?.applicableFields?.includes(attrName) || rowMeta?.flatTypes?.[attrName] === 'object')
    ) {
      return { shouldSet: true, value: deepCloneValue(existingVal) };
    }
    return { shouldSet: false, value: undefined };
  }

  return { shouldSet: true, value: baseObj || {} };
}

/**
 * Builds a properly nested component patch object from multi-level dotted columns
 * (e.g. `seo.openGraph.title` -> `{ openGraph: { title } }`), ignoring empty cells
 * so absent/inapplicable components remain untouched.
 */
export function buildNestedComponentPatchFromDots(
  attrName: string,
  dotEntries: Array<[string, any]>
): { hasEffectiveEdits: boolean; patch: Record<string, any> } {
  const patch: Record<string, any> = {};
  let hasEffectiveEdits = false;
  const prefix = `${attrName}.`;

  for (const [fullKey, rawCell] of dotEntries) {
    if (!fullKey.startsWith(prefix)) continue;
    const relPathStr = fullKey.slice(prefix.length);
    const relSegments = relPathStr.split('.').filter(Boolean);
    if (relSegments.length === 0 || relSegments.some((s) => !isSafePathSegment(s))) {
      continue;
    }

    if (rawCell === undefined || rawCell === null || rawCell === '') {
      continue;
    }

    const strCell = String(rawCell);
    const trimmed = strCell.trim();
    if (EXPLICIT_CLEAR_TOKENS.has(trimmed)) {
      setValueAtPath(patch, relSegments, null);
      hasEffectiveEdits = true;
      continue;
    }

    setValueAtPath(patch, relSegments, strCell);
    hasEffectiveEdits = true;
  }

  return { hasEffectiveEdits, patch };
}

function resolveDottedComponentAttrDef(
  strapi: Core.Strapi,
  rootDef: any,
  segments: string[]
): Record<string, any> | null {
  if (!rootDef || segments.length === 0) return null;
  if (segments.length === 1) return rootDef;

  if (rootDef.type === 'component' && !rootDef.repeatable && rootDef.component) {
    const comp = strapi.components?.[rootDef.component];
    if (!comp?.attributes) return null;
    const nextAttr = comp.attributes[segments[1]];
    if (!nextAttr) return null;
    return resolveDottedComponentAttrDef(strapi, nextAttr, segments.slice(1));
  }

  return null;
}

/**
 * Validates record-level schema types and mandatory fields ONLY for attributes/components
 * applicable to the current record (avoiding false errors on page-type-specific fields).
 */
export function validateRecordSchemaConstraints(
  strapi: Core.Strapi,
  uid: string,
  existingDoc: any,
  payload: Record<string, any>,
  rawRow: Record<string, any>,
  options: { isCreate: boolean; rowMeta?: FlattenedRowMeta | null }
): { errors: string[]; warnings: string[] } {
  const ct = strapi.contentTypes?.[uid];
  if (!ct) return { errors: [], warnings: [] };

  const attrs = ct.attributes || {};
  const errors: string[] = [];
  const warnings: string[] = [];
  const applicableList = Array.isArray(options.rowMeta?.applicableFields)
    ? new Set(options.rowMeta!.applicableFields)
    : null;

  const isMissingRequiredValue = (val: any): boolean =>
    val === undefined || val === null || (typeof val === 'string' && val.trim() === '');

  // 1. Validate direct and dotted column scalar/component formats present in the CSV row
  for (const [colKey, rawVal] of Object.entries(rawRow)) {
    if (rawVal === undefined || rawVal === null) continue;
    const strVal = String(rawVal);
    const trimmed = strVal.trim();
    if (!trimmed || EXPLICIT_CLEAR_TOKENS.has(trimmed)) continue;

    if (colKey.includes('.')) {
      const segments = colKey.split('.').filter(Boolean);
      const rootAttr = attrs[segments[0]];
      if (rootAttr?.type === 'component' && !rootAttr.repeatable) {
        const subDef = resolveDottedComponentAttrDef(strapi, rootAttr, segments);
        if (subDef) {
          if (subDef.type === 'integer' || subDef.type === 'biginteger') {
            if (!/^-?\d+$/.test(trimmed)) {
              errors.push(`Column "${colKey}" expects an integer, received: "${rawVal}"`);
            }
          } else if (subDef.type === 'float' || subDef.type === 'decimal') {
            if (isNaN(Number(trimmed))) {
              errors.push(`Column "${colKey}" expects a numeric float/decimal, received: "${rawVal}"`);
            }
          } else if (subDef.type === 'enumeration' && Array.isArray(subDef.enum)) {
            if (!subDef.enum.includes(trimmed)) {
              warnings.push(
                `Column "${colKey}" value "${rawVal}" is not in defined enum options: [${subDef.enum.join(', ')}]`
              );
            }
          }
        }
      }
    }
  }

  // 2. Top-level required validation (only on creation, or if an existing required field is explicitly cleared)
  for (const [attrName, attrDef] of Object.entries(attrs) as [string, any][]) {
    if (!attrDef?.required) continue;
    const norm = attrName.toLowerCase().replace(/[\s_-]/g, '');
    if (SYSTEM_ATTRIBUTES.has(norm)) continue;

    if (options.isCreate) {
      if (applicableList && !applicableList.has(attrName) && payload[attrName] === undefined) {
        continue;
      }
      if (isMissingRequiredValue(payload[attrName])) {
        errors.push(`Missing mandatory field "${attrName}".`);
      }
    } else if (attrName in payload && isMissingRequiredValue(payload[attrName])) {
      errors.push(`Mandatory field "${attrName}" cannot be empty or cleared.`);
    }
  }

  // 3. Single-component mandatory subfield validation ONLY when component is applicable/populated on this record
  const validateComponentRequired = (compUid: string, valueObj: any, pathPrefix: string) => {
    const comp = strapi.components?.[compUid];
    if (!comp?.attributes || !isPlainObject(valueObj)) return;

    for (const [subKey, subDef] of Object.entries(comp.attributes) as [string, any][]) {
      const subPath = `${pathPrefix}.${subKey}`;
      const subVal = valueObj[subKey];

      if (subDef?.required && isMissingRequiredValue(subVal)) {
        errors.push(`Missing mandatory field "${subPath}".`);
      }
      if (subDef?.type === 'component' && !subDef.repeatable && subDef.component && isPlainObject(subVal)) {
        validateComponentRequired(subDef.component, subVal, subPath);
      }
    }
  };

  for (const [attrName, attrDef] of Object.entries(attrs) as [string, any][]) {
    if (attrDef?.type === 'component' && !attrDef.repeatable && attrDef.component) {
      const nextCompVal = payload[attrName];
      // Only validate inner required fields if this component is actively present/updated as a non-null object!
      // When Page Type B leaves all dotted cells blank and has existingDoc[attrName] == null, nextCompVal is undefined -> NO false error.
      if (isPlainObject(nextCompVal)) {
        validateComponentRequired(attrDef.component, nextCompVal, attrName);
      } else if (
        nextCompVal === undefined &&
        isPlainObject(existingDoc?.[attrName]) &&
        (applicableList === null || applicableList.has(attrName))
      ) {
        // Check if existing component already exists cleanly — no update, no error unless modified
      }
    }
  }

  return { errors, warnings };
}
