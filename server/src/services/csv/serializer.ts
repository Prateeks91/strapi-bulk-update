import type { Core } from '@strapi/strapi';
import { DiscoveredSchema, DiscoveredField, discoverSchema } from './schema-discovery';
import {
  FlattenedLeafType,
  buildExportColumnPlan,
  extractRowFlattenedMetadata,
  serializePlannedCell,
} from './object-flattening';

export const METADATA_COLUMN_KEY = '__bulk_updater_metadata';
export const CURRENT_SCHEMA_VERSION = 1;

export interface BulkUpdaterMetadata {
  schemaVersion: number;
  contentType: string;
  documentId: string;
  locale?: string;
  exportedAt: string;
  applicableFields?: string[];
  flatTypes?: Record<string, FlattenedLeafType>;
}

/**
 * Escapes a single cell value according to RFC-4180
 */
export function escapeCsvCell(val: any): string {
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

  // Excel CSV Formula Injection Mitigation
  if (/^[=+@-]/.test(str)) {
    str = `'${str}`;
  }

  // Quote cell if it contains delimiter, quotes, or newlines
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Robust RFC-4180 multiline CSV parser
 */
export function parseCsvToMatrix(csvText: string): string[][] {
  if (!csvText) return [];

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
          currentCell += '"';
          i++; // skip second quote
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += char;
      }
    } else {
      if (char === '"' && !cellIsQuoted && currentCell.trim() === '') {
        inQuotes = true;
        cellIsQuoted = true;
        currentCell = '';
      } else if (char === ',') {
        currentRow.push(cellIsQuoted ? currentCell : currentCell.trim());
        currentCell = '';
        cellIsQuoted = false;
      } else if (char === '\r') {
        if (nextChar === '\n') {
          i++;
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

/**
 * Parses raw CSV text into an array of header-keyed records
 */
export function parseCsvToRecords(csvText: string): Array<Record<string, string>> {
  const matrix = parseCsvToMatrix(csvText);
  if (matrix.length < 2) return [];

  const headers = matrix[0].map((h) => h.trim());
  const records: Array<Record<string, string>> = [];

  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i];
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

/**
 * Serializes a single document attribute losslessly
 */
export function serializeFieldValue(value: any, field: DiscoveredField): any {
  if (value === null || value === undefined) {
    return '';
  }

  switch (field.category) {
    case 'scalar': {
      if (value instanceof Date) {
        return value.toISOString();
      }
      return String(value);
    }

    case 'blocks':
    case 'json': {
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }

    case 'component_single': {
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }

    case 'component_repeatable': {
      // Repeatable component: preserve complete array of items
      if (Array.isArray(value)) {
        return JSON.stringify(value);
      }
      return typeof value === 'object' ? JSON.stringify([value]) : '';
    }

    case 'dynamiczone': {
      // Dynamic zone: preserve __component and full ordered structure
      if (Array.isArray(value)) {
        const cleaned = value.map((block) => {
          if (block && typeof block === 'object') {
            return { ...block };
          }
          return block;
        });
        return JSON.stringify(cleaned);
      }
      return '';
    }

    case 'relation_to_one': {
      if (typeof value === 'object' && value !== null) {
        const docId = value.documentId || value.id || '';
        return JSON.stringify({
          documentId: String(docId),
          title: value.title || value.name || value.slug || undefined,
        });
      }
      return String(value);
    }

    case 'relation_to_many': {
      if (Array.isArray(value)) {
        const list = value.map((item) => {
          if (typeof item === 'object' && item !== null) {
            const docId = item.documentId || item.id || '';
            return {
              documentId: String(docId),
              title: item.title || item.name || item.slug || undefined,
            };
          }
          return { documentId: String(item) };
        });
        return JSON.stringify(list);
      }
      return '';
    }

    case 'media_single': {
      if (typeof value === 'object' && value !== null) {
        return JSON.stringify({
          id: value.id,
          documentId: value.documentId,
          name: value.name,
          url: value.url,
          mime: value.mime,
        });
      }
      return String(value);
    }

    case 'media_to_many': {
      if (Array.isArray(value)) {
        const list = value.map((file) => {
          if (typeof file === 'object' && file !== null) {
            return {
              id: file.id,
              documentId: file.documentId,
              name: file.name,
              url: file.url,
              mime: file.mime,
            };
          }
          return file;
        });
        return JSON.stringify(list);
      }
      return '';
    }

    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/**
 * Serializes a collection of documents into a lossless CSV string
 */
export function serializeDocumentsToCsv(
  strapi: Core.Strapi,
  uid: string,
  documents: any[],
  options: { exportedAt?: string; schema?: DiscoveredSchema } = {}
): {
  csvContent: string;
  headers: string[];
  count: number;
} {
  const schema = options.schema || discoverSchema(strapi, uid);
  const plan = buildExportColumnPlan(strapi, uid, documents || [], schema);

  // Headers start with metadata column, followed by planned export columns (with object fields flattened)
  const headers = [METADATA_COLUMN_KEY, ...plan.headers];

  const lines: string[] = [];
  lines.push(headers.map(escapeCsvCell).join(','));

  const exportedAt = options.exportedAt || new Date().toISOString();

  for (const doc of documents) {
    const rowValues: string[] = [];
    const flattenedMeta = extractRowFlattenedMetadata(plan, doc);

    // 1. Metadata column
    const metadata: BulkUpdaterMetadata = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      contentType: uid,
      documentId: String(doc.documentId || doc.id || ''),
      locale: doc.locale || undefined,
      exportedAt,
      ...(flattenedMeta.applicableFields ? { applicableFields: flattenedMeta.applicableFields } : {}),
      ...(flattenedMeta.flatTypes ? { flatTypes: flattenedMeta.flatTypes } : {}),
    };
    rowValues.push(escapeCsvCell(metadata));

    // 2. Planned columns (scalars, flattened dotted objects/single components, repeatables, DZ, relations, media)
    for (const col of plan.columns) {
      const cellValue = serializePlannedCell(col, doc, serializeFieldValue);
      rowValues.push(escapeCsvCell(cellValue));
    }

    lines.push(rowValues.join(','));
  }

  // Prepend UTF-8 BOM and terminate lines with CRLF
  const csvContent = '\uFEFF' + lines.join('\r\n') + '\r\n';

  return {
    csvContent,
    headers,
    count: documents.length,
  };
}

/**
 * Parses and extracts metadata from a CSV row
 */
export function extractMetadataFromRow(row: Record<string, any>): BulkUpdaterMetadata | null {
  if (!row || typeof row !== 'object') return null;

  const rawMeta = row[METADATA_COLUMN_KEY] || row['__bulk_updater_metadata'];
  if (!rawMeta) return null;

  if (typeof rawMeta === 'object') {
    return rawMeta as BulkUpdaterMetadata;
  }

  if (typeof rawMeta === 'string') {
    try {
      const parsed = JSON.parse(rawMeta);
      if (parsed && typeof parsed === 'object') {
        return parsed as BulkUpdaterMetadata;
      }
    } catch {}
  }

  return null;
}

export interface FailedCsvRowRecord {
  row: number;
  documentId?: string;
  error: string;
  originalRow: Record<string, any>;
}

export interface ErrorCsvOutput {
  csvContent: string;
  headers: string[];
  errorColumnName: string;
  errorCount: number;
}

/**
 * Removes stack trace lines and unsafe internal details from error messages
 */
export function sanitizeUserErrorMessage(msg: any): string {
  if (msg === null || msg === undefined) return 'Error processing row';
  const raw = typeof msg === 'string' ? msg : String(msg);
  // Strip accidental Node stack frames ("    at fn (/path/...)")
  const cleanedLines = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s+at\s+.+(\(.+\)|:\d+:\d+)\s*$/.test(line))
    .map((line) => line.trim())
    .filter(Boolean);
  const result = cleanedLines.join(' ').trim();
  return result || 'Error processing row';
}

/**
 * Resolves a non-colliding Error column header name at the end of existing CSV headers
 */
export function resolveErrorColumnName(existingHeaders: string[]): string {
  const existingLower = new Set(
    existingHeaders.map((h) => String(h || '').trim().toLowerCase())
  );
  if (!existingLower.has('error')) {
    return 'Error';
  }
  if (!existingLower.has('import error')) {
    return 'Import Error';
  }
  let suffix = 2;
  while (existingLower.has(`import error (${suffix})`)) {
    suffix++;
  }
  return `Import Error (${suffix})`;
}

/**
 * Formats a safe timestamped filename: error_collectionType_YYYYMMDD_HHmmss.csv
 */
export function formatErrorCsvFilename(
  collectionTypeOrUid?: string,
  date: Date = new Date()
): string {
  const rawSegment = collectionTypeOrUid
    ? String(collectionTypeOrUid).split('.').pop() || String(collectionTypeOrUid)
    : 'collection';
  const safeType =
    rawSegment
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'collection';

  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `error_${safeType}_${stamp}.csv`;
}

/**
 * Generates an RFC-4180 compliant Error CSV containing only failed original rows
 * with their original columns preserved and an appended Error column.
 */
export function buildErrorCsv(options: {
  headers?: string[];
  failedRows: FailedCsvRowRecord[];
}): ErrorCsvOutput {
  const { headers, failedRows } = options || {};
  if (!Array.isArray(failedRows) || failedRows.length === 0) {
    return {
      csvContent: '',
      headers: headers ? [...headers] : [],
      errorColumnName: 'Error',
      errorCount: 0,
    };
  }

  // Deduplicate by row number, preserving multiple distinct messages per row cleanly
  const groupedByRow = new Map<
    number,
    { row: number; documentId?: string; messages: string[]; originalRow: Record<string, any> }
  >();

  for (const item of failedRows) {
    if (!item || typeof item !== 'object') continue;
    const rowNum = typeof item.row === 'number' && !isNaN(item.row) ? item.row : groupedByRow.size + 2;
    const msg = sanitizeUserErrorMessage(item.error);
    const existing = groupedByRow.get(rowNum);
    if (existing) {
      if (!existing.messages.includes(msg)) {
        existing.messages.push(msg);
      }
    } else {
      groupedByRow.set(rowNum, {
        row: rowNum,
        documentId: item.documentId,
        messages: [msg],
        originalRow: item.originalRow && typeof item.originalRow === 'object' ? item.originalRow : {},
      });
    }
  }

  const orderedEntries = Array.from(groupedByRow.values()).sort((a, b) => a.row - b.row);
  if (orderedEntries.length === 0) {
    return {
      csvContent: '',
      headers: headers ? [...headers] : [],
      errorColumnName: 'Error',
      errorCount: 0,
    };
  }

  // Preserve exact original header order or infer ordered keys from failed rows
  let baseHeaders: string[] = [];
  if (Array.isArray(headers) && headers.length > 0) {
    baseHeaders = [...headers];
  } else {
    const keySet = new Set<string>();
    for (const entry of orderedEntries) {
      for (const k of Object.keys(entry.originalRow || {})) {
        if (!keySet.has(k)) {
          keySet.add(k);
          baseHeaders.push(k);
        }
      }
    }
  }

  const errorColumnName = resolveErrorColumnName(baseHeaders);
  const finalHeaders = [...baseHeaders, errorColumnName];

  const lines: string[] = [];
  lines.push(finalHeaders.map(escapeCsvCell).join(','));

  for (const entry of orderedEntries) {
    const cells = baseHeaders.map((h) => {
      const val = entry.originalRow ? entry.originalRow[h] : '';
      return escapeCsvCell(val === undefined || val === null ? '' : val);
    });
    cells.push(escapeCsvCell(entry.messages.join('; ')));
    lines.push(cells.join(','));
  }

  const csvContent = '\uFEFF' + lines.join('\r\n') + '\r\n';
  return {
    csvContent,
    headers: finalHeaders,
    errorColumnName,
    errorCount: orderedEntries.length,
  };
}
