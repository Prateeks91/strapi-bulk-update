import routes from './routes';
import contentTypes from './content-types';
import bulkUpdaterController from './controllers/bulk-updater';
import auditController from './controllers/audit';
import validationRulesController from './controllers/validation-rules';
import csvController from './controllers/csv';
import bulkUpdaterService from './services/bulk-updater';
import auditService from './services/audit';
import validationRulesService from './services/validation-rules';
import csvService from './services/csv';

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
      if (['create', 'update'].includes(context.action)) {
        const params = context.params as any;
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

          // Build fieldQuotas map from UI rules
          const fieldQuotas: Record<string, { quotas: Record<string, number>; ruleName: string }> = {};

          for (const rule of activeUiRules) {
            if (rule.targetField && rule.quotas) {
              fieldQuotas[rule.targetField] = {
                quotas: rule.quotas,
                ruleName: rule.name,
              };
            }
          }

          // 2. Discover attributes from schemas as fallback if not in UI rules
          const allComponents = strapi.components || {};
          for (const comp of Object.values(allComponents) as any[]) {
            const attrs = comp.attributes || {};
            for (const [attrName, attrDef] of Object.entries(attrs) as any[]) {
              if (
                attrDef.type === 'customField' &&
                (attrDef.customField === 'plugin::bulk-updater.scoped-select' ||
                 attrDef.customField === 'global::scoped-select') &&
                !fieldQuotas[attrName]
              ) {
                const quotas = attrDef.options?.quotas || {};
                const items = attrDef.options?.items || [];
                const itemQuotas: Record<string, number> = {};

                for (const item of items) {
                  if (typeof item.maxAllowed === 'number' && item.maxAllowed > 0) {
                    itemQuotas[item.value] = item.maxAllowed;
                  }
                }

                const mergedQuotas = {
                  h1: 1,
                  h2: 3,
                  ...itemQuotas,
                  ...quotas,
                };

                fieldQuotas[attrName] = {
                  quotas: mergedQuotas,
                  ruleName: `${attrName} quota rule`,
                };
              }
            }
          }

          // Fallback rule for standard headingLevel if not configured yet
          if (!fieldQuotas.headingLevel) {
            fieldQuotas.headingLevel = {
              quotas: { h1: 1, h2: 3 },
              ruleName: 'Default SEO Heading Rule',
            };
          }

          const counts: Record<string, Record<string, number>> = {};

          function scanDataTree(obj: any) {
            if (!obj || typeof obj !== 'object') return;

            for (const key of Object.keys(obj)) {
              const val = obj[key];

              if (fieldQuotas[key] && typeof val === 'string' && val) {
                const lowerVal = val.toLowerCase();
                counts[key] = counts[key] || {};
                counts[key][lowerVal] = (counts[key][lowerVal] || 0) + 1;
              }

              if (typeof val === 'object' && val !== null) {
                scanDataTree(val);
              }
            }
          }

          // If updating an existing document and updating a scalar field that has quota rules,
          // merge with the existing document state to ensure full cross-component tree compliance
          let dataToScan = data;
          if (context.action === 'update' && (params?.documentId || params?.where?.documentId)) {
            const docId = params?.documentId || params?.where?.documentId;
            const hasQuotaFieldInPayload = Object.keys(fieldQuotas).some((k) => k in data);
            if (hasQuotaFieldInPayload && context.uid) {
              try {
                const existing = await strapi.documents(context.uid as any).findOne({
                  documentId: docId,
                  populate: '*',
                });
                if (existing) {
                  dataToScan = { ...existing, ...data };
                }
              } catch {
                // If lookup fails, scan incoming data
              }
            }
          }

          scanDataTree(dataToScan);

          // Validate collected counts against active quotas
          for (const [fieldKey, ruleMeta] of Object.entries(fieldQuotas)) {
            for (const [val, maxAllowed] of Object.entries(ruleMeta.quotas)) {
              const lowerVal = val.toLowerCase();
              const actualCount = counts[fieldKey]?.[lowerVal] || 0;
              if (actualCount > maxAllowed) {
                throw new errors.ApplicationError(
                  `Validation Error (${ruleMeta.ruleName}): Option "${val.toUpperCase()}" on field "${fieldKey}" cannot appear more than ${maxAllowed} time(s) across this entry (found ${actualCount}).`
                );
              }
            }
          }
        }
      }

      return next();
    });
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
  },
};
