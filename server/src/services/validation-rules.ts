import type { Core } from '@strapi/strapi';

export interface ValidationRule {
  id: string;
  name: string;
  description?: string;
  targetField: string;
  quotas: Record<string, number>;
  exceededAction: 'disable' | 'hide';
  enabled: boolean;
  scope: 'entry' | 'document';
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_RULES: ValidationRule[] = [
  {
    id: 'rule_seo_heading_h1',
    name: 'SEO Single H1 Page Rule',
    description: 'Enforces that only one H1 heading tag can be selected across all dynamic zone heading blocks within an entry.',
    targetField: 'headingLevel',
    quotas: {
      h1: 1,
      h2: 3,
    },
    exceededAction: 'disable',
    enabled: true,
    scope: 'entry',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getStore() {
    return strapi.store({
      type: 'plugin',
      name: 'bulk-updater',
      key: 'validation-rules',
    });
  },

  async getRules(): Promise<ValidationRule[]> {
    const store = await this.getStore();
    const stored = await store.get({});
    if (!stored || !Array.isArray(stored.rules)) {
      // Seed default rules if first time
      await store.set({ value: { rules: DEFAULT_RULES } });
      return DEFAULT_RULES;
    }
    return stored.rules;
  },

  async saveRule(ruleData: Partial<ValidationRule>): Promise<ValidationRule> {
    const store = await this.getStore();
    const rules = await this.getRules();

    const now = new Date().toISOString();
    let savedRule: ValidationRule;

    if (ruleData.id) {
      // Update existing
      const index = rules.findIndex((r) => r.id === ruleData.id);
      if (index !== -1) {
        savedRule = {
          ...rules[index],
          ...ruleData,
          updatedAt: now,
        } as ValidationRule;
        rules[index] = savedRule;
      } else {
        savedRule = {
          id: ruleData.id,
          name: ruleData.name || 'New Rule',
          description: ruleData.description || '',
          targetField: ruleData.targetField || 'headingLevel',
          quotas: ruleData.quotas || { h1: 1 },
          exceededAction: ruleData.exceededAction || 'disable',
          enabled: ruleData.enabled ?? true,
          scope: ruleData.scope || 'entry',
          createdAt: now,
          updatedAt: now,
        };
        rules.push(savedRule);
      }
    } else {
      // Create new
      const id = `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      savedRule = {
        id,
        name: ruleData.name || 'Custom Quota Rule',
        description: ruleData.description || '',
        targetField: ruleData.targetField || 'headingLevel',
        quotas: ruleData.quotas || { h1: 1 },
        exceededAction: ruleData.exceededAction || 'disable',
        enabled: ruleData.enabled ?? true,
        scope: ruleData.scope || 'entry',
        createdAt: now,
        updatedAt: now,
      };
      rules.push(savedRule);
    }

    await store.set({ value: { rules } });
    return savedRule;
  },

  async deleteRule(ruleId: string): Promise<boolean> {
    const store = await this.getStore();
    const rules = await this.getRules();
    const filtered = rules.filter((r) => r.id !== ruleId);
    await store.set({ value: { rules: filtered } });
    return true;
  },

  async toggleRule(ruleId: string, enabled?: boolean): Promise<ValidationRule | null> {
    const store = await this.getStore();
    const rules = await this.getRules();
    const index = rules.findIndex((r) => r.id === ruleId);
    if (index === -1) return null;

    const current = rules[index];
    const newEnabled = typeof enabled === 'boolean' ? enabled : !current.enabled;
    const updated = {
      ...current,
      enabled: newEnabled,
      updatedAt: new Date().toISOString(),
    };
    rules[index] = updated;
    await store.set({ value: { rules } });
    return updated;
  },

  async scanViolations(ruleId: string): Promise<{
    rule: ValidationRule;
    totalScanned: number;
    totalViolations: number;
    violations: Array<{
      uid: string;
      collectionDisplayName: string;
      documentId: string;
      entryLabel: string;
      violatingOption: string;
      foundCount: number;
      maxAllowed: number;
      editUrl: string;
    }>;
  }> {
    const rules = await this.getRules();
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) {
      throw new Error(`Validation rule ${ruleId} not found`);
    }

    const targetField = rule.targetField;
    const quotas = rule.quotas || {};
    const violations: Array<any> = [];
    let totalScanned = 0;

    const allContentTypes = strapi.contentTypes || {};
    const allComponents = strapi.components || {};

    // Helper: matches a key against targetField (case-insensitive & supports dot notation)
    function matchesRule(key: string, ruleTargetField: string): boolean {
      if (!key || !ruleTargetField) return false;
      const kLower = key.toLowerCase().trim();
      const tLower = ruleTargetField.toLowerCase().trim();
      return (
        kLower === tLower ||
        tLower.endsWith(`.${kLower}`) ||
        tLower.split('.').pop() === kLower ||
        kLower.endsWith(`.${tLower}`)
      );
    }

    function componentHasField(compUid: string, targetField: string): boolean {
      const comp = allComponents[compUid];
      if (!comp?.attributes) return false;
      for (const [attrName, attrDef] of Object.entries(comp.attributes) as any[]) {
        if (matchesRule(attrName, targetField)) return true;
        if (attrDef.type === 'component' && attrDef.component) {
          if (componentHasField(attrDef.component, targetField)) return true;
        }
      }
      return false;
    }

    // Helper: Checks if a content-type schema or any of its components has the target field
    function schemaHasField(ctSchema: any): { hasField: boolean; populateAttrs: Record<string, any> } {
      if (!ctSchema || !ctSchema.attributes) return { hasField: false, populateAttrs: {} };
      const rawAttrs = ctSchema.attributes;
      const populateAttrs: Record<string, any> = {};
      let hasField = false;

      for (const [attrKey, attrDef] of Object.entries(rawAttrs) as any[]) {
        if (matchesRule(attrKey, targetField)) {
          hasField = true;
        }
        if (attrDef.type === 'component' && attrDef.component) {
          if (componentHasField(attrDef.component, targetField)) {
            hasField = true;
            populateAttrs[attrKey] = true;
          }
        } else if (attrDef.type === 'dynamiczone' && Array.isArray(attrDef.components)) {
          const matchingComp = attrDef.components.some(
            (compUid: string) => componentHasField(compUid, targetField)
          );
          if (matchingComp) {
            hasField = true;
            populateAttrs[attrKey] = true;
          }
        }
      }

      return { hasField, populateAttrs };
    }

    const candidateUids = Object.keys(allContentTypes).filter(
      (uid) => uid.startsWith('api::') && !uid.includes('bulk-updater')
    );

    // Filter candidate collections to ONLY those that actually possess targetField in their schema
    const relevantCollections: Array<{ uid: string; displayName: string; populateOption?: Record<string, any> | string }> = [];
    for (const uid of candidateUids) {
      const ct = allContentTypes[uid];
      if (!ct) continue;
      const { hasField, populateAttrs } = schemaHasField(ct);
      if (hasField) {
        relevantCollections.push({
          uid,
          displayName: ct.info?.displayName || uid,
          populateOption: Object.keys(populateAttrs).length > 0 ? populateAttrs : '*',
        });
      }
    }

    const BATCH_SIZE = 250;

    await Promise.all(
      relevantCollections.map(async ({ uid, displayName, populateOption }) => {
        try {
          let page = 1;
          while (true) {
            const entries: any[] = await strapi.documents(uid as any).findMany({
              page,
              pageSize: BATCH_SIZE,
              populate: populateOption,
            });

            if (!entries || entries.length === 0) break;

            for (const entry of entries) {
              totalScanned++;
              const counts: Record<string, number> = {};

              function traverse(obj: any) {
                if (!obj || typeof obj !== 'object') return;
                for (const key of Object.keys(obj)) {
                  const val = obj[key];
                  if (matchesRule(key, targetField) && typeof val === 'string' && val.trim()) {
                    const lower = val.toLowerCase().trim();
                    counts[lower] = (counts[lower] || 0) + 1;
                  }
                  if (typeof val === 'object' && val !== null) {
                    traverse(val);
                  }
                }
              }

              traverse(entry);

              for (const [optKey, max] of Object.entries(quotas)) {
                const lowerOpt = optKey.toLowerCase().trim();
                const actualCount = counts[lowerOpt] || 0;
                if (actualCount > max) {
                  const entryLabel =
                    entry.title || entry.name || entry.email || `Entry #${entry.documentId}`;
                  violations.push({
                    uid,
                    collectionDisplayName: displayName,
                    documentId: entry.documentId,
                    entryLabel,
                    violatingOption: optKey.toUpperCase(),
                    foundCount: actualCount,
                    maxAllowed: max,
                    editUrl: `/admin/content-manager/collection-types/${uid}/${entry.documentId}`,
                  });
                }
              }
            }

            if (entries.length < BATCH_SIZE) break;
            page++;
          }
        } catch (err) {
          strapi.log.warn(`[bulk-updater] Failed scanning ${uid} for rule ${ruleId}:`, err);
        }
      })
    );

    return {
      rule,
      totalScanned,
      totalViolations: violations.length,
      violations,
    };
  },
});
