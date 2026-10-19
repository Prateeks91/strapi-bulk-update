import type { Core } from '@strapi/strapi';

export interface ValidationRule {
  id: string;
  name: string;
  description?: string;
  collectionUid?: string; // specific collection UID (e.g. 'api::article.article') or '*' (all)
  targetField: string;    // dot-path or attribute name, e.g. 'headingLevel' or 'st-featured.titleHeadingStyle.titleStyle'
  quotas: Record<string, number>;
  exceededAction: 'disable' | 'hide';
  enabled: boolean;
  scope: 'entry' | 'document';
  includeRichTextHtml?: boolean; // Scans rich text / CKEditor HTML / Markdown / Blocks headings
  richTextFields?: string[];     // Optional specific rich text paths to scan
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_RULES: ValidationRule[] = [
  {
    id: 'rule_seo_heading_h1',
    name: 'SEO Single H1 Page Rule',
    description: 'Enforces that only one H1 heading tag can be selected across all dynamic zone heading blocks within an entry, combined with rich text HTML.',
    collectionUid: '*',
    targetField: 'headingLevel',
    quotas: {
      h1: 1,
      h2: 3,
    },
    exceededAction: 'disable',
    enabled: true,
    scope: 'entry',
    includeRichTextHtml: true,
    richTextFields: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

/**
 * Extracts heading counts (h1..h6) from rich text content (HTML strings, Markdown strings, or Strapi Blocks AST)
 */
export function extractHeadingsFromRichText(content: any): Record<string, number> {
  const counts: Record<string, number> = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  if (!content) return counts;

  // 1. Strapi 5 Blocks AST (Array of block nodes)
  if (Array.isArray(content)) {
    for (const node of content) {
      if (node && typeof node === 'object') {
        if (node.type === 'heading' && typeof node.level === 'number') {
          const tag = `h${node.level}`;
          if (counts[tag] !== undefined) counts[tag]++;
        }
        if (Array.isArray(node.children)) {
          const sub = extractHeadingsFromRichText(node.children);
          for (const k of Object.keys(counts)) counts[k] += sub[k];
        }
      }
    }
    return counts;
  }

  // 2. String (HTML or Markdown)
  if (typeof content === 'string') {
    for (let level = 1; level <= 6; level++) {
      const tag = `h${level}`;
      // HTML regex: <h1 ...> or <h1> (case-insensitive)
      const htmlMatches = content.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi'));
      if (htmlMatches) {
        counts[tag] += htmlMatches.length;
      }
      // Markdown regex: '# Heading' at beginning of line
      const mdRegex = new RegExp(`(?:^|\\n)${'#'.repeat(level)}\\s+[^\\n]+`, 'g');
      const mdMatches = content.match(mdRegex);
      if (mdMatches) {
        counts[tag] += mdMatches.length;
      }
    }
  }

  return counts;
}

function cleanKey(str: string): string {
  return (str || '').replace(/[-_]/g, '').toLowerCase().trim();
}

/**
 * Matches a current property path against a rule targetField (supports dot paths, leaf keys, and dynamic zone component names)
 */
export function matchesPath(normalizedPath: string, leafKey: string, targetField: string): boolean {
  if (!targetField) return false;
  const pClean = cleanKey(normalizedPath);
  const kClean = cleanKey(leafKey);
  const tClean = cleanKey(targetField);

  // If targetField has no dots, match either leafKey or end of path
  if (!tClean.includes('.')) {
    return (
      kClean === tClean ||
      pClean === tClean ||
      pClean.endsWith(`.${tClean}`)
    );
  }

  // If targetField has dots (e.g., 'titleHeadingStyle.titleStyle', 'content.titleHeadingStyle.titleStyle', or 'st-featured.titleHeadingStyle.titleStyle')
  return (
    pClean === tClean ||
    pClean.endsWith(`.${tClean}`) ||
    pClean.endsWith(tClean) ||
    pClean.includes(`.${tClean}`)
  );
}

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
          collectionUid: ruleData.collectionUid !== undefined ? ruleData.collectionUid : (rules[index].collectionUid || '*'),
          includeRichTextHtml: ruleData.includeRichTextHtml !== undefined ? Boolean(ruleData.includeRichTextHtml) : Boolean(rules[index].includeRichTextHtml),
          richTextFields: Array.isArray(ruleData.richTextFields) ? ruleData.richTextFields : (rules[index].richTextFields || []),
          updatedAt: now,
        } as ValidationRule;
        rules[index] = savedRule;
      } else {
        savedRule = {
          id: ruleData.id,
          name: ruleData.name || 'New Rule',
          description: ruleData.description || '',
          collectionUid: ruleData.collectionUid || '*',
          targetField: ruleData.targetField || 'headingLevel',
          quotas: ruleData.quotas || { h1: 1 },
          exceededAction: ruleData.exceededAction || 'disable',
          enabled: ruleData.enabled ?? true,
          scope: ruleData.scope || 'entry',
          includeRichTextHtml: Boolean(ruleData.includeRichTextHtml),
          richTextFields: Array.isArray(ruleData.richTextFields) ? ruleData.richTextFields : [],
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
        collectionUid: ruleData.collectionUid || '*',
        targetField: ruleData.targetField || 'headingLevel',
        quotas: ruleData.quotas || { h1: 1 },
        exceededAction: ruleData.exceededAction || 'disable',
        enabled: ruleData.enabled ?? true,
        scope: ruleData.scope || 'entry',
        includeRichTextHtml: Boolean(ruleData.includeRichTextHtml),
        richTextFields: Array.isArray(ruleData.richTextFields) ? ruleData.richTextFields : [],
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
      structuredCount: number;
      richTextCount: number;
      maxAllowed: number;
      editUrl: string;
      detail?: string;
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

    function componentHasField(compUid: string, targetField: string): boolean {
      const comp = allComponents[compUid];
      if (!comp?.attributes) return false;
      if (matchesPath(compUid, compUid, targetField)) return true;
      for (const [attrName, attrDef] of Object.entries(comp.attributes) as any[]) {
        if (matchesPath(attrName, attrName, targetField) || matchesPath(`${compUid}.${attrName}`, attrName, targetField)) return true;
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
        if (matchesPath(attrKey, attrKey, targetField)) {
          hasField = true;
        }
        if (attrDef.type === 'component' && attrDef.component) {
          if (componentHasField(attrDef.component, targetField)) {
            hasField = true;
            populateAttrs[attrKey] = true;
          }
        } else if (attrDef.type === 'dynamiczone' && Array.isArray(attrDef.components)) {
          const matchingComp = attrDef.components.some(
            (compUid: string) => componentHasField(compUid, targetField) || matchesPath(`${attrKey}.${compUid}`, compUid, targetField)
          );
          if (matchingComp) {
            hasField = true;
            populateAttrs[attrKey] = true;
          }
        }
      }

      return { hasField, populateAttrs };
    }

    const candidateUids = Object.keys(allContentTypes).filter((uid) => {
      if (!uid.startsWith('api::') || uid.includes('bulk-updater')) return false;
      if (rule.collectionUid && rule.collectionUid !== '*' && rule.collectionUid !== uid) {
        return false;
      }
      return true;
    });

    // Filter candidate collections to those that possess targetField in schema, OR if rule has collectionUid specified
    const relevantCollections: Array<{ uid: string; displayName: string; populateOption?: Record<string, any> | string }> = [];
    for (const uid of candidateUids) {
      const ct = allContentTypes[uid];
      if (!ct) continue;
      const { hasField, populateAttrs } = schemaHasField(ct);
      // If collectionUid is specifically targeted, include it even if populateAttrs needs to be '*'
      if (hasField || (rule.collectionUid && rule.collectionUid === uid)) {
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
              const structuredCounts: Record<string, number> = {};
              const richTextCounts: Record<string, number> = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };

              function traverse(obj: any, currentPath = '') {
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

                  const isMatch = matchesPath(normalizedPath, key, targetField) ||
                    (compPath ? matchesPath(compPath, key, targetField) : false);

                  if (isMatch && typeof val === 'string' && val.trim()) {
                    const lower = val.toLowerCase().trim();
                    structuredCounts[lower] = (structuredCounts[lower] || 0) + 1;
                  }

                  if (rule.includeRichTextHtml) {
                    if (typeof val === 'string' && (val.includes('<h') || val.includes('#'))) {
                      const headings = extractHeadingsFromRichText(val);
                      for (const [tag, count] of Object.entries(headings)) {
                        if (count > 0) {
                          richTextCounts[tag] = (richTextCounts[tag] || 0) + count;
                        }
                      }
                    } else if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0]?.type) {
                      const headings = extractHeadingsFromRichText(val);
                      for (const [tag, count] of Object.entries(headings)) {
                        if (count > 0) {
                          richTextCounts[tag] = (richTextCounts[tag] || 0) + count;
                        }
                      }
                      continue;
                    }
                  }

                  if (typeof val === 'object' && val !== null) {
                    traverse(val, newPath);
                  }
                }
              }

              traverse(entry);

              for (const [optKey, max] of Object.entries(quotas)) {
                const lowerOpt = optKey.toLowerCase().trim();
                const structCount = structuredCounts[lowerOpt] || 0;
                const rtCount = rule.includeRichTextHtml ? (richTextCounts[lowerOpt] || 0) : 0;
                const combinedCount = structCount + rtCount;

                if (combinedCount > max) {
                  const entryLabel =
                    entry.title || entry.name || entry.email || `Entry #${entry.documentId}`;
                  
                  let detail = '';
                  if (rtCount > 0 && structCount > 0) {
                    detail = `${structCount} structured + ${rtCount} in rich text HTML`;
                  } else if (rtCount > 0) {
                    detail = `${rtCount} in rich text HTML / Markdown`;
                  } else {
                    detail = `${structCount} in structured component`;
                  }

                  violations.push({
                    uid,
                    collectionDisplayName: displayName,
                    documentId: entry.documentId,
                    entryLabel,
                    violatingOption: optKey.toUpperCase(),
                    foundCount: combinedCount,
                    structuredCount: structCount,
                    richTextCount: rtCount,
                    maxAllowed: max,
                    detail,
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
