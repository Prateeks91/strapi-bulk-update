import type { Core } from '@strapi/strapi';
import {
  DiscoveredField,
  DiscoveredSchema,
  discoverSchema,
  SYSTEM_ATTRIBUTES,
} from './schema-discovery';

export const EXPLICIT_CLEAR_TOKENS = new Set(['__CLEAR__', '__NULL__']);
export const EXPLICIT_EMPTY_STRING_TOKEN = '__EMPTY__';
export const EXPLICIT_DELETE_KEY_TOKEN = '__DELETE__';
export const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type CsvExportMode = 'all' | 'metafields' | 'topbarconfig';
export type DetectedCsvExportMode = CsvExportMode | 'legacy';
export type TargetObjectState = 'present' | 'empty_object' | 'null' | 'absent';
export type FlattenedLeafType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface FlattenedRowMeta {
  exportMode?: CsvExportMode;
  targetObjectField?: string;
  targetObjectState?: TargetObjectState;
  applicableFields?: string[];
  flatTypes?: Record<string, FlattenedLeafType>;
}

export type ExportColumnKind =
  | 'system'
  | 'field'
  | 'flattened_first_level';

export interface ExportColumnDescriptor {
  header: string;
  kind: ExportColumnKind;
  rootKey: string;
  propKey?: string;
  field?: DiscoveredField;
  componentSubDef?: Record<string, any>;
}

export interface ExportColumnPlan {
  exportMode: CsvExportMode;
  targetObjectField?: string;
  columns: ExportColumnDescriptor[];
  headers: string[];
}

export function normalizeExportMode(raw: any): CsvExportMode {
  const val = String(raw || '').trim().toLowerCase();
  if (val === 'metafields') return 'metafields';
  if (val === 'topbarconfig') return 'topbarconfig';
  return 'all';
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

export function deepEqualValues(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualValues(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).filter((k) => !FORBIDDEN_OBJECT_KEYS.has(k));
    const keysB = Object.keys(b).filter((k) => !FORBIDDEN_OBJECT_KEYS.has(k));
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqualValues(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function isSafePropKey(segment: string): boolean {
  return Boolean(segment) && !FORBIDDEN_OBJECT_KEYS.has(segment) && !segment.includes('.');
}

/**
 * Resolves the exact schema attribute name matching the targeted export mode ('metafields' or 'topbarconfig').
 */
export function resolveTargetObjectField(
  schema: DiscoveredSchema,
  exportMode: CsvExportMode
): string | undefined {
  if (exportMode === 'all') return undefined;

  const keys = Object.keys(schema.fields || {});
  const exactMatch = keys.find((k) => k === exportMode);
  if (exactMatch) return exactMatch;

  const normalizedTarget = exportMode.toLowerCase().replace(/[_-]/g, '');
  return keys.find((k) => k.toLowerCase().replace(/[_-]/g, '') === normalizedTarget);
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
 * Discovers ONLY the direct first-level property keys across the dataset for a targeted object field.
 * Nested plain objects and arrays remain single JSON values and are NEVER flattened deeper.
 */
function collectFirstLevelObjectColumns(
  strapi: Core.Strapi,
  rootKey: string,
  field: DiscoveredField,
  documents: any[],
  blockedNames: Set<string>
): ExportColumnDescriptor[] {
  const result: ExportColumnDescriptor[] = [];
  const seenProps = new Set<string>();

  // 1. If the targeted field is a single component, seed direct schema attributes first
  if (field.category === 'component_single' && field.componentUid) {
    const comp = strapi.components?.[field.componentUid];
    if (comp?.attributes) {
      for (const [subKey, subDef] of Object.entries(comp.attributes) as [string, any][]) {
        if (!isSafePropKey(subKey)) continue;
        const norm = subKey.toLowerCase().replace(/[\s_-]/g, '');
        if (SYSTEM_ATTRIBUTES.has(norm) || subKey === 'id' || subKey === '__component') continue;
        const header = `${rootKey}.${subKey}`;
        if (blockedNames.has(header) || seenProps.has(subKey)) continue;
        seenProps.add(subKey);
        result.push({
          header,
          kind: 'flattened_first_level',
          rootKey,
          propKey: subKey,
          field,
          componentSubDef: subDef,
        });
      }
    }
  }

  // 2. Discover first-level own keys present in actual exported documents (for json or dynamic keys)
  for (const doc of documents) {
    const obj = doc?.[rootKey];
    if (obj === null || obj === undefined) continue;
    if (!isPlainObject(obj)) {
      // Heterogeneous non-object root (e.g. array/primitive at root): keep single column for safety
      if (field.category === 'json') {
        return [];
      }
      continue;
    }

    for (const propKey of Object.keys(obj)) {
      if (!isSafePropKey(propKey)) continue;
      const header = `${rootKey}.${propKey}`;
      if (blockedNames.has(header) || seenProps.has(propKey)) continue;
      seenProps.add(propKey);
      result.push({
        header,
        kind: 'flattened_first_level',
        rootKey,
        propKey,
        field,
      });
    }
  }

  return result;
}

/**
 * Builds the deterministic CSV column plan according to exportMode:
 * - 'all': preserves the full native export layout with zero object splitting
 * - 'metafields' / 'topbarconfig': splits ONLY that selected object at strictly one level
 */
export function buildExportColumnPlan(
  strapi: Core.Strapi,
  uid: string,
  documents: any[],
  options: { schema?: DiscoveredSchema; exportMode?: CsvExportMode } = {}
): ExportColumnPlan {
  const schema = options.schema || discoverSchema(strapi, uid);
  const exportMode: CsvExportMode = normalizeExportMode(options.exportMode);
  const targetObjectField = resolveTargetObjectField(schema, exportMode);
  const topLevelNames = new Set(schema.allExportKeys);
  const columns: ExportColumnDescriptor[] = [];

  for (const key of schema.allExportKeys) {
    if (key === 'documentId' || key === 'locale') {
      columns.push({
        header: key,
        kind: 'system',
        rootKey: key,
      });
      continue;
    }

    const field = schema.fields[key];
    if (!field) {
      columns.push({
        header: key,
        kind: 'field',
        rootKey: key,
      });
      continue;
    }

    // In 'all' mode, NEVER flatten any object or component — preserve exact migration layout
    if (exportMode !== 'all' && targetObjectField && key === targetObjectField) {
      if (field.category === 'json' || field.category === 'component_single') {
        const firstLevelCols = collectFirstLevelObjectColumns(
          strapi,
          key,
          field,
          documents,
          topLevelNames
        );
        if (firstLevelCols.length > 0) {
          columns.push(...firstLevelCols);
          continue;
        }
      }
    }

    columns.push({
      header: key,
      kind: 'field',
      rootKey: key,
      field,
    });
  }

  return {
    exportMode,
    targetObjectField,
    columns,
    headers: columns.map((c) => c.header),
  };
}

/**
 * Extracts per-row export mode, object presence/applicability state, and leaf type hints for CSV metadata.
 */
export function extractRowFlattenedMetadata(
  plan: ExportColumnPlan,
  doc: any
): FlattenedRowMeta {
  const out: FlattenedRowMeta = {
    exportMode: plan.exportMode,
  };

  if (plan.exportMode === 'all' || !plan.targetObjectField) {
    return out;
  }

  const rootKey = plan.targetObjectField;
  out.targetObjectField = rootKey;

  const hasOwn = doc && typeof doc === 'object' && Object.prototype.hasOwnProperty.call(doc, rootKey);
  const rawVal = hasOwn ? doc[rootKey] : undefined;

  if (!hasOwn || rawVal === undefined) {
    out.targetObjectState = 'absent';
    out.applicableFields = [];
    return out;
  }

  if (rawVal === null) {
    out.targetObjectState = 'null';
    out.applicableFields = [];
    return out;
  }

  if (isPlainObject(rawVal)) {
    const keys = Object.keys(rawVal);
    out.targetObjectState = keys.length === 0 ? 'empty_object' : 'present';
    out.applicableFields = [rootKey];

    const flatTypes: Record<string, FlattenedLeafType> = {};
    for (const col of plan.columns) {
      if (col.kind !== 'flattened_first_level' || !col.propKey) continue;
      if (!Object.prototype.hasOwnProperty.call(rawVal, col.propKey)) continue;
      const leafVal = rawVal[col.propKey];
      if (leafVal !== undefined && needsTypeAnnotation(leafVal)) {
        flatTypes[col.header] = classifyLeafType(leafVal);
      }
    }
    if (Object.keys(flatTypes).length > 0) {
      out.flatTypes = flatTypes;
    }
    return out;
  }

  out.targetObjectState = 'present';
  out.applicableFields = [rootKey];
  return out;
}

/**
 * Serializes a single planned CSV column value for a document.
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

  if (col.kind === 'flattened_first_level' && col.propKey) {
    const rootObj = doc?.[col.rootKey];
    if (!isPlainObject(rootObj) || !Object.prototype.hasOwnProperty.call(rootObj, col.propKey)) {
      return '';
    }
    const val = rootObj[col.propKey];
    if (val === undefined || val === null) return '';

    const subDef = col.componentSubDef || {};
    const subType = String(subDef.type || '').toLowerCase();

    if (subType === 'media') {
      return serializeFieldFallback(val, {
        key: col.header,
        label: col.header,
        category: subDef.multiple ? 'media_to_many' : 'media_single',
        rawType: 'media',
        multiple: Boolean(subDef.multiple),
      });
    }
    if (subType === 'relation') {
      const isToMany = String(subDef.relation || '').toLowerCase().endsWith('many');
      return serializeFieldFallback(val, {
        key: col.header,
        label: col.header,
        category: isToMany ? 'relation_to_many' : 'relation_to_one',
        rawType: 'relation',
        relationType: subDef.relation,
      });
    }

    if (val instanceof Date) return val.toISOString();
    if (Array.isArray(val) || isPlainObject(val)) {
      return JSON.stringify(val);
    }
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'number') return Number.isFinite(val) ? String(val) : '';
    return String(val);
  }

  const rawValue = doc?.[col.rootKey];
  if (col.field) {
    return serializeFieldFallback(rawValue, col.field);
  }
  return rawValue;
}

/**
 * Safely identifies and validates the CSV export mode solely from the internal metadata column.
 */
export function inspectRowMetadataMode(
  rawRow: Record<string, any>
): {
  mode: DetectedCsvExportMode;
  targetObjectField?: string;
  targetObjectState?: TargetObjectState;
  flatTypes?: Record<string, FlattenedLeafType>;
  applicableFields?: string[];
  error?: string;
} {
  if (!rawRow || typeof rawRow !== 'object') {
    return { mode: 'legacy' };
  }

  const rawMetaCell =
    rawRow['__bulk_updater_metadata'] !== undefined
      ? rawRow['__bulk_updater_metadata']
      : rawRow['_bulk_updater_metadata'];

  if (rawMetaCell === undefined || rawMetaCell === null || String(rawMetaCell).trim() === '') {
    return { mode: 'legacy' };
  }

  let parsed: any = rawMetaCell;
  if (typeof rawMetaCell === 'string') {
    try {
      parsed = JSON.parse(rawMetaCell);
    } catch {
      return {
        mode: 'legacy',
        error: 'Corrupted __bulk_updater_metadata cell: invalid JSON.',
      };
    }
  }

  if (!isPlainObject(parsed)) {
    return {
      mode: 'legacy',
      error: 'Corrupted __bulk_updater_metadata cell: expected JSON object.',
    };
  }

  if (parsed.exportMode === undefined) {
    return {
      mode: 'legacy',
      applicableFields: Array.isArray(parsed.applicableFields) ? parsed.applicableFields : undefined,
      flatTypes: isPlainObject(parsed.flatTypes) ? parsed.flatTypes : undefined,
    };
  }

  const rawMode = String(parsed.exportMode).trim().toLowerCase();
  if (rawMode !== 'all' && rawMode !== 'metafields' && rawMode !== 'topbarconfig') {
    return {
      mode: 'legacy',
      error: `Unsupported CSV exportMode "${parsed.exportMode}" in metadata.`,
    };
  }

  return {
    mode: rawMode as CsvExportMode,
    targetObjectField:
      typeof parsed.targetObjectField === 'string' && parsed.targetObjectField.trim()
        ? parsed.targetObjectField.trim()
        : undefined,
    targetObjectState: parsed.targetObjectState,
    applicableFields: Array.isArray(parsed.applicableFields) ? parsed.applicableFields : undefined,
    flatTypes: isPlainObject(parsed.flatTypes) ? parsed.flatTypes : undefined,
  };
}

/**
 * Verifies batch-level CSV mode consistency across uploaded rows without guessing on conflicting rows.
 */
export function detectCsvBatchExportMode(
  rows: Array<Record<string, any>>
): { mode: DetectedCsvExportMode; error?: string } {
  const seenModes = new Set<DetectedCsvExportMode>();

  for (let i = 0; i < rows.length; i++) {
    const info = inspectRowMetadataMode(rows[i]);
    if (info.error) {
      return { mode: 'legacy', error: `Row ${i + 2}: ${info.error}` };
    }
    seenModes.add(info.mode);
  }

  if (seenModes.size > 1) {
    return {
      mode: 'legacy',
      error: `Inconsistent CSV export modes detected across rows (${Array.from(seenModes).join(', ')}). Re-export the file cleanly before importing.`,
    };
  }

  const first = Array.from(seenModes)[0];
  return { mode: first || 'legacy' };
}

/**
 * Parses a first-level leaf cell into an accurately typed JSON value using metadata,
 * existing property types, or strict JSON parsing for nested objects & arrays.
 */
export function parseFirstLevelCellValue(
  rawCell: any,
  annotatedType?: FlattenedLeafType,
  existingPropValue?: any
): { value: any; error?: string } {
  if (rawCell === null || rawCell === undefined) return { value: null };
  if (typeof rawCell !== 'string') return { value: rawCell };

  const trimmed = rawCell.trim();
  if (EXPLICIT_CLEAR_TOKENS.has(trimmed)) {
    return { value: null };
  }
  if (trimmed === EXPLICIT_EMPTY_STRING_TOKEN) {
    return { value: '' };
  }

  if (annotatedType === 'string') {
    return { value: rawCell };
  }

  if (annotatedType === 'object' || isPlainObject(existingPropValue)) {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return { value: JSON.parse(trimmed) };
      } catch {
        return {
          value: rawCell,
          error: `Invalid JSON object value: "${rawCell}"`,
        };
      }
    }
  }

  if (annotatedType === 'array' || Array.isArray(existingPropValue)) {
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return { value: parsed };
      } catch {
        return {
          value: rawCell,
          error: `Invalid JSON array value: "${rawCell}"`,
        };
      }
    }
  }

  if (annotatedType === 'number' || typeof existingPropValue === 'number') {
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num)) return { value: num };
    }
  }

  if (annotatedType === 'boolean' || typeof existingPropValue === 'boolean') {
    const low = trimmed.toLowerCase();
    if (low === 'true') return { value: true };
    if (low === 'false') return { value: false };
  }

  if (typeof existingPropValue === 'string') {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return { value: JSON.parse(trimmed) };
      } catch {}
    }
    return { value: rawCell };
  }

  if (trimmed === 'null') return { value: null };
  if (trimmed === 'true') return { value: true };
  if (trimmed === 'false') return { value: false };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return { value: num };
  }
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return { value: JSON.parse(trimmed) };
    } catch {}
  }

  return { value: rawCell };
}

/**
 * Reconstructs ONLY the selected target object at strictly one level (merging changes safely
 * while preserving unrelated properties and respecting record-specific applicability).
 */
export function reconstructTargetedFirstLevelObject(params: {
  targetAttr: string;
  exportMode: 'metafields' | 'topbarconfig';
  existingDoc: any;
  docIdForError?: string;
  rawRow: Record<string, string>;
  rowMeta: ReturnType<typeof inspectRowMetadataMode>;
  isAttrRequired?: boolean;
}): {
  shouldSet: boolean;
  value: any;
  errors: string[];
} {
  const {
    targetAttr,
    exportMode,
    existingDoc,
    docIdForError,
    rawRow,
    rowMeta,
    isAttrRequired = false,
  } = params;

  const prefix = `${targetAttr}.`;
  const firstLevelEntries: Array<[string, string, string]> = [];
  const invalidNestedColumns: string[] = [];

  for (const [colKey, val] of Object.entries(rawRow)) {
    if (!colKey.startsWith(prefix)) continue;
    const propKey = colKey.slice(prefix.length);
    if (!propKey) continue;
    if (propKey.includes('.')) {
      if (val !== undefined && val !== null && String(val) !== '') {
        invalidNestedColumns.push(colKey);
      }
      continue;
    }
    if (!isSafePropKey(propKey)) continue;
    firstLevelEntries.push([colKey, propKey, val]);
  }

  if (invalidNestedColumns.length > 0) {
    return {
      shouldSet: false,
      value: undefined,
      errors: [
        `Deeply nested column(s) [${invalidNestedColumns.join(', ')}] are not valid in "${exportMode}" one-level targeted mode.`,
      ],
    };
  }

  const directRawVal = targetAttr in rawRow ? rawRow[targetAttr] : undefined;
  const directTrimmed = typeof directRawVal === 'string' ? directRawVal.trim() : '';

  const hasNonEmptyFirstLevelEdit = firstLevelEntries.some(
    ([, , val]) => val !== undefined && val !== null && String(val) !== ''
  );

  // Determine record-specific applicability on existing DB documents
  if (existingDoc) {
    const existingObj = existingDoc[targetAttr];
    const hasObjectOnRecord = isPlainObject(existingObj);

    if (!hasObjectOnRecord) {
      // Check if an explicit non-empty modification was attempted on a record that does not own this object
      const attemptedDirectEdit =
        directRawVal !== undefined &&
        directRawVal !== null &&
        directTrimmed !== '';

      if (!hasNonEmptyFirstLevelEdit && !attemptedDirectEdit) {
        // Object is absent/null/inapplicable and CSV leaves it blank -> omit completely without error
        return { shouldSet: false, value: undefined, errors: [] };
      }

      if (!isAttrRequired) {
        const recordRef = docIdForError || existingDoc.documentId || existingDoc.id || 'record';
        return {
          shouldSet: false,
          value: undefined,
          errors: [
            `Field "${targetAttr}" is not applicable or absent on document "${recordRef}". Targeted "${exportMode}" import will not create a new "${targetAttr}" object automatically.`,
          ],
        };
      }
    }
  } else {
    // New record creation: if no values provided at all for target object, omit cleanly
    if (!hasNonEmptyFirstLevelEdit && (!directTrimmed || directTrimmed === '')) {
      return { shouldSet: false, value: undefined, errors: [] };
    }
  }

  const base: Record<string, any> = isPlainObject(existingDoc?.[targetAttr])
    ? deepCloneValue(existingDoc[targetAttr])
    : {};
  const errors: string[] = [];
  let appliedAnyModification = false;

  // Support fallback direct column only if non-empty and no dotted columns exist
  if (
    firstLevelEntries.length === 0 &&
    directRawVal !== undefined &&
    directRawVal !== null &&
    directTrimmed !== ''
  ) {
    if (EXPLICIT_CLEAR_TOKENS.has(directTrimmed) || directTrimmed === 'null') {
      return { shouldSet: true, value: null, errors: [] };
    }
    try {
      const parsedDirect = typeof directRawVal === 'string' ? JSON.parse(directRawVal) : directRawVal;
      if (isPlainObject(parsedDirect)) {
        return {
          shouldSet: true,
          value: { ...base, ...deepCloneValue(parsedDirect) },
          errors: [],
        };
      }
      return { shouldSet: true, value: parsedDirect, errors: [] };
    } catch {
      return {
        shouldSet: false,
        value: undefined,
        errors: [`Column "${targetAttr}" contains invalid JSON: "${directRawVal}"`],
      };
    }
  }

  for (const [colKey, propKey, rawCell] of firstLevelEntries) {
    if (rawCell === undefined || rawCell === null) continue;
    const strCell = String(rawCell);
    const trimmed = strCell.trim();

    if (trimmed === EXPLICIT_DELETE_KEY_TOKEN) {
      if (Object.prototype.hasOwnProperty.call(base, propKey)) {
        delete base[propKey];
        appliedAnyModification = true;
      }
      continue;
    }

    if (EXPLICIT_CLEAR_TOKENS.has(trimmed)) {
      base[propKey] = null;
      appliedAnyModification = true;
      continue;
    }

    if (strCell === '') {
      // Blank cell NEVER deletes or overwrites an existing property
      continue;
    }

    const annotatedType = rowMeta.flatTypes?.[colKey];
    const existingPropValue = isPlainObject(existingDoc?.[targetAttr])
      ? existingDoc[targetAttr][propKey]
      : undefined;

    const parsed = parseFirstLevelCellValue(strCell, annotatedType, existingPropValue);
    if (parsed.error) {
      errors.push(`Column "${colKey}": ${parsed.error}`);
      continue;
    }

    base[propKey] = parsed.value;
    appliedAnyModification = true;
  }

  if (errors.length > 0) {
    return { shouldSet: false, value: undefined, errors };
  }

  if (!appliedAnyModification) {
    return { shouldSet: false, value: undefined, errors: [] };
  }

  // Round-trip stability: if merged result is identical to existing DB object, avoid redundant mutation
  if (existingDoc && isPlainObject(existingDoc[targetAttr]) && deepEqualValues(base, existingDoc[targetAttr])) {
    return { shouldSet: false, value: undefined, errors: [] };
  }

  return { shouldSet: true, value: base, errors: [] };
}

/**
 * Validates record-level schema types and mandatory fields ONLY for applicable fields on the record.
 */
export function validateRecordSchemaConstraints(
  strapi: Core.Strapi,
  uid: string,
  existingDoc: any,
  payload: Record<string, any>,
  rawRow: Record<string, string>,
  options: {
    isCreate: boolean;
    detectedMode?: DetectedCsvExportMode;
    targetObjectField?: string;
    rowMeta?: ReturnType<typeof inspectRowMetadataMode>;
  }
): { errors: string[]; warnings: string[] } {
  const ct = strapi.contentTypes?.[uid];
  if (!ct) return { errors: [], warnings: [] };

  const attrs = ct.attributes || {};
  const errors: string[] = [];
  const warnings: string[] = [];
  const isTargeted =
    options.detectedMode === 'metafields' || options.detectedMode === 'topbarconfig';

  const isMissingRequiredValue = (val: any): boolean =>
    val === undefined || val === null || (typeof val === 'string' && val.trim() === '');

  // On Create or All/Legacy mode, enforce top-level required attributes
  if (!isTargeted || options.isCreate) {
    for (const [attrName, attrDef] of Object.entries(attrs) as [string, any][]) {
      if (!attrDef?.required) continue;
      const norm = attrName.toLowerCase().replace(/[\s_-]/g, '');
      if (SYSTEM_ATTRIBUTES.has(norm)) continue;

      if (options.isCreate) {
        if (isMissingRequiredValue(payload[attrName])) {
          errors.push(`Missing mandatory field "${attrName}".`);
        }
      } else if (attrName in payload && isMissingRequiredValue(payload[attrName])) {
        errors.push(`Mandatory field "${attrName}" cannot be empty or cleared.`);
      }
    }
  } else if (options.targetObjectField) {
    // In targeted update mode, check required constraint on the targeted root field if cleared
    const tDef = attrs[options.targetObjectField];
    if (
      tDef?.required &&
      options.targetObjectField in payload &&
      isMissingRequiredValue(payload[options.targetObjectField])
    ) {
      errors.push(`Mandatory field "${options.targetObjectField}" cannot be empty or cleared.`);
    }
  }

  // Single-component mandatory subfield validation ONLY when that component is present/updated in payload
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
      if (isPlainObject(nextCompVal)) {
        validateComponentRequired(attrDef.component, nextCompVal, attrName);
      }
    }
  }

  // Targeted component property format check when applicable
  if (isTargeted && options.targetObjectField) {
    const tDef = attrs[options.targetObjectField];
    if (tDef?.type === 'component' && !tDef.repeatable && tDef.component && strapi.components?.[tDef.component]) {
      const compAttrs = strapi.components[tDef.component].attributes || {};
      const prefix = `${options.targetObjectField}.`;
      for (const [colKey, rawVal] of Object.entries(rawRow)) {
        if (!colKey.startsWith(prefix)) continue;
        const propKey = colKey.slice(prefix.length);
        const subDef = compAttrs[propKey];
        const trimmed = rawVal === undefined || rawVal === null ? '' : String(rawVal).trim();
        if (!subDef || !trimmed || EXPLICIT_CLEAR_TOKENS.has(trimmed) || trimmed === EXPLICIT_DELETE_KEY_TOKEN || trimmed === EXPLICIT_EMPTY_STRING_TOKEN) {
          continue;
        }
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
            warnings.push(`Column "${colKey}" value "${rawVal}" is not in defined enum options: [${subDef.enum.join(', ')}]`);
          }
        }
      }
    }
  }

  return { errors, warnings };
}
