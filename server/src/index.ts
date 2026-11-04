import routes from './routes';
import contentTypes from './content-types';
import bulkUpdaterController from './controllers/bulk-updater';
import auditController from './controllers/audit';
import validationRulesController from './controllers/validation-rules';
import csvController from './controllers/csv';
import bulkUpdaterService, { buildDeepPopulate } from './services/bulk-updater';
import auditService from './services/audit';
import validationRulesService, { extractHeadingsFromRichText, matchesPath, cleanKey, validateEntityQuotas, deepMergeEntities } from './services/validation-rules';
import csvService from './services/csv';
import contentHistoryService, { recordContentHistoryVersion } from './services/content-history';

import { errors } from '@strapi/utils';

function createValidationError(ruleName: string, detailMsg: string, targetField: string) {
  const fullMessage = `Validation Error (${ruleName}): ${detailMsg}`;
  const ApplicationErrorClass: any = (errors as any)?.ApplicationError || Error;

  const err = new ApplicationErrorClass(fullMessage);
  err.name = 'ApplicationError';
  err.status = 400;
  (err as any).isQuotaViolation = true;
  (err as any).targetField = targetField;
  (err as any).details = {};
  return err;
}

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
    // Intercept quota validation errors to return HTTP 400 ApplicationError so Strapi's admin UI displays specific danger banner
    strapi.server.use(async (ctx: any, next: any) => {
      try {
        await next();
      } catch (err: any) {
        const isQuotaErr =
          err?.isQuotaViolation ||
          err?.name === 'ApplicationError' ||
          err?.name === 'ValidationError' ||
          (typeof err?.message === 'string' &&
            (err.message.startsWith('Validation Error') || err.message.includes('cannot appear more than')));

        if (isQuotaErr) {
          ctx.status = 400;
          ctx.body = {
            data: null,
            error: {
              status: 400,
              name: 'ApplicationError',
              message: err.message,
              details: {},
            },
          };
          return;
        }
        throw err;
      }
    });

    // Register Document Service middleware to enforce validation & cross-component quotas on the backend
    strapi.documents.use(async (context: any, next: any) => {
      const params = context.params as any;
      if (['create', 'update'].includes(context.action)) {
        const data = params?.data;

        if (data && typeof data === 'object') {
          let fullEntity = data;

          if (context.action === 'update' && (params?.documentId || params?.where?.documentId)) {
            const docId = params?.documentId || params?.where?.documentId;
            if (context.uid && docId) {
              try {
                const ct = strapi.contentTypes[context.uid];
                const populateDef = ct?.attributes ? buildDeepPopulate(ct.attributes, strapi.components) : undefined;
                const existing = await strapi.documents(context.uid).findOne({
                  documentId: docId,
                  ...(params?.locale ? { locale: params.locale } : {}),
                  ...(populateDef ? { populate: populateDef } : { populate: '*' }),
                });
                if (existing) {
                  fullEntity = deepMergeEntities(existing, data);
                }
              } catch {
                // If lookup fails, scan incoming payload
              }
            }
          }

          const valResult = await validateEntityQuotas(strapi, context.uid, fullEntity);
          if (!valResult.isValid) {
            throw createValidationError(valResult.ruleName!, valResult.errorMessage!, valResult.targetField!);
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
