import type { Core } from '@strapi/strapi';
import { recordContentHistoryVersion } from './content-history';

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
  const candidates = [row.locale, row.Locale, row['locale'], row['Locale']];
  for (const c of candidates) {
    if (c !== undefined && c !== null) {
      const str = String(c).trim();
      if (str && str.toLowerCase() !== 'null' && str.toLowerCase() !== 'undefined') {
        return str;
      }
    }
  }
  return undefined;
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

    current = current[part];
  }

  if (current === null || current === undefined) return '';

  // If Media object
  if (typeof current === 'object' && current.url) {
    return current.url;
  }

  // If Relation object
  if (typeof current === 'object' && !Array.isArray(current)) {
    if (current.documentId || current.name || current.title) {
      return current.name || current.title || current.documentId;
    }
  }

  // If array of objects (e.g. relations or components)
  if (Array.isArray(current)) {
    return current
      .map((item) => {
        if (!item) return '';
        if (typeof item === 'object') {
          return item.name || item.title || item.documentId || JSON.stringify(item);
        }
        return String(item);
      })
      .filter(Boolean)
      .join('; ');
  }

  return current;
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

    // 4. Retrieve entries (handling singleType vs collectionType)
    let entries: any[] = [];
    if (ct.kind === 'singleType') {
      const findFirstArgs: any = {};
      if (deepPopulate) {
        findFirstArgs.populate = deepPopulate;
      }
      const doc = await (strapi.documents(uid as any) as any).findFirst(findFirstArgs);
      entries = doc ? [doc] : [];
    } else {
      const findManyArgs: any = {
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        limit: options.limit || 5000,
        sort: { createdAt: 'desc' },
      };
      if (deepPopulate) {
        findManyArgs.populate = deepPopulate;
      }
      entries = await (strapi.documents(uid as any) as any).findMany(findManyArgs);
    }

    // 5. Generate RFC-4180 CRLF rows with UTF-8 BOM
    const lines: string[] = [];
    // Header line using field keys
    lines.push(fields.map((f) => escapeCsvValue(f.key)).join(','));

    for (const entry of (entries || []) as any[]) {
      const rowValues = fields.map((f) => {
        const val = getNestedExportValue(entry, f.key);
        return escapeCsvValue(val);
      });
      lines.push(rowValues.join(','));
    }

    // Prepend UTF-8 BOM and terminate lines with CRLF for seamless Excel import
    const csvContent = '\uFEFF' + lines.join('\r\n') + '\r\n';
    const filename = `${ct.info?.singularName || uid}_export_${new Date().toISOString().slice(0, 10)}.csv`;

    return {
      filename,
      csvContent,
      count: entries ? entries.length : 0,
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
      return await this.exportCollectionCsv(uid, { documentIds: byUid[uid] });
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
   * Imports CSV records to update existing records or insert/override records
   */
  async importCsv(
    uid: string,
    csvText: string,
    options: {
      mode?: 'auto' | 'update' | 'create_or_override';
      publish?: boolean;
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

    const attrs = ct.attributes || {};
    const { mode = 'auto', publish = true, user } = options;

    const stats = {
      total: parsedRows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      newWithoutDocId: 0,
      errors: [] as Array<{ row: number; error: string; documentId?: string }>,
      diffs: [] as Array<any>,
    };

    const batchId = `csv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const userEmail = user?.email || 'admin@strapi.io';
    const userName = user ? `${user.firstname || ''} ${user.lastname || ''}`.trim() : 'CSV Importer';

    const findExistingDocument = async (targetDocId: string, docLocale?: string): Promise<any> => {
      if (!targetDocId) return null;
      try {
        const queryArgs: any = { documentId: targetDocId };
        if (docLocale) queryArgs.locale = docLocale;
        const found = await (strapi.documents(uid as any) as any).findOne(queryArgs);
        if (found) return found;
      } catch {
        // Strapi 5 throws NotFoundError if documentId does not exist
      }

      if (/^\d+$/.test(targetDocId)) {
        try {
          const queryArgs: any = {
            filters: { id: parseInt(targetDocId, 10) },
            limit: 1,
          };
          if (docLocale) queryArgs.locale = docLocale;
          const list = await (strapi.documents(uid as any) as any).findMany(queryArgs);
          if (list && list.length > 0) return list[0];
        } catch {
          // Ignore
        }
      }

      return null;
    };

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
    ]);

    for (let i = 0; i < parsedRows.length; i++) {
      const rowNumber = i + 2; // Row 1 is header
      const row = parsedRows[i];

      let docId = extractDocId(row);
      const rowLocale = extractLocale(row);

      // If singleType and no documentId provided in row, auto-detect existing single document
      if (ct.kind === 'singleType' && !docId) {
        try {
          const findSingleArgs: any = {};
          if (rowLocale) findSingleArgs.locale = rowLocale;
          const singleDoc = await (strapi.documents(uid as any) as any).findFirst(findSingleArgs);
          if (singleDoc?.documentId) {
            docId = singleDoc.documentId;
          }
        } catch {}
      }

      const payload: Record<string, any> = {};

      // Transform and cast row columns to schema field types
      for (const [key, rawVal] of Object.entries(row)) {
        const normalizedKey = key.toLowerCase().replace(/[\s_-]/g, '');
        if (SYSTEM_FIELD_KEYS.has(normalizedKey)) continue;

        if (key.includes('.')) {
          const [parent, child] = key.split('.');
          const parentDef = attrs[parent];
          if (parentDef?.type === 'component' && !parentDef.repeatable && parentDef.component) {
            const comp = strapi.components[parentDef.component];
            const childDef = comp?.attributes?.[child];
            if (childDef) {
              if (!payload[parent]) payload[parent] = {};
              let val: any = rawVal;
              if (rawVal === '' || rawVal === null || rawVal === undefined) {
                val = null;
              } else if (childDef.type === 'integer' || childDef.type === 'biginteger') {
                const parsedInt = parseInt(rawVal, 10);
                val = isNaN(parsedInt) ? null : parsedInt;
              } else if (childDef.type === 'float' || childDef.type === 'decimal') {
                const parsedFloat = parseFloat(rawVal);
                val = isNaN(parsedFloat) ? null : parsedFloat;
              } else if (childDef.type === 'boolean') {
                val = rawVal.toLowerCase() === 'true' || rawVal === '1';
              } else if (childDef.type === 'json') {
                try {
                  val = JSON.parse(rawVal);
                } catch {
                  val = rawVal;
                }
              }
              payload[parent][child] = val;
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

        if (rawVal === '' || rawVal === null || rawVal === undefined) {
          // Do not overwrite dynamiczone or repeatable component with null unless explicitly desired
          if (attrDef.type !== 'dynamiczone' && !(attrDef.type === 'component' && attrDef.repeatable)) {
            payload[key] = null;
          }
          continue;
        }

        switch (attrDef.type) {
          case 'integer':
          case 'biginteger': {
            const parsedInt = parseInt(rawVal, 10);
            payload[key] = isNaN(parsedInt) ? null : parsedInt;
            break;
          }
          case 'float':
          case 'decimal': {
            const parsedFloat = parseFloat(rawVal);
            payload[key] = isNaN(parsedFloat) ? null : parsedFloat;
            break;
          }
          case 'boolean':
            payload[key] = rawVal.toLowerCase() === 'true' || rawVal === '1';
            break;
          case 'json':
            try {
              payload[key] = JSON.parse(rawVal);
            } catch {
              payload[key] = rawVal;
            }
            break;
          case 'dynamiczone': {
            // Dynamic zones in Strapi 5 must be an array of component objects with __component
            try {
              const parsed = JSON.parse(rawVal);
              if (
                Array.isArray(parsed) &&
                parsed.every((item) => item && typeof item === 'object' && typeof item.__component === 'string')
              ) {
                payload[key] = parsed;
              }
            } catch {
              // Summary text or unparseable format from export: omit to avoid schema validation errors
            }
            break;
          }
          case 'component': {
            if (attrDef.repeatable) {
              try {
                const parsed = JSON.parse(rawVal);
                if (Array.isArray(parsed) && parsed.every((item) => item && typeof item === 'object')) {
                  payload[key] = parsed;
                }
              } catch {
                // Summary text: omit to preserve existing repeatable components
              }
            } else {
              try {
                const parsed = JSON.parse(rawVal);
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                  payload[key] = parsed;
                }
              } catch {
                // Summary text: omit
              }
            }
            break;
          }
          case 'relation': {
            try {
              const parsed = JSON.parse(rawVal);
              if (Array.isArray(parsed) || (typeof parsed === 'object' && parsed !== null)) {
                payload[key] = parsed;
                break;
              }
            } catch {}

            if (isValidDocId(rawVal)) {
              payload[key] = rawVal;
            } else if (rawVal.includes(';') || rawVal.includes(',')) {
              const parts = rawVal.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
              if (parts.length > 0 && parts.every((p) => isValidDocId(p))) {
                payload[key] = parts;
              }
            }
            break;
          }
          case 'media': {
            if (/^\d+$/.test(rawVal.trim())) {
              payload[key] = parseInt(rawVal.trim(), 10);
            } else {
              try {
                const parsed = JSON.parse(rawVal);
                if (typeof parsed === 'number' || typeof parsed === 'object') {
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

          const existing = await findExistingDocument(docId, rowLocale);

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
              mergedPayload[key] = { ...((existing as any)[key] || {}), ...payload[key] };
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
          if (rowLocale) updateArgs.locale = rowLocale;

          await (strapi.documents(uid as any) as any).update(updateArgs);

          if (publish && ct.options?.draftAndPublish) {
            try {
              const pubArgs: any = { documentId: resolvedDocId };
              if (rowLocale) pubArgs.locale = rowLocale;
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
              statusOverride: publish && ct.options?.draftAndPublish ? 'published' : undefined,
            });
          } catch {}

          stats.updated++;
          stats.diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: resolvedDocId,
            label: (existing as any).title || (existing as any).name || `Entry #${resolvedDocId}`,
            attribute: Object.keys(payload).join(', '),
            oldValue: existing,
            newValue: payload,
            status: 'updated',
            message: `Updated via CSV import (row ${rowNumber})`,
          });
        } else if (mode === 'create_or_override') {
          let existing: any = null;
          if (docId) {
            existing = await findExistingDocument(docId, rowLocale);
          }

          if (existing) {
            const resolvedDocId = existing.documentId || docId;
            const mergedPayload = { ...payload };
            for (const key of Object.keys(payload)) {
              if (attrs[key]?.type === 'component' && typeof payload[key] === 'object' && payload[key] !== null) {
                mergedPayload[key] = { ...((existing as any)[key] || {}), ...payload[key] };
              }
            }

            const updateArgs: any = {
              documentId: resolvedDocId,
              data: mergedPayload,
            };
            if (rowLocale) updateArgs.locale = rowLocale;

            await (strapi.documents(uid as any) as any).update(updateArgs);

            if (publish && ct.options?.draftAndPublish) {
              try {
                const pubArgs: any = { documentId: resolvedDocId };
                if (rowLocale) pubArgs.locale = rowLocale;
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
                statusOverride: publish && ct.options?.draftAndPublish ? 'published' : undefined,
              });
            } catch {}

            stats.updated++;
            stats.diffs.push({
              uid,
              collectionName: ct.info?.displayName || uid,
              documentId: resolvedDocId,
              label: (existing as any).title || (existing as any).name || `Entry #${resolvedDocId}`,
              attribute: Object.keys(payload).join(', '),
              oldValue: existing,
              newValue: payload,
              status: 'updated',
              message: `Overridden via CSV import (row ${rowNumber})`,
            });
            continue;
          }

          const createArgs: any = { data: payload };
          if (rowLocale) createArgs.locale = rowLocale;
          const created: any = await strapi.documents(uid as any).create(createArgs);

          const newDocId = created?.documentId || docId;
          if (publish && ct.options?.draftAndPublish && newDocId) {
            try {
              const pubArgs: any = { documentId: newDocId };
              if (rowLocale) pubArgs.locale = rowLocale;
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
              statusOverride: publish && ct.options?.draftAndPublish ? 'published' : undefined,
            });
          } catch {}

          stats.created++;
          if (!docId) {
            stats.newWithoutDocId++;
          }
          stats.diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: newDocId,
            label: created?.title || created?.name || `New Entry #${newDocId}`,
            attribute: Object.keys(payload).join(', '),
            oldValue: null,
            newValue: payload,
            status: 'updated',
            message: docId
              ? `Created via CSV import (row ${rowNumber})`
              : `Created as new entry (no documentId provided in CSV - row ${rowNumber})`,
          });
        } else {
          // Default: Smart Auto-Detect ('auto')
          let existing: any = null;
          if (docId) {
            existing = await findExistingDocument(docId, rowLocale);
          }

          if (existing) {
            const resolvedDocId = existing.documentId || docId;
            const mergedPayload = { ...payload };
            for (const key of Object.keys(payload)) {
              if (attrs[key]?.type === 'component' && typeof payload[key] === 'object' && payload[key] !== null) {
                mergedPayload[key] = { ...((existing as any)[key] || {}), ...payload[key] };
              }
            }

            const updateArgs: any = {
              documentId: resolvedDocId,
              data: mergedPayload,
            };
            if (rowLocale) updateArgs.locale = rowLocale;

            await (strapi.documents(uid as any) as any).update(updateArgs);

            if (publish && ct.options?.draftAndPublish) {
              try {
                const pubArgs: any = { documentId: resolvedDocId };
                if (rowLocale) pubArgs.locale = rowLocale;
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
                statusOverride: publish && ct.options?.draftAndPublish ? 'published' : undefined,
              });
            } catch {}

            stats.updated++;
            stats.diffs.push({
              uid,
              collectionName: ct.info?.displayName || uid,
              documentId: resolvedDocId,
              label: (existing as any).title || (existing as any).name || `Entry #${resolvedDocId}`,
              attribute: Object.keys(payload).join(', '),
              oldValue: existing,
              newValue: payload,
              status: 'updated',
              message: `Updated existing entry via smart match (row ${rowNumber})`,
            });
            continue;
          }

          // Missing docId OR provided docId does not exist in DB -> create new
          const createArgs: any = { data: payload };
          if (rowLocale) createArgs.locale = rowLocale;
          const created: any = await strapi.documents(uid as any).create(createArgs);

          const newDocId = created?.documentId || docId;
          if (publish && ct.options?.draftAndPublish && newDocId) {
            try {
              const pubArgs: any = { documentId: newDocId };
              if (rowLocale) pubArgs.locale = rowLocale;
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
              statusOverride: publish && ct.options?.draftAndPublish ? 'published' : undefined,
            });
          } catch {}

          stats.created++;
          if (!docId) {
            stats.newWithoutDocId++;
          }
          stats.diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: newDocId,
            label: created?.title || created?.name || `New Entry #${newDocId}`,
            attribute: Object.keys(payload).join(', '),
            oldValue: null,
            newValue: payload,
            status: 'updated',
            message: docId
              ? `Created as new entry (documentId "${docId}" not found in database - row ${rowNumber})`
              : `Created as new entry (no documentId provided in CSV - row ${rowNumber})`,
          });
        }
      } catch (err: any) {
        stats.errors.push({
          row: rowNumber,
          documentId: docId || undefined,
          error: extractDetailedErrorMessage(err),
        });
      }
    }

    try {
      const bulkService = strapi.plugin('bulk-updater').service('bulkUpdater');
      if (bulkService && (bulkService as any).invalidateCollectionCache) {
        (bulkService as any).invalidateCollectionCache(uid);
      }
    } catch {
      // Ignore
    }

    if (stats.updated > 0 || stats.created > 0) {
      try {
        const auditService = strapi.plugin('bulk-updater').service('audit');
        if (auditService) {
          const isEnabled = typeof auditService.isAuditEnabled === 'function'
            ? auditService.isAuditEnabled()
            : Boolean(auditService.getAuditConfig?.().enabled ?? true);

          if (isEnabled) {
            const batchSummary = {
              batchId,
              attribute: 'CSV_IMPORT',
              value: `Mode: ${mode} (${stats.created} created, ${stats.updated} updated)`,
              updatedCount: stats.updated + stats.created,
              skippedCount: stats.skipped,
              totalTargets: stats.total,
            };

            const userObj = {
              email: userEmail || 'admin@strapi.io',
              firstname: userName || 'Admin',
            };

            if (typeof auditService.recordBatch === 'function') {
              await auditService.recordBatch(batchSummary, stats.diffs, userObj);
            } else if (typeof auditService.logOperation === 'function') {
              await auditService.logOperation({
                ...batchSummary,
                userEmail,
                userName,
                diffs: stats.diffs,
              });
            }
          }
        }
      } catch (auditErr) {
        strapi.log.warn('[bulk-updater] Failed logging CSV import audit:', auditErr);
      }
    }

    return {
      success: true,
      batchId,
      stats,
    };
  },
});
