import type { Core } from '@strapi/strapi';
import { resolveMediaIds } from '../csv/payload-builder';

export type EditMode = 'common' | 'grid';

export interface AttributeMeta {
  depth: number;
  type: string;
  component?: string;
  isRelation?: boolean;
  customField?: string;
  options?: Record<string, any>;
  enumOptions?: string[];
  multiple?: boolean;
  repeatable?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  regex?: string;
  required?: boolean;
  target?: string;
  relationType?: string;
  rootType?: string;
  rootRepeatable?: boolean;
}

export interface OccurrenceSegmentRef {
  key: string;
  index?: number;
  componentId?: number | string;
  componentUid?: string;
}

export interface OccurrenceUpdateInput {
  occurrenceKey?: string;
  segments?: OccurrenceSegmentRef[];
  dynamicZoneIndex?: number;
  componentId?: number | string;
  componentUid?: string;
  value: any;
}

export interface BulkTargetEntry {
  uid: string;
  documentId: string;
  locale?: string;
  status?: string;
  publishedAt?: string | null;
  dynamicZoneIndexes?: number[];
  targetComponentUid?: string;
  overrideValue?: any;
  occurrenceUpdates?: OccurrenceUpdateInput[];
}

export interface EnumeratedOccurrence {
  occurrenceKey: string;
  displayPath: string;
  segments: OccurrenceSegmentRef[];
  value: any;
  componentUid?: string;
  componentName?: string;
  componentId?: number | string;
  index: number;
  isMissingIntermediate: boolean;
  leafSchema?: any;
}

export interface ResolvedRelationCommand {
  mode: 'set' | 'connect' | 'disconnect' | 'clear';
  targetDocIds: string[];
  relationPayload: any;
  display: string;
}

export function formatComponentDisplayName(compUid?: string): string {
  if (!compUid) return 'Component';
  const name = compUid.includes('.') ? compUid.split('.')[1] : compUid;
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function parseAttrPath(path: string): {
  cleanPath: string;
  rootKey: string;
  subPath: string;
  targetComponentUid?: string;
  targetIndex?: number;
} {
  if (!path) return { cleanPath: '', rootKey: '', subPath: '' };
  const bracketMatch = path.match(/^([^.[]+)\[([^\]]+)\](?:\.(.+))?$/);
  if (bracketMatch) {
    const rootKey = bracketMatch[1];
    const selector = bracketMatch[2].trim();
    const subPath = bracketMatch[3] || '';
    const cleanPath = subPath ? `${rootKey}.${subPath}` : rootKey;
    const numMatch = selector.match(/^#?(\d+)/);
    if (numMatch) {
      return { cleanPath, rootKey, subPath, targetIndex: parseInt(numMatch[1], 10) };
    }
    return { cleanPath, rootKey, subPath, targetComponentUid: selector };
  }

  const parts = path.split('.');
  return {
    cleanPath: path,
    rootKey: parts[0] || '',
    subPath: parts.slice(1).join('.'),
  };
}

/**
 * Enriches static attribute metadata with type, enum, customField, and validation metadata
 * in a purely additive way so existing consumers stay completely compatible.
 */
export function buildRichAttributeMeta(attrDef: any, baseMeta: AttributeMeta): AttributeMeta {
  if (!attrDef || typeof attrDef !== 'object') {
    return { ...baseMeta };
  }

  const enriched: AttributeMeta = { ...baseMeta };

  if (attrDef.customField) {
    enriched.customField = String(attrDef.customField);
  }
  if (attrDef.options && typeof attrDef.options === 'object') {
    enriched.options = {
      ...(attrDef.options.scope !== undefined ? { scope: attrDef.options.scope } : {}),
      ...(attrDef.options.disabledBehavior !== undefined ? { disabledBehavior: attrDef.options.disabledBehavior } : {}),
      ...(attrDef.options.quotas ? { quotas: { ...attrDef.options.quotas } } : {}),
      ...(Array.isArray(attrDef.options.items) ? { items: attrDef.options.items.map((it: any) => ({ ...it })) } : {}),
    };
  }
  if (Array.isArray(attrDef.enum)) {
    enriched.enumOptions = [...attrDef.enum];
  }
  if (attrDef.type === 'media') {
    enriched.multiple = Boolean(attrDef.multiple);
  }
  if (attrDef.type === 'component') {
    enriched.repeatable = Boolean(attrDef.repeatable);
  }
  if (typeof attrDef.min === 'number') enriched.min = attrDef.min;
  if (typeof attrDef.max === 'number') enriched.max = attrDef.max;
  if (typeof attrDef.minLength === 'number') enriched.minLength = attrDef.minLength;
  if (typeof attrDef.maxLength === 'number') enriched.maxLength = attrDef.maxLength;
  if (typeof attrDef.regex === 'string') enriched.regex = attrDef.regex;
  if (attrDef.required) enriched.required = true;
  if (attrDef.target) enriched.target = attrDef.target;
  if (attrDef.relation) enriched.relationType = attrDef.relation;

  return enriched;
}

export function buildOccurrenceKey(segments: OccurrenceSegmentRef[]): string {
  if (!segments || segments.length === 0) return '__scalar__';
  return segments
    .map((seg) => {
      if (seg.index !== undefined) {
        return seg.componentId !== undefined && seg.componentId !== null
          ? `${seg.key}[${seg.index}#${seg.componentId}]`
          : `${seg.key}[${seg.index}]`;
      }
      return seg.key;
    })
    .join('.');
}

export function buildReadableOccurrencePath(segments: OccurrenceSegmentRef[]): string {
  if (!segments || segments.length === 0) return '';
  return segments
    .map((seg) => {
      if (seg.index !== undefined) {
        const compLabel = seg.componentUid ? ` ${formatComponentDisplayName(seg.componentUid)}` : '';
        return `${seg.key}[#${seg.index}${compLabel}]`;
      }
      return seg.key;
    })
    .join('.');
}

/**
 * Recursively enumerates all valid occurrences of an attribute path across
 * single components, repeatable components, dynamic zones, and arbitrarily nested chains.
 */
export function enumerateOccurrences(
  contentType: any,
  allComponents: Record<string, any>,
  entity: any,
  attrPath: string
): EnumeratedOccurrence[] {
  if (!contentType || !attrPath) return [];
  const parsed = parseAttrPath(attrPath);
  const parts = parsed.cleanPath.split('.').filter(Boolean);
  if (parts.length === 0) return [];

  const results: EnumeratedOccurrence[] = [];

  function walk(
    currentSchema: any,
    currentVal: any,
    remainingParts: string[],
    segments: OccurrenceSegmentRef[],
    missingIntermediate: boolean,
    firstArrayIndex: number | undefined,
    resolvedCompUid: string | undefined,
    resolvedCompId: number | string | undefined,
    isRootLevel: boolean
  ) {
    if (!currentSchema?.attributes || remainingParts.length === 0) return;

    const [head, ...tail] = remainingParts;
    const attrDef = currentSchema.attributes[head];
    if (!attrDef) return;

    const nextVal = currentVal && typeof currentVal === 'object' ? currentVal[head] : undefined;

    if (tail.length === 0) {
      const nextSegs: OccurrenceSegmentRef[] = [...segments, { key: head }];
      results.push({
        occurrenceKey: segments.length === 0 ? '__scalar__' : buildOccurrenceKey(nextSegs),
        displayPath: buildReadableOccurrencePath(nextSegs),
        segments: nextSegs,
        value: nextVal !== undefined ? nextVal : null,
        componentUid: resolvedCompUid,
        componentName: resolvedCompUid ? formatComponentDisplayName(resolvedCompUid) : undefined,
        componentId: resolvedCompId,
        index: firstArrayIndex ?? 0,
        isMissingIntermediate: missingIntermediate,
        leafSchema: attrDef,
      });
      return;
    }

    if (attrDef.type === 'dynamiczone') {
      if (!Array.isArray(nextVal)) return;
      nextVal.forEach((item: any, idx: number) => {
        if (!item || typeof item !== 'object') return;
        if (isRootLevel && parsed.targetIndex !== undefined && idx !== parsed.targetIndex) return;
        if (isRootLevel && parsed.targetComponentUid && item.__component !== parsed.targetComponentUid) return;

        const compSchema = item.__component ? allComponents?.[item.__component] : null;
        if (!compSchema) return;

        const seg: OccurrenceSegmentRef = {
          key: head,
          index: idx,
          componentId: item.id,
          componentUid: item.__component,
        };

        walk(
          compSchema,
          item,
          tail,
          [...segments, seg],
          missingIntermediate,
          firstArrayIndex ?? idx,
          item.__component,
          resolvedCompId ?? item.id,
          false
        );
      });
      return;
    }

    if (attrDef.type === 'component' && attrDef.component) {
      const compSchema = allComponents?.[attrDef.component];
      if (!compSchema) return;

      if (attrDef.repeatable) {
        if (!Array.isArray(nextVal)) return;
        nextVal.forEach((item: any, idx: number) => {
          if (!item || typeof item !== 'object') return;
          if (isRootLevel && parsed.targetIndex !== undefined && idx !== parsed.targetIndex) return;

          const seg: OccurrenceSegmentRef = {
            key: head,
            index: idx,
            componentId: item.id,
            componentUid: attrDef.component,
          };

          walk(
            compSchema,
            item,
            tail,
            [...segments, seg],
            missingIntermediate,
            firstArrayIndex ?? idx,
            attrDef.component,
            resolvedCompId ?? item.id,
            false
          );
        });
      } else {
        const isMissing = !nextVal || typeof nextVal !== 'object';
        const seg: OccurrenceSegmentRef = {
          key: head,
          componentId: !isMissing ? nextVal.id : undefined,
          componentUid: attrDef.component,
        };
        walk(
          compSchema,
          isMissing ? undefined : nextVal,
          tail,
          [...segments, seg],
          missingIntermediate || isMissing,
          firstArrayIndex,
          resolvedCompUid ?? attrDef.component,
          resolvedCompId ?? (!isMissing ? nextVal.id : undefined),
          false
        );
      }
    }
  }

  walk(contentType, entity, parts, [], false, undefined, undefined, undefined, true);
  return results;
}

export function formatRelationState(currentRel: any, isMulti: boolean): { oldDocIds: string[]; oldDisplay: string } {
  if (isMulti && Array.isArray(currentRel)) {
    const oldDocIds = currentRel.map((r: any) => r?.documentId).filter(Boolean);
    const oldDisplay =
      currentRel.map((r: any) => r?.name || r?.title || r?.email || r?.username || r?.documentId).filter(Boolean).join(', ') ||
      '(unlinked / none)';
    return { oldDocIds, oldDisplay };
  }
  if (currentRel && typeof currentRel === 'object') {
    const oldDocIds = currentRel.documentId ? [currentRel.documentId] : [];
    const oldDisplay =
      currentRel.name || currentRel.title || currentRel.email || currentRel.username || currentRel.documentId || '(unlinked / none)';
    return { oldDocIds, oldDisplay };
  }
  return { oldDocIds: [], oldDisplay: '(unlinked / none)' };
}

export function resolveRelationCommand(rawValue: any, isMulti: boolean, forComponentNested = false): ResolvedRelationCommand {
  let mode: 'set' | 'connect' | 'disconnect' | 'clear' = 'set';
  let targetDocIds: string[] = [];
  let display = '';

  if (rawValue === null || rawValue === undefined || rawValue === '__clear__' || rawValue === '') {
    mode = 'clear';
    display = '(cleared / unlinked)';
  } else if (typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    if (rawValue.mode) {
      mode = rawValue.mode;
      targetDocIds = Array.isArray(rawValue.documentIds)
        ? rawValue.documentIds.filter(Boolean).map(String)
        : rawValue.documentId
        ? [String(rawValue.documentId)]
        : [];
      display = rawValue.label || targetDocIds.join(', ') || `[${mode}]`;
    } else if (rawValue.documentId) {
      targetDocIds = [String(rawValue.documentId)];
      display = rawValue.label || targetDocIds[0];
    }
  } else if (Array.isArray(rawValue)) {
    targetDocIds = rawValue.map((v: any) => (typeof v === 'object' ? v?.documentId : v)).filter(Boolean).map(String);
    display = targetDocIds.join(', ') || '(cleared / unlinked)';
    if (targetDocIds.length === 0) mode = 'clear';
  } else {
    const strVal = String(rawValue);
    try {
      const parsed = JSON.parse(strVal);
      if (parsed && typeof parsed === 'object' && parsed.mode) {
        mode = parsed.mode;
        targetDocIds = Array.isArray(parsed.documentIds)
          ? parsed.documentIds.filter(Boolean).map(String)
          : parsed.documentId
          ? [String(parsed.documentId)]
          : [];
        display = parsed.label || targetDocIds.join(', ') || `[${mode}]`;
      } else if (Array.isArray(parsed)) {
        targetDocIds = parsed.filter(Boolean).map(String);
        display = targetDocIds.join(', ');
      } else {
        targetDocIds = [strVal];
        display = strVal;
      }
    } catch {
      targetDocIds = [strVal];
      display = strVal;
    }
  }

  let relationPayload: any;
  if (mode === 'clear') {
    relationPayload = isMulti ? { set: [] } : null;
  } else if (mode === 'set') {
    relationPayload = isMulti ? { set: targetDocIds } : targetDocIds[0] || null;
  } else if (mode === 'connect') {
    relationPayload = { connect: targetDocIds };
  } else if (mode === 'disconnect') {
    relationPayload = { disconnect: targetDocIds };
  }

  return { mode, targetDocIds, relationPayload, display };
}

/**
 * Type-checks and coerces an inline cell value according to the exact Strapi attribute schema.
 */
export async function coerceAndValidateFieldValue(
  attrDef: any,
  rawValue: any,
  strapi?: Core.Strapi,
  options: { forComponentNested?: boolean } = {}
): Promise<{ valid: boolean; value: any; displayValue: string; isRelation?: boolean; relationMeta?: any; error?: string }> {
  if (!attrDef || typeof attrDef !== 'object') {
    return {
      valid: true,
      value: rawValue,
      displayValue: rawValue !== undefined && rawValue !== null ? String(rawValue) : '(empty)',
    };
  }

  const type = String(attrDef.type || '').toLowerCase();

  if (type === 'relation') {
    const isMulti = attrDef.relation === 'oneToMany' || attrDef.relation === 'manyToMany';
    const cmd = resolveRelationCommand(rawValue, isMulti, options.forComponentNested);
    if (attrDef.required && (cmd.mode === 'clear' || (cmd.mode === 'set' && cmd.targetDocIds.length === 0))) {
      return {
        valid: false,
        value: rawValue,
        displayValue: cmd.display,
        isRelation: true,
        error: 'Relation field is required and cannot be cleared.',
      };
    }
    return {
      valid: true,
      value: cmd.relationPayload,
      displayValue: cmd.display,
      isRelation: true,
      relationMeta: { isRelation: true, mode: cmd.mode, documentIds: cmd.targetDocIds, display: cmd.display },
    };
  }

  if (type === 'media') {
    const isMultiple = Boolean(attrDef.multiple);
    if (rawValue === null || rawValue === undefined || rawValue === '' || rawValue === '__clear__') {
      if (attrDef.required) {
        return { valid: false, value: rawValue, displayValue: '', error: 'Media field is required.' };
      }
      const cleared = isMultiple ? [] : null;
      return { valid: true, value: cleared, displayValue: '(cleared)' };
    }

    const mediaPayload = strapi
      ? await resolveMediaIds(strapi, rawValue, isMultiple)
      : rawValue;

    if (attrDef.required && (mediaPayload === null || (Array.isArray(mediaPayload) && mediaPayload.length === 0))) {
      return { valid: false, value: rawValue, displayValue: '', error: 'Media asset could not be resolved.' };
    }

    return {
      valid: true,
      value: mediaPayload,
      displayValue: Array.isArray(mediaPayload) ? `[${mediaPayload.length} asset(s)]` : mediaPayload !== null ? `#${mediaPayload}` : '(cleared)',
    };
  }

  const isEmptyInput = rawValue === null || rawValue === undefined || rawValue === '';
  if (attrDef.required && (isEmptyInput || (type === 'boolean' && rawValue === null))) {
    return {
      valid: false,
      value: rawValue,
      displayValue: '',
      error: 'Field is required and cannot be empty.',
    };
  }

  if (rawValue === null || rawValue === undefined) {
    return { valid: true, value: null, displayValue: '(empty)' };
  }

  switch (type) {
    case 'integer': {
      if (rawValue === '') return { valid: true, value: null, displayValue: '(empty)' };
      const str = String(rawValue).trim();
      if (!/^-?\d+$/.test(str)) {
        return { valid: false, value: rawValue, displayValue: str, error: `Invalid integer value "${str}".` };
      }
      const num = Number(str);
      if (!Number.isSafeInteger(num)) {
        return { valid: false, value: rawValue, displayValue: str, error: `Integer "${str}" is out of safe range.` };
      }
      if (typeof attrDef.min === 'number' && num < attrDef.min) {
        return { valid: false, value: rawValue, displayValue: str, error: `Value ${num} is less than minimum ${attrDef.min}.` };
      }
      if (typeof attrDef.max === 'number' && num > attrDef.max) {
        return { valid: false, value: rawValue, displayValue: str, error: `Value ${num} exceeds maximum ${attrDef.max}.` };
      }
      return { valid: true, value: num, displayValue: String(num) };
    }

    case 'biginteger': {
      if (rawValue === '') return { valid: true, value: null, displayValue: '(empty)' };
      const str = String(rawValue).trim();
      if (!/^-?\d+$/.test(str)) {
        return { valid: false, value: rawValue, displayValue: str, error: `Invalid biginteger value "${str}".` };
      }
      return { valid: true, value: str, displayValue: str };
    }

    case 'float':
    case 'decimal': {
      if (rawValue === '') return { valid: true, value: null, displayValue: '(empty)' };
      const str = String(rawValue).trim();
      if (!/^-?\d+(\.\d+)?$/.test(str)) {
        return { valid: false, value: rawValue, displayValue: str, error: `Invalid decimal number "${str}".` };
      }
      const num = Number(str);
      if (!Number.isFinite(num)) {
        return { valid: false, value: rawValue, displayValue: str, error: `Number "${str}" is not finite.` };
      }
      if (typeof attrDef.min === 'number' && num < attrDef.min) {
        return { valid: false, value: rawValue, displayValue: str, error: `Value ${num} is less than minimum ${attrDef.min}.` };
      }
      if (typeof attrDef.max === 'number' && num > attrDef.max) {
        return { valid: false, value: rawValue, displayValue: str, error: `Value ${num} exceeds maximum ${attrDef.max}.` };
      }
      return { valid: true, value: num, displayValue: String(num) };
    }

    case 'boolean': {
      if (rawValue === '') return { valid: true, value: null, displayValue: '(empty)' };
      if (typeof rawValue === 'boolean') {
        return { valid: true, value: rawValue, displayValue: String(rawValue) };
      }
      const lower = String(rawValue).trim().toLowerCase();
      if (lower === 'true' || lower === '1' || lower === 'yes') {
        return { valid: true, value: true, displayValue: 'true' };
      }
      if (lower === 'false' || lower === '0' || lower === 'no') {
        return { valid: true, value: false, displayValue: 'false' };
      }
      return { valid: false, value: rawValue, displayValue: String(rawValue), error: `Invalid boolean value "${rawValue}".` };
    }

    case 'enumeration': {
      if (rawValue === '') return { valid: true, value: null, displayValue: '(empty)' };
      const str = String(rawValue);
      if (Array.isArray(attrDef.enum) && !attrDef.enum.includes(str)) {
        return {
          valid: false,
          value: rawValue,
          displayValue: str,
          error: `Value "${str}" is not an allowed enum option (${attrDef.enum.join(', ')}).`,
        };
      }
      return { valid: true, value: str, displayValue: str };
    }

    case 'email': {
      const str = String(rawValue).trim();
      if (str === '') return { valid: true, value: '', displayValue: '(empty)' };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
        return { valid: false, value: rawValue, displayValue: str, error: `Invalid email address "${str}".` };
      }
      return { valid: true, value: str, displayValue: str };
    }

    case 'uid': {
      const str = String(rawValue).trim();
      if (str !== '' && !/^[A-Za-z0-9\-_.~]*$/.test(str)) {
        return { valid: false, value: rawValue, displayValue: str, error: `Invalid UID slug "${str}". Allowed characters: A-Z a-z 0-9 - _ . ~` };
      }
      return { valid: true, value: str, displayValue: str || '(empty)' };
    }

    case 'json':
    case 'blocks': {
      if (rawValue === '') return { valid: true, value: null, displayValue: '(empty)' };
      let parsedVal = rawValue;
      if (typeof rawValue === 'string') {
        try {
          parsedVal = JSON.parse(rawValue);
        } catch (err: any) {
          return {
            valid: false,
            value: rawValue,
            displayValue: rawValue,
            error: `Invalid ${type === 'blocks' ? 'Blocks' : 'JSON'} syntax: ${err.message}`,
          };
        }
      }
      if (type === 'blocks' && parsedVal !== null && !Array.isArray(parsedVal)) {
        return { valid: false, value: rawValue, displayValue: String(rawValue), error: 'Strapi Blocks field must be a JSON array.' };
      }
      return {
        valid: true,
        value: parsedVal,
        displayValue: parsedVal === null ? '(empty)' : JSON.stringify(parsedVal),
      };
    }

    case 'date':
    case 'datetime': {
      if (rawValue === '') return { valid: true, value: null, displayValue: '(empty)' };
      const str = String(rawValue).trim();
      const d = new Date(str);
      if (isNaN(d.getTime())) {
        return { valid: false, value: rawValue, displayValue: str, error: `Invalid ${type} value "${str}".` };
      }
      const out = type === 'date' ? (/^\d{4}-\d{2}-\d{2}$/.test(str) ? str : d.toISOString().slice(0, 10)) : d.toISOString();
      return { valid: true, value: out, displayValue: out };
    }

    case 'time': {
      if (rawValue === '') return { valid: true, value: null, displayValue: '(empty)' };
      const str = String(rawValue).trim();
      if (!/^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(str)) {
        return { valid: false, value: rawValue, displayValue: str, error: `Invalid time format "${str}" (expected HH:mm or HH:mm:ss).` };
      }
      return { valid: true, value: str, displayValue: str };
    }

    default: {
      const str = typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue);
      if (typeof attrDef.minLength === 'number' && str.length < attrDef.minLength) {
        return { valid: false, value: rawValue, displayValue: str, error: `Length ${str.length} is shorter than minimum ${attrDef.minLength}.` };
      }
      if (typeof attrDef.maxLength === 'number' && str.length > attrDef.maxLength) {
        return { valid: false, value: rawValue, displayValue: str, error: `Length ${str.length} exceeds maximum ${attrDef.maxLength}.` };
      }
      if (typeof attrDef.regex === 'string' && attrDef.regex && str !== '') {
        try {
          const re = new RegExp(attrDef.regex);
          if (!re.test(str)) {
            return { valid: false, value: rawValue, displayValue: str, error: `Value does not match required pattern /${attrDef.regex}/.` };
          }
        } catch {
          // Ignore malformed schema regex
        }
      }
      return { valid: true, value: rawValue, displayValue: str || '(empty)' };
    }
  }
}

function findTargetArrayIndex(arr: any[], seg: OccurrenceSegmentRef, arrFieldKey: string): number {
  if (!Array.isArray(arr)) {
    throw new Error(`Expected array for component/dynamiczone field "${arrFieldKey}".`);
  }

  if (seg.componentId !== undefined && seg.componentId !== null) {
    const idMatchIdx = arr.findIndex((item) => {
      if (!item || typeof item !== 'object') return false;
      if (String(item.id) !== String(seg.componentId)) return false;
      if (seg.componentUid && item.__component && item.__component !== seg.componentUid) return false;
      return true;
    });
    if (idMatchIdx === -1) {
      throw new Error(
        `Stale target: component instance (id: ${seg.componentId}) in "${arrFieldKey}" was modified or deleted. Please refresh the grid and retry.`
      );
    }
    return idMatchIdx;
  }

  if (typeof seg.index === 'number') {
    if (seg.index < 0 || seg.index >= arr.length) {
      throw new Error(
        `Stale target: occurrence #${seg.index} in "${arrFieldKey}" no longer exists (length ${arr.length}). Please refresh the grid and retry.`
      );
    }
    const item = arr[seg.index];
    if (seg.componentUid && item?.__component && item.__component !== seg.componentUid) {
      throw new Error(
        `Stale target: occurrence #${seg.index} in "${arrFieldKey}" changed component type to "${item.__component}". Please refresh the grid.`
      );
    }
    return seg.index;
  }

  throw new Error(`Missing occurrence index/componentId for "${arrFieldKey}".`);
}

function buildFallbackSegmentsFromUpdate(
  contentType: any,
  allComponents: Record<string, any>,
  cleanPath: string,
  occUpdate: OccurrenceUpdateInput,
  parsedTargetCompUid?: string
): OccurrenceSegmentRef[] {
  if (Array.isArray(occUpdate.segments) && occUpdate.segments.length > 0) {
    return occUpdate.segments;
  }

  const parts = cleanPath.split('.').filter(Boolean);
  const segs: OccurrenceSegmentRef[] = [];
  let curSchema = contentType;
  let usedFirstArrayMeta = false;

  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    const attrDef = curSchema?.attributes?.[key];
    const isLast = i === parts.length - 1;

    if (!isLast && attrDef && (attrDef.type === 'dynamiczone' || (attrDef.type === 'component' && attrDef.repeatable))) {
      const seg: OccurrenceSegmentRef = { key };
      if (!usedFirstArrayMeta) {
        if (occUpdate.dynamicZoneIndex !== undefined) seg.index = occUpdate.dynamicZoneIndex;
        if (occUpdate.componentId !== undefined) seg.componentId = occUpdate.componentId;
        if (occUpdate.componentUid || parsedTargetCompUid) {
          seg.componentUid = occUpdate.componentUid || parsedTargetCompUid;
        }
        usedFirstArrayMeta = true;
      }
      segs.push(seg);
      const nextCompUid = seg.componentUid || attrDef.component;
      curSchema = nextCompUid ? allComponents?.[nextCompUid] : undefined;
    } else {
      segs.push({ key });
      if (!isLast && attrDef?.type === 'component' && attrDef.component) {
        curSchema = allComponents?.[attrDef.component];
      }
    }
  }

  return segs;
}

export function formatValueDisplay(val: any, isRelation = false, isMulti = false): string {
  if (isRelation) {
    return formatRelationState(val, isMulti).oldDisplay;
  }
  if (val === undefined || val === null || val === '') return '(empty)';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/**
 * Atomically applies 1..N grid occurrence updates onto a single fetched Strapi document
 * without modifying sibling fields, component IDs, or array element ordering.
 */
export async function applyOccurrenceUpdatesToDocument({
  strapi,
  contentType,
  allComponents,
  currentDoc,
  attribute,
  updates,
}: {
  strapi?: Core.Strapi;
  contentType: any;
  allComponents: Record<string, any>;
  currentDoc: any;
  attribute: string;
  updates: OccurrenceUpdateInput[];
}): Promise<{
  updateData: Record<string, any>;
  diffs: Array<{
    occurrenceKey: string;
    segments: OccurrenceSegmentRef[];
    index: number;
    componentId?: number | string;
    componentUid?: string;
    componentName?: string;
    attribute: string;
    oldValue: any;
    newValue: any;
    oldDisplay: string;
    newDisplay: string;
    hasChange: boolean;
  }>;
  errors: string[];
}> {
  const parsed = parseAttrPath(attribute);
  const parts = parsed.cleanPath.split('.').filter(Boolean);
  const rootKey = parts[0];
  const rootAttrDef = contentType?.attributes?.[rootKey];

  const diffs: Array<any> = [];
  const errors: string[] = [];

  // Case A: Top-level scalar / relation / media field
  if (parts.length === 1 && rootAttrDef?.type !== 'component' && rootAttrDef?.type !== 'dynamiczone') {
    const updateItem = updates[0];
    if (!updateItem) {
      return { updateData: {}, diffs: [], errors: [] };
    }

    const isRelation = rootAttrDef?.type === 'relation';
    const isMulti = isRelation && (rootAttrDef.relation === 'oneToMany' || rootAttrDef.relation === 'manyToMany');
    const rawCurrent = currentDoc?.[rootKey];
    const coerced = await coerceAndValidateFieldValue(rootAttrDef, updateItem.value, strapi, { forComponentNested: false });

    if (!coerced.valid) {
      errors.push(coerced.error || `Invalid value for ${rootKey}`);
      return { updateData: {}, diffs: [], errors };
    }

    let oldVal: any;
    let oldDisplay: string;
    let newValOut: any;
    let newDisplay: string;
    let hasChange: boolean;

    if (isRelation) {
      const relState = formatRelationState(rawCurrent, isMulti);
      oldVal = { isRelation: true, documentIds: relState.oldDocIds, display: relState.oldDisplay };
      oldDisplay = relState.oldDisplay;
      newValOut = coerced.relationMeta;
      newDisplay = coerced.displayValue;
      hasChange =
        coerced.relationMeta?.mode === 'clear'
          ? relState.oldDocIds.length > 0
          : JSON.stringify(relState.oldDocIds) !== JSON.stringify(coerced.relationMeta?.documentIds || []) ||
            coerced.relationMeta?.mode !== 'set';
    } else {
      oldVal = rawCurrent ?? null;
      oldDisplay = formatValueDisplay(rawCurrent);
      newValOut = coerced.value;
      newDisplay = coerced.displayValue;
      hasChange = !areValuesEquivalent(rawCurrent, coerced.value);
    }

    diffs.push({
      occurrenceKey: '__scalar__',
      segments: [{ key: rootKey }],
      index: 0,
      attribute: rootKey,
      oldValue: oldVal,
      newValue: newValOut,
      oldDisplay,
      newDisplay,
      hasChange,
    });

    return {
      updateData: { [rootKey]: coerced.value },
      diffs,
      errors,
    };
  }

  // Case B: Nested component / repeatable component / dynamic zone updates
  const existingRoot = currentDoc?.[rootKey];
  const isRootArray = rootAttrDef?.type === 'dynamiczone' || (rootAttrDef?.type === 'component' && rootAttrDef?.repeatable);
  let workingRoot: any = isRootArray
    ? Array.isArray(existingRoot)
      ? [...existingRoot]
      : []
    : existingRoot && typeof existingRoot === 'object'
    ? { ...existingRoot }
    : {};

  for (const occUpdate of updates) {
    const segments = buildFallbackSegmentsFromUpdate(
      contentType,
      allComponents,
      parsed.cleanPath,
      occUpdate,
      parsed.targetComponentUid
    );

    if (segments.length === 0) continue;

    // Walk segments[0..n-2], cloning intermediate objects/arrays immutably so IDs and sibling fields remain untouched
    let curSchema: any = contentType;
    let containerHolder: any = { [rootKey]: workingRoot };
    let resolvedRootIdx = 0;
    let resolvedCompId: number | string | undefined;
    let resolvedCompUid: string | undefined;
    const normalizedSegs: OccurrenceSegmentRef[] = [];

    for (let sIdx = 0; sIdx < segments.length - 1; sIdx++) {
      const seg = segments[sIdx];
      const segAttrDef = curSchema?.attributes?.[seg.key];
      if (!segAttrDef) {
        throw new Error(`Attribute segment "${seg.key}" does not exist in schema.`);
      }

      if (segAttrDef.type === 'dynamiczone' || (segAttrDef.type === 'component' && segAttrDef.repeatable)) {
        const arr = containerHolder[seg.key];
        const liveIdx = findTargetArrayIndex(arr, seg, seg.key);
        const clonedArr = [...arr];
        const clonedItem = { ...(clonedArr[liveIdx] || {}) };
        clonedArr[liveIdx] = clonedItem;
        containerHolder[seg.key] = clonedArr;
        if (sIdx === 0) {
          workingRoot = clonedArr;
          resolvedRootIdx = liveIdx;
        }
        const compUid = clonedItem.__component || seg.componentUid || segAttrDef.component;
        if (resolvedCompId === undefined && clonedItem.id !== undefined) resolvedCompId = clonedItem.id;
        if (!resolvedCompUid && compUid) resolvedCompUid = compUid;

        normalizedSegs.push({
          key: seg.key,
          index: liveIdx,
          componentId: clonedItem.id ?? seg.componentId,
          componentUid: compUid,
        });

        curSchema = compUid ? allComponents?.[compUid] : undefined;
        containerHolder = clonedItem;
      } else if (segAttrDef.type === 'component' && segAttrDef.component) {
        const existingObj = containerHolder[seg.key];
        const clonedObj = existingObj && typeof existingObj === 'object' ? { ...existingObj } : {};
        containerHolder[seg.key] = clonedObj;
        if (sIdx === 0) {
          workingRoot = clonedObj;
        }
        if (resolvedCompId === undefined && clonedObj.id !== undefined) resolvedCompId = clonedObj.id;
        if (!resolvedCompUid) resolvedCompUid = segAttrDef.component;

        normalizedSegs.push({
          key: seg.key,
          componentId: clonedObj.id ?? seg.componentId,
          componentUid: segAttrDef.component,
        });

        curSchema = allComponents?.[segAttrDef.component];
        containerHolder = clonedObj;
      } else {
        throw new Error(`Segment "${seg.key}" is not a traversable component or dynamic zone.`);
      }
    }

    const leafSeg = segments[segments.length - 1];
    normalizedSegs.push({ key: leafSeg.key });
    const leafSchema = curSchema?.attributes?.[leafSeg.key];
    if (!leafSchema) {
      throw new Error(`Leaf field "${leafSeg.key}" does not exist on target component "${resolvedCompUid || 'schema'}".`);
    }

    const isLeafRelation = leafSchema.type === 'relation';
    const isLeafMulti = isLeafRelation && (leafSchema.relation === 'oneToMany' || leafSchema.relation === 'manyToMany');
    const rawOldVal = containerHolder[leafSeg.key];

    const coerced = await coerceAndValidateFieldValue(leafSchema, occUpdate.value, strapi, {
      forComponentNested: true,
    });
    if (!coerced.valid) {
      errors.push(`${buildReadableOccurrencePath(segments)}: ${coerced.error}`);
      continue;
    }

    containerHolder[leafSeg.key] = coerced.value;

    const oldVal = isLeafRelation
      ? (() => {
          const relState = formatRelationState(rawOldVal, isLeafMulti);
          return { isRelation: true, documentIds: relState.oldDocIds, display: relState.oldDisplay };
        })()
      : rawOldVal ?? null;

    const oldDisplay = isLeafRelation ? oldVal.display : formatValueDisplay(rawOldVal);
    const newValOut = isLeafRelation ? coerced.relationMeta : coerced.value;
    const newDisplay = coerced.displayValue;
    const hasChange = isLeafRelation
      ? coerced.relationMeta?.mode === 'clear'
        ? oldVal.documentIds.length > 0
        : JSON.stringify(oldVal.documentIds) !== JSON.stringify(coerced.relationMeta?.documentIds || []) ||
          coerced.relationMeta?.mode !== 'set'
      : !areValuesEquivalent(rawOldVal, coerced.value);

    diffs.push({
      occurrenceKey: occUpdate.occurrenceKey || buildOccurrenceKey(normalizedSegs),
      segments: normalizedSegs,
      index: resolvedRootIdx,
      componentId: resolvedCompId,
      componentUid: resolvedCompUid,
      componentName: formatComponentDisplayName(resolvedCompUid),
      attribute: buildReadableOccurrencePath(normalizedSegs),
      oldValue: oldVal,
      newValue: newValOut,
      oldDisplay,
      newDisplay,
      hasChange,
    });
  }

  return {
    updateData: errors.length === 0 ? { [rootKey]: workingRoot } : {},
    diffs,
    errors,
  };
}

export function areValuesEquivalent(a: any, b: any): boolean {
  const normA = a === undefined ? null : a;
  const normB = b === undefined ? null : b;
  if (normA === normB) return true;
  if (normA === null || normB === null) return false;
  if (typeof normA === 'object' || typeof normB === 'object') {
    try {
      return JSON.stringify(normA) === JSON.stringify(normB);
    } catch {
      return false;
    }
  }
  return String(normA) === String(normB);
}

/**
 * Merges selected entries cleanly by (uid, documentId, locale) in grid mode while preserving
 * exact legacy behavior for common mode.
 */
export async function resolveBatchTargets(
  strapi: any,
  {
    selectedCollections = [],
    selectedEntries = [],
    editMode = 'common',
  }: {
    selectedCollections?: string[];
    selectedEntries?: BulkTargetEntry[];
    editMode?: EditMode;
  }
): Promise<BulkTargetEntry[]> {
  if (editMode !== 'grid') {
    const targetsMap = new Map<string, BulkTargetEntry>();
    for (const colUid of selectedCollections) {
      if (!strapi.contentTypes?.[colUid]) continue;
      const entries = await strapi.documents(colUid as any).findMany();
      for (const entry of (entries || []) as any[]) {
        const key = `${colUid}@@@${entry.documentId}`;
        targetsMap.set(key, { uid: colUid, documentId: entry.documentId });
      }
    }
    for (const item of selectedEntries) {
      if (!item?.uid || !item?.documentId) continue;
      const key = `${item.uid}@@@${item.documentId}`;
      targetsMap.set(key, {
        ...item,
        uid: item.uid,
        documentId: item.documentId,
      });
    }
    return Array.from(targetsMap.values());
  }

  // Grid mode: group & merge occurrenceUpdates by (uid, documentId, locale) without whole-collection overwrite
  const gridTargetsMap = new Map<string, BulkTargetEntry>();

  for (const item of selectedEntries) {
    if (!item?.uid || !item?.documentId) continue;
    const key = `${item.uid}@@@${item.documentId}@@@${item.locale || ''}`;
    const existing = gridTargetsMap.get(key);

    if (!existing) {
      gridTargetsMap.set(key, {
        ...item,
        occurrenceUpdates: Array.isArray(item.occurrenceUpdates) ? [...item.occurrenceUpdates] : undefined,
      });
    } else {
      const mergedOccurrences = [
        ...(existing.occurrenceUpdates || []),
        ...(Array.isArray(item.occurrenceUpdates) ? item.occurrenceUpdates : []),
      ];
      gridTargetsMap.set(key, {
        ...existing,
        ...item,
        occurrenceUpdates: mergedOccurrences.length > 0 ? mergedOccurrences : existing.occurrenceUpdates,
      });
    }
  }

  return Array.from(gridTargetsMap.values());
}
