export interface AttributeMetaRich {
  depth: number;
  type: string;
  component?: string;
  isRelation?: boolean;
  customField?: string;
  options?: {
    scope?: string;
    disabledBehavior?: string;
    quotas?: Record<string, number>;
    items?: Array<{ value: string; label: string; maxAllowed?: number | null }>;
  };
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

export interface EnumeratedClientOccurrence {
  occurrenceKey: string;
  displayPath: string;
  segments: OccurrenceSegmentRef[];
  value: any;
  componentUid?: string;
  componentName?: string;
  componentId?: number | string;
  index: number;
  isMissingIntermediate: boolean;
}

export interface GridOccurrenceEdit {
  occurrenceKey: string;
  displayPath: string;
  segments: OccurrenceSegmentRef[];
  originalValue: any;
  value: any;
  fieldType: string;
  validationError?: string | null;
  touchedAt: number;
}

export interface GridRecordEdits {
  uid: string;
  documentId: string;
  locale?: string;
  status?: string;
  publishedAt?: string | null;
  recordLabel: string;
  occurrences: Record<string, GridOccurrenceEdit>;
}

export type GridEditsState = Record<string, GridRecordEdits>;

export interface RelationOptionItem {
  documentId: string;
  label: string;
}

export interface MediaOptionItem {
  id: number;
  documentId?: string;
  name: string;
  url?: string;
  mime?: string;
}

export interface ValidationRuleMeta {
  id: string;
  name: string;
  enabled: boolean;
  collectionUid?: string;
  targetField?: string;
  quotas?: Record<string, number>;
  includeRichTextHtml?: boolean;
  richTextFields?: string[];
}

export function formatComponentNameFriendly(compUid?: string): string {
  if (!compUid) return 'Component';
  const name = compUid.includes('.') ? compUid.split('.')[1] : compUid;
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function parseAttrPathClient(path: string): {
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
    if (/^\d+$/.test(selector)) {
      return { cleanPath, rootKey, subPath, targetIndex: parseInt(selector, 10) };
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

export function buildReadablePath(segments: OccurrenceSegmentRef[]): string {
  if (!segments || segments.length === 0) return '';
  return segments
    .map((seg) => {
      if (seg.index !== undefined) {
        const label = seg.componentUid ? ` ${formatComponentNameFriendly(seg.componentUid)}` : '';
        return `${seg.key}[#${seg.index}${label}]`;
      }
      return seg.key;
    })
    .join('.');
}

function getDirectProp(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  const camel = key.replace(/_([a-z0-9])/g, (_, l) => l.toUpperCase());
  if (obj[camel] !== undefined) return obj[camel];
  const snake = key.replace(/([A-Z])/g, '_$1').toLowerCase();
  if (obj[snake] !== undefined) return obj[snake];
  return undefined;
}

function resolveTailExistsOrValue(obj: any, parts: string[]): any {
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      for (const item of cur) {
        const found = resolveTailExistsOrValue(item, parts.slice(parts.indexOf(p)));
        if (found !== undefined) return found;
      }
      return undefined;
    }
    cur = getDirectProp(cur, p);
  }
  return cur;
}

/**
 * Recursively enumerates all editable occurrences for `attrPath` inside `entry`,
 * spanning scalar fields, single components (even when intermediate is null),
 * repeatable components, dynamic zones, and deep nested component chains.
 */
export function enumerateClientOccurrences(
  entry: any,
  attrPath: string,
  availableAttributes?: string[],
  attrMeta?: AttributeMetaRich
): EnumeratedClientOccurrence[] {
  if (!entry || !attrPath) return [];
  const parsed = parseAttrPathClient(attrPath);
  const parts = parsed.cleanPath.split('.').filter(Boolean);
  if (parts.length === 0) return [];

  if (parts.length === 1 && !parsed.targetComponentUid && parsed.targetIndex === undefined) {
    const val = getDirectProp(entry, parts[0]);
    return [
      {
        occurrenceKey: '__scalar__',
        displayPath: parts[0],
        segments: [{ key: parts[0] }],
        value: val !== undefined ? val : null,
        index: 0,
        isMissingIntermediate: false,
      },
    ];
  }

  const results: EnumeratedClientOccurrence[] = [];

  function walk(
    currentVal: any,
    remainingParts: string[],
    segments: OccurrenceSegmentRef[],
    missingIntermediate: boolean,
    firstArrayIndex: number | undefined,
    resolvedCompUid: string | undefined,
    resolvedCompId: number | string | undefined,
    isRootLevel: boolean
  ) {
    if (remainingParts.length === 0) return;

    const [head, ...tail] = remainingParts;

    // Leaf attribute
    if (tail.length === 0) {
      const val = currentVal && typeof currentVal === 'object' ? getDirectProp(currentVal, head) : undefined;
      const nextSegs = [...segments, { key: head }];
      results.push({
        occurrenceKey: buildOccurrenceKey(nextSegs),
        displayPath: buildReadablePath(nextSegs),
        segments: nextSegs,
        value: val !== undefined ? val : null,
        componentUid: resolvedCompUid,
        componentName: resolvedCompUid ? formatComponentNameFriendly(resolvedCompUid) : undefined,
        componentId: resolvedCompId,
        index: firstArrayIndex ?? 0,
        isMissingIntermediate: missingIntermediate,
      });
      return;
    }

    const nextVal = currentVal && typeof currentVal === 'object' ? getDirectProp(currentVal, head) : undefined;

    const isExpectingRootArray =
      isRootLevel && (attrMeta?.rootType === 'dynamiczone' || attrMeta?.rootRepeatable);

    if (Array.isArray(nextVal)) {
      const subPath = tail.join('.');
      nextVal.forEach((item: any, idx: number) => {
        if (!item || typeof item !== 'object') return;
        if (isRootLevel && parsed.targetIndex !== undefined && idx !== parsed.targetIndex) return;
        if (isRootLevel && parsed.targetComponentUid && item.__component !== parsed.targetComponentUid) return;

        // If inside a dynamic zone (items carry __component), check block applicability
        if (item.__component && isRootLevel) {
          const scopedAttr = `${head}[${item.__component}].${subPath}`;
          const supportedBySchema = Array.isArray(availableAttributes) && availableAttributes.includes(scopedAttr);
          const presentInData = resolveTailExistsOrValue(item, tail) !== undefined;
          if (!supportedBySchema && !presentInData) {
            return;
          }
        }

        const seg: OccurrenceSegmentRef = {
          key: head,
          index: idx,
          componentId: item.id,
          componentUid: item.__component || (isRootLevel ? attrMeta?.component : undefined),
        };

        walk(
          item,
          tail,
          [...segments, seg],
          missingIntermediate,
          firstArrayIndex ?? idx,
          item.__component || resolvedCompUid,
          resolvedCompId ?? item.id,
          false
        );
      });
      return;
    }

    // If root array (DZ / repeatable) is currently empty/null, there are no item instances to edit
    if (isExpectingRootArray) {
      return;
    }

    // Single component or null intermediate object: continue descending so user can initialize it
    const isMissing = !nextVal || typeof nextVal !== 'object';
    const seg: OccurrenceSegmentRef = {
      key: head,
      componentId: !isMissing ? nextVal.id : undefined,
      componentUid: !isMissing && nextVal.__component ? nextVal.__component : undefined,
    };

    walk(
      isMissing ? undefined : nextVal,
      tail,
      [...segments, seg],
      missingIntermediate || isMissing,
      firstArrayIndex,
      resolvedCompUid,
      resolvedCompId,
      false
    );
  }

  walk(entry, parts, [], false, undefined, undefined, undefined, true);
  return results;
}

export function normalizeDisplayCompareValue(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && v.isRelation) return v;
  return v;
}

export function areClientValuesEqual(a: any, b: any): boolean {
  const na = normalizeDisplayCompareValue(a);
  const nb = normalizeDisplayCompareValue(b);
  if (na === nb) return true;
  if (na === null || nb === null) return na === nb;
  if (typeof na === 'object' || typeof nb === 'object') {
    try {
      return JSON.stringify(na) === JSON.stringify(nb);
    } catch {
      return false;
    }
  }
  return String(na) === String(nb);
}

export function extractRelationEditCommand(rawVal: any, currentDisplayVal?: any, isMulti = false): {
  mode: 'set' | 'connect' | 'disconnect' | 'clear';
  documentIds: string[];
  label: string;
} {
  if (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal) && rawVal.mode) {
    return {
      mode: rawVal.mode,
      documentIds: Array.isArray(rawVal.documentIds) ? rawVal.documentIds : rawVal.documentId ? [rawVal.documentId] : [],
      label: rawVal.label || '',
    };
  }
  if (Array.isArray(rawVal)) {
    return {
      mode: 'set',
      documentIds: rawVal.map((r: any) => r?.documentId).filter(Boolean),
      label: rawVal.map((r: any) => r?.name || r?.title || r?.email || r?.documentId).filter(Boolean).join(', '),
    };
  }
  if (rawVal && typeof rawVal === 'object' && rawVal.documentId) {
    return {
      mode: 'set',
      documentIds: [rawVal.documentId],
      label: rawVal.name || rawVal.title || rawVal.email || rawVal.documentId,
    };
  }
  if (typeof rawVal === 'string') {
    try {
      const parsed = JSON.parse(rawVal);
      if (parsed && typeof parsed === 'object' && parsed.mode) {
        return {
          mode: parsed.mode,
          documentIds: Array.isArray(parsed.documentIds) ? parsed.documentIds : [],
          label: parsed.label || '',
        };
      }
    } catch {}
  }
  if (currentDisplayVal) {
    return extractRelationEditCommand(currentDisplayVal, undefined, isMulti);
  }
  return { mode: 'clear', documentIds: [], label: '' };
}

export function validateClientFieldValue(value: any, attrMeta?: AttributeMetaRich): string | null {
  if (!attrMeta) return null;
  const type = String(attrMeta.type || '').toLowerCase();

  const isEmpty = value === null || value === undefined || value === '';
  if (attrMeta.required && isEmpty && type !== 'boolean') {
    return 'Required field';
  }
  if (attrMeta.required && type === 'boolean' && (value === null || value === undefined || value === '')) {
    return 'Required boolean';
  }
  if (isEmpty) return null;

  switch (type) {
    case 'integer':
    case 'biginteger': {
      const s = String(value).trim();
      if (!/^-?\d+$/.test(s)) return 'Must be a valid integer';
      if (type === 'integer') {
        const n = Number(s);
        if (!Number.isSafeInteger(n)) return 'Integer out of range';
        if (typeof attrMeta.min === 'number' && n < attrMeta.min) return `Min ${attrMeta.min}`;
        if (typeof attrMeta.max === 'number' && n > attrMeta.max) return `Max ${attrMeta.max}`;
      }
      return null;
    }
    case 'float':
    case 'decimal': {
      const s = String(value).trim();
      if (!/^-?\d+(\.\d+)?$/.test(s)) return 'Must be a valid number';
      const n = Number(s);
      if (typeof attrMeta.min === 'number' && n < attrMeta.min) return `Min ${attrMeta.min}`;
      if (typeof attrMeta.max === 'number' && n > attrMeta.max) return `Max ${attrMeta.max}`;
      return null;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return null;
      const lower = String(value).trim().toLowerCase();
      if (!['true', 'false', '1', '0'].includes(lower)) return 'Must be true or false';
      return null;
    }
    case 'enumeration': {
      if (Array.isArray(attrMeta.enumOptions) && !attrMeta.enumOptions.includes(String(value))) {
        return `Must be one of: ${attrMeta.enumOptions.join(', ')}`;
      }
      return null;
    }
    case 'email': {
      const s = String(value).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Invalid email';
      return null;
    }
    case 'uid': {
      const s = String(value).trim();
      if (!/^[A-Za-z0-9\-_.~]*$/.test(s)) return 'Invalid UID format';
      return null;
    }
    case 'json':
    case 'blocks': {
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (type === 'blocks' && parsed !== null && !Array.isArray(parsed)) {
            return 'Blocks must be a JSON array';
          }
        } catch (err: any) {
          return `Invalid JSON: ${err.message}`;
        }
      } else if (type === 'blocks' && !Array.isArray(value)) {
        return 'Blocks must be an array';
      }
      return null;
    }
    case 'date':
    case 'datetime': {
      const d = new Date(String(value).trim());
      if (isNaN(d.getTime())) return 'Invalid date/datetime';
      return null;
    }
    case 'time': {
      if (!/^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(String(value).trim())) {
        return 'Invalid time (HH:mm or HH:mm:ss)';
      }
      return null;
    }
    default: {
      const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (typeof attrMeta.minLength === 'number' && str.length < attrMeta.minLength) {
        return `Min length ${attrMeta.minLength}`;
      }
      if (typeof attrMeta.maxLength === 'number' && str.length > attrMeta.maxLength) {
        return `Max length ${attrMeta.maxLength}`;
      }
      if (attrMeta.regex) {
        try {
          if (!new RegExp(attrMeta.regex).test(str)) return `Must match /${attrMeta.regex}/`;
        } catch {}
      }
      return null;
    }
  }
}

export function cleanRuleKey(str: string): string {
  return (str || '').replace(/[-_]/g, '').toLowerCase().trim();
}

export function matchesFieldRulePath(attrPath: string, targetField?: string): boolean {
  if (!attrPath || !targetField) return false;
  const cleanAttr = parseAttrPathClient(attrPath).cleanPath;
  const parts = cleanAttr.split('.').map(cleanRuleKey).filter(Boolean);
  const leaf = parts[parts.length - 1] || '';
  const targetClean = cleanRuleKey(targetField.replace(/^api::/i, ''));
  if (leaf === targetClean || cleanRuleKey(cleanAttr) === targetClean) return true;
  const tSegs = targetField.replace(/^api::/i, '').split('.').map(cleanRuleKey).filter(Boolean);
  if (tSegs.length === 1) return leaf === tSegs[0];
  return tSegs.every((t) => t === '*' || parts.includes(t));
}

/**
 * Computes real-time usage counts per quota value across all occurrences of `entry`
 * overlaid with unsaved `recordEdits`, excluding `excludeOccurrenceKey` for dropdown feedback.
 */
export function computeRecordQuotaUsage(
  entry: any,
  attrPath: string,
  excludeOccurrenceKey: string,
  recordEdits: GridRecordEdits | undefined,
  colAttributes: string[] | undefined,
  attrMeta: AttributeMetaRich | undefined,
  validationRules: ValidationRuleMeta[]
): { usageCounts: Record<string, number>; quotas: Record<string, number> } {
  const occs = enumerateClientOccurrences(entry, attrPath, colAttributes, attrMeta);
  const usageCounts: Record<string, number> = {};

  for (const occ of occs) {
    if (occ.occurrenceKey === excludeOccurrenceKey) continue;
    const edited = recordEdits?.occurrences?.[occ.occurrenceKey];
    const effectiveVal = edited ? edited.value : occ.value;
    if (effectiveVal !== undefined && effectiveVal !== null && String(effectiveVal).trim() !== '') {
      const k = String(effectiveVal).toLowerCase().trim();
      usageCounts[k] = (usageCounts[k] || 0) + 1;
    }
  }

  const quotas: Record<string, number> = {};
  if (attrMeta?.options?.items) {
    for (const item of attrMeta.options.items) {
      if (typeof item.maxAllowed === 'number' && item.maxAllowed > 0) {
        quotas[item.value.toLowerCase().trim()] = item.maxAllowed;
      }
    }
  }
  if (attrMeta?.options?.quotas) {
    for (const [k, v] of Object.entries(attrMeta.options.quotas)) {
      if (typeof v === 'number' && v > 0) quotas[k.toLowerCase().trim()] = v;
    }
  }
  for (const rule of validationRules || []) {
    if (!rule.enabled) continue;
    if (rule.targetField && !matchesFieldRulePath(attrPath, rule.targetField)) continue;
    for (const [k, v] of Object.entries(rule.quotas || {})) {
      if (typeof v === 'number' && v > 0) quotas[k.toLowerCase().trim()] = v;
    }
  }

  return { usageCounts, quotas };
}

export function serializeGridTargets(
  gridEdits: GridEditsState,
  selectedEntries: Record<string, boolean>,
  collectionPages: Record<string, any> = {},
  attrMeta?: AttributeMetaRich
): {
  targets: any[];
  totalEditCount: number;
  hasValidationErrors: boolean;
} {
  const targets: any[] = [];
  let totalEditCount = 0;
  let hasValidationErrors = false;

  for (const [key, rec] of Object.entries(gridEdits)) {
    if (!selectedEntries[key]) continue;
    const occEntries = Object.values(rec.occurrences || {});
    if (occEntries.length === 0) continue;

    for (const occ of occEntries) {
      if (occ.validationError) {
        hasValidationErrors = true;
      }
    }

    const colPage = collectionPages[rec.uid];
    const cachedEntry = colPage?.entries?.find((e: any) => e.documentId === rec.documentId);

    const targetObj: any = {
      uid: rec.uid,
      documentId: rec.documentId,
      status: cachedEntry?.status ?? rec.status,
      publishedAt: cachedEntry?.publishedAt ?? rec.publishedAt,
      locale: cachedEntry?.locale ?? rec.locale,
    };

    const isScalarOnly = occEntries.length === 1 && occEntries[0].occurrenceKey === '__scalar__' && !attrMeta?.rootType;
    if (isScalarOnly) {
      targetObj.overrideValue = occEntries[0].value;
      totalEditCount += 1;
    } else {
      targetObj.occurrenceUpdates = occEntries.map((occ) => ({
        occurrenceKey: occ.occurrenceKey,
        segments: occ.segments,
        dynamicZoneIndex: occ.segments?.[0]?.index,
        componentId: occ.segments?.find((s) => s.componentId !== undefined)?.componentId,
        componentUid: occ.segments?.find((s) => s.componentUid)?.componentUid,
        value: occ.value,
      }));
      totalEditCount += occEntries.length;
    }

    targets.push(targetObj);
  }

  return { targets, totalEditCount, hasValidationErrors };
}
