import type { Core } from '@strapi/strapi';

/**
 * Robust CSV string escaping helper
 */
function escapeCsvValue(val: any): string {
  if (val === null || val === undefined) return '';
  let str = '';
  if (typeof val === 'object') {
    str = JSON.stringify(val);
  } else {
    str = String(val);
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Basic CSV parser supporting quotes, commas, and newlines
 */
export function parseCsv(csvText: string): Array<Record<string, string>> {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      if (current.trim().length > 0) {
        lines.push(current);
      }
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) {
    lines.push(current);
  }

  if (lines.length < 1) return [];

  function splitLine(line: string): string[] {
    const fields: string[] = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const nc = line[i + 1];
      if (c === '"') {
        if (inQ && nc === '"') {
          field += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (c === ',' && !inQ) {
        fields.push(field);
        field = '';
      } else {
        field += c;
      }
    }
    fields.push(field);
    return fields.map((f) => f.trim());
  }

  const headers = splitLine(lines[0]);
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitLine(lines[i]);
    const rowObj: Record<string, string> = {};
    headers.forEach((h, index) => {
      rowObj[h] = values[index] !== undefined ? values[index] : '';
    });
    rows.push(rowObj);
  }

  return rows;
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

    const csvContent = `${headers.map(escapeCsvValue).join(',')}\n${sampleRow.map(escapeCsvValue).join(',')}\n`;
    return {
      filename: `${ct.info?.singularName || 'template'}_template.csv`,
      csvContent,
      headers,
    };
  },

  /**
   * Exports entries of a collection to CSV, with optional filters
   */
  async exportCollectionCsv(
    uid: string,
    options: {
      search?: string;
      attribute?: string;
      filterOperator?: string;
      filterQuery?: string;
      limit?: number;
    } = {}
  ) {
    const ct = strapi.contentTypes[uid];
    if (!ct) {
      throw new Error(`Content type ${uid} not found`);
    }

    const attrs = ct.attributes || {};
    const excluded = ['createdBy', 'updatedBy', 'localizations'];

    // Discover exportable scalar and component fields
    const exportFields: string[] = ['documentId'];
    const compFieldsToPopulate: string[] = [];
    for (const [attrName, attrDef] of Object.entries(attrs) as any[]) {
      if (excluded.includes(attrName)) continue;
      if (['dynamiczone', 'media', 'relation'].includes(attrDef.type)) continue;
      if (attrDef.type === 'component') {
        if (!attrDef.repeatable && attrDef.component) {
          const comp = strapi.components[attrDef.component];
          if (comp?.attributes) {
            compFieldsToPopulate.push(attrName);
            for (const [subKey, subDef] of Object.entries(comp.attributes) as any[]) {
              if (excluded.includes(subKey)) continue;
              if (['component', 'dynamiczone', 'media', 'relation'].includes(subDef.type)) continue;
              exportFields.push(`${attrName}.${subKey}`);
            }
          }
        }
        continue;
      }
      exportFields.push(attrName);
    }

    // Build database query filters
    const filters: Record<string, any> = {};
    const { attribute, filterOperator, filterQuery, search } = options;

    if (attribute && filterOperator && filterQuery !== undefined && filterQuery !== '') {
      switch (filterOperator) {
        case 'equals':
          filters[attribute] = { $eq: filterQuery };
          break;
        case 'notEquals':
          filters[attribute] = { $ne: filterQuery };
          break;
        case 'contains':
          filters[attribute] = { $containsi: filterQuery };
          break;
        case 'notContains':
          filters[attribute] = { $notContainsi: filterQuery };
          break;
        case 'startsWith':
          filters[attribute] = { $startsWith: filterQuery };
          break;
        case 'endsWith':
          filters[attribute] = { $endsWith: filterQuery };
          break;
      }
    }

    if (search && search.trim() !== '') {
      const q = search.trim();
      const searchConditions: any[] = [];
      const searchFields = ['name', 'title', 'email', 'slug', 'description'].filter(
        (f) => attrs[f] && ['string', 'text', 'email'].includes(attrs[f].type)
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

    const populateOption = compFieldsToPopulate.length > 0
      ? compFieldsToPopulate.reduce((acc, k) => ({ ...acc, [k]: true }), {})
      : undefined;

    const entries = await strapi.documents(uid as any).findMany({
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      limit: options.limit || 5000,
      sort: { createdAt: 'desc' },
      populate: populateOption,
    });

    const lines: string[] = [];
    lines.push(exportFields.map(escapeCsvValue).join(','));

    for (const entry of (entries || []) as any[]) {
      const rowValues = exportFields.map((field) => {
        let val: any;
        if (field.includes('.')) {
          const [parent, child] = field.split('.');
          val = entry[parent]?.[child];
        } else {
          val = entry[field];
        }
        return escapeCsvValue(val);
      });
      lines.push(rowValues.join(','));
    }

    const csvContent = lines.join('\n');
    const filename = `${ct.info?.singularName || uid}_export_${new Date().toISOString().slice(0, 10)}.csv`;

    return {
      filename,
      csvContent,
      count: entries ? entries.length : 0,
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
      csvContent: lines.join('\n'),
      count: scanReport.violations.length,
      ruleName: scanReport.rule.name,
    };
  },

  /**
   * Imports CSV records to update existing records or insert/override records
   */
  async importCsv(
    uid: string,
    csvText: string,
    options: {
      mode: 'update' | 'create_or_override';
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
    const { mode, publish = true, user } = options;

    const stats = {
      total: parsedRows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [] as Array<{ row: number; error: string; documentId?: string }>,
      diffs: [] as Array<any>,
    };

    const batchId = `csv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const userEmail = user?.email || 'admin@strapi.io';
    const userName = user ? `${user.firstname || ''} ${user.lastname || ''}`.trim() : 'CSV Importer';

    for (let i = 0; i < parsedRows.length; i++) {
      const rowNumber = i + 2; // Row 1 is header
      const row = parsedRows[i];

      const docId = (row.documentId || row.id || '').trim();
      const payload: Record<string, any> = {};

      // Transform and cast row columns to schema field types
      for (const [key, rawVal] of Object.entries(row)) {
        if (key === 'documentId' || key === 'id') continue;

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
                val = parseInt(rawVal, 10);
              } else if (childDef.type === 'float' || childDef.type === 'decimal') {
                val = parseFloat(rawVal);
              } else if (childDef.type === 'boolean') {
                val = rawVal.toLowerCase() === 'true' || rawVal === '1';
              }
              payload[parent][child] = val;
            }
          }
          continue;
        }

        const attrDef = attrs[key];
        if (!attrDef) continue; // Skip unknown columns

        if (rawVal === '' || rawVal === null || rawVal === undefined) {
          payload[key] = null;
          continue;
        }

        switch (attrDef.type) {
          case 'integer':
          case 'biginteger':
            payload[key] = parseInt(rawVal, 10);
            break;
          case 'float':
          case 'decimal':
            payload[key] = parseFloat(rawVal);
            break;
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
              error: 'Missing documentId for Update mode.',
            });
            continue;
          }

          const existing = await strapi.documents(uid as any).findOne({
            documentId: docId,
          });

          if (!existing) {
            stats.skipped++;
            stats.errors.push({
              row: rowNumber,
              documentId: docId,
              error: `Document with documentId "${docId}" not found.`,
            });
            continue;
          }

          const mergedPayload = { ...payload };
          for (const key of Object.keys(payload)) {
            if (attrs[key]?.type === 'component' && typeof payload[key] === 'object' && payload[key] !== null) {
              mergedPayload[key] = { ...((existing as any)[key] || {}), ...payload[key] };
            }
          }

          await strapi.documents(uid as any).update({
            documentId: docId,
            data: mergedPayload,
          });

          if (publish && ct.options?.draftAndPublish) {
            try {
              await (strapi.documents(uid as any) as any).publish({ documentId: docId });
            } catch (pubErr) {
              strapi.log.warn(`[bulk-updater] Auto-publish failed for ${docId}:`, pubErr);
            }
          }

          stats.updated++;
          stats.diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: docId,
            label: (existing as any).title || (existing as any).name || `Entry #${docId}`,
            attribute: Object.keys(payload).join(', '),
            oldValue: existing,
            newValue: payload,
            status: 'updated',
            message: `Updated via CSV import (row ${rowNumber})`,
          });
        } else {
          // mode === 'create_or_override'
          if (docId) {
            const existing = await strapi.documents(uid as any).findOne({
              documentId: docId,
            });

            if (existing) {
              const mergedPayload = { ...payload };
              for (const key of Object.keys(payload)) {
                if (attrs[key]?.type === 'component' && typeof payload[key] === 'object' && payload[key] !== null) {
                  mergedPayload[key] = { ...((existing as any)[key] || {}), ...payload[key] };
                }
              }

              await strapi.documents(uid as any).update({
                documentId: docId,
                data: mergedPayload,
              });

              if (publish && ct.options?.draftAndPublish) {
                try {
                  await (strapi.documents(uid as any) as any).publish({ documentId: docId });
                } catch (pubErr) {
                  strapi.log.warn(`[bulk-updater] Auto-publish failed for ${docId}:`, pubErr);
                }
              }

              stats.updated++;
              stats.diffs.push({
                uid,
                collectionName: ct.info?.displayName || uid,
                documentId: docId,
                label: (existing as any).title || (existing as any).name || `Entry #${docId}`,
                attribute: Object.keys(payload).join(', '),
                oldValue: existing,
                newValue: payload,
                status: 'updated',
                message: `Overridden via CSV import (row ${rowNumber})`,
              });
              continue;
            }
          }

          const created: any = await strapi.documents(uid as any).create({
            data: payload,
          });

          const newDocId = created?.documentId || docId;
          if (publish && ct.options?.draftAndPublish && newDocId) {
            try {
              await (strapi.documents(uid as any) as any).publish({ documentId: newDocId });
            } catch (pubErr) {
              strapi.log.warn(`[bulk-updater] Auto-publish failed for ${newDocId}:`, pubErr);
            }
          }

          stats.created++;
          stats.diffs.push({
            uid,
            collectionName: ct.info?.displayName || uid,
            documentId: newDocId,
            label: created?.title || created?.name || `New Entry #${newDocId}`,
            attribute: Object.keys(payload).join(', '),
            oldValue: null,
            newValue: payload,
            status: 'updated',
            message: `Created via CSV import (row ${rowNumber})`,
          });
        }
      } catch (err: any) {
        stats.errors.push({
          row: rowNumber,
          documentId: docId || undefined,
          error: err.message || 'Error processing row',
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
        if (auditService && auditService.isAuditEnabled()) {
          await auditService.logOperation({
            batchId,
            attribute: 'CSV_IMPORT',
            value: `Mode: ${mode} (${stats.created} created, ${stats.updated} updated)`,
            userEmail,
            userName,
            updatedCount: stats.updated + stats.created,
            skippedCount: stats.skipped,
            totalTargets: stats.total,
            diffs: stats.diffs,
          });
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
