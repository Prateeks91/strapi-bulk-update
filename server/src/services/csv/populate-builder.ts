import type { Core } from '@strapi/strapi';
import { DiscoveredSchema, discoverSchema, classifyAttribute } from './schema-discovery';

export interface PopulateOptions {
  maxDepth?: number;
}

/**
 * Recursively builds dynamic populate query for Strapi 5 Document Service
 */
function buildComponentPopulate(
  strapi: Core.Strapi,
  compUid: string,
  visited: Set<string>,
  depth: number,
  maxDepth: number
): Record<string, any> | true {
  if (depth >= maxDepth) return true;
  if (visited.has(compUid)) return true;

  const comp = strapi.components?.[compUid];
  if (!comp?.attributes) return true;

  const nextVisited = new Set(visited);
  nextVisited.add(compUid);

  const populate: Record<string, any> = {};

  for (const [attrName, attrDef] of Object.entries(comp.attributes) as [string, any][]) {
    const category = classifyAttribute(attrName, attrDef);

    if (category === 'component_single' || category === 'component_repeatable') {
      if (attrDef.component) {
        const subPop = buildComponentPopulate(
          strapi,
          attrDef.component,
          nextVisited,
          depth + 1,
          maxDepth
        );
        populate[attrName] = typeof subPop === 'object' && Object.keys(subPop).length > 0
          ? { populate: subPop }
          : true;
      } else {
        populate[attrName] = true;
      }
    } else if (category === 'dynamiczone') {
      const dzComponents: string[] = Array.isArray(attrDef.components) ? attrDef.components : [];
      if (dzComponents.length > 0) {
        const onPopulate: Record<string, any> = {};
        for (const dzCompUid of dzComponents) {
          const dzCompPop = buildComponentPopulate(
            strapi,
            dzCompUid,
            nextVisited,
            depth + 1,
            maxDepth
          );
          onPopulate[dzCompUid] = typeof dzCompPop === 'object' && Object.keys(dzCompPop).length > 0
            ? { populate: dzCompPop }
            : true;
        }
        populate[attrName] = { on: onPopulate };
      } else {
        populate[attrName] = { populate: '*' };
      }
    } else if (category === 'relation_to_one' || category === 'relation_to_many') {
      // In Strapi 5, populate relation basic info
      populate[attrName] = true;
    } else if (category === 'media_single' || category === 'media_to_many') {
      populate[attrName] = true;
    }
  }

  return Object.keys(populate).length > 0 ? populate : true;
}

/**
 * Builds a comprehensive, schema-aware populate object for fetching documents in Strapi 5
 */
export function buildLosslessPopulate(
  strapi: Core.Strapi,
  uid: string,
  options: PopulateOptions = {}
): Record<string, any> | undefined {
  const maxDepth = options.maxDepth || 5;
  const schema = discoverSchema(strapi, uid);
  const populate: Record<string, any> = {};
  const visited = new Set<string>([uid]);

  for (const [fieldName, field] of Object.entries(schema.fields)) {
    switch (field.category) {
      case 'component_single':
      case 'component_repeatable': {
        if (field.componentUid) {
          const compPop = buildComponentPopulate(
            strapi,
            field.componentUid,
            visited,
            0,
            maxDepth
          );
          populate[fieldName] = typeof compPop === 'object' && Object.keys(compPop).length > 0
            ? { populate: compPop }
            : true;
        } else {
          populate[fieldName] = true;
        }
        break;
      }

      case 'dynamiczone': {
        const dzComponents = field.dzComponents || [];
        if (dzComponents.length > 0) {
          const onPopulate: Record<string, any> = {};
          for (const compUid of dzComponents) {
            const compPop = buildComponentPopulate(
              strapi,
              compUid,
              visited,
              0,
              maxDepth
            );
            onPopulate[compUid] = typeof compPop === 'object' && Object.keys(compPop).length > 0
              ? { populate: compPop }
              : true;
          }
          populate[fieldName] = { on: onPopulate };
        } else {
          populate[fieldName] = { populate: '*' };
        }
        break;
      }

      case 'relation_to_one':
      case 'relation_to_many': {
        populate[fieldName] = true;
        break;
      }

      case 'media_single':
      case 'media_to_many': {
        populate[fieldName] = true;
        break;
      }

      default:
        // Scalars, JSON, blocks do not require populate
        break;
    }
  }

  return Object.keys(populate).length > 0 ? populate : undefined;
}
