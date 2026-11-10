/**
 * Robust RFC-4180 compliant CSV parser for Strapi Bulk Updater.
 *
 * Guarantees correct parsing for:
 * 1. Multiline strings & HTML content with embedded line breaks (\n, \r\n, \r) inside quotes.
 * 2. Commas embedded inside double-quoted cells without shifting subsequent columns.
 * 3. Escaped double quotes ("" -> ").
 * 4. Leading/trailing whitespace outside quotes.
 * 5. UTF-8 Byte Order Mark (BOM).
 * 6. Excel formula injection unescaping ('=, '+, '-, '@).
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
        // If cell was already quoted and closed, ignore trailing whitespace between closing quote and comma
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

export function parseCsvWithHeaders(csvText: string): {
  headers: string[];
  records: Array<Record<string, string>>;
} {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim());
  if (rows.length < 2) return { headers, records: [] };

  const records: Array<Record<string, string>> = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      let val = row[idx] !== undefined ? row[idx] : '';
      // Unescape leading single quote if added for Excel formula safety ('=, '+, '-, '@)
      if (typeof val === 'string' && /^'[=+@-]/.test(val)) {
        val = val.substring(1);
      }
      record[h] = val;
    });
    records.push(record);
  }

  return { headers, records };
}

export function parseCsv(csvText: string): Array<Record<string, string>> {
  return parseCsvWithHeaders(csvText).records;
}

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

  str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (/^[=+@-]/.test(str)) {
    str = `'${str}`;
  }

  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function sanitizeUserErrorMessage(msg: any): string {
  if (msg === null || msg === undefined) return 'Error processing row';
  const raw = typeof msg === 'string' ? msg : String(msg);
  const cleanedLines = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s+at\s+.+(\(.+\)|:\d+:\d+)\s*$/.test(line))
    .map((line) => line.trim())
    .filter(Boolean);
  return cleanedLines.join(' ').trim() || 'Error processing row';
}

export function resolveErrorColumnName(existingHeaders: string[]): string {
  const existingLower = new Set(
    existingHeaders.map((h) => String(h || '').trim().toLowerCase())
  );
  if (!existingLower.has('error')) return 'Error';
  if (!existingLower.has('import error')) return 'Import Error';
  let suffix = 2;
  while (existingLower.has(`import error (${suffix})`)) {
    suffix++;
  }
  return `Import Error (${suffix})`;
}

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

export interface FailedCsvRowEntry {
  row: number;
  documentId?: string;
  error: string;
  originalRow: Record<string, any>;
}

export function buildErrorCsv(options: {
  headers?: string[];
  failedRows: FailedCsvRowEntry[];
}): { csvContent: string; headers: string[]; errorColumnName: string; errorCount: number } {
  const { headers, failedRows } = options || {};
  if (!Array.isArray(failedRows) || failedRows.length === 0) {
    return {
      csvContent: '',
      headers: headers ? [...headers] : [],
      errorColumnName: 'Error',
      errorCount: 0,
    };
  }

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

  const metaRaw = row.__bulk_updater_metadata || row['__bulk_updater_metadata'];
  if (metaRaw) {
    try {
      const meta = typeof metaRaw === 'object' ? metaRaw : JSON.parse(metaRaw);
      if (meta?.documentId && isValidDocId(String(meta.documentId).trim())) {
        return String(meta.documentId).trim();
      }
    } catch {}
  }

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
