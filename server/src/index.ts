import routes from './routes';
import contentTypes from './content-types';
import bulkUpdaterController from './controllers/bulk-updater';
import auditController from './controllers/audit';
import validationRulesController from './controllers/validation-rules';
import csvController from './controllers/csv';
import bulkUpdaterService from './services/bulk-updater';
import auditService from './services/audit';
import validationRulesService, { extractHeadingsFromRichText, matchesPath, cleanKey } from './services/validation-rules';
import csvService from './services/csv';
import contentHistoryService, { recordContentHistoryVersion } from './services/content-history';

import { errors } from '@strapi/utils';

export default {
  register({ strapi }: { strapi: any }) {
    // Register the server definition for custom field plugin::bulk-updater.scoped-select
    strapi.customFields.register({
      name: 'scoped-select',
      plugin: 'bulk-updater',
      type: 'string',
    });
  },
  bootstrap({ strapi }: { strapi: any }) {
    // Register Document Service middleware to enforce cross-component quotas on the backend
    strapi.documents.use(async (context: any, next: any) => {
      const params = context.params as any;
      if (['create', 'update'].includes(context.action)) {
        const data = params?.data;

        if (data && typeof data === 'object') {
          // 1. Fetch active UI-configured validation rules from the plugin store
          let activeUiRules: any[] = [];
          try {
            const rulesService = strapi.plugin('bulk-updater').service('validationRules');
            if (rulesService) {
              const allRules = await rulesService.getRules();
              activeUiRules = allRules.filter((r: any) => r.enabled);
            }
          } catch (err) {
            strapi.log.warn('[bulk-updater] Failed to fetch active UI validation rules:', err);
          }

          // 2. Discover attributes from schemas as fallback if not in UI rules
          // Filter UI rules scoped to this collection type (or '*' for global, with flexible UID / name matching)
          const effectiveRules: Array<{
            id: string;
            name: string;
            collectionUid?: string;
            targetField: string;
            quotas: Record<string, number>;
            includeRichTextHtml?: boolean;
            richTextFields?: string[];
          }> = [
            ...activeUiRules
              .filter((r: any) => {
                if (!r.collectionUid || r.collectionUid === '*') return true;
                if (r.collectionUid === context.uid) return true;
                const cleanRuleCol = cleanKey(r.collectionUid);
                const cleanCtxCol = cleanKey(context.uid);
                return cleanCtxCol.includes(cleanRuleCol) || cleanRuleCol.includes(cleanCtxCol);
              })
              .map((r: any) => ({
                id: r.id || r.targetField,
                name: r.name || r.targetField,
                collectionUid: r.collectionUid || '*',
                targetField: r.targetField,
                quotas: r.quotas || {},
                includeRichTextHtml: Boolean(r.includeRichTextHtml),
                richTextFields: r.richTextFields || [],
              })),
          ];

          const allComponents = strapi.components || {};
          for (const comp of Object.values(allComponents) as any[]) {
            const attrs = comp.attributes || {};
            for (const [attrName, attrDef] of Object.entries(attrs) as any[]) {
              if (
                attrDef.type === 'customField' &&
                (attrDef.customField === 'plugin::bulk-updater.scoped-select' ||
                 attrDef.customField === 'global::scoped-select') &&
                !effectiveRules.some((r) => matchesPath(attrName, attrName, r.targetField))
              ) {
                const quotas = attrDef.options?.quotas || {};
                const items = attrDef.options?.items || [];
                const itemQuotas: Record<string, number> = {};

                for (const item of items) {
                  if (typeof item.maxAllowed === 'number' && item.maxAllowed > 0) {
                    itemQuotas[item.value] = item.maxAllowed;
                  }
                }

                effectiveRules.push({
                  id: `schema_${attrName}`,
                  name: `${attrName} quota rule`,
                  collectionUid: '*',
                  targetField: attrName,
                  quotas: {
                    h1: 1,
                    h2: 3,
                    ...itemQuotas,
                    ...quotas,
                  },
                  includeRichTextHtml: true,
                  richTextFields: [],
                });
              }
            }
          }

          const structuredCounts: Record<string, Record<string, number>> = {};
          const richTextCounts: Record<string, number> = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };

          function scanDataTree(obj: any, currentPath = '') {
            if (!obj || typeof obj !== 'object') return;
            const compName = typeof obj.__component === 'string' ? obj.__component : '';

            for (const key of Object.keys(obj)) {
              if (key === '__component') continue;
              const val = obj[key];
              const newPath = currentPath ? `${currentPath}.${key}` : key;
              const normalizedPath = newPath.replace(/\.\d+/g, '');

              const compPath = compName
                ? (currentPath ? `${currentPath}.${compName}.${key}` : `${compName}.${key}`).replace(/\.\d+/g, '')
                : '';

              // Check structured rules matching targetField (supports dot notation like st-featured.titleHeadingStyle.titleStyle or titleHeadingStyle.titleStyle)
              for (const rule of effectiveRules) {
                const isMatch = matchesPath(normalizedPath, key, rule.targetField) ||
                  (compPath ? matchesPath(compPath, key, rule.targetField) : false);

                if (isMatch && typeof val === 'string' && val.trim()) {
                  const lowerVal = val.toLowerCase().trim();
                  structuredCounts[rule.id] = structuredCounts[rule.id] || {};
                  structuredCounts[rule.id][lowerVal] = (structuredCounts[rule.id][lowerVal] || 0) + 1;
                }
              }

              // Check rich text HTML / Markdown / Blocks content
              if (typeof val === 'string' && (val.includes('<h') || val.includes('#'))) {
                const headings = extractHeadingsFromRichText(val);
                for (const [tag, count] of Object.entries(headings)) {
                  if (count > 0) {
                    richTextCounts[tag] = (richTextCounts[tag] || 0) + count;
                  }
                }
              } else if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0]?.type) {
                // Strapi Blocks array
                const headings = extractHeadingsFromRichText(val);
                for (const [tag, count] of Object.entries(headings)) {
                  if (count > 0) {
                    richTextCounts[tag] = (richTextCounts[tag] || 0) + count;
                  }
                }
                continue;
              }

              if (typeof val === 'object' && val !== null) {
                scanDataTree(val, newPath);
              }
            }
          }

          // If updating an existing document, merge incoming data with existing document
          // state so cross-component dynamic zone quotas are evaluated across the full tree
          let dataToScan = data;
          if (context.action === 'update' && (params?.documentId || params?.where?.documentId)) {
            const docId = params?.documentId || params?.where?.documentId;
            if (context.uid && docId) {
              try {
                const existing = await strapi.db?.query?.(context.uid)?.findOne?.({
                  where: { documentId: docId },
                  populate: true,
                });
                if (existing) {
                  dataToScan = { ...existing, ...data };
                }
              } catch {
                // If lookup fails, scan incoming payload
              }
            }
          }

          scanDataTree(dataToScan);

          // Validate collected counts against active quotas
          for (const rule of effectiveRules) {
            const ruleCounts = structuredCounts[rule.id] || {};

            for (const [quotaKey, maxAllowed] of Object.entries(rule.quotas || {})) {
              const lowerVal = quotaKey.toLowerCase().trim();
              const structCount = ruleCounts[lowerVal] || 0;
              const rtCount = rule.includeRichTextHtml ? (richTextCounts[lowerVal] || 0) : 0;
              const totalFound = structCount + rtCount;

              if (totalFound > (maxAllowed as number)) {
                let detailMsg = `Option "${quotaKey.toUpperCase()}" cannot appear more than ${maxAllowed} time(s) across this entry.`;
                if (rtCount > 0 && structCount > 0) {
                  detailMsg += ` Found ${totalFound} occurrences combined: ${structCount} in structured component ('${rule.targetField}') and ${rtCount} in rich text HTML / Markdown.`;
                } else if (rtCount > 0) {
                  detailMsg += ` Found ${totalFound} in rich text HTML / Markdown content.`;
                } else {
                  detailMsg += ` Found ${totalFound} in structured field '${rule.targetField}'.`;
                }
                throw new errors.ApplicationError(`Validation Error (${rule.name}): ${detailMsg}`);
              }
            }
          }
        }
      }

      const result = await next();
      return result;
    });

    // Register universal Content History fallback middleware so Content History
    // operates reliably across all Strapi tiers (Community Edition and Enterprise)
    strapi.server.use(async (ctx: any, next: any) => {
      if (!ctx.path.startsWith('/content-manager/history-versions')) {
        await next();
        return;
      }

      await next();

      if (ctx.status === 404 || ctx.status === 405) {
        if (ctx.method === 'GET' && ctx.path === '/content-manager/history-versions') {
          const { contentType, documentId, locale, page = 1, pageSize = 20 } = ctx.query;
          if (!contentType) return;
          const historyQuery = strapi.db?.query?.('plugin::content-manager.history-version');
          if (!historyQuery) return;

          const pageNum = Math.max(1, parseInt(page, 10) || 1);
          const limit = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));

          const whereClause: any = {
            contentType,
            ...(documentId ? { relatedDocumentId: documentId } : {}),
            ...(locale ? { locale } : {}),
          };

          const [results, total] = await Promise.all([
            historyQuery.findMany({
              where: whereClause,
              populate: ['createdBy'],
              orderBy: { createdAt: 'desc' },
              limit,
              offset: (pageNum - 1) * limit,
            }),
            historyQuery.count({ where: whereClause }),
          ]);

          const sanitizedResults = (results || []).map((ver: any) => ({
            ...ver,
            createdBy: ver.createdBy
              ? {
                  id: ver.createdBy.id,
                  firstname: ver.createdBy.firstname,
                  lastname: ver.createdBy.lastname,
                  username: ver.createdBy.username,
                  email: ver.createdBy.email,
                }
              : undefined,
            meta: {
              unknownAttributes: { added: {}, removed: {} },
            },
          }));

          ctx.status = 200;
          ctx.body = {
            data: sanitizedResults,
            meta: {
              pagination: {
                page: pageNum,
                pageSize: limit,
                pageCount: Math.ceil(total / limit) || 1,
                total,
              },
            },
          };
        } else if (ctx.method === 'PUT' && ctx.path.endsWith('/restore')) {
          const match = ctx.path.match(/\/content-manager\/history-versions\/([^/]+)\/restore/);
          const versionId = match?.[1];
          if (!versionId) return;

          const historyQuery = strapi.db?.query?.('plugin::content-manager.history-version');
          const version = await historyQuery?.findOne?.({ where: { id: versionId } });
          if (!version) {
            ctx.status = 404;
            ctx.body = { error: 'Version not found' };
            return;
          }

          const restored = await strapi.documents(version.contentType).update({
            documentId: version.relatedDocumentId,
            locale: version.locale || undefined,
            data: version.data,
          });

          await recordContentHistoryVersion(strapi, {
            uid: version.contentType,
            documentId: version.relatedDocumentId,
            statusOverride: version.status || 'published',
          });

          ctx.status = 200;
          ctx.body = {
            data: {
              documentId: restored?.documentId || version.relatedDocumentId,
            },
          };
        }
      }
    });

    // Ensure database performance and concurrency resiliency for Content History
    try {
      const knex = strapi.db?.connection;
      if (knex) {
        // Optimize SQLite busy timeout to eliminate lock contention
        if (knex.client?.config?.client === 'sqlite3' || knex.client?.dialect === 'sqlite3') {
          knex.raw('PRAGMA busy_timeout = 10000;').catch(() => {});
        }

        // Ensure index exists on strapi_history_versions for high-speed queries
        knex.schema.hasTable('strapi_history_versions').then((hasTable: boolean) => {
          if (hasTable) {
            knex.raw(`
              CREATE INDEX IF NOT EXISTS idx_history_versions_lookup 
              ON strapi_history_versions (content_type, related_document_id, created_at)
            `).catch(() => {});
          }
        }).catch(() => {});
      }
    } catch {}
  },
  routes,
  contentTypes,
  controllers: {
    bulkUpdater: bulkUpdaterController,
    audit: auditController,
    validationRules: validationRulesController,
    csv: csvController,
  },
  services: {
    bulkUpdater: bulkUpdaterService,
    audit: auditService,
    validationRules: validationRulesService,
    csv: csvService,
    contentHistory: contentHistoryService,
  },
};
