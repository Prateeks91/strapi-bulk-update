import type { Core } from '@strapi/strapi';
import { DiscoveredSchema, DiscoveredField, discoverSchema } from './schema-discovery';

export const METADATA_COLUMN_KEY = '__bulk_updater_metadata';
export const CURRENT_SCHEMA_VERSION = 1;

export interface BulkUpdaterMetadata {
  schemaVersion: number;
  contentType: string;
  documentId: string;
  locale?: string;
  exportedAt: string;
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
  documents: any[]
): {
  csvContent: string;
  headers: string[];
  count: number;
} {
  const schema = discoverSchema(strapi, uid);

  // Headers start with metadata column, followed by documentId, locale (if localized), and discovered fields
  const headers = [METADATA_COLUMN_KEY, ...schema.allExportKeys];

  const lines: string[] = [];
  lines.push(headers.map(escapeCsvCell).join(','));

  const exportedAt = new Date().toISOString();

  for (const doc of documents) {
    const rowValues: string[] = [];

    // 1. Metadata column
    const metadata: BulkUpdaterMetadata = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      contentType: uid,
      documentId: String(doc.documentId || doc.id || ''),
      locale: doc.locale || undefined,
      exportedAt,
    };
    rowValues.push(escapeCsvCell(metadata));

    // 2. Discovered fields
    for (const key of schema.allExportKeys) {
      if (key === 'documentId') {
        rowValues.push(escapeCsvCell(doc.documentId || doc.id || ''));
      } else if (key === 'locale') {
        rowValues.push(escapeCsvCell(doc.locale || ''));
      } else {
        const field = schema.fields[key];
        const rawValue = doc[key];
        if (field) {
          const serialized = serializeFieldValue(rawValue, field);
          rowValues.push(escapeCsvCell(serialized));
        } else {
          rowValues.push(escapeCsvCell(rawValue));
        }
      }
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
