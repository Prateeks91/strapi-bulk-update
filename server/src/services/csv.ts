import type { Core } from '@strapi/strapi';
import { recordContentHistoryVersion } from './content-history';
import {
  getExecutionWindowConfig,
  checkBusinessHours,
  registerPendingBatch,
  type PendingBatch,
  inspectPreUpdateStatus,
  determineShouldPublish,
  isStageApproved,
  isStageEditingOrPending,
  extractStageName,
} from './bulk-updater';
import { extractHeadingsFromRichText } from './validation-rules';

/**
 * Robust, Excel-Safe CSV string escaping helper (RFC-4180 compliant)
 */
function escapeCsvValue(val: any): string {
  if (val === null || val === undefined) return '';
  let str = '';

  if (val instanceof Date) {
    str = val.toISOString();
  } else if (typeof val === 'object') {
    str = JSON.stringify(val);
  } else {
    str = String(val);
  }

  // Normalize CRLF or lone CR inside cells to standard LF
  str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Excel CSV Formula Injection Mitigation:
  // If first character is =, +, -, or @, prefix with a single quote to prevent execution in Excel
  if (/^[=+@-]$/.test(str.charAt(0))) {
    str = `'${str}`;
  }

  // Quote cell if it contains delimiter, quotes, or newlines
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * RFC-4180 compliant CSV parser that correctly handles:
 * - Multiline strings & HTML content with embedded line breaks (\n, \r\n, \r) inside quotes
 * - Commas embedded inside double-quoted cells without shifting subsequent columns
 * - Escaped double quotes ("" -> ")
 * - Leading/trailing whitespace outside quotes
 * - UTF-8 Byte Order Mark (BOM)
 * - Excel formula injection unescaping ('=, '+, '-, '@)
 */
export function parseCsvRows(csvText: string): string[][] {
  if (!csvText) return [];

  // Strip UTF-8 BOM if present
  let text = csvText;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  let cellIsQuoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote: "" -> "
          currentCell += '"';
          i++; // skip second quote
        } else {
          // Closing quote
          inQuotes = false;
        }
      } else {
        // Any character inside quotes (including \r, \n, commas, HTML tags) is preserved verbatim
        currentCell += char;
      }
    } else {
      if (char === '"' && !cellIsQuoted && currentCell.trim() === '') {
        // Opening quote (discards leading whitespace before opening quote)
        inQuotes = true;
        cellIsQuoted = true;
        currentCell = '';
      } else if (char === ',') {
        currentRow.push(cellIsQuoted ? currentCell : currentCell.trim());
        currentCell = '';
        cellIsQuoted = false;
      } else if (char === '\r') {
        if (nextChar === '\n') {
          i++; // Skip \n in \r\n sequence
        }
        currentRow.push(cellIsQuoted ? currentCell : currentCell.trim());
        if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentCell = '';
        cellIsQuoted = false;
      } else if (char === '\n') {
        currentRow.push(cellIsQuoted ? currentCell : currentCell.trim());
        if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentCell = '';
        cellIsQuoted = false;
      } else {
        // If cell was already quoted and closed, ignore trailing whitespace between closing quote and delimiter
        if (!(cellIsQuoted && !inQuotes && (char === ' ' || char === '\t'))) {
          currentCell += char;
        }
      }
    }
  }

  if (currentCell !== '' || cellIsQuoted || currentRow.length > 0) {
    currentRow.push(cellIsQuoted ? currentCell : currentCell.trim());
    if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

export function parseCsv(csvText: string): Array<Record<string, string>> {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim());
  const records: Array<Record<string, string>> = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      let val = row[idx] !== undefined ? row[idx] : '';
      if (typeof val === 'string' && /^'[=+@-]/.test(val)) {
        val = val.substring(1);
      }
      record[h] = val;
    });
    records.push(record);
  }

  return records;
}

const LIFECYCLE_STATUS_WORDS = new Set([
  'pending review',
  'pending_review',
  'pending approval',
  'pending_approval',
  'approved',
  'rejected',
  'draft',
  'published',
  'modified',
  'supported',
  'ignored',
  'editing',
  'in review',
  'in_review',
  'ready to publish',
  'ready_to_publish',
  'null',
  'undefined',
]);

export function isValidDocId(val: any): boolean {
  if (!val || typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed) return false;
  if (LIFECYCLE_STATUS_WORDS.has(trimmed.toLowerCase())) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

export function extractDocId(row: Record<string, any>): string {
  if (!row || typeof row !== 'object') return '';
  const candidates = [
    row.documentId,
    row.document_id,
    row['Document ID'],
    row['Document Id'],
    row['document_id'],
    row.docId,
    row['docId'],
    row.id,
    row.ID,
    row.Id,
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null) {
      const str = String(c).trim();
      if (isValidDocId(str)) {
        return str;
      }
    }
  }
  return '';
}

export function extractLocale(row: Record<string, any>): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const candidates = [
    row.locale,
    row.Locale,
    row['locale'],
    row['Locale'],
    row.strapi_locale,
    row['strapi_locale'],
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null) {
      const str = String(c).trim();
      if (
        str &&
        str.toLowerCase() !== 'null' &&
        str.toLowerCase() !== 'undefined' &&
        str.toLowerCase() !== '[null]' &&
        str.toLowerCase() !== '""'
      ) {
        return str;
      }
    }
  }
  return undefined;
}

export function getEffectiveLocale(ct: any, rowLocale?: string): string | undefined {
  if (!ct?.pluginOptions?.i18n?.localized) {
    return undefined;
  }
  if (!rowLocale) {
    return undefined;
  }
  const trimmed = rowLocale.trim();
  if (
    !trimmed ||
    trimmed.toLowerCase() === 'null' ||
    trimmed.toLowerCase() === 'undefined' ||
    trimmed.toLowerCase() === '[null]' ||
    trimmed.toLowerCase() === '""'
  ) {
    return undefined;
  }
  return trimmed;
}

export function resolveStageValue(row?: Record<string, any>, existing?: Record<string, any>): any {
  if (row && typeof row === 'object') {
    const stageNameFromRow = extractStageName(row);
    if (stageNameFromRow) return stageNameFromRow;
  }
  if (existing && typeof existing === 'object') {
    if (existing.strapi_stage !== undefined && existing.strapi_stage !== null) {
      return existing.strapi_stage;
    }
    if (existing.stage !== undefined && existing.stage !== null) {
      return existing.stage;
    }
    const stageNameFromExisting = extractStageName(existing);
    if (stageNameFromExisting) return stageNameFromExisting;
  }
  return undefined;
}

export function isRowInEditingStage(row: Record<string, any>, existing?: any): boolean {
  const stage = resolveStageValue(row, existing);
  return isStageEditingOrPending(stage);
}

export function isRowInApprovedStage(row: Record<string, any>, existing?: any): boolean {
  const stage = resolveStageValue(row, existing);
  return isStageApproved(stage);
}

export function extractDetailedErrorMessage(err: any): string {
  if (!err) return 'Error processing row';

  // 1. Check err.details?.errors or err.error?.details?.errors (Strapi / Yup standard format)
  const detailsErrors = err.details?.errors || err.error?.details?.errors;
  if (Array.isArray(detailsErrors) && detailsErrors.length > 0) {
    const messages = detailsErrors
      .map((e: any) => {
        if (!e) return '';
        const path = Array.isArray(e.path) ? e.path.join('.') : e.path;
        const msg = e.message || (typeof e === 'string' ? e : JSON.stringify(e));
        return path ? `${path}: ${msg}` : msg;
      })
      .filter(Boolean);
    if (messages.length > 0) return messages.join('; ');
  }

  // 2. Check err.inner (Yup's nested ValidationError instances)
  if (Array.isArray(err.inner) && err.inner.length > 0) {
    const messages = err.inner
      .map((e: any) => {
        if (!e) return '';
        const path = e.path;
        const msg = e.message || (typeof e === 'string' ? e : JSON.stringify(e));
        return path ? `${path}: ${msg}` : msg;
      })
      .filter(Boolean);
    if (messages.length > 0) return messages.join('; ');
  }

  // 3. Check err.errors (Yup validation error string array)
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.join('; ');
  }

  // 4. Check err.details if it is a string or object with message
  if (typeof err.details === 'string' && err.details.trim()) {
    return err.details;
  }
  if (err.details?.message) {
    return err.details.message;
  }

  // 5. Check err.message if descriptive
  if (err.message && err.message !== '[object Object]') {
    return err.message;
  }

  return 'Error processing row';
}

/**
 * Field definition discovered for export
 */
interface ExportFieldDef {
  key: string;
  label: string;
  type: string;
}

/**
 * Recursively discovers all exportable fields, fully supporting nested components
 */
function discoverExportFields(
  ct: any,
  allComponents: Record<string, any>,
  maxDepth = 4
): ExportFieldDef[] {
  const fields: ExportFieldDef[] = [{ key: 'documentId', label: 'documentId', type: 'string' }];
  const excluded = ['createdBy', 'updatedBy', 'localizations'];

  function walkComponent(compUid: string, pathPrefix: string, labelPrefix: string, depth: number) {
    if (depth >= maxDepth) return;
    const comp = allComponents[compUid];
    if (!comp?.attributes) return;

    for (const [subKey, subDef] of Object.entries(comp.attributes) as any[]) {
      if (excluded.includes(subKey)) continue;
      const keyPath = `${pathPrefix}.${subKey}`;
      const displayLabel = `${labelPrefix} > ${subKey}`;

      if (subDef.type === 'component' && subDef.component) {
        if (!subDef.repeatable) {
          walkComponent(subDef.component, keyPath, displayLabel, depth + 1);
        } else {
          fields.push({ key: keyPath, label: displayLabel, type: 'component' });
        }
      } else {
        fields.push({ key: keyPath, label: displayLabel, type: subDef.type });
      }
    }
  }

  for (const [attrName, attrDef] of Object.entries(ct.attributes || {}) as any[]) {
    if (excluded.includes(attrName)) continue;
    if (attrDef.type === 'component' && attrDef.component) {
      if (!attrDef.repeatable) {
        walkComponent(attrDef.component, attrName, attrName, 0);
      } else {
        fields.push({ key: attrName, label: attrName, type: 'component' });
      }
    } else {
      fields.push({ key: attrName, label: attrName, type: attrDef.type });
    }
  }

  return fields;
}

/**
 * Builds a deep populate object for Strapi 5 Document Service
 */
function buildDeepPopulate(
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
 * Safely resolves deep nested dot-notation paths (e.g. "defaultSeo.metaDescription" or "author.name")
 */
function getNestedExportValue(entry: any, path: string): any {
  if (!entry || !path) return '';
  const parts = path.split('.');
  let current: any = entry;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (current === null || current === undefined) return '';

    if (Array.isArray(current)) {
      // Repeatable component or array: extract remainder for each element
      const subPath = parts.slice(i).join('.');
      return current
        .map((item) => {
          if (!item) return '';
          if (typeof item === 'object') {
            const val = getNestedExportValue(item, subPath);
            return typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
          }
          return String(item);
        })
        .filter(Boolean)
        .join('; ');
    }

    if (current && typeof current === 'object') {
      if (current[part] !== undefined) {
        current = current[part];
      } else {
        const camel = part.replace(/_([a-z0-9])/g, (_, l) => l.toUpperCase());
        const snake = part.replace(/([A-Z])/g, '_$1').toLowerCase();
        if (current[camel] !== undefined) {
          current = current[camel];
        } else if (current[snake] !== undefined) {
          current = current[snake];
        } else {
          current = undefined;
        }
      }
    } else {
      current = undefined;
    }
  }

  if (current === null || current === undefined) return '';

  // If Strapi 5 Blocks rich-text editor data (array of block nodes)
  if (Array.isArray(current) && current.length > 0 && current[0]?.type && Array.isArray(current[0]?.children)) {
    return JSON.stringify(current);
  }

  // If Media object
  if (typeof current === 'object' && current.url) {
    return current.url;
  }

  // If Relation object
  if (typeof current === 'object' && !Array.isArray(current)) {
    if (current.name && (current.locale === null || !current.documentId)) {
      return current.name;
    }
    if (current.documentId || current.id || current.name || current.title) {
      return current.documentId || current.id || current.name || current.title;
    }
  }

  // If array of objects (e.g. relations or components)
  if (Array.isArray(current)) {
    return current
      .map((item) => {
        if (!item) return '';
        if (typeof item === 'object') {
          if (item.url) return item.url;
          return item.documentId || item.id || item.name || item.title || JSON.stringify(item);
        }
        return String(item);
      })
      .filter(Boolean)
      .join('; ');
  }

  return current;
}


export interface ProcessRowsStats {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  newWithoutDocId: number;
  errors: Array<{ row: number; error: string; documentId?: string }>;
  diffs: Array<any>;
}

interface CsvImportSession {
  batchId: string;
  uid: string;
  createdAt: number;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  newWithoutDocId: number;
  errors: Array<{ row: number; error: string; documentId?: string }>;
  diffs: Array<any>;
  publishStrategy?: 'safe' | 'all';
  unreviewedConsent?: boolean;
}

const csvImportSessions = new Map<string, CsvImportSession>();

function cleanupStaleSessions() {
  const oneHourAgo = Date.now() - 3600000;
  for (const [id, session] of csvImportSessions.entries()) {
    if (session.createdAt < oneHourAgo) {
      csvImportSessions.delete(id);
    }
  }
}

const SYSTEM_FIELD_KEYS = new Set([
  'documentid',
  'document_id',
  'docid',
  'id',
  'createdat',
  'updatedat',
  'publishedat',
  'createdby',
  'updatedby',
  'localizations',
  'locale',
  'status',
  'strapistage',
  'strapi_stage',
  'strapiassignee',
  'strapi_assignee',
  'strapistatus',
  'strapi_status',
]);

async function findExistingDocument(
  strapi: Core.Strapi,
  uid: string,
  targetDocId: string,
  docLocale?: string
): Promise<any> {
  if (!targetDocId) return null;
  const ct = strapi.contentTypes[uid];
  const effectiveLocale = getEffectiveLocale(ct, docLocale);

  try {
    const queryArgs: any = { documentId: targetDocId };
    if (effectiveLocale) queryArgs.locale = effectiveLocale;
    queryArgs.populate = ['strapi_stage', 'stage'];
    const found = await (strapi.documents(uid as any) as any).findOne(queryArgs);
    if (found) return found;
  } catch {
    // Strapi 5 throws NotFoundError if documentId does not exist
  }

  if (ct?.pluginOptions?.i18n?.localized && !effectiveLocale) {
    try {
      const list = await (strapi.documents(uid as any) as any).findMany({
        filters: { documentId: targetDocId },
        limit: 1,
      });
      if (list && list.length > 0) return list[0];
    } catch {
      // Ignore
    }
  }

  if (/^\d+$/.test(targetDocId)) {
    try {
      const queryArgs: any = {
        filters: { id: parseInt(targetDocId, 10) },
        limit: 1,
      };
      if (effectiveLocale) queryArgs.locale = effectiveLocale;
      const list = await (strapi.documents(uid as any) as any).findMany(queryArgs);
      if (list && list.length > 0) return list[0];
    } catch {
      // Ignore
    }
  }

  return null;
}

/**
 * Recursively deep merges two component objects while preserving array values and existing properties.
 */
function deepMergeComponent(existingVal: any, newVal: any): any {
  if (!existingVal || typeof existingVal !== 'object' || Array.isArray(existingVal)) {
    return newVal;
  }
  if (!newVal || typeof newVal !== 'object' || Array.isArray(newVal)) {
    return newVal;
  }
  const merged = { ...existingVal };
  for (const k of Object.keys(newVal)) {
    if (newVal[k] && typeof newVal[k] === 'object' && !Array.isArray(newVal[k])) {
      merged[k] = deepMergeComponent(existingVal[k], newVal[k]);
    } else if (newVal[k] !== undefined) {
      merged[k] = newVal[k];
    }
  }
  return merged;
}


export function parseNumberValue(rawVal: string, isInteger: boolean): number | null {
  const cleanStr = String(rawVal).replace(/[$€£,\s]/g, '');
  if (isInteger) {
    const n = parseInt(cleanStr, 10);
    return isNaN(n) ? null : n;
  } else {
    const f = parseFloat(cleanStr);
    return isNaN(f) ? null : f;
  }
}

export function parseBooleanValue(rawVal: string): boolean {
  const s = String(rawVal).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on';
}

export function parseBlocksValue(rawVal: string): any {
  try {
    const parsed = JSON.parse(rawVal);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  const trimmed = String(rawVal).trim();
  if (!trimmed) return [];
  return [{ type: 'paragraph', children: [{ type: 'text', text: trimmed }] }];
}

export function parseEnumValue(rawVal: string, allowedValues?: string[]): string {
  const trimmed = String(rawVal).trim();
  if (Array.isArray(allowedValues) && allowedValues.length > 0) {
    const match = allowedValues.find((v) => v.toLowerCase() === trimmed.toLowerCase());
    if (match) return match;
  }
  return trimmed;
}

export function parseRelationValue(rawVal: any, relationType?: string): any {
  const isToMany = relationType ? relationType.toLowerCase().endsWith('many') : false;
  if (rawVal === null || rawVal === undefined) return isToMany ? [] : null;

  let parsed: any = rawVal;
  if (typeof rawVal === 'string') {
    const trimmed = rawVal.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {}
    }
  }

  // Handle stage object or single relation object: { name: "Editing", locale: null, ... }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    if (parsed.name && (parsed.locale === null || LIFECYCLE_STATUS_WORDS.has(String(parsed.name).trim().toLowerCase()))) {
      return isToMany ? [] : null;
    }
    const docId = parsed.documentId || parsed.id || null;
    if (docId && isValidDocId(String(docId).trim())) {
      const validStr = String(docId).trim();
      return isToMany ? [validStr] : validStr;
    }
    return isToMany ? [] : null;
  }

  if (Array.isArray(parsed)) {
    const ids = parsed
      .map((item: any) => {
        if (typeof item === 'object' && item !== null) {
          if (item.name && (item.locale === null || LIFECYCLE_STATUS_WORDS.has(String(item.name).trim().toLowerCase()))) {
            return null;
          }
          const id = item.documentId || item.id;
          return id && isValidDocId(String(id).trim()) ? String(id).trim() : null;
        }
        return isValidDocId(String(item).trim()) ? String(item).trim() : null;
      })
      .filter(Boolean);
    return isToMany ? ids : (ids[0] || null);
  }

  if (typeof rawVal === 'string') {
    if (rawVal.includes(';') || rawVal.includes(',')) {
      const parts = rawVal
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter((p) => isValidDocId(p));
      return isToMany ? parts : (parts[0] || null);
    }

    const trimmed = rawVal.trim();
    if (isValidDocId(trimmed)) {
      return isToMany ? [trimmed] : trimmed;
    }
  }

  return isToMany ? [] : null;
}

export function parseMediaValue(rawVal: string, isMultiple = false): any {
  const trimmed = String(rawVal).trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const ids = parsed
          .map((item: any) => (typeof item === 'object' && item !== null ? item.id || item.documentId : item))
          .filter(Boolean);
        return isMultiple ? ids : (ids[0] || null);
      }
      if (typeof parsed === 'number') {
        return isMultiple ? [parsed] : parsed;
      }
      if (typeof parsed === 'object' && parsed !== null) {
        const id = parsed.id || parsed.documentId || parsed;
        return isMultiple ? [id] : id;
      }
    } catch {}
  }

  if (rawVal.includes(';') || rawVal.includes(',')) {
    const parts = rawVal
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/^\d+$/.test(s) ? parseInt(s, 10) : s));
    return isMultiple ? parts : (parts[0] || null);
  }

  if (/^\d+$/.test(trimmed)) {
    const numId = parseInt(trimmed, 10);
    return isMultiple ? [numId] : numId;
  }

  if (isValidDocId(trimmed)) {
    return isMultiple ? [trimmed] : trimmed;
  }

  return isMultiple ? [] : null;
}

/**
 * Transforms and casts row CSV columns into Strapi schema field types,
 * supporting nested components (dot-notation), relations, dynamic zones, and primitive types.
 */
export function parseRowToPayload(
  strapi: Core.Strapi,
  attrs: any,
  row: Record<string, string>
): Record<string, any> {
  const payload: Record<string, any> = {};

  for (const [key, rawVal] of Object.entries(row)) {
    const normalizedKey = key.toLowerCase().replace(/[\s_-]/g, '');
    if (SYSTEM_FIELD_KEYS.has(normalizedKey)) continue;

    if (key.includes('.')) {
      const topPart = key.split('.')[0].toLowerCase().replace(/[\s_-]/g, '');
      if (SYSTEM_FIELD_KEYS.has(topPart)) continue;
      const parts = key.split('.');
      let currentAttrs = attrs;
      let currentTarget = payload;
      let validPath = true;

      for (let pIdx = 0; pIdx < parts.length; pIdx++) {
        const part = parts[pIdx];
        const isLeaf = pIdx === parts.length - 1;

        if (isLeaf) {
          let leafDef = currentAttrs[part];
          if (!leafDef) {
            const match = Object.keys(currentAttrs).find(
              (k) => k.toLowerCase() === part.toLowerCase() || k.toLowerCase() === part.toLowerCase().replace(/\s+/g, '')
            );
            if (match) leafDef = currentAttrs[match];
          }
          if (!leafDef) {
            validPath = false;
            break;
          }

          // Cast and assign leaf value
          if (rawVal === '' || rawVal === null || rawVal === undefined) {
            if (
              leafDef.type !== 'dynamiczone' &&
              !(leafDef.type === 'component' && leafDef.repeatable) &&
              leafDef.type !== 'relation' &&
              leafDef.type !== 'password'
            ) {
              currentTarget[part] = null;
            }
          } else if (leafDef.type === 'integer' || leafDef.type === 'biginteger') {
            currentTarget[part] = parseNumberValue(rawVal, true);
          } else if (leafDef.type === 'float' || leafDef.type === 'decimal') {
            currentTarget[part] = parseNumberValue(rawVal, false);
          } else if (leafDef.type === 'boolean') {
            currentTarget[part] = parseBooleanValue(rawVal);
          } else if (leafDef.type === 'blocks') {
            currentTarget[part] = parseBlocksValue(rawVal);
          } else if (leafDef.type === 'enumeration') {
            currentTarget[part] = parseEnumValue(rawVal, leafDef.enum);
          } else if (leafDef.type === 'relation') {
            currentTarget[part] = parseRelationValue(rawVal, leafDef.relation);
          } else if (leafDef.type === 'media') {
            currentTarget[part] = parseMediaValue(rawVal, Boolean(leafDef.multiple));
          } else if (
            leafDef.type === 'date' ||
            leafDef.type === 'time' ||
            leafDef.type === 'datetime' ||
            leafDef.type === 'timestamp'
          ) {
            currentTarget[part] = String(rawVal).trim() || null;
          } else if (leafDef.type === 'email' || leafDef.type === 'uid') {
            currentTarget[part] = String(rawVal).trim();
          } else if (leafDef.type === 'password') {
            if (String(rawVal).trim()) {
              currentTarget[part] = String(rawVal).trim();
            }
          } else if (leafDef.type === 'json') {
            try {
              currentTarget[part] = JSON.parse(rawVal);
            } catch {
              currentTarget[part] = rawVal;
            }
          } else if (leafDef.type === 'component' && leafDef.repeatable) {
            try {
              const parsed = JSON.parse(rawVal);
              if (Array.isArray(parsed)) {
                currentTarget[part] = parsed;
              }
            } catch {}
          } else {
            currentTarget[part] = rawVal;
          }
        } else {
          // Intermediate segment
          let compDef = currentAttrs[part];
          if (!compDef) {
            const match = Object.keys(currentAttrs).find(
              (k) => k.toLowerCase() === part.toLowerCase() || k.toLowerCase() === part.toLowerCase().replace(/\s+/g, '')
            );
            if (match) compDef = currentAttrs[match];
          }

          if (compDef?.type === 'component' && !compDef.repeatable && compDef.component) {
            const comp = strapi.components[compDef.component];
            if (!comp?.attributes) {
              validPath = false;
              break;
            }
            if (!currentTarget[part] || typeof currentTarget[part] !== 'object' || Array.isArray(currentTarget[part])) {
              currentTarget[part] = {};
            }
            currentTarget = currentTarget[part];
            currentAttrs = comp.attributes;
          } else {
            validPath = false;
            break;
          }
        }
      }
      continue;
    }

    let attrDef = attrs[key];
    if (!attrDef) {
      const matchKey = Object.keys(attrs).find(
        (k) => k.toLowerCase() === key.toLowerCase() || k.toLowerCase() === key.toLowerCase().replace(/\s+/g, '')
      );
      if (matchKey) {
        attrDef = attrs[matchKey];
      }
    }
    if (!attrDef) continue; // Skip unknown columns
    if (attrDef?.target?.includes('review-workflow') || attrDef?.target === 'admin::review-workflow-stage') {
      continue;
    }

    if (rawVal === '' || rawVal === null || rawVal === undefined) {
      if (
        attrDef.type !== 'dynamiczone' &&
        !(attrDef.type === 'component' && attrDef.repeatable) &&
        attrDef.type !== 'relation' &&
        attrDef.type !== 'password'
      ) {
        payload[key] = null;
      }
      continue;
    }

    switch (attrDef.type) {
      case 'integer':
      case 'biginteger':
        payload[key] = parseNumberValue(rawVal, true);
        break;
      case 'float':
      case 'decimal':
        payload[key] = parseNumberValue(rawVal, false);
        break;
      case 'boolean':
        payload[key] = parseBooleanValue(rawVal);
        break;
      case 'blocks':
        payload[key] = parseBlocksValue(rawVal);
        break;
      case 'enumeration':
        payload[key] = parseEnumValue(rawVal, attrDef.enum);
        break;
      case 'relation':
        payload[key] = parseRelationValue(rawVal, attrDef.relation);
        break;
      case 'media':
        payload[key] = parseMediaValue(rawVal, Boolean(attrDef.multiple));
        break;
      case 'date':
      case 'time':
      case 'datetime':
      case 'timestamp':
        payload[key] = String(rawVal).trim() || null;
        break;
      case 'email':
      case 'uid':
        payload[key] = String(rawVal).trim();
        break;
      case 'password':
        if (String(rawVal).trim()) {
          payload[key] = String(rawVal).trim();
        }
        break;
      case 'json':
        try {
          payload[key] = JSON.parse(rawVal);
        } catch {
          payload[key] = rawVal;
        }
        break;
      case 'dynamiczone': {
        try {
          const parsed = JSON.parse(rawVal);
          if (
            Array.isArray(parsed) &&
            parsed.every((item) => item && typeof item === 'object' && typeof item.__component === 'string')
          ) {
            payload[key] = parsed;
          }
        } catch {}
        break;
      }
      case 'component': {
        if (attrDef.repeatable) {
          try {
            const parsed = JSON.parse(rawVal);
            if (Array.isArray(parsed) && parsed.every((item) => item && typeof item === 'object')) {
              payload[key] = parsed;
            }
          } catch {}
        } else {
          try {
            const parsed = JSON.parse(rawVal);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              payload[key] = parsed;
            }
          } catch {}
        }
        break;
      }
      default:
        payload[key] = rawVal;
    }
  }

  return payload;
}

function formatValueDisplay(val: any): string {
  if (val === null || val === undefined) return '(empty)';
  if (typeof val === 'object') {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  const s = String(val).trim();
  return s === '' ? '(empty)' : s;
}

export async function processCsvRows(
  strapi: Core.Strapi,
  ct: any,
  uid: string,
  rows: Array<Record<string, string>>,
  startRowNumber: number,
  options: {
    mode?: 'auto' | 'update' | 'create_or_override';
    publish?: boolean;
    publishStrategy?: 'safe' | 'all';
    unreviewedConsent?: boolean;
    user?: any;
  }
): Promise<ProcessRowsStats> {
  const attrs = ct.attributes || {};
  const { mode = 'auto', publish = true, publishStrategy = 'safe', user } = options;
  const isDraftAndPublish = Boolean(ct.options?.draftAndPublish);

  const stats: ProcessRowsStats = {
    total: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    newWithoutDocId: 0,
    errors: [],
    diffs: [],
  };

  // Pre-fetch published counterparts for all rows in this chunk
  const docIdsInChunk = rows.map((r) => extractDocId(r)).filter(Boolean);
  const publishedCounterparts = new Map<string, any>();
  if (isDraftAndPublish && docIdsInChunk.length > 0) {
    try {
      const pubList = await (strapi.documents(uid as any) as any).findMany({
        status: 'published',
        filters: { documentId: { $in: docIdsInChunk } },
        fields: ['documentId', 'updatedAt', 'publishedAt'],
        limit: docIdsInChunk.length,
      });
      for (const pub of pubList || []) {
        if (pub?.documentId) {
          publishedCounterparts.set(String(pub.documentId), pub);
        }
      }
    } catch (err) {
      strapi.log.warn(`[csv] Failed to pre-fetch published status for CSV chunk:`, err);
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = startRowNumber + i;
    const row = rows[i];

    let docId = extractDocId(row);
    const rowLocale = extractLocale(row);
    const effectiveLocale = getEffectiveLocale(ct, rowLocale);
    const isEditing = isRowInEditingStage(row);

    // If singleType and no documentId provided in row, auto-detect existing single document
    if (ct.kind === 'singleType' && !docId) {
      try {
        const findSingleArgs: any = {};
        if (effectiveLocale) findSingleArgs.locale = effectiveLocale;
        const singleDoc = await (strapi.documents(uid as any) as any).findFirst(findSingleArgs);
        if (singleDoc?.documentId) {
          docId = singleDoc.documentId;
        }
      } catch {}
    }

    const payload = parseRowToPayload(strapi, attrs, row);

    try {
      if (mode === 'update') {
        if (!docId) {
          stats.skipped++;
          stats.errors.push({
            row: rowNumber,
            error: 'Missing or invalid documentId for Update mode. (Tip: Use Smart Auto-Detect mode to auto-add entries without document IDs).',
          });
          continue;
        }

        const existing = await findExistingDocument(strapi, uid, docId, effectiveLocale);

        if (!existing) {
          stats.skipped++;
          stats.errors.push({
            row: rowNumber,
            documentId: docId,
            error: `Document with ID "${docId}" not found in database.`,
          });
          continue;
        }

        const resolvedDocId = existing.documentId || docId;
        const mergedPayload = { ...payload };
        for (const key of Object.keys(payload)) {
          if (attrs[key]?.type === 'component' && typeof payload[key] === 'object' && payload[key] !== null) {
            mergedPayload[key] = deepMergeComponent((existing as any)[key], payload[key]);
          }
        }

        if (Object.keys(mergedPayload).length === 0) {
          stats.skipped++;
          stats.diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: resolvedDocId,
            label: (existing as any).title || (existing as any).name || `Entry #${resolvedDocId}`,
            attribute: '',
            oldValue: existing,
            newValue: {},
            status: 'skipped',
            message: `Skipped (no editable attributes in row ${rowNumber})`,
          });
          continue;
        }

        const updateArgs: any = {
          documentId: resolvedDocId,
          data: mergedPayload,
        };
        if (effectiveLocale) updateArgs.locale = effectiveLocale;

        await (strapi.documents(uid as any) as any).update(updateArgs);

        let pubRecord = publishedCounterparts.get(String(resolvedDocId));
        if (!pubRecord && isDraftAndPublish && resolvedDocId) {
          try {
            const singlePub = await (strapi.documents(uid as any) as any).findMany({
              status: 'published',
              filters: { documentId: resolvedDocId },
              fields: ['documentId', 'updatedAt', 'publishedAt'],
              limit: 1,
            });
            if (singlePub && singlePub.length > 0) {
              pubRecord = singlePub[0];
              publishedCounterparts.set(String(resolvedDocId), pubRecord);
            }
          } catch {}
        }
        const { hadPublishedVersion, isModified } = inspectPreUpdateStatus(existing, pubRecord);
        const stageVal = resolveStageValue(row, existing);
        const shouldPublish = determineShouldPublish({
          isDraftAndPublish,
          hadPublishedVersion,
          isModified,
          stageValue: stageVal,
          publish: Boolean(publish),
          publishStrategy,
          unreviewedConsent: options.unreviewedConsent,
        });

        if (shouldPublish) {
          try {
            const pubArgs: any = { documentId: resolvedDocId };
            const isLoc = Boolean(ct?.pluginOptions?.i18n?.localized);
            if (isLoc && effectiveLocale && effectiveLocale !== 'null' && effectiveLocale !== 'undefined') {
              pubArgs.locale = effectiveLocale;
            }
            await (strapi.documents(uid as any) as any).publish(pubArgs);
          } catch (pubErr) {
            strapi.log.warn(`[bulk-updater] Auto-publish failed for ${resolvedDocId}:`, pubErr);
          }
        }

        try {
          await recordContentHistoryVersion(strapi, {
            uid,
            documentId: resolvedDocId,
            userId: user?.id,
            statusOverride: shouldPublish
              ? 'published'
              : (isDraftAndPublish ? (hadPublishedVersion ? 'modified' : 'draft') : undefined),
          });
        } catch {}

        stats.updated++;
        for (const attrKey of Object.keys(payload)) {
          const oldVal = (existing as any)?.[attrKey] ?? null;
          const newVal = payload[attrKey];
          stats.diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: resolvedDocId,
            label: (existing as any).title || (existing as any).name || `Entry #${resolvedDocId}`,
            attribute: attrKey,
            oldValue: oldVal,
            newValue: newVal,
            status: 'updated',
            message: `Updated "${attrKey}" via CSV import (row ${rowNumber})`,
          });
        }
      } else if (mode === 'create_or_override') {
        let existing: any = null;
        if (docId) {
          existing = await findExistingDocument(strapi, uid, docId, effectiveLocale);
        }

        if (existing) {
          const resolvedDocId = existing.documentId || docId;
          const mergedPayload = { ...payload };
          for (const key of Object.keys(payload)) {
            if (attrs[key]?.type === 'component' && typeof payload[key] === 'object' && payload[key] !== null) {
              mergedPayload[key] = deepMergeComponent((existing as any)[key], payload[key]);
            }
          }

          const updateArgs: any = {
            documentId: resolvedDocId,
            data: mergedPayload,
          };
          if (effectiveLocale) updateArgs.locale = effectiveLocale;

          await (strapi.documents(uid as any) as any).update(updateArgs);

          let pubRecord = publishedCounterparts.get(String(resolvedDocId));
        if (!pubRecord && isDraftAndPublish && resolvedDocId) {
          try {
            const singlePub = await (strapi.documents(uid as any) as any).findMany({
              status: 'published',
              filters: { documentId: resolvedDocId },
              fields: ['documentId', 'updatedAt', 'publishedAt'],
              limit: 1,
            });
            if (singlePub && singlePub.length > 0) {
              pubRecord = singlePub[0];
              publishedCounterparts.set(String(resolvedDocId), pubRecord);
            }
          } catch {}
        }
        const { hadPublishedVersion, isModified } = inspectPreUpdateStatus(existing, pubRecord);
          const stageVal = resolveStageValue(row, existing);
          const shouldPublish = determineShouldPublish({
            isDraftAndPublish,
            hadPublishedVersion,
            isModified,
            stageValue: stageVal,
            publish: Boolean(publish),
            publishStrategy,
            unreviewedConsent: options.unreviewedConsent,
          });

          if (shouldPublish) {
            try {
              const pubArgs: any = { documentId: resolvedDocId };
              const isLoc = Boolean(ct?.pluginOptions?.i18n?.localized);
            if (isLoc && effectiveLocale && effectiveLocale !== 'null' && effectiveLocale !== 'undefined') pubArgs.locale = effectiveLocale;
              await (strapi.documents(uid as any) as any).publish(pubArgs);
            } catch (pubErr) {
              strapi.log.warn(`[bulk-updater] Auto-publish failed for ${resolvedDocId}:`, pubErr);
            }
          }

          try {
            await recordContentHistoryVersion(strapi, {
              uid,
              documentId: resolvedDocId,
              userId: user?.id,
              statusOverride: shouldPublish
                ? 'published'
                : (isDraftAndPublish ? (hadPublishedVersion ? 'modified' : 'draft') : undefined),
            });
          } catch {}

          stats.updated++;
          for (const attrKey of Object.keys(payload)) {
            const oldVal = (existing as any)?.[attrKey] ?? null;
            const newVal = payload[attrKey];
            stats.diffs.push({
              uid,
              collectionName: ct.info?.displayName || uid,
              documentId: resolvedDocId,
              label: (existing as any).title || (existing as any).name || `Entry #${resolvedDocId}`,
              attribute: attrKey,
              oldValue: oldVal,
              newValue: newVal,
              status: 'updated',
              message: `Overridden "${attrKey}" via CSV import (row ${rowNumber})`,
            });
          }
          continue;
        }

        const createArgs: any = { data: payload };
        if (effectiveLocale) createArgs.locale = effectiveLocale;
        const created: any = await strapi.documents(uid as any).create(createArgs);

        const newDocId = created?.documentId || docId;
        const isApprovedStage = isRowInApprovedStage(row);
        const shouldPublishNew = !isEditing && !isApprovedStage && isDraftAndPublish && Boolean(publish) && (
          publishStrategy === 'all' || options.unreviewedConsent ? true : false
        );

        if (shouldPublishNew && newDocId) {
          try {
            const pubArgs: any = { documentId: newDocId };
            const isLoc = Boolean(ct?.pluginOptions?.i18n?.localized);
            if (isLoc && effectiveLocale && effectiveLocale !== 'null' && effectiveLocale !== 'undefined') pubArgs.locale = effectiveLocale;
            await (strapi.documents(uid as any) as any).publish(pubArgs);
          } catch (pubErr) {
            strapi.log.warn(`[bulk-updater] Auto-publish failed for ${newDocId}:`, pubErr);
          }
        }

        try {
          await recordContentHistoryVersion(strapi, {
            uid,
            documentId: newDocId,
            userId: user?.id,
            statusOverride: shouldPublishNew ? 'published' : (isDraftAndPublish ? 'draft' : undefined),
          });
        } catch {}

        stats.created++;
        if (!docId) {
          stats.newWithoutDocId++;
        }
        for (const attrKey of Object.keys(payload)) {
          stats.diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: newDocId,
            label: created?.title || created?.name || `New Entry #${newDocId}`,
            attribute: attrKey,
            oldValue: null,
            newValue: payload[attrKey],
            status: 'created',
            message: docId
              ? `Created "${attrKey}" via CSV import (row ${rowNumber})`
              : `Created "${attrKey}" as new entry (row ${rowNumber})`,
          });
        }
      } else {
        // Default: Smart Auto-Detect ('auto')
        let existing: any = null;
        if (docId) {
          existing = await findExistingDocument(strapi, uid, docId, effectiveLocale);
        }

        if (existing) {
          const resolvedDocId = existing.documentId || docId;
          const mergedPayload = { ...payload };
          for (const key of Object.keys(payload)) {
            if (attrs[key]?.type === 'component' && typeof payload[key] === 'object' && payload[key] !== null) {
              mergedPayload[key] = deepMergeComponent((existing as any)[key], payload[key]);
            }
          }

          const updateArgs: any = {
            documentId: resolvedDocId,
            data: mergedPayload,
          };
          if (effectiveLocale) updateArgs.locale = effectiveLocale;

          await (strapi.documents(uid as any) as any).update(updateArgs);

          let pubRecord = publishedCounterparts.get(String(resolvedDocId));
        if (!pubRecord && isDraftAndPublish && resolvedDocId) {
          try {
            const singlePub = await (strapi.documents(uid as any) as any).findMany({
              status: 'published',
              filters: { documentId: resolvedDocId },
              fields: ['documentId', 'updatedAt', 'publishedAt'],
              limit: 1,
            });
            if (singlePub && singlePub.length > 0) {
              pubRecord = singlePub[0];
              publishedCounterparts.set(String(resolvedDocId), pubRecord);
            }
          } catch {}
        }
        const { hadPublishedVersion, isModified } = inspectPreUpdateStatus(existing, pubRecord);
          const stageVal = resolveStageValue(row, existing);
          const shouldPublish = determineShouldPublish({
            isDraftAndPublish,
            hadPublishedVersion,
            isModified,
            stageValue: stageVal,
            publish: Boolean(publish),
            publishStrategy,
            unreviewedConsent: options.unreviewedConsent,
          });

          if (shouldPublish) {
            try {
              const pubArgs: any = { documentId: resolvedDocId };
              const isLoc = Boolean(ct?.pluginOptions?.i18n?.localized);
            if (isLoc && effectiveLocale && effectiveLocale !== 'null' && effectiveLocale !== 'undefined') pubArgs.locale = effectiveLocale;
              await (strapi.documents(uid as any) as any).publish(pubArgs);
            } catch (pubErr) {
              strapi.log.warn(`[bulk-updater] Auto-publish failed for ${resolvedDocId}:`, pubErr);
            }
          }

          try {
            await recordContentHistoryVersion(strapi, {
              uid,
              documentId: resolvedDocId,
              userId: user?.id,
              statusOverride: shouldPublish
                ? 'published'
                : (isDraftAndPublish ? (hadPublishedVersion ? 'modified' : 'draft') : undefined),
            });
          } catch {}

          stats.updated++;
          for (const attrKey of Object.keys(payload)) {
            const oldVal = (existing as any)?.[attrKey] ?? null;
            const newVal = payload[attrKey];
            stats.diffs.push({
              uid,
              collectionName: ct.info?.displayName || uid,
              documentId: resolvedDocId,
              label: (existing as any).title || (existing as any).name || `Entry #${resolvedDocId}`,
              attribute: attrKey,
              oldValue: oldVal,
              newValue: newVal,
              status: 'updated',
              message: `Updated "${attrKey}" via CSV import (row ${rowNumber})`,
            });
          }
          continue;
        }

        // Missing docId OR provided docId does not exist in DB -> create new
        const createArgs: any = { data: payload };
        if (effectiveLocale) createArgs.locale = effectiveLocale;
        const created: any = await strapi.documents(uid as any).create(createArgs);

        const newDocId = created?.documentId || docId;
        const isApprovedStage = isRowInApprovedStage(row);
        const shouldPublishNew = !isEditing && !isApprovedStage && isDraftAndPublish && Boolean(publish) && (
          publishStrategy === 'all' || options.unreviewedConsent ? true : false
        );

        if (shouldPublishNew && newDocId) {
          try {
            const pubArgs: any = { documentId: newDocId };
            const isLoc = Boolean(ct?.pluginOptions?.i18n?.localized);
            if (isLoc && effectiveLocale && effectiveLocale !== 'null' && effectiveLocale !== 'undefined') pubArgs.locale = effectiveLocale;
            await (strapi.documents(uid as any) as any).publish(pubArgs);
          } catch (pubErr) {
            strapi.log.warn(`[bulk-updater] Auto-publish failed for ${newDocId}:`, pubErr);
          }
        }

        try {
          await recordContentHistoryVersion(strapi, {
            uid,
            documentId: newDocId,
            userId: user?.id,
            statusOverride: shouldPublishNew ? 'published' : (isDraftAndPublish ? 'draft' : undefined),
          });
        } catch {}

        stats.created++;
        if (!docId) {
          stats.newWithoutDocId++;
        }
        for (const attrKey of Object.keys(payload)) {
          stats.diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: newDocId,
            label: created?.title || created?.name || `New Entry #${newDocId}`,
            attribute: attrKey,
            oldValue: null,
            newValue: payload[attrKey],
            status: 'created',
            message: docId
              ? `Created "${attrKey}" as new entry (documentId "${docId}" not found in database - row ${rowNumber})`
              : `Created "${attrKey}" as new entry (no documentId provided in CSV - row ${rowNumber})`,
          });
        }
      }
    } catch (err: any) {
      stats.errors.push({
        row: rowNumber,
        documentId: docId || undefined,
        error: extractDetailedErrorMessage(err),
      });
    }
  }

  return stats;
}

async function recordCsvAuditLog(
  strapi: Core.Strapi,
  ct: any,
  uid: string,
  batchId: string,
  stats: { total: number; created: number; updated: number; skipped: number; diffs: Array<any> },
  user?: any,
  publishOnApproval?: boolean,
  publishStrategy?: 'safe' | 'all',
  unreviewedConsent?: boolean
) {
  if (stats.updated === 0 && stats.created === 0) return;

  try {
    const auditService = strapi.plugin('bulk-updater').service('audit');
    if (!auditService) return;

    const isEnabled = typeof auditService.isAuditEnabled === 'function'
      ? auditService.isAuditEnabled()
      : Boolean(auditService.getAuditConfig?.().enabled ?? true);

    if (!isEnabled) return;

    const userEmail = user?.email || 'admin@strapi.io';
    const userName = user ? `${user.firstname || ''} ${user.lastname || ''}`.trim() : 'CSV Importer';
    const collectionDisplayName = ct.info?.displayName || uid;
    const updatedDiffs = stats.diffs.filter(
      (d) => d.status === 'updated' || d.status === 'created'
    );
    const uniqueAttributes = Array.from(
      new Set(updatedDiffs.map((d) => d.attribute))
    ).filter(Boolean);
    const attrListStr = uniqueAttributes.length > 0 ? uniqueAttributes.join(', ') : 'fields';

    const batchAttribute = `CSV [${collectionDisplayName}]: ${attrListStr}`;

    let batchValue = '';
    if (updatedDiffs.length === 1) {
      const d = updatedDiffs[0];
      const newStr = d.newValue !== null && d.newValue !== undefined ? String(d.newValue) : '(empty)';
      batchValue = `"${d.label}": ${d.attribute} → "${newStr}"`;
    } else if (updatedDiffs.length > 1 && stats.updated === 1 && stats.created === 0) {
      const d = updatedDiffs[0];
      const changes = updatedDiffs
        .map((ud) => `${ud.attribute}: "${ud.newValue ?? ''}"`)
        .join(', ');
      batchValue = `"${d.label}": ${changes}`;
    } else {
      const sampleVal = updatedDiffs[0]
        ? ` (e.g. ${updatedDiffs[0].attribute}: "${updatedDiffs[0].newValue ?? ''}")`
        : '';
      batchValue = `${stats.updated} updated, ${stats.created} created in ${collectionDisplayName}${sampleVal}`;
    }

    const batchSummary = {
      batchId,
      attribute: batchAttribute,
      value: batchValue,
      updatedCount: stats.updated + stats.created,
      skippedCount: stats.skipped,
      totalTargets: stats.total,
    };

    const userObj = {
      email: userEmail || 'admin@strapi.io',
      firstname: userName || 'Admin',
    };

    if (typeof auditService.recordBatch === 'function') {
      await auditService.recordBatch(
        batchSummary,
        stats.diffs,
        userObj,
        publishOnApproval,
        publishStrategy,
        unreviewedConsent
      );
    } else if (typeof auditService.logOperation === 'function') {
      await auditService.logOperation({
        ...batchSummary,
        userEmail,
        userName,
        diffs: stats.diffs,
      });
    }
  } catch (auditErr) {
    strapi.log.warn('[bulk-updater] Failed logging CSV import audit:', auditErr);
  }
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Generates a sample template CSV with schema attribute headers and sample values
   */
  async getTemplateCsv(uid: string) {
    const ct = strapi.contentTypes[uid];
    if (!ct) {
      throw new Error(`Content type ${uid} not found`);
    }

    const attrs = ct.attributes || {};
    const excluded = ['createdAt', 'updatedAt', 'publishedAt', 'createdBy', 'updatedBy', 'localizations'];

    // Base columns: documentId (optional for create, required for update)
    const headers = ['documentId'];
    const sampleRow: string[] = ['(Leave empty to create new, or enter existing docId)'];

    for (const [attrName, attrDef] of Object.entries(attrs) as any[]) {
      if (excluded.includes(attrName)) continue;
      if (attrDef.type === 'relation') continue;
      if (attrDef.type === 'component' || attrDef.type === 'dynamiczone') continue;

      headers.push(attrName);
      let sampleVal = '';
      switch (attrDef.type) {
        case 'string':
        case 'text':
        case 'richtext':
          sampleVal = `Sample ${attrName}`;
          break;
        case 'integer':
        case 'biginteger':
        case 'float':
        case 'decimal':
          sampleVal = '10';
          break;
        case 'boolean':
          sampleVal = 'true';
          break;
        case 'email':
          sampleVal = 'sample@example.com';
          break;
        case 'enumeration':
          sampleVal = attrDef.enum?.[0] || 'option1';
          break;
        case 'customField':
          sampleVal = 'value';
          break;
        default:
          sampleVal = 'sample';
      }
      sampleRow.push(sampleVal);
    }

    const csvContent =
      '\uFEFF' +
      headers.map(escapeCsvValue).join(',') +
      '\r\n' +
      sampleRow.map(escapeCsvValue).join(',') +
      '\r\n';

    return {
      filename: `${ct.info?.singularName || 'template'}_template.csv`,
      csvContent,
      headers,
    };
  },

  /**
   * Exports entries of a collection to CSV with deep nested component support,
   * RFC-4180 CRLF line endings, and UTF-8 BOM for 100% Microsoft Excel compatibility.
   */
  async exportCollectionCsv(
    uid: string,
    options: {
      search?: string;
      attribute?: string;
      filterOperator?: string;
      filterQuery?: string;
      limit?: number;
      documentIds?: string[];
    } = {}
  ) {
    const ct = strapi.contentTypes[uid];
    if (!ct) {
      throw new Error(`Content type ${uid} not found`);
    }

    const allComponents = strapi.components || {};

    // 1. Discover all exportable fields, including nested components
    const fields = discoverExportFields(ct, allComponents);

    // 2. Build database query filters
    const filters: Record<string, any> = {};
    const { attribute, filterOperator, filterQuery, search, documentIds } = options;

    // Filter by specific selected document IDs if provided
    if (documentIds && Array.isArray(documentIds) && documentIds.length > 0) {
      filters.documentId = { $in: documentIds };
    }

    // Apply attribute condition filter with nested component support
    if (attribute && filterOperator && filterOperator !== 'none') {
      const isNested = attribute.includes('.');
      if (filterOperator === 'empty') {
        if (isNested) {
          const [parent, child] = attribute.split('.');
          filters[parent] = { [child]: { $null: true } };
        } else {
          filters[attribute] = { $null: true };
        }
      } else if (filterOperator === 'not_empty') {
        if (isNested) {
          const [parent, child] = attribute.split('.');
          filters[parent] = { [child]: { $notNull: true } };
        } else {
          filters[attribute] = { $notNull: true };
        }
      } else if (filterQuery !== undefined && filterQuery !== '') {
        const opMap: Record<string, string> = {
          equals: '$eq',
          notEquals: '$ne',
          contains: '$containsi',
          notContains: '$notContainsi',
          startsWith: '$startsWith',
          endsWith: '$endsWith',
        };
        const strapiOp = opMap[filterOperator] || '$eq';
        if (isNested) {
          const [parent, child] = attribute.split('.');
          filters[parent] = { [child]: { [strapiOp]: filterQuery } };
        } else {
          filters[attribute] = { [strapiOp]: filterQuery };
        }
      }
    }

    // Text search filter
    if (search && search.trim() !== '') {
      const q = search.trim();
      const searchConditions: any[] = [];
      const searchFields = ['name', 'title', 'email', 'slug', 'description'].filter(
        (f) => ct.attributes?.[f] && ['string', 'text', 'email'].includes(ct.attributes[f].type)
      );

      for (const field of searchFields) {
        searchConditions.push({ [field]: { $containsi: q } });
      }

      if (searchConditions.length > 0) {
        if (filters && Object.keys(filters).length > 0) {
          filters.$and = [{ $or: searchConditions }];
        } else {
          filters.$or = searchConditions;
        }
      }
    }

    // 3. Build deep populate tree so nested components and relations are retrieved
    const deepPopulate = buildDeepPopulate(ct.attributes || {}, allComponents);

    // 4. Retrieve entries and generate RFC-4180 CRLF rows with UTF-8 BOM
    const lines: string[] = [];
    lines.push(fields.map((f) => escapeCsvValue(f.key)).join(','));

    let totalExported = 0;
    const maxLimit = options.limit && options.limit > 0 ? options.limit : Infinity;
    const CHUNK_SIZE = 1000;

    if (ct.kind === 'singleType') {
      const findFirstArgs: any = {};
      if (deepPopulate) {
        findFirstArgs.populate = deepPopulate;
      }
      const doc = await (strapi.documents(uid as any) as any).findFirst(findFirstArgs);
      if (doc) {
        const rowValues = fields.map((f) => escapeCsvValue(getNestedExportValue(doc, f.key)));
        lines.push(rowValues.join(','));
        totalExported = 1;
      }
    } else {
      let currentPage = 1;
      let hasMore = true;

      while (hasMore && totalExported < maxLimit) {
        const remaining = maxLimit - totalExported;
        const currentBatchLimit = Math.min(CHUNK_SIZE, remaining);

        const findPageArgs: any = {
          filters: Object.keys(filters).length > 0 ? filters : undefined,
          page: currentPage,
          pageSize: currentBatchLimit,
          sort: { createdAt: 'desc' },
        };
        if (deepPopulate) {
          findPageArgs.populate = deepPopulate;
        }

        const chunkEntries: any[] = await (strapi.documents(uid as any) as any).findMany(findPageArgs);

        if (!chunkEntries || chunkEntries.length === 0) {
          hasMore = false;
          break;
        }

        for (const entry of chunkEntries) {
          const rowValues = fields.map((f) => escapeCsvValue(getNestedExportValue(entry, f.key)));
          lines.push(rowValues.join(','));
          totalExported++;
          if (totalExported >= maxLimit) {
            hasMore = false;
            break;
          }
        }

        if (chunkEntries.length < currentBatchLimit) {
          hasMore = false;
        } else {
          currentPage++;
        }
      }
    }

    // Prepend UTF-8 BOM and terminate lines with CRLF for seamless Excel import
    const csvContent = '\uFEFF' + lines.join('\r\n') + '\r\n';
    const filename = `${ct.info?.singularName || uid}_export_${new Date().toISOString().slice(0, 10)}.csv`;

    return {
      filename,
      csvContent,
      count: totalExported,
      fields: fields.map((f) => f.key),
    };
  },

  /**
   * Exports violations of a specific rule directly into a CSV
   */
  async exportViolationsCsv(ruleId: string) {
    const validationRulesService = strapi.plugin('bulk-updater').service('validationRules');
    const scanReport = await validationRulesService.scanViolations(ruleId);

    const headers = [
      'collectionUid',
      'collectionName',
      'documentId',
      'entryLabel',
      'targetField',
      'violatingOption',
      'foundCount',
      'maxAllowed',
      'directEditorUrl',
    ];

    const lines: string[] = [];
    lines.push(headers.map(escapeCsvValue).join(','));

    for (const v of scanReport.violations) {
      const row = [
        v.uid,
        v.collectionDisplayName,
        v.documentId,
        v.entryLabel,
        scanReport.rule.targetField,
        v.violatingOption,
        v.foundCount,
        v.maxAllowed,
        v.editUrl,
      ];
      lines.push(row.map(escapeCsvValue).join(','));
    }

    const safeRuleName = scanReport.rule.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `violations_${safeRuleName}_${new Date().toISOString().slice(0, 10)}.csv`;

    return {
      filename,
      csvContent: '\uFEFF' + lines.join('\r\n') + '\r\n',
      count: scanReport.violations.length,
      ruleName: scanReport.rule.name,
    };
  },

  /**
   * Bulk Export: Exports selected entries across multiple collections or a multi-collection batch.
   */
  async exportBulkCsv(selectedEntries: Array<{ uid: string; documentId: string }>) {
    if (!selectedEntries || selectedEntries.length === 0) {
      throw new Error('No entries selected for bulk export');
    }

    // Group selected documentIds by collection uid
    const byUid: Record<string, string[]> = {};
    for (const item of selectedEntries) {
      if (!byUid[item.uid]) byUid[item.uid] = [];
      byUid[item.uid].push(item.documentId);
    }

    const uids = Object.keys(byUid);

    // If all entries belong to a single collection, export full collection schema with deep fields
    if (uids.length === 1) {
      const uid = uids[0];
      return await this.exportCollectionCsv(uid, { documentIds: byUid[uid], limit: 0 });
    }

    // Multi-collection unified export
    const rows: string[] = [];
    const headers = [
      'Collection UID',
      'Collection Name',
      'Document ID',
      'Record Title / Name',
      'Primary Identifier',
      'Created At',
      'Updated At',
      'Published Status',
    ];
    rows.push(headers.map(escapeCsvValue).join(','));

    let totalExported = 0;

    for (const uid of uids) {
      const ct = strapi.contentTypes[uid];
      if (!ct) continue;
      const displayName = ct.info?.displayName || uid;
      const docIds = byUid[uid];

      const entries = await (strapi.documents(uid as any) as any).findMany({
        filters: { documentId: { $in: docIds } },
        limit: docIds.length,
      });

      for (const entry of (entries || []) as any[]) {
        const titleOrName = entry.title || entry.name || entry.subject || entry.email || `Entry #${entry.documentId}`;
        const identifier = entry.slug || entry.email || entry.username || entry.documentId;
        const isPublished = Boolean(entry.publishedAt);

        const row = [
          uid,
          displayName,
          entry.documentId,
          titleOrName,
          identifier,
          entry.createdAt || '',
          entry.updatedAt || '',
          isPublished ? 'Published' : 'Draft',
        ];
        rows.push(row.map(escapeCsvValue).join(','));
        totalExported++;
      }
    }

    const filename = `bulk_export_selected_${totalExported}_entries_${new Date().toISOString().slice(0, 10)}.csv`;
    return {
      filename,
      csvContent: '\uFEFF' + rows.join('\r\n') + '\r\n',
      count: totalExported,
      isMultiCollection: true,
    };
  },

  /**
   * Imports a single chunk of CSV rows (for large dataset streaming/batching).
   * Aggregates stats across chunks and writes unified audit trail on the final chunk.
   */
  async importChunk(
    uid: string,
    rows: Array<Record<string, string>>,
    options: {
      batchId?: string;
      isFirstChunk?: boolean;
      isLastChunk?: boolean;
      startRowNumber?: number;
      mode?: 'auto' | 'update' | 'create_or_override';
      publish?: boolean;
      publishStrategy?: 'safe' | 'all';
      unreviewedConsent?: boolean;
      user?: any;
    }
  ) {
    const ct = strapi.contentTypes[uid];
    if (!ct) {
      throw new Error(`Content type ${uid} not found`);
    }

    cleanupStaleSessions();

    const batchId = options.batchId || `csv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let session = csvImportSessions.get(batchId);

    if (!session || options.isFirstChunk) {
      session = {
        batchId,
        uid,
        createdAt: Date.now(),
        total: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        newWithoutDocId: 0,
        errors: [],
        diffs: [],
        publishStrategy: options.publishStrategy,
        unreviewedConsent: options.unreviewedConsent,
      };
      csvImportSessions.set(batchId, session);
    }

    const startRowNumber = options.startRowNumber || (session.total + 2);
    const chunkStats = await processCsvRows(strapi, ct, uid, rows || [], startRowNumber, options);

    session.total += chunkStats.total;
    session.created += chunkStats.created;
    session.updated += chunkStats.updated;
    session.skipped += chunkStats.skipped;
    session.newWithoutDocId += chunkStats.newWithoutDocId;
    session.errors.push(...chunkStats.errors);
    session.diffs.push(...chunkStats.diffs);

    if (options.isLastChunk) {
      await recordCsvAuditLog(
        strapi,
        ct,
        uid,
        batchId,
        session,
        options.user,
        options.publish !== false,
        session.publishStrategy || options.publishStrategy,
        session.unreviewedConsent ?? options.unreviewedConsent
      );

      try {
        const bulkService = strapi.plugin('bulk-updater').service('bulkUpdater');
        if (bulkService && (bulkService as any).invalidateCollectionCache) {
          (bulkService as any).invalidateCollectionCache(uid);
        }
      } catch {}

      const aggregateStats = {
        total: session.total,
        created: session.created,
        updated: session.updated,
        skipped: session.skipped,
        newWithoutDocId: session.newWithoutDocId,
        errors: session.errors,
        diffs: session.diffs,
      };

      csvImportSessions.delete(batchId);

      return {
        success: true,
        batchId,
        chunkStats,
        stats: aggregateStats,
        isFinished: true,
      };
    }

    return {
      success: true,
      batchId,
      chunkStats,
      isFinished: false,
    };
  },

  /**
   * Imports CSV records to update existing records or insert/override records (single payload).
   */
  async importCsv(
    uid: string,
    csvText: string,
    options: {
      mode?: 'auto' | 'update' | 'create_or_override';
      publish?: boolean;
      publishStrategy?: 'safe' | 'all';
      unreviewedConsent?: boolean;
      user?: any;
    }
  ) {
    const ct = strapi.contentTypes[uid];
    if (!ct) {
      throw new Error(`Content type ${uid} not found`);
    }

    const parsedRows = parseCsv(csvText);
    if (!parsedRows || parsedRows.length === 0) {
      throw new Error('CSV is empty or could not be parsed.');
    }

    const batchId = `csv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const stats = await processCsvRows(strapi, ct, uid, parsedRows, 2, options);

    try {
      const bulkService = strapi.plugin('bulk-updater').service('bulkUpdater');
      if (bulkService && (bulkService as any).invalidateCollectionCache) {
        (bulkService as any).invalidateCollectionCache(uid);
      }
    } catch {}

    await recordCsvAuditLog(
      strapi,
      ct,
      uid,
      batchId,
      stats,
      options.user,
      options.publish !== false,
      options.publishStrategy,
      options.unreviewedConsent
    );

    return {
      success: true,
      batchId,
      stats,
    };
  },

  /**
   * Executes a pending CSV batch approved by Checker or queued for off-peak execution
   */
  async executeCsvPendingBatch(
    uid: string,
    rows: Array<Record<string, string>>,
    batchId: string,
    options: {
      mode?: 'auto' | 'update' | 'create_or_override';
      publish?: boolean;
      publishStrategy?: 'safe' | 'all';
      unreviewedConsent?: boolean;
      user?: any;
    } = {},
    checkerUser?: any
  ) {
    const ct = strapi.contentTypes[uid];
    if (!ct) {
      throw new Error(`Content type ${uid} not found`);
    }

    const effectiveUser = checkerUser || options.user;
    const stats = await processCsvRows(strapi, ct, uid, rows || [], 2, {
      ...options,
      user: effectiveUser,
    });

    await recordCsvAuditLog(
      strapi,
      ct,
      uid,
      batchId,
      stats,
      effectiveUser,
      options.publish !== false,
      options.publishStrategy,
      options.unreviewedConsent
    );

    try {
      const bulkService = strapi.plugin('bulk-updater').service('bulkUpdater');
      if (bulkService && (bulkService as any).invalidateCollectionCache) {
        (bulkService as any).invalidateCollectionCache(uid);
      }
    } catch {}

    return {
      success: true,
      batchId,
      stats,
    };
  },

  /**
   * Pre-Flight Dry-Run Validation: Non-mutating analysis verifying document existence,
   * data types, schema integrity, and quota rule violations before execution.
   */
  async validatePreflight(
    uid: string,
    rows: Array<Record<string, string>>,
    options: {
      mode?: 'auto' | 'update' | 'create_or_override';
    } = {}
  ) {
    const ct = strapi.contentTypes[uid];
    if (!ct) {
      throw new Error(`Content type ${uid} not found`);
    }

    const { mode = 'auto' } = options;
    const attrs = ct.attributes || {};

    let validationRulesService: any = null;
    let activeRules: any[] = [];
    try {
      validationRulesService = strapi.plugin('bulk-updater').service('validationRules');
      if (validationRulesService) {
        const rulesRes = await validationRulesService.getRules();
        activeRules = (rulesRes || []).filter((r: any) => r.enabled);
      }
    } catch {}

    let validRows = 0;
    let estimatedUpdates = 0;
    let estimatedCreates = 0;
    const isDraftAndPublish = Boolean(ct.options?.draftAndPublish);
    const lifecycleStats = {
      isDraftAndPublish,
      totalChecked: 0,
      published: 0,
      modified: 0,
      draft: 0,
      unreviewedCount: 0,
    };

    const docIdsInPreflight = rows.map((r) => extractDocId(r)).filter(Boolean);
    const publishedCounterparts = new Map<string, any>();
    if (isDraftAndPublish && docIdsInPreflight.length > 0) {
      try {
        const pubList = await (strapi.documents(uid as any) as any).findMany({
          status: 'published',
          filters: { documentId: { $in: docIdsInPreflight } },
          fields: ['documentId', 'updatedAt', 'publishedAt'],
          limit: docIdsInPreflight.length,
        });
        for (const pub of pubList || []) {
          if (pub?.documentId) {
            publishedCounterparts.set(String(pub.documentId), pub);
          }
        }
      } catch (err) {
        strapi.log.warn(`[csv] Failed to pre-fetch published status for CSV preflight:`, err);
      }
    }
    const errors: Array<{ row: number; documentId?: string; error: string }> = [];
    const warnings: Array<{ row: number; documentId?: string; warning: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const row = rows[i];
      const docId = extractDocId(row);
      const rowLocale = extractLocale(row);
      const effectiveLocale = getEffectiveLocale(ct, rowLocale);
      const isEditing = isRowInEditingStage(row);
      let rowHasError = false;

      // 1. Document Existence Check
      let existing: any = null;
      if (docId) {
        existing = await findExistingDocument(strapi, uid, docId, effectiveLocale);
      }

      if (existing && isDraftAndPublish) {
        lifecycleStats.totalChecked++;
        const targetDocId = existing.documentId || docId;
        let pubRecord = publishedCounterparts.get(String(targetDocId));
        if (!pubRecord && isDraftAndPublish && targetDocId) {
          try {
            const singlePub = await (strapi.documents(uid as any) as any).findMany({
              status: 'published',
              filters: { documentId: targetDocId },
              fields: ['documentId', 'updatedAt', 'publishedAt'],
              limit: 1,
            });
            if (singlePub && singlePub.length > 0) {
              pubRecord = singlePub[0];
              publishedCounterparts.set(String(targetDocId), pubRecord);
            }
          } catch {}
        }
        const { hadPublishedVersion, isModified } = inspectPreUpdateStatus(existing, pubRecord);
        const stageVal = resolveStageValue(row, existing);
        const willPublish = determineShouldPublish({
          isDraftAndPublish,
          hadPublishedVersion,
          isModified,
          stageValue: stageVal,
          publish: true,
          publishStrategy: options.publishStrategy || 'safe',
          unreviewedConsent: options.unreviewedConsent,
        });

        if (willPublish) {
          lifecycleStats.published++;
        } else if (hadPublishedVersion && (isModified || isRowInEditingStage(row))) {
          lifecycleStats.modified++;
          lifecycleStats.unreviewedCount++;
        } else if (!hadPublishedVersion) {
          lifecycleStats.draft++;
          lifecycleStats.unreviewedCount++;
        } else {
          lifecycleStats.published++;
        }
      }

      if (mode === 'update') {
        if (!docId) {
          errors.push({
            row: rowNumber,
            error: 'Missing or invalid documentId for Update Only mode.',
          });
          rowHasError = true;
        } else if (!existing) {
          errors.push({
            row: rowNumber,
            documentId: docId,
            error: `Document with ID "${docId}" not found in database.`,
          });
          rowHasError = true;
        } else {
          estimatedUpdates++;
        }
      } else if (mode === 'create_or_override') {
        if (existing) {
          estimatedUpdates++;
        } else {
          estimatedCreates++;
        }
      } else {
        // Smart Auto-Detect
        if (existing) {
          estimatedUpdates++;
        } else {
          estimatedCreates++;
          if (docId) {
            warnings.push({
              row: rowNumber,
              documentId: docId,
              warning: `Document ID "${docId}" not found in DB; will create as a new entry.`,
            });
          }
        }
      }

      // 2. Schema Type Validation
      for (const [colKey, rawVal] of Object.entries(row)) {
        if (!rawVal || rawVal.trim() === '') continue;
        const normalizedKey = colKey.toLowerCase().replace(/[\s_-]/g, '');
        if (SYSTEM_FIELD_KEYS.has(normalizedKey)) continue;

        let attrDef = attrs[colKey];
        if (!attrDef && !colKey.includes('.')) {
          const matchKey = Object.keys(attrs).find(
            (k) => k.toLowerCase() === colKey.toLowerCase() || k.toLowerCase() === colKey.toLowerCase().replace(/\s+/g, '')
          );
          if (matchKey) attrDef = attrs[matchKey];
        }

        if (attrDef) {
          if (attrDef.type === 'integer' || attrDef.type === 'biginteger') {
            const num = parseInt(rawVal, 10);
            if (isNaN(num)) {
              errors.push({
                row: rowNumber,
                documentId: docId || undefined,
                error: `Column "${colKey}" expects an integer, received: "${rawVal}"`,
              });
              rowHasError = true;
            }
          } else if (attrDef.type === 'float' || attrDef.type === 'decimal') {
            const num = parseFloat(rawVal);
            if (isNaN(num)) {
              errors.push({
                row: rowNumber,
                documentId: docId || undefined,
                error: `Column "${colKey}" expects a numeric float/decimal, received: "${rawVal}"`,
              });
              rowHasError = true;
            }
          } else if (attrDef.type === 'enumeration' && Array.isArray(attrDef.enum)) {
            if (!attrDef.enum.includes(rawVal.trim())) {
              warnings.push({
                row: rowNumber,
                documentId: docId || undefined,
                warning: `Column "${colKey}" value "${rawVal}" is not in defined enum options: [${attrDef.enum.join(', ')}]`,
              });
            }
          } else if (attrDef.type === 'json') {
            try {
              JSON.parse(rawVal);
            } catch {
              warnings.push({
                row: rowNumber,
                documentId: docId || undefined,
                warning: `Column "${colKey}" is type JSON but contains non-JSON text.`,
              });
            }
          }
        }

        // 3. Quota Rules Scan
        if (activeRules.length > 0) {
          for (const rule of activeRules) {
            if (rule.collectionUid && rule.collectionUid !== '*' && rule.collectionUid !== uid) continue;
            if (rule.includeRichTextHtml && (rawVal.includes('<h') || rawVal.includes('# '))) {
              const headings = extractHeadingsFromRichText(rawVal);
              for (const [tag, count] of Object.entries(headings)) {
                const max = rule.quotas?.[tag.toLowerCase()];
                if (max !== undefined && count > max) {
                  warnings.push({
                    row: rowNumber,
                    documentId: docId || undefined,
                    warning: `Rule "${rule.name}" quota warning: column "${colKey}" contains ${count} "${tag.toUpperCase()}" headings (maximum allowed: ${max}).`,
                  });
                }
              }
            }
          }
        }
      }

      if (!rowHasError) {
        validRows++;
      }
    }

    return {
      success: true,
      totalRows: rows.length,
      validRows,
      estimatedUpdates,
      estimatedCreates,
      lifecycleStats,
      hasErrors: errors.length > 0,
      hasWarnings: warnings.length > 0,
      errors: errors.slice(0, 100),
      warnings: warnings.slice(0, 100),
      totalErrorCount: errors.length,
      totalWarningCount: warnings.length,
    };
  },

  /**
   * Previews CSV batch changes item-by-item without mutating the database.
   * Compares proposed CSV rows against existing documents to compute exact diffs for Maker-Checker review.
   */
  async previewCsvBatch(
    uid: string,
    rows: Array<Record<string, string>>,
    options: {
      mode?: 'auto' | 'update' | 'create_or_override';
      publish?: boolean;
      publishStrategy?: 'safe' | 'all';
      unreviewedConsent?: boolean;
    } = {}
  ) {
    const ct = strapi.contentTypes[uid];
    if (!ct) {
      throw new Error(`Content type "${uid}" not found`);
    }

    const attrs = ct.attributes || {};
    const { mode = 'auto' } = options;

    const diffs: any[] = [];
    let willUpdateCount = 0;
    let willCreateCount = 0;
    let unchangedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const row = rows[i];
      let docId = extractDocId(row);
      const rowLocale = extractLocale(row);
      const effectiveLocale = getEffectiveLocale(ct, rowLocale);

      // Handle singleType
      if (ct.kind === 'singleType' && !docId) {
        try {
          const findSingleArgs: any = {};
          if (effectiveLocale) findSingleArgs.locale = effectiveLocale;
          const singleDoc = await (strapi.documents(uid as any) as any).findFirst(findSingleArgs);
          if (singleDoc?.documentId) {
            docId = singleDoc.documentId;
          }
        } catch {}
      }

      // Check existing document
      let existing: any = null;
      if (docId) {
        existing = await findExistingDocument(strapi, uid, docId, effectiveLocale);
      }

      if (mode === 'update' && (!docId || !existing)) {
        skippedCount++;
        diffs.push({
          uid,
          collectionName: ct.info?.displayName || uid,
          documentId: docId || `(Row #${rowNumber})`,
          label: `Row #${rowNumber}`,
          attribute: '(record)',
          oldValue: null,
          newValue: null,
          oldDisplay: '—',
          newDisplay: '—',
          hasChange: false,
          status: 'will_skip',
          action: 'skip',
          message: !docId ? 'Missing documentId in update mode' : `Document "${docId}" not found in database`,
        });
        continue;
      }

      const payload = parseRowToPayload(strapi, attrs, row);

      if (existing) {
        const resolvedDocId = existing.documentId || docId;
        const entryLabel = existing.title || existing.name || existing.slug || `Entry #${resolvedDocId}`;
        let rowHasChanges = false;
        const payloadKeys = Object.keys(payload);

        if (payloadKeys.length === 0) {
          unchangedCount++;
          diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: resolvedDocId,
            label: entryLabel,
            attribute: '(no fields)',
            oldValue: null,
            newValue: null,
            oldDisplay: '—',
            newDisplay: '—',
            hasChange: false,
            status: 'unchanged',
            action: 'update',
            message: 'No modified attributes in CSV row',
          });
        } else {
          for (const attrKey of payloadKeys) {
            const oldVal = (existing as any)?.[attrKey] ?? null;
            let newVal = payload[attrKey];
            if (attrs[attrKey]?.type === 'component' && typeof newVal === 'object' && newVal !== null) {
              newVal = deepMergeComponent((existing as any)[attrKey], newVal);
            }

            const oldDisplay = formatValueDisplay(oldVal);
            const newDisplay = formatValueDisplay(newVal);
            const hasChange = String(oldVal ?? '') !== String(newVal ?? '');

            if (hasChange) {
              rowHasChanges = true;
            }

            diffs.push({
              uid,
              collectionName: ct.info?.displayName || uid,
              documentId: resolvedDocId,
              label: entryLabel,
              attribute: attrKey,
              oldValue: oldVal,
              newValue: newVal,
              oldDisplay,
              newDisplay,
              hasChange,
              status: hasChange ? 'will_update' : 'unchanged',
              action: 'update',
              message: hasChange ? `Will update "${attrKey}" from CSV` : `Already matches CSV value`,
            });
          }

          if (rowHasChanges) {
            willUpdateCount++;
          } else {
            unchangedCount++;
          }
        }
      } else {
        // New record to create
        willCreateCount++;
        const resolvedDocId = docId || `(Auto-generated)`;
        const entryLabel = payload.title || payload.name || payload.slug || `New Entry (Row #${rowNumber})`;
        const payloadKeys = Object.keys(payload);

        if (payloadKeys.length === 0) {
          diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: resolvedDocId,
            label: entryLabel,
            attribute: '(all fields)',
            oldValue: null,
            newValue: null,
            oldDisplay: '(new entry)',
            newDisplay: '(empty record)',
            hasChange: true,
            status: 'will_create',
            action: 'create',
            message: 'Will create new record',
          });
        } else {
          for (const attrKey of payloadKeys) {
            const newVal = payload[attrKey];
            diffs.push({
              uid,
              collectionName: ct.info?.displayName || uid,
              documentId: resolvedDocId,
              label: entryLabel,
              attribute: attrKey,
              oldValue: null,
              newValue: newVal,
              oldDisplay: '(new entry)',
              newDisplay: formatValueDisplay(newVal),
              hasChange: true,
              status: 'will_create',
              action: 'create',
              message: `Will create new record with attribute "${attrKey}"`,
            });
          }
        }
      }
    }

    return {
      success: true,
      summary: {
        total: rows.length,
        willUpdate: willUpdateCount,
        willCreate: willCreateCount,
        unchanged: unchangedCount,
        skipped: skippedCount,
      },
      diffs,
    };
  },

  /**
   * Submits a CSV batch with Guardrails: Maker-Checker (4-Eyes), Execution Windows, Off-Peak Scheduling
   */
  async submitBatch(
    uid: string,
    rows: Array<Record<string, string>>,
    options: {
      executionMode?: 'immediate' | 'queue_offpeak' | 'maker_checker';
      makerNotes?: string;
      forceImmediate?: boolean;
      mode?: 'auto' | 'update' | 'create_or_override';
      publish?: boolean;
      publishStrategy?: 'safe' | 'all';
      unreviewedConsent?: boolean;
      unreviewedCount?: number;
      user?: any;
    } = {}
  ) {
    const ct = strapi.contentTypes[uid];
    if (!ct) {
      throw new Error(`Content type ${uid} not found`);
    }

    if (!rows || rows.length === 0) {
      throw new Error('No CSV records provided for batch submission.');
    }

    const {
      executionMode = 'immediate',
      makerNotes = '',
      forceImmediate = false,
      mode = 'auto',
      publish = true,
      publishStrategy = 'safe',
      unreviewedConsent = false,
      unreviewedCount = 0,
      user,
    } = options;

    const executionConfig = getExecutionWindowConfig(strapi);
    const { isBusinessHours, policyMessage } = checkBusinessHours(executionConfig);
    const collectionDisplayName = ct.info?.displayName || uid;

    // 1. Enterprise Maker-Checker Flow (4-Eyes Approval Principle)
    if (executionMode === 'maker_checker') {
      const batchId = `csv_batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const batch: PendingBatch = {
        id: batchId,
        createdAt: new Date().toISOString(),
        createdBy: user
          ? {
              id: user.id,
              email: user.email,
              firstname: user.firstname,
              lastname: user.lastname,
              username: user.username,
            }
          : { email: 'admin@system.local' },
        payload: {
          action: 'csv_import',
          uid,
          rows,
          options: {
            mode,
            publish,
            publishStrategy,
            unreviewedConsent,
            user,
          },
          attribute: `CSV Import: ${collectionDisplayName}`,
          value: `${rows.length} rows (${mode} mode)`,
          publishOnApproval: publish,
          publishStrategy,
          unreviewedConsent,
          unreviewedCount,
        },
        summary: {
          attribute: `CSV Import: ${collectionDisplayName}`,
          value: `${rows.length} rows (${mode} mode)`,
          totalTargets: rows.length,
          collectionBreakdown: { [collectionDisplayName]: rows.length },
          publishOnApproval: publish,
          publishStrategy,
          unreviewedConsent,
          unreviewedCount,
        },
        status: 'pending_approval',
        executionMode: 'maker_checker',
        makerNotes,
        publishStrategy,
        unreviewedConsent,
        unreviewedCount,
      };

      registerPendingBatch(batch, {
        id: batchId,
        createdAt: batch.createdAt,
        createdBy: batch.createdBy,
        status: 'pending_approval',
        executionMode: 'maker_checker',
        attribute: `CSV Import: ${collectionDisplayName}`,
        value: `${rows.length} rows (${mode} mode)`,
        totalTargets: rows.length,
        processedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        isLive: false,
        publishOnApproval: publish,
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
        message: 'CSV batch submitted for Checker authorization (4-Eyes Maker-Checker Workflow).',
        batch,
      };
    }

    // 2. Off-Peak Queued Batch
    if (executionMode === 'queue_offpeak') {
      const batchId = `csv_batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const batch: PendingBatch = {
        id: batchId,
        createdAt: new Date().toISOString(),
        createdBy: user
          ? {
              id: user.id,
              email: user.email,
              firstname: user.firstname,
              lastname: user.lastname,
              username: user.username,
            }
          : { email: 'admin@system.local' },
        payload: {
          action: 'csv_import',
          uid,
          rows,
          options: {
            mode,
            publish,
            publishStrategy,
            unreviewedConsent,
            user,
          },
          attribute: `CSV Import: ${collectionDisplayName}`,
          value: `${rows.length} rows (${mode} mode)`,
          publishOnApproval: publish,
          publishStrategy,
          unreviewedConsent,
          unreviewedCount,
        },
        summary: {
          attribute: `CSV Import: ${collectionDisplayName}`,
          value: `${rows.length} rows (${mode} mode)`,
          totalTargets: rows.length,
          collectionBreakdown: { [collectionDisplayName]: rows.length },
          publishOnApproval: publish,
          publishStrategy,
          unreviewedConsent,
          unreviewedCount,
        },
        status: 'queued_offpeak',
        executionMode: 'queue_offpeak',
        scheduledFor: executionConfig.offPeakStartTime,
        makerNotes,
        publishStrategy,
        unreviewedConsent,
        unreviewedCount,
      };

      registerPendingBatch(batch, {
        id: batchId,
        createdAt: batch.createdAt,
        createdBy: batch.createdBy,
        status: 'queued_offpeak',
        executionMode: 'queue_offpeak',
        scheduledFor: executionConfig.offPeakStartTime,
        attribute: `CSV Import: ${collectionDisplayName}`,
        value: `${rows.length} rows (${mode} mode)`,
        totalTargets: rows.length,
        processedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        isLive: false,
        publishOnApproval: publish,
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
        message: `CSV batch queued for server off-peak maintenance window (${executionConfig.offPeakStartTime}).`,
        batch,
      };
    }

    // 3. Peak Business Hours Restriction Active (Auto-Queue)
    if (executionConfig.enabled && executionConfig.autoQueueDuringBusinessHours && isBusinessHours && !forceImmediate) {
      const batchId = `csv_batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const batch: PendingBatch = {
        id: batchId,
        createdAt: new Date().toISOString(),
        createdBy: user
          ? {
              id: user.id,
              email: user.email,
              firstname: user.firstname,
              lastname: user.lastname,
              username: user.username,
            }
          : { email: 'admin@system.local' },
        payload: {
          action: 'csv_import',
          uid,
          rows,
          options: {
            mode,
            publish,
            publishStrategy,
            unreviewedConsent,
            user,
          },
          attribute: `CSV Import: ${collectionDisplayName}`,
          value: `${rows.length} rows (${mode} mode)`,
          publishOnApproval: publish,
          publishStrategy,
          unreviewedConsent,
          unreviewedCount,
        },
        summary: {
          attribute: `CSV Import: ${collectionDisplayName}`,
          value: `${rows.length} rows (${mode} mode)`,
          totalTargets: rows.length,
          collectionBreakdown: { [collectionDisplayName]: rows.length },
          publishOnApproval: publish,
          publishStrategy,
          unreviewedConsent,
          unreviewedCount,
        },
        status: 'queued_offpeak',
        executionMode: 'queue_offpeak',
        scheduledFor: executionConfig.offPeakStartTime,
        makerNotes: 'Automatically queued due to peak business hours restriction.',
        publishStrategy,
        unreviewedConsent,
        unreviewedCount,
      };

      registerPendingBatch(batch, {
        id: batchId,
        createdAt: batch.createdAt,
        createdBy: batch.createdBy,
        status: 'queued_offpeak',
        executionMode: 'queue_offpeak',
        scheduledFor: executionConfig.offPeakStartTime,
        attribute: `CSV Import: ${collectionDisplayName}`,
        value: `${rows.length} rows (${mode} mode)`,
        totalTargets: rows.length,
        processedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        isLive: false,
        publishOnApproval: publish,
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

    // 4. Immediate execution allowed: Signal frontend to proceed with chunked execution
    return {
      success: true,
      pending: false,
      executeNow: true,
    };
  },
});
