import type { Core } from '@strapi/strapi';

export type FieldCategory =
  | 'scalar'
  | 'json'
  | 'blocks'
  | 'component_single'
  | 'component_repeatable'
  | 'dynamiczone'
  | 'relation_to_one'
  | 'relation_to_many'
  | 'media_single'
  | 'media_to_many'
  | 'system';

export interface DiscoveredField {
  key: string;
  label: string;
  category: FieldCategory;
  rawType: string;
  repeatable?: boolean;
  componentUid?: string;
  dzComponents?: string[];
  targetUid?: string;
  relationType?: string;
  multiple?: boolean;
  enumOptions?: string[];
  required?: boolean;
  subFields?: Record<string, DiscoveredField>;
}

export interface DiscoveredSchema {
  uid: string;
  displayName: string;
  singularName: string;
  kind: 'collectionType' | 'singleType';
  isDraftAndPublish: boolean;
  isLocalized: boolean;
  fields: Record<string, DiscoveredField>;
  allExportKeys: string[];
}

export const SYSTEM_ATTRIBUTES = new Set([
  'createdat',
  'updatedat',
  'publishedat',
  'createdby',
  'updatedby',
  'localizations',
  'locale',
  'documentid',
  'id',
  'strapistage',
  'strapi_stage',
  'strapiassignee',
  'strapi_assignee',
  'strapistatus',
  'strapi_status',
]);

/**
 * Classifies an attribute definition into a typed FieldCategory
 */
export function classifyAttribute(attrName: string, attrDef: any): FieldCategory {
  const normKey = attrName.toLowerCase().replace(/[\s_-]/g, '');
  if (SYSTEM_ATTRIBUTES.has(normKey)) {
    return 'system';
  }

  if (!attrDef || typeof attrDef !== 'object') {
    return 'scalar';
  }

  const type = String(attrDef.type || '').toLowerCase();

  if (type === 'component') {
    return attrDef.repeatable ? 'component_repeatable' : 'component_single';
  }

  if (type === 'dynamiczone') {
    return 'dynamiczone';
  }

  if (type === 'relation') {
    const rel = String(attrDef.relation || '').toLowerCase();
    const isMany =
      rel.endsWith('many') ||
      rel === 'onetomany' ||
      rel === 'manytomany' ||
      rel === 'morphone' ||
      rel === 'morphmany';
    return isMany ? 'relation_to_many' : 'relation_to_one';
  }

  if (type === 'media') {
    return attrDef.multiple ? 'media_to_many' : 'media_single';
  }

  if (type === 'blocks') {
    return 'blocks';
  }

  if (type === 'json') {
    return 'json';
  }

  return 'scalar';
}

/**
 * Discovers subfields of a component recursively
 */
export function discoverComponentFields(
  strapi: Core.Strapi,
  compUid: string,
  visited: Set<string> = new Set(),
  depth = 0,
  maxDepth = 6
): Record<string, DiscoveredField> {
  const result: Record<string, DiscoveredField> = {};
  if (depth >= maxDepth) return result;

  const comp = strapi.components?.[compUid];
  if (!comp?.attributes) return result;

  const nextVisited = new Set(visited);
  nextVisited.add(compUid);

  for (const [attrName, attrDef] of Object.entries(comp.attributes) as [string, any][]) {
    const normKey = attrName.toLowerCase().replace(/[\s_-]/g, '');
    if (SYSTEM_ATTRIBUTES.has(normKey)) continue;

    const category = classifyAttribute(attrName, attrDef);
    if (category === 'system') continue;

    const field: DiscoveredField = {
      key: attrName,
      label: attrName,
      category,
      rawType: attrDef.type,
      repeatable: Boolean(attrDef.repeatable),
      componentUid: attrDef.component,
      dzComponents: Array.isArray(attrDef.components) ? attrDef.components : undefined,
      targetUid: attrDef.target,
      relationType: attrDef.relation,
      multiple: Boolean(attrDef.multiple),
      enumOptions: Array.isArray(attrDef.enum) ? attrDef.enum : undefined,
      required: Boolean(attrDef.required),
    };

    if (category === 'component_single' && attrDef.component) {
      if (!visited.has(attrDef.component)) {
        field.subFields = discoverComponentFields(
          strapi,
          attrDef.component,
          nextVisited,
          depth + 1,
          maxDepth
        );
      }
    } else if (category === 'component_repeatable' && attrDef.component) {
      if (!visited.has(attrDef.component)) {
        field.subFields = discoverComponentFields(
          strapi,
          attrDef.component,
          nextVisited,
          depth + 1,
          maxDepth
        );
      }
    }

    result[attrName] = field;
  }

  return result;
}

/**
 * Dynamically discovers the full schema of a content type and all its components
 */
export function discoverSchema(strapi: Core.Strapi, uid: string): DiscoveredSchema {
  const ct = strapi.contentTypes[uid];
  if (!ct) {
    throw new Error(`Content type "${uid}" not found in registered Strapi schema.`);
  }

  const fields: Record<string, DiscoveredField> = {};
  const allExportKeys: string[] = ['documentId'];

  const isLocalized = Boolean(ct.pluginOptions?.i18n?.localized);
  if (isLocalized) {
    allExportKeys.push('locale');
  }

  const isDraftAndPublish = Boolean(ct.options?.draftAndPublish);

  for (const [attrName, attrDef] of Object.entries(ct.attributes || {}) as [string, any][]) {
    const normKey = attrName.toLowerCase().replace(/[\s_-]/g, '');
    if (SYSTEM_ATTRIBUTES.has(normKey)) continue;

    // Skip admin review workflow internals
    if (attrDef?.target?.includes('review-workflow') || attrDef?.target === 'admin::review-workflow-stage') {
      continue;
    }

    const category = classifyAttribute(attrName, attrDef);
    if (category === 'system') continue;

    const field: DiscoveredField = {
      key: attrName,
      label: attrName,
      category,
      rawType: attrDef.type,
      repeatable: Boolean(attrDef.repeatable),
      componentUid: attrDef.component,
      dzComponents: Array.isArray(attrDef.components) ? attrDef.components : undefined,
      targetUid: attrDef.target,
      relationType: attrDef.relation,
      multiple: Boolean(attrDef.multiple),
      enumOptions: Array.isArray(attrDef.enum) ? attrDef.enum : undefined,
      required: Boolean(attrDef.required),
    };

    if ((category === 'component_single' || category === 'component_repeatable') && attrDef.component) {
      field.subFields = discoverComponentFields(strapi, attrDef.component, new Set(), 0, 6);
    }

    fields[attrName] = field;
    allExportKeys.push(attrName);
  }

  return {
    uid,
    displayName: ct.info?.displayName || uid,
    singularName: ct.info?.singularName || uid,
    kind: ct.kind === 'singleType' ? 'singleType' : 'collectionType',
    isDraftAndPublish,
    isLocalized,
    fields,
    allExportKeys,
  };
}
