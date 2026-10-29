import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import {
  Box,
  Flex,
  Typography,
  Button,
  TextInput,
  SingleSelect,
  SingleSelectOption,
  Checkbox,
  Badge,
  Alert,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Combobox,
  ComboboxOption,
  Field,
  Loader,
} from '@strapi/design-system';
import { Play, ArrowClockwise, Check, Download, Eye, Cog } from '@strapi/icons';
import ValidationRulesTab from './ValidationRulesTab';
import CsvManagerTab from './CsvManagerTab';
import ProcessingDashboardModal from '../components/ProcessingDashboardModal';
import BulkUpdatePreviewModal from '../components/BulkUpdatePreviewModal';
import CheckerReviewModal from '../components/CheckerReviewModal';
import { isAbortError } from '../utils/isAbortError';
import { getEntryLifecycleStatus } from '../utils/lifecycleStatus';
export { getEntryLifecycleStatus } from '../utils/lifecycleStatus';

interface Entry {
  id: number | string;
  documentId: string;
  status?: 'draft' | 'published' | 'modified' | 'unknown' | 'pending_review' | string;
  publishedAt?: string | null;
  updatedAt?: string | null;
  [key: string]: any;
}

export interface RelationMeta {
  isRelation: boolean;
  relationType: string;
  targetUid: string;
  targetDisplayName: string;
  isMulti: boolean;
}

interface CollectionModel {
  uid: string;
  kind?: string;
  isSingleType?: boolean;
  draftAndPublish?: boolean;
  singularName: string;
  pluralName: string;
  displayName: string;
  attributes: string[];
  attributesMeta?: Record<string, { depth: number; type: string; component?: string; isRelation?: boolean }>;
  relations?: Record<string, RelationMeta>;
  totalEntries?: number;
  entries: Entry[];
}

interface CollectionPageState {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  entries: Entry[];
  loading: boolean;
}

interface UpdateResult {
  uid: string;
  collectionName: string;
  documentId: string;
  label: string;
  attribute: string;
  oldValue?: any;
  newValue?: any;
  status: 'updated' | 'skipped' | 'error';
  message: string;
}

interface AuditRecord {
  id: number | string;
  documentId: string;
  batchId: string;
  attribute: string;
  value: string;
  userEmail: string;
  userName: string;
  updatedCount: number;
  skippedCount: number;
  totalTargets: number;
  publishOnApproval?: boolean;
  publishStrategy?: 'safe' | 'all';
  unreviewedConsent?: boolean;
  diffs: UpdateResult[];
  isRolledBack: boolean;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  executedAt: string;
}

interface ExecutionWindowInfo {
  enabled: boolean;
  timeZone: string;
  businessHours: {
    start: string;
    end: string;
  };
  offPeakStartTime: string;
  autoQueueDuringBusinessHours: boolean;
  isBusinessHours: boolean;
  currentServerTime: string;
  policyMessage: string;
}

interface PendingBatch {
  id: string;
  createdAt: string;
  createdBy: { id?: string | number; email?: string; firstname?: string; lastname?: string; username?: string };
  payload: {
    action?: string;
    attribute: string;
    value: string;
    selectedEntries?: Array<{ uid: string; documentId: string; dynamicZoneIndexes?: number[] }>;
    selectedCollections?: string[];
    isRegex?: boolean;
    regexPattern?: string;
    publishOnApproval?: boolean;
    publishStrategy?: 'safe' | 'all';
    unreviewedConsent?: boolean;
    unreviewedCount?: number;
    rows?: any[];
    uid?: string;
    options?: any;
  };
  summary: {
    attribute: string;
    value: string;
    totalTargets: number;
    collectionBreakdown: Record<string, number>;
    publishOnApproval?: boolean;
    publishStrategy?: 'safe' | 'all';
    unreviewedConsent?: boolean;
    unreviewedCount?: number;
  };
  status: 'pending_approval' | 'queued_offpeak' | 'approved' | 'rejected' | 'executed';
  executionMode: 'maker_checker' | 'queue_offpeak' | 'immediate';
  scheduledFor?: string;
  makerNotes?: string;
  approval?: {
    checkerUser?: { id?: string | number; email?: string; firstname?: string; lastname?: string; username?: string };
    decisionDate?: string;
    rejectionReason?: string;
  };
  executionResult?: any;
}

export interface ColumnDef {
  key: string;
  label: string;
  sortable?: boolean;
  isPermanent?: boolean;
  defaultVisible: boolean;
}

/**
 * Parses dynamic zone dot or bracket notation paths:
 * e.g. "blocks.title", "blocks[shared.heading].title", or "blocks[0].title"
 */
export function parseDynamicZonePath(path: string): {
  cleanPath: string;
  rootKey: string;
  subPath: string;
  targetComponentUid?: string;
  targetIndex?: number;
} {
  if (!path) return { cleanPath: '', rootKey: '', subPath: '' };
  const bracketMatch = path.match(/^([^.[]+)\[([^\]]+)\]\.(.+)$/);
  if (bracketMatch) {
    const rootKey = bracketMatch[1];
    const selector = bracketMatch[2];
    const subPath = bracketMatch[3];
    const cleanPath = `${rootKey}.${subPath}`;
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

/**
 * Formats a component UID into a friendly readable label (e.g. "shared.featured-section" -> "Featured Section")
 */
export function formatComponentName(compUid?: string): string {
  if (!compUid) return 'Component';
  const name = compUid.includes('.') ? compUid.split('.')[1] : compUid;
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface DynamicZoneItemMatch {
  index: number;
  componentUid?: string;
  componentName?: string;
  value: any;
  path: string;
}

/**
 * Extracts all matching instances of a nested property across dynamic zone components or repeatable arrays.
 */
export function getAllNestedValues(
  obj: any,
  path: string,
  availableAttributes?: string[]
): DynamicZoneItemMatch[] {
  if (!obj || !path) return [];
  const parsed = parseDynamicZonePath(path);
  const parts = parsed.cleanPath.split('.');
  const [head, ...tail] = parts;

  const rootTarget = getPropertyValue(obj, head);

  // If rootTarget is an Array (Dynamic Zone or Repeatable Component)
  if (Array.isArray(rootTarget)) {
    const results: DynamicZoneItemMatch[] = [];
    rootTarget.forEach((item, idx) => {
      if (!item || typeof item !== 'object') return;
      if (parsed.targetIndex !== undefined && idx !== parsed.targetIndex) return;
      if (parsed.targetComponentUid && item.__component !== parsed.targetComponentUid) return;

      const subPath = tail.join('.');
      const scopedPath = item.__component ? `${head}[${item.__component}].${subPath}` : '';
      const isSupported = availableAttributes ? availableAttributes.includes(scopedPath) : false;

      const subVal = tail.length > 0 ? getNestedValue(item, subPath) : item;
      if (subVal !== undefined || isSupported) {
        results.push({
          index: idx,
          componentUid: item.__component,
          componentName: formatComponentName(item.__component),
          value: subVal !== undefined ? subVal : null,
          path: `${head}[#${idx}${item.__component ? ` ${formatComponentName(item.__component)}` : ''}].${subPath}`,
        });
      }
    });
    return results;
  }

  // Not an array, standard object resolution
  const singleVal = getNestedValue(obj, parsed.cleanPath);
  if (singleVal !== undefined) {
    return [
      {
        index: 0,
        value: singleVal,
        path: parsed.cleanPath,
      },
    ];
  }

  return [];
}

/**
 * Robust property value resolver:
 * Matches direct key, snake_case <-> camelCase aliases (e.g. updated_at <-> updatedAt, created_at <-> createdAt),
 * and case-insensitive fallback.
 */
export function getPropertyValue(target: any, key: string): any {
  if (!target || typeof target !== 'object' || !key) return undefined;

  // 1. Direct match
  if (target[key] !== undefined && target[key] !== null) return target[key];

  // 2. snake_case -> camelCase (e.g. updated_at -> updatedAt, created_at -> createdAt)
  const camelKey = key.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());
  if (target[camelKey] !== undefined && target[camelKey] !== null) return target[camelKey];

  // 3. camelCase -> snake_case (e.g. updatedAt -> updated_at, createdAt -> created_at)
  const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
  if (target[snakeKey] !== undefined && target[snakeKey] !== null) return target[snakeKey];

  // 4. Case-insensitive / underscore-insensitive match
  const lowerKey = key.toLowerCase();
  const lowerNoUnderscore = lowerKey.replace(/_/g, '');
  const matchedKey = Object.keys(target).find((k) => {
    const kLower = k.toLowerCase();
    return kLower === lowerKey || kLower.replace(/_/g, '') === lowerNoUnderscore;
  });
  if (matchedKey && target[matchedKey] !== undefined && target[matchedKey] !== null) {
    return target[matchedKey];
  }

  // 5. Fallback: check key presence
  if (key in target) return target[key];
  if (camelKey in target) return target[camelKey];
  if (snakeKey in target) return target[snakeKey];

  return undefined;
}

/**
 * Safely resolves a nested dot-notation property across objects and dynamic zone / repeatable component arrays.
 */
export function getNestedValue(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  const parsed = parseDynamicZonePath(path);
  const parts = parsed.cleanPath.split('.');

  function extract(current: any, remainingParts: string[]): any {
    if (current === undefined || current === null) return undefined;
    if (remainingParts.length === 0) return current;

    const [head, ...tail] = remainingParts;

    if (Array.isArray(current)) {
      if (/^\d+$/.test(head)) {
        return extract(current[parseInt(head, 10)], tail);
      }
      for (let idx = 0; idx < current.length; idx++) {
        const item = current[idx];
        if (parsed.targetIndex !== undefined && idx !== parsed.targetIndex) continue;
        if (parsed.targetComponentUid && item?.__component !== parsed.targetComponentUid) continue;
        const found = extract(getPropertyValue(item, head), tail);
        if (found !== undefined && found !== null) return found;
      }
      return undefined;
    }

    return extract(getPropertyValue(current, head), tail);
  }

  return extract(obj, parts);
}

/**
 * Flat helper: Generates the list of available columns for a given collection model.
 * Zero deep nesting: returns a flat array of ColumnDef.
 */
export function getAvailableColumnsForCollection(
  col: CollectionModel,
  selectedAttribute: string,
  searchAttribute?: string
): ColumnDef[] {
  const cols: ColumnDef[] = [
    {
      key: 'select',
      label: 'Select',
      isPermanent: true,
      defaultVisible: true,
    },
    {
      key: 'identifier',
      label: 'Identifier',
      sortable: !col.isSingleType,
      defaultVisible: true,
    },
  ];

  // Schema-specific attributes
  const candidateAttrs = col.attributes || [];
  candidateAttrs.forEach((attr) => {
    if (attr === 'name' || attr === 'title' || attr === selectedAttribute || (searchAttribute && attr === searchAttribute)) {
      return;
    }
    let formattedLabel = attr;
    if (attr === 'updated_at' || attr === 'updatedAt') {
      formattedLabel = 'Updated At';
    } else if (attr === 'created_at' || attr === 'createdAt') {
      formattedLabel = 'Created At';
    } else if (attr === 'published_at' || attr === 'publishedAt') {
      formattedLabel = 'Published At';
    } else {
      const bracketMatch = attr.match(/^([^.[]+)\[([^\]]+)\]\.(.+)$/);
      if (bracketMatch) {
        const root = bracketMatch[1].charAt(0).toUpperCase() + bracketMatch[1].slice(1);
        const comp = formatComponentName(bracketMatch[2]);
        const sub = bracketMatch[3].split('.').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' > ');
        formattedLabel = `${root} [${comp}] > ${sub}`;
      } else if (attr.includes('.')) {
        formattedLabel = attr.split('.').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' > ');
      } else {
        formattedLabel = attr.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
      }
    }

    cols.push({
      key: `attr_${attr}`,
      label: formattedLabel,
      sortable: !col.isSingleType,
      defaultVisible: ['department', 'email', 'location', 'updated_at', 'updatedAt'].includes(attr),
    });
  });

  // Ensure system timestamp columns are available to show/hide in the column picker if not already present
  const hasUpdatedAt = candidateAttrs.some((a) => a === 'updatedAt' || a === 'updated_at');
  const hasCreatedAt = candidateAttrs.some((a) => a === 'createdAt' || a === 'created_at');
  const hasPublishedAt = candidateAttrs.some((a) => a === 'publishedAt' || a === 'published_at');

  if (!hasUpdatedAt) {
    cols.push({
      key: 'attr_updatedAt',
      label: 'Updated At',
      sortable: !col.isSingleType,
      defaultVisible: false,
    });
  }
  if (!hasCreatedAt) {
    cols.push({
      key: 'attr_createdAt',
      label: 'Created At',
      sortable: !col.isSingleType,
      defaultVisible: false,
    });
  }
  if (!hasPublishedAt && col.draftAndPublish) {
    cols.push({
      key: 'attr_publishedAt',
      label: 'Published At',
      sortable: !col.isSingleType,
      defaultVisible: false,
    });
  }

  // Dedicated search attribute column if searchAttribute differs from selectedAttribute
  if (searchAttribute && searchAttribute !== selectedAttribute) {
    let formattedSearchLabel = searchAttribute;
    const bracketMatch = searchAttribute.match(/^([^.[]+)\[([^\]]+)\]\.(.+)$/);
    if (bracketMatch) {
      const root = bracketMatch[1].charAt(0).toUpperCase() + bracketMatch[1].slice(1);
      const comp = formatComponentName(bracketMatch[2]);
      const sub = bracketMatch[3].split('.').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' > ');
      formattedSearchLabel = `${root} [${comp}] > ${sub}`;
    } else if (searchAttribute.includes('.')) {
      formattedSearchLabel = searchAttribute.split('.').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' > ');
    }

    cols.push({
      key: 'search_attr',
      label: `Search: "${formattedSearchLabel}"`,
      sortable: !col.isSingleType && col.attributes.includes(searchAttribute),
      defaultVisible: true,
    });
  }

  // Target attribute column (only if an update attribute has been selected)
  if (selectedAttribute && selectedAttribute.trim()) {
    let formattedTargetLabel = selectedAttribute;
    const bracketMatch = selectedAttribute.match(/^([^.[]+)\[([^\]]+)\]\.(.+)$/);
    if (bracketMatch) {
      const root = bracketMatch[1].charAt(0).toUpperCase() + bracketMatch[1].slice(1);
      const comp = formatComponentName(bracketMatch[2]);
      const sub = bracketMatch[3].split('.').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' > ');
      formattedTargetLabel = `${root} [${comp}] > ${sub}`;
    } else if (selectedAttribute.includes('.')) {
      formattedTargetLabel = selectedAttribute.split('.').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' > ');
    }

    const targetLabel = searchAttribute && searchAttribute !== selectedAttribute
      ? `Update Target: "${formattedTargetLabel}"`
      : `Current "${formattedTargetLabel}"`;

    cols.push({
      key: 'target_attr',
      label: targetLabel,
      sortable: !col.isSingleType && col.attributes.includes(selectedAttribute),
      defaultVisible: true,
    });
  }

  // Status column
  cols.push({
    key: 'status',
    label: 'Status',
    sortable: false,
    defaultVisible: true,
  });

  return cols;
}

export interface SortOptionItem {
  field: string;
  order: 'asc' | 'desc';
  label: string;
  columnLabel: string;
  group: 'timestamps' | 'system' | 'attributes';
}

/**
 * Returns a human-friendly display label of the active sort state.
 */
export function getActiveSortLabel(
  currentSort: { field: string; order: 'asc' | 'desc' },
  col: CollectionModel
): string {
  const f = currentSort.field;
  const o = currentSort.order;
  const dir = o === 'asc' ? '▲' : '▼';
  if (f === 'updatedAt' || f === 'updated_at') {
    return `Updated: ${o === 'desc' ? 'Newest' : 'Oldest'} ${dir}`;
  }
  if (f === 'createdAt' || f === 'created_at') {
    return `Created: ${o === 'desc' ? 'Newest' : 'Oldest'} ${dir}`;
  }
  if (f === 'publishedAt' || f === 'published_at') {
    return `Published: ${o === 'desc' ? 'Newest' : 'Oldest'} ${dir}`;
  }
  if (f === 'id') {
    return `ID: ${o === 'desc' ? 'Highest' : 'Lowest'} ${dir}`;
  }
  let attrLabel = f;
  if (f.includes('.')) {
    attrLabel = f.split('.').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' > ');
  } else {
    attrLabel = f.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  }
  return `${attrLabel} (${o === 'asc' ? 'A → Z' : 'Z → A'} ${dir})`;
}

/**
 * Generates a complete, searchable list of all sortable columns and directions for a collection.
 */
export function getSortOptionsForCollection(
  col: CollectionModel,
  selectedAttribute: string,
  searchAttribute?: string
): SortOptionItem[] {
  const options: SortOptionItem[] = [];

  // 1. Timestamps (Newest / Oldest)
  const hasCustomUpdatedAt = col.attributes?.includes('updated_at');
  const updatedField = hasCustomUpdatedAt ? 'updated_at' : 'updatedAt';
  options.push({
    field: updatedField,
    order: 'desc',
    label: 'Updated At (Newest First ↓)',
    columnLabel: 'Updated At',
    group: 'timestamps',
  });
  options.push({
    field: updatedField,
    order: 'asc',
    label: 'Updated At (Oldest First ↑)',
    columnLabel: 'Updated At',
    group: 'timestamps',
  });

  const hasCustomCreatedAt = col.attributes?.includes('created_at');
  const createdField = hasCustomCreatedAt ? 'created_at' : 'createdAt';
  options.push({
    field: createdField,
    order: 'desc',
    label: 'Created At (Newest First ↓)',
    columnLabel: 'Created At',
    group: 'timestamps',
  });
  options.push({
    field: createdField,
    order: 'asc',
    label: 'Created At (Oldest First ↑)',
    columnLabel: 'Created At',
    group: 'timestamps',
  });

  if (col.draftAndPublish) {
    const hasCustomPublishedAt = col.attributes?.includes('published_at');
    const publishedField = hasCustomPublishedAt ? 'published_at' : 'publishedAt';
    options.push({
      field: publishedField,
      order: 'desc',
      label: 'Published At (Newest First ↓)',
      columnLabel: 'Published At',
      group: 'timestamps',
    });
    options.push({
      field: publishedField,
      order: 'asc',
      label: 'Published At (Oldest First ↑)',
      columnLabel: 'Published At',
      group: 'timestamps',
    });
  }

  // 2. System Identifiers
  options.push({
    field: 'id',
    order: 'desc',
    label: 'Entry ID (Highest First ↓)',
    columnLabel: 'ID',
    group: 'system',
  });
  options.push({
    field: 'id',
    order: 'asc',
    label: 'Entry ID (Lowest First ↑)',
    columnLabel: 'ID',
    group: 'system',
  });

  // 3. Collection Attributes
  const systemKeywords = [
    'createdat',
    'created_at',
    'updatedat',
    'updated_at',
    'publishedat',
    'published_at',
    'id',
    'documentid',
  ];
  const attrs = (col.attributes || []).filter((a) => !systemKeywords.includes(a.toLowerCase()));

  attrs.forEach((attr) => {
    let formattedLabel = attr;
    if (attr.includes('.')) {
      formattedLabel = attr.split('.').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' > ');
    } else {
      formattedLabel = attr.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
    }

    options.push({
      field: attr,
      order: 'asc',
      label: `${formattedLabel} (A → Z / Lowest ↑)`,
      columnLabel: formattedLabel,
      group: 'attributes',
    });
    options.push({
      field: attr,
      order: 'desc',
      label: `${formattedLabel} (Z → A / Highest ↓)`,
      columnLabel: formattedLabel,
      group: 'attributes',
    });
  });

  return options;
}

/**
 * Flat helper: Renders table header cell without nested JSX.
 */
function renderHeaderCell(
  colDef: ColumnDef,
  col: CollectionModel,
  currentSort: { field: string; order: 'asc' | 'desc' },
  selectedAttribute: string,
  searchAttribute: string,
  onSort: (colUid: string, field: string) => void
) {
  if (colDef.key === 'select') {
    return (
      <Th key="select" style={{ width: 48 }}>
        <Typography variant="sigma">Select</Typography>
      </Th>
    );
  }

  const isCurrentSorted =
    (colDef.key === 'identifier' && (currentSort.field === 'name' || currentSort.field === 'title' || currentSort.field === 'id')) ||
    (colDef.key === 'search_attr' && currentSort.field === searchAttribute) ||
    (colDef.key === 'target_attr' && currentSort.field === selectedAttribute) ||
    (colDef.key.startsWith('attr_') && (
      currentSort.field === colDef.key.replace('attr_', '') ||
      (currentSort.field === 'updatedAt' && colDef.key === 'attr_updated_at') ||
      (currentSort.field === 'updated_at' && colDef.key === 'attr_updatedAt') ||
      (currentSort.field === 'createdAt' && colDef.key === 'attr_created_at') ||
      (currentSort.field === 'created_at' && colDef.key === 'attr_createdAt') ||
      (currentSort.field === 'publishedAt' && colDef.key === 'attr_published_at') ||
      (currentSort.field === 'published_at' && colDef.key === 'attr_publishedAt')
    ));

  const sortArrow = isCurrentSorted ? (currentSort.order === 'asc' ? '▲' : '▼') : '⇅';

  const handleClick = () => {
    if (!colDef.sortable) return;
    if (colDef.key === 'identifier') {
      const field = col.attributes.includes('name') ? 'name' : col.attributes.includes('title') ? 'title' : 'createdAt';
      onSort(col.uid, field);
    } else if (colDef.key === 'search_attr') {
      onSort(col.uid, searchAttribute);
    } else if (colDef.key === 'target_attr') {
      onSort(col.uid, selectedAttribute);
    } else if (colDef.key.startsWith('attr_')) {
      onSort(col.uid, colDef.key.replace('attr_', ''));
    }
  };

  return (
    <Th
      key={colDef.key}
      style={{ cursor: colDef.sortable ? 'pointer' : 'default', userSelect: 'none' }}
      onClick={handleClick}
    >
      <Flex gap={1} alignItems="center">
        <Typography variant="sigma">{colDef.label}</Typography>
        {colDef.sortable && (
          <Typography variant="pi" textColor="neutral500">
            {sortArrow}
          </Typography>
        )}
      </Flex>
    </Th>
  );
}

/**
 * Flat helper: Formats attribute values, gracefully handling timestamps, relation objects, and arrays.
 */
export function formatDisplayValue(val: any): string {
  if (val === undefined || val === null || val === '') {
    return '(empty / not set)';
  }
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? '(invalid date)' : val.toLocaleString();
  }
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString();
    }
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return '(empty / unlinked)';
    return val
      .map((item) =>
        typeof item === 'object' && item !== null
          ? item.name || item.title || item.email || item.username || item.documentId || item.id
          : String(item)
      )
      .join(', ');
  }
  if (typeof val === 'object' && val !== null) {
    if (val.isRelation && val.display) return val.display;
    return val.name || val.title || val.email || val.username || val.documentId || val.id || JSON.stringify(val);
  }
  return String(val);
}

/**
 * Flat helper: Renders a single cell content using clean early returns.
 * Zero deep nesting.
 */
function renderCellContent(
  colDef: ColumnDef,
  entry: Entry,
  col: CollectionModel,
  selectedAttribute: string,
  searchAttribute: string,
  isMatch: boolean,
  hasAttr: boolean,
  isSelected: boolean,
  onToggleSelect: () => void,
  pendingBatches: PendingBatch[] = [],
  isDzExpanded = false,
  onToggleExpandDz?: () => void,
  filterQuery = ''
): React.ReactNode {
  switch (colDef.key) {
    case 'select':
      return (
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggleSelect}
        />
      );

    case 'identifier': {
      const mainText = entry.name || entry.title || `Entry #${entry.id || entry.documentId}`;
      const dzField = Object.keys(entry).find(
        (k) => Array.isArray(entry[k]) && entry[k].length > 0 && entry[k].some((item: any) => item && item.__component)
      );
      const dzItemsCount = dzField ? entry[dzField].length : 0;

      return (
        <Box>
          <Typography fontWeight="semiBold">{mainText}</Typography>
          {entry.email && (
            <Typography variant="pi" textColor="neutral500" display="block">
              {entry.email}
            </Typography>
          )}
          {dzItemsCount > 0 && (
            <Box marginTop={1}>
              <Button
                variant="ghost"
                size="S"
                onClick={onToggleExpandDz}
                style={{
                  padding: '2px 6px',
                  height: 'auto',
                  fontSize: '0.72rem',
                  color: isDzExpanded ? '#4945ff' : '#666687',
                  backgroundColor: isDzExpanded ? 'rgba(73, 69, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)',
                  borderRadius: 4,
                }}
              >
                {isDzExpanded
                  ? `▲ Hide ${dzField} (${dzItemsCount} blocks)`
                  : `▼ View ${dzField} (${dzItemsCount} blocks)`}
              </Button>
            </Box>
          )}
        </Box>
      );
    }

    case 'search_attr': {
      const matches = getAllNestedValues(entry, searchAttribute, col?.attributes);
      if (matches.length === 0) {
        return (
          <Typography textColor="neutral500" style={{ fontStyle: 'italic' }}>
            (empty / not set)
          </Typography>
        );
      }
      if (matches.length === 1 && !matches[0].componentUid) {
        const displayStr = formatDisplayValue(matches[0].value);
        const isUnset = displayStr === '(empty / not set)' || displayStr === '(empty / unlinked)';
        return (
          <Typography
            textColor={isUnset ? 'neutral500' : 'primary700'}
            fontWeight="semiBold"
            style={{
              fontStyle: isUnset ? 'italic' : 'normal',
              display: 'inline-block',
              maxWidth: 260,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {displayStr}
          </Typography>
        );
      }

      const qLower = (filterQuery || '').trim().toLowerCase();
      return (
        <Flex direction="column" gap={1} alignItems="flex-start" style={{ maxWidth: 320 }}>
          {matches.map((m) => {
            const displayStr = formatDisplayValue(m.value);
            const isMatchItem = qLower && displayStr.toLowerCase().includes(qLower);
            return (
              <Flex
                key={m.index}
                gap={1}
                alignItems="center"
                style={{
                  backgroundColor: isMatchItem ? 'rgba(46, 213, 115, 0.15)' : 'rgba(0, 0, 0, 0.03)',
                  padding: '2px 6px',
                  borderRadius: 4,
                  border: isMatchItem ? '1px solid #2ed573' : '1px solid transparent',
                }}
              >
                <Badge size="S" backgroundColor={isMatchItem ? 'success100' : 'primary100'} textColor={isMatchItem ? 'success700' : 'primary700'}>
                  #{m.index} {m.componentName}
                </Badge>
                <Typography
                  variant="pi"
                  fontWeight={isMatchItem ? 'bold' : 'normal'}
                  textColor={isMatchItem ? 'success700' : 'neutral800'}
                  style={{
                    maxWidth: 200,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {displayStr}
                </Typography>
              </Flex>
            );
          })}
        </Flex>
      );
    }

    case 'target_attr': {
      const matches = getAllNestedValues(entry, selectedAttribute, col?.attributes);
      if (matches.length === 0) {
        return (
          <Typography textColor="neutral500" style={{ fontStyle: 'italic' }}>
            (empty / not set)
          </Typography>
        );
      }
      if (matches.length === 1 && !matches[0].componentUid) {
        const displayStr = formatDisplayValue(matches[0].value);
        const isUnset = displayStr === '(empty / not set)' || displayStr === '(empty / unlinked)';
        return (
          <Typography
            textColor={isUnset ? 'neutral500' : 'neutral800'}
            style={{
              fontStyle: isUnset ? 'italic' : 'normal',
              display: 'inline-block',
              maxWidth: 260,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {displayStr}
          </Typography>
        );
      }

      return (
        <Flex direction="column" gap={1} alignItems="flex-start" style={{ maxWidth: 320 }}>
          {matches.map((m) => {
            const displayStr = formatDisplayValue(m.value);
            return (
              <Flex
                key={m.index}
                gap={1}
                alignItems="center"
                style={{
                  backgroundColor: 'rgba(0, 0, 0, 0.03)',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                <Badge size="S" backgroundColor="neutral200" textColor="neutral800">
                  #{m.index} {m.componentName}
                </Badge>
                <Typography
                  variant="pi"
                  textColor="neutral800"
                  style={{
                    maxWidth: 200,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {displayStr}
                </Typography>
              </Flex>
            );
          })}
        </Flex>
      );
    }

    case 'status': {
      if (selectedAttribute && !hasAttr) {
        return (
          <Badge backgroundColor="neutral200" textColor="neutral600">
            Ignored
          </Badge>
        );
      }
      const lifecycle = getEntryLifecycleStatus(entry, col, pendingBatches);
      return (
        <Flex gap={1} alignItems="center">
          <Badge backgroundColor={lifecycle.badgeColor} textColor={lifecycle.textColor}>
            {lifecycle.label}
          </Badge>
          {isMatch && (
            <Badge backgroundColor="secondary100" textColor="secondary700">
              Matches Filter
            </Badge>
          )}
        </Flex>
      );
    }

    default: {
      const attrName = colDef.key.replace('attr_', '');
      const rawVal = getNestedValue(entry, attrName);
      const displayStr = formatDisplayValue(rawVal);
      return (
        <Typography
          textColor="neutral700"
          style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {displayStr === '(empty / not set)' ? '-' : displayStr}
        </Typography>
      );
    }
  }
}

const BulkUpdater: React.FC = () => {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  // Active view tab: 'editor' | 'audit' | 'rules' | 'csv' (synced with ?tab= query param)
  const getInitialTab = (): 'editor' | 'audit' | 'rules' | 'csv' => {
    try {
      const params = new URLSearchParams(window.location.search);
      const t = params.get('tab');
      if (t === 'audit' || t === 'editor' || t === 'rules' || t === 'csv') return t as any;
    } catch {}
    return 'editor';
  };

  const [activeTab, setActiveTabState] = useState<'editor' | 'audit' | 'rules' | 'csv'>(getInitialTab);

  const setActiveTab = (tab: 'editor' | 'audit' | 'rules' | 'csv') => {
    setActiveTabState(tab);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', tab);
      window.history.replaceState({}, '', url.toString());
    } catch {}
  };

  const [loading, setLoading] = useState<boolean>(true);
  const [updating, setUpdating] = useState<boolean>(false);
  const [attributes, setAttributes] = useState<string[]>([]);
  const [collections, setCollections] = useState<CollectionModel[]>([]);
  const [auditEnabled, setAuditEnabled] = useState<boolean>(false);

  // Execution Window & Maker-Checker State
  const [executionWindow, setExecutionWindow] = useState<ExecutionWindowInfo | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [pendingBatches, setPendingBatches] = useState<PendingBatch[]>([]);
  const [pendingBatchesLoading, setPendingBatchesLoading] = useState<boolean>(false);
  const [approvingBatchId, setApprovingBatchId] = useState<string | null>(null);
  const [rejectingBatchId, setRejectingBatchId] = useState<string | null>(null);
  const [inspectingPendingBatch, setInspectingPendingBatch] = useState<PendingBatch | null>(null);
  const [exportingPendingBatchId, setExportingPendingBatchId] = useState<string | null>(null);
  const [makerNotesInput, setMakerNotesInput] = useState<string>('');
  const [publishOnApproval, setPublishOnApproval] = useState<boolean>(true);
  const [publishStrategy, setPublishStrategy] = useState<'safe' | 'all'>('safe');
  const [unreviewedConsent, setUnreviewedConsent] = useState<boolean>(false);
  const [publishConsent, setPublishConsent] = useState<boolean>(false);

  // Processing Dashboard & Status Tracking State
  const [showProcessingDashboard, setShowProcessingDashboard] = useState<boolean>(false);
  const [dashboardBatchId, setDashboardBatchId] = useState<string>('');
  const [dashboardJob, setDashboardJob] = useState<any>(null);
  const [isSubmittingBatch, setIsSubmittingBatch] = useState<boolean>(false);

  // Preview Modal State
  const [showPreviewModal, setShowPreviewModal] = useState<boolean>(false);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [previewData, setPreviewData] = useState<any>(null);

  // Bulk Publish Modal State
  const [showPublishConfirmModal, setShowPublishConfirmModal] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);
  const [publishMakerNotesInput, setPublishMakerNotesInput] = useState<string>('');
  const [bulkExporting, setBulkExporting] = useState<boolean>(false);

  // Managed Cache Keys
  const MODELS_CACHE_KEY = 'strapi_bulk_updater_models_cache';
  const LAST_ATTR_KEY = 'strapi_bulk_updater_last_attr';
  const LAST_COLLECTION_KEY = 'strapi_bulk_updater_last_collection';

  const getInitialCollectionUid = (): string => {
    try {
      const stored = localStorage.getItem(LAST_COLLECTION_KEY);
      if (stored) return stored;
    } catch {}
    return '';
  };
  const [selectedCollectionUid, setSelectedCollectionUid] = useState<string>(getInitialCollectionUid);

  // Selected state
  const getInitialAttribute = (): string => {
    try {
      const stored = localStorage.getItem(LAST_ATTR_KEY);
      if (stored) return stored;
    } catch {}
    return '';
  };
  const [selectedAttribute, setSelectedAttribute] = useState<string>(getInitialAttribute);
  const [attributeValue, setAttributeValue] = useState<string>('');
  const [selectedEntries, setSelectedEntries] = useState<Record<string, boolean>>({});
  const [expandedDzEntries, setExpandedDzEntries] = useState<Record<string, boolean>>({});
  const [selectedDzBlocks, setSelectedDzBlocks] = useState<Record<string, number[]>>({});

  // Relation State
  const [relationsMeta, setRelationsMeta] = useState<Record<string, RelationMeta>>({});
  const [relationOptions, setRelationOptions] = useState<Array<{ documentId: string; label: string }>>([]);
  const [relationOptionsLoading, setRelationOptionsLoading] = useState<boolean>(false);
  const [selectedRelationDocId, setSelectedRelationDocId] = useState<string>('');
  const [relationMode, setRelationMode] = useState<'set' | 'connect' | 'disconnect' | 'clear'>('set');

  const fetchRelationOptions = async (targetUid: string) => {
    try {
      setRelationOptionsLoading(true);
      const res = await get(`/bulk-updater/relation-options?targetUid=${encodeURIComponent(targetUid)}`);
      if (res.data && res.data.success) {
        setRelationOptions(res.data.options || []);
      }
    } catch {
      setRelationOptions([]);
    } finally {
      setRelationOptionsLoading(false);
    }
  };

  // Pro feature: Regex
  const [useRegex, setUseRegex] = useState<boolean>(false);
  const [regexPattern, setRegexPattern] = useState<string>('');

  // Component Nesting Depth Config (User Configurable, 1 to 5)
  const DEPTH_STORAGE_KEY = 'strapi_bulk_updater_component_depth';
  const [componentDepth, setComponentDepth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(DEPTH_STORAGE_KEY);
      if (stored) {
        const val = Number(stored);
        if (val >= 1 && val <= 5) return val;
      }
    } catch {}
    return 3;
  });

  const handleComponentDepthChange = (depth: number) => {
    const capped = Math.min(5, Math.max(1, depth));
    setComponentDepth(capped);
    try {
      localStorage.setItem(DEPTH_STORAGE_KEY, String(capped));
    } catch {}
  };

  const [searchRelationOptions, setSearchRelationOptions] = useState<Array<{ documentId: string; label: string }>>([]);
  const [searchRelationOptionsLoading, setSearchRelationOptionsLoading] = useState<boolean>(false);

  const fetchSearchRelationOptions = async (targetUid: string) => {
    try {
      setSearchRelationOptionsLoading(true);
      const res = await get(`/bulk-updater/relation-options?targetUid=${encodeURIComponent(targetUid)}`);
      if (res.data && res.data.success) {
        setSearchRelationOptions(res.data.options || []);
      }
    } catch {
      setSearchRelationOptions([]);
    } finally {
      setSearchRelationOptionsLoading(false);
    }
  };

  // Search Attribute (separate from update attribute)
  const [searchAttribute, setSearchAttribute] = useState<string>('');
  const [searchAttributeInput, setSearchAttributeInput] = useState<string>('');
  const [attributesMeta, setAttributesMeta] = useState<Record<string, { depth: number; type: string; component?: string; isRelation?: boolean }>>({});

  const effectiveSearchAttribute = searchAttribute || selectedAttribute;

  useEffect(() => {
    if (effectiveSearchAttribute && relationsMeta[effectiveSearchAttribute]) {
      fetchSearchRelationOptions(relationsMeta[effectiveSearchAttribute].targetUid);
    } else {
      setSearchRelationOptions([]);
    }
  }, [effectiveSearchAttribute, relationsMeta]);

  // Target Value Filter state ("Find items with a certain value first")
  type FilterOperator = 'none' | 'empty' | 'not_empty' | 'equals' | 'contains' | 'starts_with';
  const [filterOperator, setFilterOperator] = useState<FilterOperator>('none');
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [entrySearch, setEntrySearch] = useState<string>('');
  type StatusFilter = 'all' | 'pending_review' | 'draft' | 'published' | 'modified' | 'unknown';
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const isFilterActive =
    Boolean(searchAttribute && searchAttribute !== selectedAttribute) ||
    (filterOperator !== 'none' &&
      (['empty', 'not_empty'].includes(filterOperator) || Boolean(filterQuery.trim()))) ||
    Boolean(entrySearch.trim()) ||
    Boolean(statusFilter !== 'all') ||
    Boolean(useRegex && regexPattern.trim());

  // Result state
  const [lastResults, setLastResults] = useState<UpdateResult[] | null>(null);
  const [updateSummary, setUpdateSummary] = useState<{
    updatedCount: number;
    skippedCount: number;
    batchId?: string;
  } | null>(null);

  const [collectionPages, setCollectionPages] = useState<Record<string, CollectionPageState>>({});
  const [collectionSearch, setCollectionSearch] = useState<string>('');

  // Content Type visibility filter & search
  const [visibleTypeUids, setVisibleTypeUids] = useState<Record<string, boolean>>({});
  const [typeVisibilitySearch, setTypeVisibilitySearch] = useState<string>('');

  // Attribute Info breakdown state
  const [attributeInfoExpanded, setAttributeInfoExpanded] = useState<boolean>(false);
  const [attributeInfoSearch, setAttributeInfoSearch] = useState<string>('');

  // Pagination & Sorting state (capped at 100)
  const [defaultPageSize, setDefaultPageSize] = useState<number>(10);
  const [collectionSorts, setCollectionSorts] = useState<Record<string, { field: string; order: 'asc' | 'desc' }>>({});

  // Column Visibility per Collection Type (flat mapping: uid -> string[])
  const [collectionColumnVisibility, setCollectionColumnVisibility] = useState<Record<string, string[]>>({});
  const [openColumnPickerUid, setOpenColumnPickerUid] = useState<string | null>(null);
  const [columnSearchTerm, setColumnSearchTerm] = useState<string>('');
  const [openSortPickerUid, setOpenSortPickerUid] = useState<string | null>(null);
  const [sortSearchTerm, setSortSearchTerm] = useState<string>('');

  const toggleColumn = (colUid: string, colKey: string, availableCols: ColumnDef[]) => {
    setCollectionColumnVisibility((prev) => {
      const current = prev[colUid] || availableCols.filter((c) => c.defaultVisible).map((c) => c.key);
      let next: string[];
      if (current.includes(colKey)) {
        const remaining = current.filter((k) => k !== colKey);
        if (remaining.filter((k) => k !== 'select').length === 0) {
          return prev;
        }
        next = remaining;
      } else {
        next = [...current, colKey];
      }
      return { ...prev, [colUid]: next };
    });
  };

  const showAllColumns = (colUid: string, availableCols: ColumnDef[]) => {
    setCollectionColumnVisibility((prev) => ({
      ...prev,
      [colUid]: availableCols.map((c) => c.key),
    }));
  };

  const resetDefaultColumns = (colUid: string, availableCols: ColumnDef[]) => {
    setCollectionColumnVisibility((prev) => ({
      ...prev,
      [colUid]: availableCols.filter((c) => c.defaultVisible).map((c) => c.key),
    }));
  };

  // Audit state
  const [auditHistory, setAuditHistory] = useState<AuditRecord[]>([]);
  const [auditLoading, setAuditLoading] = useState<boolean>(false);
  const [rollingBackBatchId, setRollingBackBatchId] = useState<string | null>(null);
  const [expandedDiffBatchId, setExpandedDiffBatchId] = useState<string | null>(null);
  const [auditNotice, setAuditNotice] = useState<string | null>(null);

  const latestActiveBatch = auditHistory.find((rec) => !rec.isRolledBack);

  const applyModelsData = (data: any) => {
    if (!data) return;
    const attrs: string[] = data.attributes || [];
    setAttributes(attrs);
    const cols: CollectionModel[] = data.collections || [];
    setCollections(cols);
    setAuditEnabled(Boolean(data.auditEnabled));
    if (data.executionWindow) {
      setExecutionWindow(data.executionWindow);
    }

    const pages: Record<string, CollectionPageState> = {};
    const initialVisibility: Record<string, boolean> = {};
    const initialSorts: Record<string, { field: string; order: 'asc' | 'desc' }> = {};
    cols.forEach((col: CollectionModel) => {
      const total = col.totalEntries !== undefined ? col.totalEntries : (col.entries ? col.entries.length : 0);
      const initialPageSize = col.isSingleType ? 1 : 10;
      const previewSlice = (col.entries || []).slice(0, initialPageSize).map((entry: Entry) => {
        if (!entry.status) {
          const lifecycle = getEntryLifecycleStatus(entry, col, pendingBatches);
          return {
            ...entry,
            status: lifecycle.status,
            publishedAt: entry.publishedAt ?? (lifecycle.status === 'published' ? (entry.updatedAt || null) : null),
          };
        }
        return entry;
      });
      pages[col.uid] = {
        page: 1,
        pageSize: initialPageSize,
        total,
        pageCount: col.isSingleType ? 1 : (Math.ceil(total / initialPageSize) || 1),
        entries: previewSlice,
        loading: false,
      };
      initialVisibility[col.uid] = true;
      initialSorts[col.uid] = { field: 'createdAt', order: 'desc' };
    });
    setCollectionPages(pages);
    setVisibleTypeUids(initialVisibility);
    setCollectionSorts(initialSorts);

    if (data.relationsMeta) {
      setRelationsMeta(data.relationsMeta);
    }
    if (data.attributesMeta) {
      setAttributesMeta(data.attributesMeta);
    }

    let resolvedColUid = selectedCollectionUid;
    let storedCol: string | null = null;
    try {
      storedCol = localStorage.getItem(LAST_COLLECTION_KEY);
    } catch {}

    if (!resolvedColUid || !cols.some((c) => c.uid === resolvedColUid)) {
      resolvedColUid = (storedCol && cols.some((c) => c.uid === storedCol)) ? storedCol : (cols[0]?.uid || '');
    }
    setSelectedCollectionUid(resolvedColUid);
    try {
      if (resolvedColUid) localStorage.setItem(LAST_COLLECTION_KEY, resolvedColUid);
    } catch {}

    const activeCol = cols.find((c) => c.uid === resolvedColUid) || cols[0];
    const activeAttrs = activeCol?.attributes || [];
    setAttributes(activeAttrs);

    let storedAttr: string | null = null;
    try {
      storedAttr = localStorage.getItem(LAST_ATTR_KEY);
    } catch {}

    const resolvedAttr =
      storedAttr && activeAttrs.includes(storedAttr)
        ? storedAttr
        : (selectedAttribute && activeAttrs.includes(selectedAttribute) ? selectedAttribute : '');

    setSelectedAttribute(resolvedAttr);
    if (resolvedAttr && data.relationsMeta && data.relationsMeta[resolvedAttr]) {
      fetchRelationOptions(data.relationsMeta[resolvedAttr].targetUid);
    }
  };

  const fetchModels = async () => {
    // 1. Instant hydration from session cache if available (0ms rendering)
    try {
      const cached = sessionStorage.getItem(MODELS_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.data) {
          applyModelsData(parsed.data);
          setLoading(false);
        }
      }
    } catch {}

    try {
      if (collections.length === 0) {
        setLoading(true);
      }
      const res = await get('/bulk-updater/models');
      if (res.data && res.data.success) {
        applyModelsData(res.data);
        try {
          sessionStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data: res.data }));
        } catch {}
      }
    } catch (err: any) {
      if (!isAbortError(err)) {
        toggleNotification({
          type: 'danger',
          message: err?.message || 'Failed to load collections data',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const loadCollectionPage = async (
    colUid: string,
    targetPage: number,
    customPageSize?: number,
    customSortField?: string,
    customSortOrder?: 'asc' | 'desc',
    overrideFilterOp?: FilterOperator,
    overrideFilterQuery?: string,
    overrideEntrySearch?: string,
    autoSelectReturned = true,
    overrideSearchAttr?: string
  ) => {
    const currentPageState = collectionPages[colUid];
    const size = customPageSize || currentPageState?.pageSize || defaultPageSize;
    const currentSort = collectionSorts[colUid] || { field: 'createdAt', order: 'desc' };
    const sortField = customSortField !== undefined ? customSortField : currentSort.field;
    const sortOrder = customSortOrder !== undefined ? customSortOrder : currentSort.order;

    const op = overrideFilterOp !== undefined ? overrideFilterOp : filterOperator;
    const q = overrideFilterQuery !== undefined ? overrideFilterQuery : filterQuery;
    const s = overrideEntrySearch !== undefined ? overrideEntrySearch : entrySearch;
    const searchAttr = overrideSearchAttr !== undefined ? overrideSearchAttr : searchAttribute;

    setCollectionPages((prev) => ({
      ...prev,
      [colUid]: {
        ...(prev[colUid] || { page: 1, pageSize: size, total: 0, pageCount: 1, entries: [] }),
        loading: true,
      },
    }));

    try {
      const params = new URLSearchParams({
        page: String(targetPage),
        pageSize: String(size),
      });
      if (selectedAttribute) params.set('attribute', selectedAttribute);
      if (searchAttr && searchAttr !== selectedAttribute) {
        params.set('searchAttribute', searchAttr);
      }
      if (op && op !== 'none') {
        params.set('filterOperator', op);
        if (q) params.set('filterQuery', q);
      }
      if (s && s.trim()) {
        params.set('search', s.trim());
      }
      if (sortField) {
        params.set('sortField', sortField);
        params.set('sortOrder', sortOrder);
      }

      const res = await get(`/bulk-updater/collections/${colUid}/entries?${params.toString()}`);
      if (res.data && (res.data.success || res.data.entries !== undefined)) {
        const fetchedEntries: Entry[] = res.data.entries || [];
        const pageNum = res.data.pagination?.page ?? targetPage ?? 1;
        const pageSizeNum = res.data.pagination?.pageSize ?? size ?? defaultPageSize;
        const totalNum = res.data.pagination?.total !== undefined ? res.data.pagination.total : fetchedEntries.length;
        const pageCountNum = res.data.pagination?.pageCount ?? Math.max(1, Math.ceil(totalNum / pageSizeNum));

        // Ensure every entry has a guaranteed lifecycle status field attached
        const col = collections.find((c) => c.uid === colUid) || null;
        const enrichedEntries: Entry[] = fetchedEntries.map((entry) => {
          if (!entry.status) {
            const lifecycle = getEntryLifecycleStatus(entry, col, pendingBatches);
            return {
              ...entry,
              status: lifecycle.status,
              publishedAt: entry.publishedAt ?? (lifecycle.status === 'published' ? (entry.updatedAt || null) : null),
            };
          }
          return entry;
        });

        setCollectionPages((prev) => ({
          ...prev,
          [colUid]: {
            page: pageNum,
            pageSize: pageSizeNum,
            total: totalNum,
            pageCount: pageCountNum,
            entries: enrichedEntries,
            loading: false,
          },
        }));

        // If a filter or search is active, pre-select all returned matching entries!
        const isFilterActiveNow =
          Boolean(searchAttr && searchAttr !== selectedAttribute) ||
          (op !== 'none' && (['empty', 'not_empty'].includes(op) || Boolean(q.trim()))) ||
          Boolean(s.trim());
        if (isFilterActiveNow && autoSelectReturned) {
          setSelectedEntries((prev) => {
            const next = { ...prev };
            fetchedEntries.forEach((e) => {
              next[`${colUid}${KEY_SEP}${e.documentId}`] = true;
            });
            return next;
          });
        }
      }
    } catch (err: any) {
      if (!isAbortError(err)) {
        toggleNotification({
          type: 'danger',
          message: `Failed to load entries for ${colUid}: ${err?.message || 'Network error'}`,
        });
      }
      setCollectionPages((prev) => ({
        ...prev,
        [colUid]: {
          ...(prev[colUid] || {}),
          loading: false,
        },
      }));
    }
  };

  const fetchAuditHistory = async () => {
    try {
      setAuditLoading(true);
      const res = await get('/bulk-updater/audit/history');
      if (res.data) {
        if (res.data.enabled) {
          setAuditHistory(res.data.history || []);
          setAuditNotice(null);
        } else {
          setAuditHistory([]);
          setAuditNotice(res.data.message || 'Audit trail is not configured.');
        }
      }
    } catch (err: any) {
      if (!isAbortError(err)) {
        toggleNotification({
          type: 'danger',
          message: err?.message || 'Failed to fetch audit history.',
        });
      }
    } finally {
      setAuditLoading(false);
    }
  };

  const fetchPendingBatches = async () => {
    try {
      setPendingBatchesLoading(true);
      const res = await get('/bulk-updater/pending-batches');
      if (res.data && res.data.success) {
        setPendingBatches(res.data.batches || []);
        if (res.data.executionWindow) {
          setExecutionWindow(res.data.executionWindow);
        }
      }
    } catch {
      // ignore
    } finally {
      setPendingBatchesLoading(false);
    }
  };

  useEffect(() => {
    fetchModels();
    fetchAuditHistory();
    fetchPendingBatches();
  }, []);

  useEffect(() => {
    if (activeTab === 'audit') {
      fetchAuditHistory();
      fetchPendingBatches();
    }
  }, [activeTab]);

  const isInitialFilterMount = useRef(true);
  useEffect(() => {
    if (isInitialFilterMount.current) {
      isInitialFilterMount.current = false;
      return;
    }

    const timer = setTimeout(() => {
      if (selectedCollectionUid) {
        const isFilterActiveNow =
          Boolean(searchAttribute && searchAttribute !== selectedAttribute) ||
          (filterOperator !== 'none' &&
            (['empty', 'not_empty'].includes(filterOperator) || Boolean(filterQuery.trim()))) ||
          Boolean(entrySearch.trim()) ||
          Boolean(useRegex && regexPattern.trim());

        if (isFilterActiveNow) {
          setSelectedEntries({});
        }

        loadCollectionPage(
          selectedCollectionUid,
          1,
          undefined,
          undefined,
          undefined,
          filterOperator,
          filterQuery,
          entrySearch,
          true,
          searchAttribute
        );
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [selectedCollectionUid, searchAttribute, filterOperator, filterQuery, entrySearch, useRegex, regexPattern]);

  const KEY_SEP = '@@@';

  const selectedCol = useMemo(() => {
    if (!collections.length) return null;
    return collections.find((c) => c.uid === selectedCollectionUid) || collections[0] || null;
  }, [collections, selectedCollectionUid]);

  const handleCollectionChange = (newUid: string) => {
    if (newUid === selectedCollectionUid) return;
    setSelectedCollectionUid(newUid);
    try {
      localStorage.setItem(LAST_COLLECTION_KEY, newUid);
    } catch {}

    setSelectedEntries({});
    setSearchAttribute('');

    const targetCol = collections.find((c) => c.uid === newUid);
    const colAttrs = targetCol?.attributes || [];
    setAttributes(colAttrs);

    if (selectedAttribute && !colAttrs.includes(selectedAttribute)) {
      setSelectedAttribute('');
      try {
        localStorage.removeItem(LAST_ATTR_KEY);
      } catch {}
      setSelectedRelationDocId('');
      setAttributeValue('');
    }

    loadCollectionPage(newUid, 1, undefined, undefined, undefined, filterOperator, filterQuery, entrySearch, true, '');
  };

  // Handle attribute selection change: updates selectedAttribute without clearing search/filters/selected entries
  const handleAttributeChange = (newAttr: string) => {
    if (newAttr !== selectedAttribute) {
      setSelectedAttribute(newAttr);
      try {
        if (newAttr) {
          localStorage.setItem(LAST_ATTR_KEY, newAttr);
        } else {
          localStorage.removeItem(LAST_ATTR_KEY);
        }
      } catch {}
      // Keep searchAttribute, selectedEntries, filterOperator, filterQuery, and entrySearch intact
      setSelectedRelationDocId('');
      setAttributeValue('');

      if (newAttr && relationsMeta[newAttr]) {
        fetchRelationOptions(relationsMeta[newAttr].targetUid);
      } else {
        setRelationOptions([]);
      }
    }
  };

  const filteredCollections = useMemo(() => {
    return selectedCol ? [selectedCol] : [];
  }, [selectedCol]);

  const getAttrDepth = (attr: string): number =>
    attributesMeta[attr]?.depth ?? (attr.includes('.') ? attr.split('.').length - 1 : 0);

  const availableColAttributes = useMemo(() => {
    return selectedCol?.attributes || attributes || [];
  }, [selectedCol, attributes]);

  // Depth-filtered attributes based on user-configured componentDepth (1 to 5)
  const depthFilteredAttributes = useMemo(() => {
    return availableColAttributes.filter((attr) => getAttrDepth(attr) <= componentDepth);
  }, [availableColAttributes, componentDepth, attributesMeta]);

  // Memoized Combobox options for Update Attribute
  const memoizedComboboxOptions = useMemo(() => {
    if (depthFilteredAttributes.length === 0) {
      return (
        <ComboboxOption value="__none__" disabled textValue="No attributes available">
          <Typography variant="pi" textColor="neutral600">
            No attributes available for this collection type (Depth L{componentDepth})
          </Typography>
        </ComboboxOption>
      );
    }

    return depthFilteredAttributes.map((attr) => {
      const rel = relationsMeta[attr];
      const depth = getAttrDepth(attr);
      const badgeText = rel ? `relation ${rel.targetDisplayName}` : depth > 0 ? `L${depth} component` : '';
      const textValue = badgeText ? `${attr} ${badgeText}` : attr;
      return (
        <ComboboxOption key={attr} value={attr} textValue={textValue}>
          <Flex justifyContent="space-between" alignItems="center" width="100%" gap={2}>
            <Typography variant="omega" fontWeight={attr === selectedAttribute ? 'bold' : 'regular'}>
              {attr}
            </Typography>
            {rel ? (
              <Badge backgroundColor="secondary100" textColor="secondary700" size="S">
                relation ➔ {rel.targetDisplayName}
              </Badge>
            ) : depth > 0 ? (
              <Badge backgroundColor={depth === 1 ? 'neutral150' : depth === 2 ? 'primary100' : 'secondary100'} textColor={depth === 1 ? 'neutral700' : depth === 2 ? 'primary700' : 'secondary700'} size="S">
                L{depth} component
              </Badge>
            ) : null}
          </Flex>
        </ComboboxOption>
      );
    });
  }, [depthFilteredAttributes, relationsMeta, selectedAttribute, componentDepth, attributesMeta]);

  // Memoized Combobox options for Search Attribute (in Section 2)
  const memoizedSearchComboboxOptions = useMemo(() => {
    return (
      <>
        <ComboboxOption
          value="__default__"
          textValue={`Same as Update Attribute (${selectedAttribute || 'None'}) default`}
        >
          <Flex justifyContent="space-between" alignItems="center" width="100%" gap={2}>
            <Typography variant="omega" fontStyle="italic" textColor="neutral600">
              -- Same as Update Attribute ({selectedAttribute || 'None'}) --
            </Typography>
            <Badge backgroundColor="neutral150" textColor="neutral600" size="S">
              Default
            </Badge>
          </Flex>
        </ComboboxOption>
        {depthFilteredAttributes.map((attr) => {
          const rel = relationsMeta[attr];
          const depth = getAttrDepth(attr);
          const badgeText = rel ? `relation ${rel.targetDisplayName}` : depth > 0 ? `L${depth} component` : '';
          const textValue = badgeText ? `${attr} ${badgeText}` : attr;
          return (
            <ComboboxOption key={`search_${attr}`} value={attr} textValue={textValue}>
              <Flex justifyContent="space-between" alignItems="center" width="100%" gap={2}>
                <Typography variant="omega" fontWeight={attr === searchAttribute ? 'bold' : 'regular'}>
                  {attr}
                </Typography>
                {rel ? (
                  <Badge backgroundColor="secondary100" textColor="secondary700" size="S">
                    relation ➔ {rel.targetDisplayName}
                  </Badge>
                ) : depth > 0 ? (
                  <Badge backgroundColor={depth === 1 ? 'neutral150' : depth === 2 ? 'primary100' : 'secondary100'} textColor={depth === 1 ? 'neutral700' : depth === 2 ? 'primary700' : 'secondary700'} size="S">
                    L{depth} component
                  </Badge>
                ) : null}
              </Flex>
            </ComboboxOption>
          );
        })}
      </>
    );
  }, [depthFilteredAttributes, relationsMeta, searchAttribute, selectedAttribute, componentDepth, attributesMeta]);

  const handleSearchAttributeChange = (newAttr: string) => {
    const finalAttr = newAttr === '__default__' ? '' : newAttr;
    setSearchAttribute(finalAttr);
    if (collections.length > 0) {
      collections.forEach((col) => {
        loadCollectionPage(
          col.uid,
          1,
          undefined,
          undefined,
          undefined,
          filterOperator,
          filterQuery,
          entrySearch,
          true,
          finalAttr
        );
      });
    }
  };

  const handleGlobalPageSizeChange = (newSize: number) => {
    const capped = Math.min(500, Math.max(1, newSize));
    setDefaultPageSize(capped);
    collections.forEach((col) => {
      if (!col.isSingleType) {
        loadCollectionPage(col.uid, 1, capped);
      }
    });
  };

  const handleCollectionPageSizeChange = (colUid: string, newSize: number) => {
    const capped = Math.min(500, Math.max(1, newSize));
    loadCollectionPage(colUid, 1, capped);
  };

  const handleCollectionSortChange = (colUid: string, field: string, order: 'asc' | 'desc') => {
    setCollectionSorts((prev) => ({
      ...prev,
      [colUid]: { field, order },
    }));
    loadCollectionPage(colUid, 1, undefined, field, order);
  };

  const handleHeaderSortClick = (colUid: string, field: string) => {
    const current = collectionSorts[colUid] || { field: 'createdAt', order: 'desc' };
    const nextOrder: 'asc' | 'desc' = current.field === field && current.order === 'asc' ? 'desc' : 'asc';
    handleCollectionSortChange(colUid, field, nextOrder);
  };

  // Toggle single entry
  const toggleEntry = (uid: string, documentId: string) => {
    const key = `${uid}${KEY_SEP}${documentId}`;
    const nextVal = !selectedEntries[key];
    setSelectedEntries((prev) => ({
      ...prev,
      [key]: nextVal,
    }));
    if (!nextVal) {
      setSelectedDzBlocks((prev) => {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
    }
  };

  // Toggle individual dynamic zone block selection for an entry
  const toggleDzBlock = (uid: string, documentId: string, blockIndex: number, allApplicableIndexes: number[]) => {
    const key = `${uid}${KEY_SEP}${documentId}`;
    setSelectedDzBlocks((prev) => {
      const currentSelected = prev[key] !== undefined ? prev[key] : [...allApplicableIndexes];
      let nextSelected: number[];
      if (currentSelected.includes(blockIndex)) {
        nextSelected = currentSelected.filter((idx) => idx !== blockIndex);
      } else {
        nextSelected = [...currentSelected, blockIndex];
      }

      if (nextSelected.length > 0) {
        setSelectedEntries((e) => ({ ...e, [key]: true }));
      } else {
        setSelectedEntries((e) => ({ ...e, [key]: false }));
      }

      return {
        ...prev,
        [key]: nextSelected,
      };
    });
  };

  // Value filter evaluation across all dynamic zone / component matches
  const entryMatchesFilter = (entry: Entry, attr: string): boolean => {
    const matches = getAllNestedValues(entry, attr);

    // If regex search pattern is provided, verify against the search attribute values
    if (useRegex && regexPattern.trim()) {
      try {
        const regex = new RegExp(regexPattern, 'i');
        const anyRegexMatch = matches.some((m) => regex.test(formatDisplayValue(m.value)));
        if (!anyRegexMatch) {
          return false;
        }
      } catch {
        // Keep unhindered while typing regex
      }
    }

    if (filterOperator === 'none') return true;

    if (matches.length === 0) {
      return filterOperator === 'empty';
    }

    const checkMatch = (val: any) => {
      const displayStr = formatDisplayValue(val);
      const isValEmpty =
        val === undefined ||
        val === null ||
        (Array.isArray(val) && val.length === 0) ||
        displayStr.trim() === '' ||
        displayStr.trim().toLowerCase() === '(not set)' ||
        displayStr.trim().toLowerCase() === '(empty / not set)' ||
        displayStr.trim().toLowerCase() === '(empty / unlinked)';

      if (filterOperator === 'empty') return isValEmpty;
      if (filterOperator === 'not_empty') return !isValEmpty;
      if (isValEmpty) return false;

      const q = filterQuery.trim().toLowerCase();
      if (!q) return true;

      const testString = (str: any): boolean => {
        if (str === undefined || str === null) return false;
        const s = String(str).trim().toLowerCase();
        switch (filterOperator) {
          case 'equals':
            return s === q;
          case 'contains':
            return s.includes(q);
          case 'starts_with':
            return s.startsWith(q);
          default:
            return true;
        }
      };

      const testEntityObject = (obj: any): boolean => {
        if (!obj || typeof obj !== 'object') return false;
        if (testString(obj.name)) return true;
        if (testString(obj.title)) return true;
        if (testString(obj.email)) return true;
        if (testString(obj.username)) return true;
        if (testString(obj.documentId)) return true;
        if (testString(String(obj.id))) return true;
        if (testString(obj.slug)) return true;
        if (testString(formatDisplayValue(obj))) return true;
        return false;
      };

      if (Array.isArray(val)) {
        return val.some((item) => (typeof item === 'object' ? testEntityObject(item) : testString(item)));
      }

      if (typeof val === 'object' && val !== null) {
        return testEntityObject(val);
      }

      return testString(displayStr);
    };

    if (filterOperator === 'empty') {
      return matches.every((m) => checkMatch(m.value));
    }
    return matches.some((m) => checkMatch(m.value));
  };

  const getVisibleEntries = (col: CollectionModel) => {
    const pageState = collectionPages[col.uid];
    const raw = pageState ? pageState.entries : (col.entries || []);
    if (statusFilter === 'all') return raw;
    return raw.filter((entry) => {
      const lifecycle = getEntryLifecycleStatus(entry, col, pendingBatches);
      return lifecycle.status === statusFilter;
    });
  };

  const matchingEntriesCount = React.useMemo(() => {
    if (!isFilterActive) return 0;
    let count = 0;
    filteredCollections.forEach((col) => {
      count += getVisibleEntries(col).length;
    });
    return count;
  }, [filteredCollections, collectionPages, isFilterActive, statusFilter, pendingBatches]);

  const selectAllMatching = () => {
    const updated = { ...selectedEntries };
    filteredCollections.forEach((col) => {
      const entries = getVisibleEntries(col);
      entries.forEach((e) => {
        updated[`${col.uid}${KEY_SEP}${e.documentId}`] = true;
      });
    });
    setSelectedEntries(updated);
  };

  const deselectAllMatching = () => {
    const updated = { ...selectedEntries };
    filteredCollections.forEach((col) => {
      const entries = getVisibleEntries(col);
      entries.forEach((e) => {
        delete updated[`${col.uid}${KEY_SEP}${e.documentId}`];
      });
    });
    setSelectedEntries(updated);
  };

  const clearFilter = () => {
    setSearchAttribute('');
    setFilterOperator('none');
    setFilterQuery('');
    setEntrySearch('');
    setStatusFilter('all');
    setRegexPattern('');
    setSelectedEntries({});
    collections.forEach((col) => {
      loadCollectionPage(col.uid, 1, undefined, undefined, undefined, 'none', '', '', false, '');
    });
  };

  const isCollectionFullySelected = (col: CollectionModel) => {
    const entries = getVisibleEntries(col);
    if (!entries.length) return false;
    return entries.every((e) => selectedEntries[`${col.uid}${KEY_SEP}${e.documentId}`]);
  };

  const isCollectionPartiallySelected = (col: CollectionModel) => {
    const entries = getVisibleEntries(col);
    if (!entries.length) return false;
    const selectedCount = entries.filter(
      (e) => selectedEntries[`${col.uid}${KEY_SEP}${e.documentId}`]
    ).length;
    return selectedCount > 0 && selectedCount < entries.length;
  };

  const toggleCollection = (col: CollectionModel) => {
    const entries = getVisibleEntries(col);
    const willSelectAll = !isCollectionFullySelected(col);
    const updated = { ...selectedEntries };
    entries.forEach((e) => {
      const key = `${col.uid}${KEY_SEP}${e.documentId}`;
      if (willSelectAll) {
        updated[key] = true;
      } else {
        delete updated[key];
      }
    });
    setSelectedEntries(updated);
  };

  const selectAll = () => {
    const updated = { ...selectedEntries };
    filteredCollections.forEach((col) => {
      const entries = getVisibleEntries(col);
      entries.forEach((e) => {
        updated[`${col.uid}${KEY_SEP}${e.documentId}`] = true;
      });
    });
    setSelectedEntries(updated);
  };

  const deselectAll = () => {
    setSelectedEntries({});
  };

  const getSelectedBreakdown = () => {
    const breakdown: Record<string, number> = {};
    Object.keys(selectedEntries).forEach((key) => {
      if (selectedEntries[key]) {
        const parts = key.split(KEY_SEP);
        if (parts.length === 2) {
          const uid = parts[0];
          const col = collections.find((c) => c.uid === uid);
          const name = col?.displayName || uid;
          breakdown[name] = (breakdown[name] || 0) + 1;
        }
      }
    });
    return breakdown;
  };

  // Lifecycle status breakdown across selected entries
  const selectedLifecycleStats = useMemo(() => {
    let published = 0;
    let modified = 0;
    let draft = 0;
    let pendingReview = 0;
    let unknown = 0;

    Object.keys(selectedEntries).forEach((key) => {
      if (!selectedEntries[key]) return;
      const parts = key.split(KEY_SEP);
      if (parts.length !== 2) return;
      const [uid, docId] = parts;
      const col = collections.find((c) => c.uid === uid) || null;
      const entry =
        collectionPages[uid]?.entries?.find((e: Entry) => e.documentId === docId || String(e.id) === docId) ||
        col?.entries?.find((e: Entry) => e.documentId === docId || String(e.id) === docId);

      if (col && col.draftAndPublish === false) {
        published++;
      } else if (entry) {
        const { status } = getEntryLifecycleStatus(entry, col, pendingBatches);
        if (status === 'published') published++;
        else if (status === 'modified') modified++;
        else if (status === 'draft') draft++;
        else if (status === 'pending_review') pendingReview++;
        else unknown++;
      } else {
        draft++;
      }
    });

    const unreviewedCount = draft + modified + pendingReview + unknown;
    return {
      published,
      modified,
      draft,
      pendingReview,
      unknown,
      unreviewedCount,
      total: published + modified + draft + pendingReview + unknown,
    };
  }, [selectedEntries, collections, collectionPages, pendingBatches]);

  // Open Confirmation Modal
  const handleOpenConfirmModal = () => {
    if (!selectedAttribute) {
      toggleNotification({
        type: 'warning',
        message: 'Please select an attribute from the dropdown',
      });
      return;
    }

    const totalSelected = Object.values(selectedEntries).filter(Boolean).length;
    if (totalSelected === 0) {
      toggleNotification({
        type: 'warning',
        message: 'Please select at least one collection type or entry to update',
      });
      return;
    }

    setPublishStrategy('safe');
    setUnreviewedConsent(false);
    setShowConfirmModal(true);
  };

  // Open Preview Modal
  const handleOpenPreviewModal = async () => {
    if (!selectedAttribute) {
      toggleNotification({
        type: 'warning',
        message: 'Please select an attribute from the dropdown',
      });
      return;
    }

    const targets: Array<{ uid: string; documentId: string; dynamicZoneIndexes?: number[] }> = [];
    Object.keys(selectedEntries).forEach((key) => {
      if (selectedEntries[key]) {
        const parts = key.split(KEY_SEP);
        if (parts.length === 2) {
          const colUid = parts[0];
          const docId = parts[1];
          const targetObj: any = { uid: colUid, documentId: docId };
          if (selectedDzBlocks[key] && selectedDzBlocks[key].length > 0) {
            targetObj.dynamicZoneIndexes = selectedDzBlocks[key];
          }
          const colPage = collectionPages[colUid];
          const cachedEntry = colPage?.entries?.find((e: any) => e.documentId === docId);
          if (cachedEntry) {
            if (cachedEntry.status) targetObj.status = cachedEntry.status;
            if (cachedEntry.publishedAt) targetObj.publishedAt = cachedEntry.publishedAt;
            if (cachedEntry.locale) targetObj.locale = cachedEntry.locale;
          }
          targets.push(targetObj);
        }
      }
    });

    if (targets.length === 0) {
      toggleNotification({
        type: 'warning',
        message: 'Please select at least one collection type or entry to preview',
      });
      return;
    }

    setShowPreviewModal(true);
    setPreviewLoading(true);

    try {
      const res = await post('/bulk-updater/preview', {
        attribute: selectedAttribute,
        value: attributeValue,
        selectedEntries: targets,
        isRegex: useRegex,
        regexPattern,
        publishOnApproval,
      });

      if (res.data && res.data.success) {
        setPreviewData(res.data);
      } else {
        throw new Error(res.data?.error || 'Failed to generate preview');
      }
    } catch (err: any) {
      if (!isAbortError(err)) {
        toggleNotification({
          type: 'danger',
          message: err.message || 'Failed to fetch preview diffs',
        });
      }
      setShowPreviewModal(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Perform bulk update with chosen mode
  const executeBatchWithMode = async (
    executionMode: 'immediate' | 'queue_offpeak' | 'maker_checker',
    forceImmediate = false
  ) => {
    const targets: Array<{ uid: string; documentId: string; dynamicZoneIndexes?: number[] }> = [];
    Object.keys(selectedEntries).forEach((key) => {
      if (selectedEntries[key]) {
        const parts = key.split(KEY_SEP);
        if (parts.length === 2) {
          const colUid = parts[0];
          const docId = parts[1];
          const targetObj: any = { uid: colUid, documentId: docId };
          if (selectedDzBlocks[key] && selectedDzBlocks[key].length > 0) {
            targetObj.dynamicZoneIndexes = selectedDzBlocks[key];
          }
          const colPage = collectionPages[colUid];
          const cachedEntry = colPage?.entries?.find((e: any) => e.documentId === docId);
          if (cachedEntry) {
            if (cachedEntry.status) targetObj.status = cachedEntry.status;
            if (cachedEntry.publishedAt) targetObj.publishedAt = cachedEntry.publishedAt;
            if (cachedEntry.locale) targetObj.locale = cachedEntry.locale;
          }
          targets.push(targetObj);
        }
      }
    });

    try {
      setUpdating(true);
      setShowConfirmModal(false);
      setShowProcessingDashboard(true);
      setIsSubmittingBatch(true);
      setLastResults(null);

      // Initialize live dashboard job tracker
      const tempBatchId = `batch_${Date.now()}`;
      setDashboardBatchId(tempBatchId);
      setDashboardJob({
        id: tempBatchId,
        createdAt: new Date().toISOString(),
        status: 'processing',
        executionMode,
        attribute: selectedAttribute,
        value: attributeValue,
        totalTargets: targets.length,
        processedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        isLive: false,
        publishOnApproval,
        publishStrategy,
        unreviewedConsent,
        unreviewedCount: selectedLifecycleStats.unreviewedCount,
        results: [],
      });

      const payload = {
        attribute: selectedAttribute,
        value: attributeValue,
        selectedEntries: targets,
        isRegex: useRegex,
        regexPattern: regexPattern,
        executionMode,
        makerNotes: makerNotesInput,
        forceImmediate,
        publishOnApproval,
        publishStrategy,
        unreviewedConsent,
        unreviewedCount: selectedLifecycleStats.unreviewedCount,
      };

      const res = await post('/bulk-updater/batch-update', payload);

      setIsSubmittingBatch(false);

      if (res.data && res.data.success) {
        setSelectedEntries({});
        setSelectedDzBlocks({});
        const finalBatchId = res.data.batchId;
        setDashboardBatchId(finalBatchId);

        if (res.data.pending) {
          setDashboardJob({
            id: finalBatchId,
            createdAt: new Date().toISOString(),
            status: res.data.status || 'pending_approval',
            executionMode,
            scheduledFor: res.data.scheduledFor,
            attribute: selectedAttribute,
            value: attributeValue,
            totalTargets: targets.length,
            processedCount: 0,
            updatedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            isLive: false,
            publishOnApproval,
            makerNotes: makerNotesInput,
            policyMessage: res.data.message,
            results: [],
          });

          toggleNotification({
            type: 'success',
            message: res.data.message || 'Batch submitted successfully.',
          });
          await fetchPendingBatches();
        } else {
          setLastResults(res.data.results || []);
          setUpdateSummary({
            updatedCount: res.data.updatedCount || 0,
            skippedCount: res.data.skippedCount || 0,
            batchId: res.data.batchId,
          });

          setDashboardJob({
            id: finalBatchId,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            status: res.data.status || 'successful',
            executionMode: 'immediate',
            attribute: selectedAttribute,
            value: attributeValue,
            totalTargets: res.data.totalTargets || targets.length,
            processedCount: res.data.results?.length || targets.length,
            updatedCount: res.data.updatedCount || 0,
            skippedCount: res.data.skippedCount || 0,
            failedCount: res.data.failedCount || 0,
            isLive: res.data.isLive !== false && (res.data.updatedCount > 0),
            publishOnApproval,
            results: res.data.results || [],
          });

          toggleNotification({
            type: 'success',
            message: `Bulk update complete! Batch ID: ${res.data.batchId}. Updated: ${res.data.updatedCount}, Skipped: ${res.data.skippedCount}`,
          });

          await fetchModels();
          await fetchAuditHistory();

          if (selectedCollectionUid) {
            loadCollectionPage(
              selectedCollectionUid,
              collectionPages[selectedCollectionUid]?.page || 1,
              undefined,
              undefined,
              undefined,
              filterOperator,
              filterQuery,
              entrySearch,
              false,
              searchAttribute
            );
          }
        }
      } else {
        setIsSubmittingBatch(false);
        setDashboardJob((prev: any) => ({
          ...prev,
          status: 'failed',
          error: res.data?.error || 'Batch update encountered an error',
        }));
        toggleNotification({
          type: 'danger',
          message: res.data?.error || 'Batch update encountered an error',
        });
      }
    } catch (err: any) {
      setIsSubmittingBatch(false);
      const errMsg = err.response?.data?.error || err.message || 'Batch update failed';
      setDashboardJob((prev: any) => ({
        ...prev,
        status: 'failed',
        error: errMsg,
      }));
      toggleNotification({
        type: 'danger',
        message: errMsg,
      });
    } finally {
      setUpdating(false);
      setMakerNotesInput('');
    }
  };

  // Bulk Export Selected Entries across collections (Excel-compatible RFC-4180 CSV with UTF-8 BOM)
  const handleBulkExportSelected = async () => {
    const targets: Array<{ uid: string; documentId: string }> = [];
    Object.keys(selectedEntries).forEach((key) => {
      if (selectedEntries[key]) {
        const parts = key.split(KEY_SEP);
        if (parts.length === 2) {
          targets.push({ uid: parts[0], documentId: parts[1] });
        }
      }
    });

    if (targets.length === 0) {
      toggleNotification({
        type: 'warning',
        message: 'Please select at least one entry to export',
      });
      return;
    }

    try {
      setBulkExporting(true);
      const res = await post('/bulk-updater/csv/export-bulk', { selectedEntries: targets });
      const csvStr = res.data?.csvContent || (typeof res.data === 'string' ? res.data : '');
      if (!csvStr) {
        toggleNotification({
          type: 'warning',
          message: 'No CSV content returned for selected entries',
        });
        return;
      }
      const safeContent = csvStr.startsWith('\uFEFF') ? csvStr : '\uFEFF' + csvStr;
      const blob = new Blob([safeContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', res.data?.filename || `bulk_export_selected_${targets.length}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toggleNotification({
        type: 'success',
        message: `Successfully exported ${res.data?.count || targets.length} selected records to Excel CSV`,
      });
    } catch (e: any) {
      toggleNotification({
        type: 'danger',
        message: e.message || 'Failed exporting selected records to CSV',
      });
    } finally {
      setBulkExporting(false);
    }
  };

  // Open Bulk Publish Modal
  const handleOpenPublishModal = () => {
    const totalSelected = Object.values(selectedEntries).filter(Boolean).length;
    if (totalSelected === 0) {
      toggleNotification({
        type: 'warning',
        message: 'Please select at least one collection type or entry to publish',
      });
      return;
    }
    setPublishConsent(false);
    setShowPublishConfirmModal(true);
  };

  // Perform bulk publish with chosen mode
  const executeBatchPublish = async (
    executionMode: 'immediate' | 'queue_offpeak' | 'maker_checker',
    forceImmediate = false
  ) => {
    const targets: Array<{ uid: string; documentId: string }> = [];
    Object.keys(selectedEntries).forEach((key) => {
      if (selectedEntries[key]) {
        const parts = key.split(KEY_SEP);
        if (parts.length === 2) {
          targets.push({ uid: parts[0], documentId: parts[1] });
        }
      }
    });

    try {
      setPublishing(true);
      setShowPublishConfirmModal(false);
      setShowProcessingDashboard(true);
      setIsSubmittingBatch(true);
      setLastResults(null);

      // Initialize live dashboard job tracker
      const tempBatchId = `batch_pub_${Date.now()}`;
      setDashboardBatchId(tempBatchId);
      setDashboardJob({
        id: tempBatchId,
        createdAt: new Date().toISOString(),
        status: 'processing',
        executionMode,
        attribute: '(publish)',
        value: 'published',
        totalTargets: targets.length,
        processedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        isLive: true,
        publishOnApproval: true,
        unreviewedConsent: publishConsent,
        unreviewedCount: selectedLifecycleStats.unreviewedCount,
        results: [],
      });

      const payload = {
        selectedEntries: targets,
        executionMode,
        makerNotes: publishMakerNotesInput,
        forceImmediate,
        unreviewedConsent: publishConsent,
        unreviewedCount: selectedLifecycleStats.unreviewedCount,
      };

      const res = await post('/bulk-updater/batch-publish', payload);

      setIsSubmittingBatch(false);

      if (res.data && res.data.success) {
        setSelectedEntries({});
        const finalBatchId = res.data.batchId;
        setDashboardBatchId(finalBatchId);

        if (res.data.pending) {
          setDashboardJob({
            id: finalBatchId,
            createdAt: new Date().toISOString(),
            status: res.data.status || 'pending_approval',
            executionMode,
            scheduledFor: res.data.scheduledFor,
            attribute: '(publish)',
            value: 'published',
            totalTargets: targets.length,
            processedCount: 0,
            updatedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            isLive: true,
            publishOnApproval: true,
            makerNotes: publishMakerNotesInput,
            policyMessage: res.data.message,
            results: [],
          });

          toggleNotification({
            type: 'success',
            message: res.data.message || 'Publish batch submitted successfully.',
          });
          await fetchPendingBatches();
        } else {
          setLastResults(res.data.results || []);
          setUpdateSummary({
            updatedCount: res.data.publishedCount || 0,
            skippedCount: res.data.skippedCount || 0,
            batchId: res.data.batchId,
          });

          setDashboardJob({
            id: finalBatchId,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            status: res.data.status || 'successful',
            executionMode: 'immediate',
            attribute: '(publish)',
            value: 'published',
            totalTargets: res.data.totalTargets || targets.length,
            processedCount: res.data.results?.length || targets.length,
            updatedCount: res.data.publishedCount || 0,
            skippedCount: res.data.skippedCount || 0,
            failedCount: res.data.failedCount || 0,
            isLive: true,
            publishOnApproval: true,
            results: res.data.results || [],
          });

          toggleNotification({
            type: 'success',
            message: `Bulk publish complete! Batch ID: ${res.data.batchId}. Published: ${res.data.publishedCount}, Skipped: ${res.data.skippedCount}`,
          });

          await fetchModels();
          await fetchAuditHistory();
        }
      } else {
        setIsSubmittingBatch(false);
        setDashboardJob((prev: any) => ({
          ...prev,
          status: 'failed',
          error: res.data?.error || 'Batch publish encountered an error',
        }));
        toggleNotification({
          type: 'danger',
          message: res.data?.error || 'Batch publish encountered an error',
        });
      }
    } catch (err: any) {
      setIsSubmittingBatch(false);
      const errMsg = err.response?.data?.error || err.message || 'Batch publish failed';
      setDashboardJob((prev: any) => ({
        ...prev,
        status: 'failed',
        error: errMsg,
      }));
      toggleNotification({
        type: 'danger',
        message: errMsg,
      });
    } finally {
      setPublishing(false);
      setPublishMakerNotesInput('');
    }
  };

  // Checker Approves Batch
  const handleApproveBatch = async (batchId: string) => {
    try {
      setApprovingBatchId(batchId);
      const res = await post(`/bulk-updater/batches/${batchId}/approve`, { executeImmediately: true });
      if (res.data && res.data.success) {
        setSelectedEntries({});
        toggleNotification({
          type: 'success',
          message: res.data.message || `Batch ${batchId} approved and executed successfully!`,
        });
        setInspectingPendingBatch(null);
        await fetchPendingBatches();
        await fetchAuditHistory();
        await fetchModels();
      } else {
        toggleNotification({
          type: 'danger',
          message: res.data?.error || 'Failed to approve batch',
        });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err.response?.data?.error || err.message || 'Failed to approve batch',
      });
    } finally {
      setApprovingBatchId(null);
    }
  };

  // Checker Rejects Batch
  const handleRejectBatch = async (batchId: string, customReason?: string) => {
    const reason =
      customReason ||
      window.prompt('Enter reason for rejection:', 'Does not meet release criteria') ||
      'Rejected by Checker';
    try {
      setRejectingBatchId(batchId);
      const res = await post(`/bulk-updater/batches/${batchId}/reject`, { reason });
      if (res.data && res.data.success) {
        toggleNotification({
          type: 'info',
          message: `Batch ${batchId} rejected: ${reason}`,
        });
        setInspectingPendingBatch(null);
        await fetchPendingBatches();
      } else {
        toggleNotification({
          type: 'danger',
          message: res.data?.error || 'Failed to reject batch',
        });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err.response?.data?.error || err.message || 'Failed to reject batch',
      });
    } finally {
      setRejectingBatchId(null);
    }
  };

  // Export Pending Batch Diffs to CSV
  const handleExportPendingBatch = async (batchId: string) => {
    try {
      setExportingPendingBatchId(batchId);
      const res = await get(`/bulk-updater/batches/${batchId}/diffs/export`);
      if (res.data && res.data.success && res.data.csvContent) {
        const safeContent = res.data.csvContent.startsWith('\uFEFF')
          ? res.data.csvContent
          : '\uFEFF' + res.data.csvContent;
        const blob = new Blob([safeContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', res.data.filename || `batch_${batchId}_review.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toggleNotification({
          type: 'success',
          message: `Exported ${res.data.count || ''} batch diffs to CSV.`,
        });
      } else {
        toggleNotification({
          type: 'danger',
          message: 'Failed to export batch diffs to CSV.',
        });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err.message || 'Error exporting batch diffs.',
      });
    } finally {
      setExportingPendingBatchId(null);
    }
  };

  // Execute Queued Batch Immediately
  const handleExecuteNow = async (batchId: string) => {
    try {
      setExecutingNowBatchId(batchId);
      const res = await post(`/bulk-updater/batches/${batchId}/execute-now`);
      if (res.data && res.data.success) {
        setSelectedEntries({});
        toggleNotification({
          type: 'success',
          message: `Batch ${batchId} executed immediately!`,
        });
        await fetchPendingBatches();
        await fetchAuditHistory();
        await fetchModels();
      } else {
        toggleNotification({
          type: 'danger',
          message: res.data?.error || 'Failed to execute batch',
        });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err.response?.data?.error || err.message || 'Failed to execute batch',
      });
    } finally {
      setExecutingNowBatchId(null);
    }
  };

  // Perform Rollback
  const handleRollback = async (batchId: string) => {
    if (!window.confirm(`Are you sure you want to roll back all changes made in batch "${batchId}"?`)) {
      return;
    }

    try {
      setRollingBackBatchId(batchId);
      const res = await post(`/bulk-updater/audit/${batchId}/rollback`);

      if (res.data && res.data.success) {
        toggleNotification({
          type: 'success',
          message: `Batch "${batchId}" rolled back successfully! Reverted ${res.data.revertedCount} entries.`,
        });
        await fetchAuditHistory();
        await fetchModels();
      } else {
        toggleNotification({
          type: 'danger',
          message: res.data?.error || 'Rollback failed.',
        });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err.response?.data?.error || err.message || 'Rollback encountered an error.',
      });
    } finally {
      setRollingBackBatchId(null);
    }
  };

  const totalSelectedCount = Object.values(selectedEntries).filter(Boolean).length;
  const rootRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (rootRef.current && rootRef.current.parentElement) {
      rootRef.current.parentElement.style.minWidth = '0';
      rootRef.current.parentElement.style.maxWidth = '100%';
    }
  }, []);

  return (
    <Box
      ref={rootRef}
      className="bulk-updater-root"
      padding={8}
      background="neutral100"
      style={{ width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}
    >
      <style>{`
        /* Prevent page-level horizontal overflow under any circumstance */
        html, body {
          overflow-x: hidden !important;
          max-width: 100vw !important;
        }
        div:has(> .bulk-updater-root) {
          min-width: 0 !important;
          max-width: 100% !important;
          width: 100% !important;
          flex: 1 1 0% !important;
          overflow-x: clip !important;
        }
        .bulk-updater-root {
          min-width: 0 !important;
          max-width: 100% !important;
          width: 100% !important;
          box-sizing: border-box !important;
          overflow-x: clip !important;
        }
        /* All tables stretch to take the full available container space */
        .bulk-updater-root table {
          width: 100% !important;
          min-width: 0 !important;
        }
        .bulk-updater-root div:has(> table) {
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
        }
        /* Table scroll container keeps horizontal scroll strictly at the table level */
        .bulk-updater-table-container {
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
          overflow-x: auto !important;
          -webkit-overflow-scrolling: touch;
        }
        .bulk-updater-table-container::-webkit-scrollbar {
          height: 8px;
        }
        .bulk-updater-table-container::-webkit-scrollbar-track {
          background: rgba(120, 120, 150, 0.1);
          border-radius: 4px;
        }
        .bulk-updater-table-container::-webkit-scrollbar-thumb {
          background: rgba(120, 120, 150, 0.4);
          border-radius: 4px;
        }
        .bulk-updater-table-container::-webkit-scrollbar-thumb:hover {
          background: rgba(120, 120, 150, 0.7);
        }
      `}</style>
      {/* Page Header */}
      <Flex direction="column" alignItems="flex-start" gap={2} marginBottom={6}>
        <Flex justifyContent="space-between" width="100%">
          <Box>
            <Flex gap={3} alignItems="center">
              <Typography variant="alpha" tag="h1" fontWeight="bold">
                Bulk Attribute Updater
              </Typography>
              {auditEnabled && (
                <Badge backgroundColor="secondary100" textColor="secondary700">
                  AUDIT &amp; ROLLBACK ACTIVE
                </Badge>
              )}
            </Flex>
            <Typography variant="omega" textColor="neutral600">
              Cross-collection batch attribute management with declarative audit trail and one-click rollback.
            </Typography>
          </Box>
          <Flex gap={2}>
            <Button
              startIcon={<Download />}
              variant="secondary"
              onClick={() => {
                setShowProcessingDashboard(true);
              }}
            >
              Processing Tracker &amp; Reports
            </Button>
            <Button
              startIcon={<ArrowClockwise />}
              variant="tertiary"
              onClick={activeTab === 'editor' ? fetchModels : fetchAuditHistory}
              loading={loading || auditLoading}
            >
              Refresh
            </Button>
          </Flex>
        </Flex>
      </Flex>

      {/* Tab Navigation */}
      <Flex gap={2} marginBottom={4} wrap="wrap" justifyContent="space-between" alignItems="center">
        <Flex gap={2}>
          <Button
            variant={activeTab === 'editor' ? 'default' : 'tertiary'}
            onClick={() => setActiveTab('editor')}
            size="M"
          >
            Bulk Updater Workspace
          </Button>
          <Button
            variant={activeTab === 'audit' ? 'default' : 'tertiary'}
            onClick={() => setActiveTab('audit')}
            size="M"
          >
            Audit Trail &amp; Approvals
            {pendingBatches.filter((b) => b.status === 'pending_approval' || b.status === 'queued_offpeak').length > 0 ? (
              <Badge backgroundColor="warning100" textColor="warning700" style={{ marginLeft: 8 }}>
                {pendingBatches.filter((b) => b.status === 'pending_approval' || b.status === 'queued_offpeak').length} PENDING
              </Badge>
            ) : auditHistory.length > 0 ? (
              ` (${auditHistory.length})`
            ) : (
              ''
            )}
          </Button>
          <Button
            variant={activeTab === 'rules' ? 'default' : 'tertiary'}
            onClick={() => setActiveTab('rules')}
            size="M"
          >
            Validation &amp; Quota Rules
          </Button>
          <Button
            variant={activeTab === 'csv' ? 'default' : 'tertiary'}
            onClick={() => setActiveTab('csv')}
            size="M"
          >
            CSV Import / Export &amp; Override
          </Button>
        </Flex>

        {/* Server Policy Indicator */}
        {executionWindow && (
          <Flex gap={2} alignItems="center">
            <Badge
              backgroundColor={executionWindow.isBusinessHours ? 'warning100' : 'success100'}
              textColor={executionWindow.isBusinessHours ? 'warning700' : 'success700'}
            >
              {executionWindow.isBusinessHours
                ? `PEAK HOURS (${executionWindow.businessHours?.start} - ${executionWindow.businessHours?.end} ${executionWindow.timeZone || ''}) • OFF-PEAK QUEUE ACTIVE`
                : `OFF-PEAK WINDOW ACTIVE (${executionWindow.timeZone || ''}) • DIRECT EXECUTION PERMITTED`}
            </Badge>
          </Flex>
        )}
      </Flex>

      {/* Quick Rollback Banner for Workspace */}
      {activeTab === 'editor' && latestActiveBatch && !updateSummary && (
        <Box
          padding={3}
          paddingLeft={4}
          paddingRight={4}
          background="neutral0"
          shadow="filterShadow"
          hasRadius
          marginBottom={4}
          style={{ borderLeft: '4px solid #4945ff' }}
        >
          <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={2}>
            <Flex gap={2} alignItems="center">
              <Badge backgroundColor="primary100" textColor="primary700">
                ACTIVE BATCH
              </Badge>
              <Typography variant="pi" textColor="neutral700">
                <code>{latestActiveBatch.batchId}</code> ({latestActiveBatch.updatedCount} entries updated by {latestActiveBatch.userEmail})
              </Typography>
            </Flex>
            <Flex gap={2}>
              <Button
                variant="danger-light"
                size="S"
                startIcon={<ArrowClockwise />}
                onClick={() => handleRollback(latestActiveBatch.batchId)}
                loading={rollingBackBatchId === latestActiveBatch.batchId}
              >
                Rollback This Batch
              </Button>
              <Button
                variant="tertiary"
                size="S"
                onClick={() => setActiveTab('audit')}
              >
                View Rollback History →
              </Button>
            </Flex>
          </Flex>
        </Box>
      )}

      {/* ======================================================== */}
      {/* TAB 1: BULK UPDATER EDITOR                               */}
      {/* ======================================================== */}
      {activeTab === 'editor' && loading && collections.length === 0 ? (
        <Box
          padding={8}
          background="neutral0"
          shadow="filterShadow"
          hasRadius
          marginBottom={6}
          style={{ width: '100%', textAlign: 'center' }}
        >
          <Flex direction="column" alignItems="center" gap={3}>
            <Loader>Discovering schema attributes and collections...</Loader>
            <Typography variant="delta" fontWeight="semiBold" textColor="neutral800">
              Discovering Schema Attributes &amp; Collections...
            </Typography>
            <Typography variant="pi" textColor="neutral600">
              Scanning collection types, components, and relations across your Strapi schema.
            </Typography>
          </Flex>
        </Box>
      ) : activeTab === 'editor' ? (
        <>
          {/* Top Collection Type Selector & Component Depth Bar */}
          <Box
            padding={4}
            background="neutral0"
            shadow="filterShadow"
            hasRadius
            marginBottom={5}
            style={{ width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}
          >
            <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
              <Flex gap={3} alignItems="center" wrap="wrap" style={{ flex: 1, minWidth: 280 }}>
                <Box style={{ width: 340, minWidth: 260 }}>
                  <Field.Root>
                    <Field.Label>Target Collection Type</Field.Label>
                    <Combobox
                      key={`top-col-${selectedCollectionUid}`}
                      autocomplete={{ type: 'list', filter: 'contains' }}
                      placeholder="Search Collection Type..."
                      value={selectedCollectionUid || undefined}
                      clearLabel="Clear collection selection"
                      onClear={() => handleCollectionChange('')}
                      onFocus={(e: React.FocusEvent<HTMLInputElement>) => {
                        e.target.select();
                      }}
                      onChange={(val: any) => {
                        if (val && typeof val === 'string') {
                          handleCollectionChange(val);
                        }
                      }}
                    >
                      {collections.map((col) => (
                        <ComboboxOption key={col.uid} value={col.uid} textValue={`${col.displayName} (${col.uid})`}>
                          <Flex justifyContent="space-between" alignItems="center" style={{ width: '100%' }}>
                            <Typography variant="pi" fontWeight="bold">
                              {col.displayName}
                            </Typography>
                            <Flex gap={1} alignItems="center">
                              {col.isSingleType ? (
                                <Badge backgroundColor="secondary100" textColor="secondary700" size="S">
                                  Single
                                </Badge>
                              ) : (
                                <Badge backgroundColor="neutral150" textColor="neutral700" size="S">
                                  {col.totalEntries !== undefined ? `${col.totalEntries} entries` : ''}
                                </Badge>
                              )}
                            </Flex>
                          </Flex>
                        </ComboboxOption>
                      ))}
                    </Combobox>
                  </Field.Root>
                </Box>

                {selectedCol && (
                  <Flex gap={2} alignItems="center" wrap="wrap" style={{ paddingTop: 20 }}>
                    <Badge backgroundColor="primary100" textColor="primary700">
                      {selectedCol.isSingleType ? 'SINGLE TYPE' : 'COLLECTION'}
                    </Badge>
                    <Badge backgroundColor="neutral150" textColor="neutral700">
                      {selectedCol.isSingleType
                        ? '1 single entry'
                        : `${collectionPages[selectedCol.uid]?.total ?? selectedCol.totalEntries ?? selectedCol.entries?.length ?? 0} records`}
                    </Badge>
                  </Flex>
                )}
              </Flex>

              {/* Component Nesting Depth Config */}
              <Flex gap={2} alignItems="center" wrap="wrap">
                <Typography variant="pi" textColor="neutral700" fontWeight="bold">
                  Component Nesting Depth:
                </Typography>
                {[1, 2, 3, 4, 5].map((lvl) => (
                  <Button
                    key={`depth_cfg_${lvl}`}
                    variant={componentDepth === lvl ? 'default' : 'tertiary'}
                    size="S"
                    onClick={() => handleComponentDepthChange(lvl)}
                    title={`Discover nested component attributes up to Level ${lvl}`}
                  >
                    Level {lvl}
                  </Button>
                ))}
              </Flex>
            </Flex>
          </Box>

          {/* 1. Search & Filter Targets */}
          <Box
            padding={6}
            background="neutral0"
            shadow="filterShadow"
            hasRadius
            marginBottom={6}
            style={{ width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}
          >
            <Flex justifyContent="space-between" alignItems="center" marginBottom={4} wrap="wrap" gap={3}>
              <Box>
                <Typography variant="delta" tag="h2" fontWeight="semiBold">
                  1. Search &amp; Filter Targets
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  Search, filter, and select entries within {selectedCol ? selectedCol.displayName : 'the selected collection'} before updating.
                </Typography>
              </Box>
              <Flex gap={2}>
                <Button variant="secondary" size="S" onClick={selectAll}>
                  Select All
                </Button>
                <Button variant="tertiary" size="S" onClick={deselectAll}>
                  Deselect All
                </Button>
              </Flex>
            </Flex>

            {/* Target Value Filter & Search Bar */}
            <Box
              padding={4}
              background="neutral100"
              hasRadius
              marginBottom={5}
              style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}
            >
              <Flex direction="column" gap={3}>
                <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={2}>
                  <Flex gap={2} alignItems="center" wrap="wrap">
                    <Typography variant="omega" fontWeight="bold">
                      Search &amp; Filter Targets:
                    </Typography>
                    {isFilterActive && (
                      <Badge backgroundColor="primary100" textColor="primary700">
                        {matchingEntriesCount} matching {matchingEntriesCount === 1 ? 'entry' : 'entries'} found in database
                      </Badge>
                    )}
                    {searchAttribute && searchAttribute !== selectedAttribute && (
                      <Badge backgroundColor="secondary100" textColor="secondary700">
                        Searching by: {searchAttribute} &rarr; Target to update: {selectedAttribute}
                      </Badge>
                    )}
                  </Flex>
                  {isFilterActive && (
                    <Button variant="ghost" size="S" onClick={clearFilter}>
                      Clear Search &amp; Filter
                    </Button>
                  )}
                </Flex>

                <Flex gap={3} alignItems="flex-end" wrap="wrap">
                  {/* Search Attribute Combobox */}
                  <Box style={{ width: 280, minWidth: 230 }}>
                    <Field.Root>
                      <Field.Label>Search Attribute</Field.Label>
                      <Combobox
                        key={`search-attr-${selectedCollectionUid}`}
                        autocomplete={{ type: 'list', filter: 'contains' }}
                        placeholder={searchAttribute || `Same as Update (${selectedAttribute || 'None'})`}
                        value={searchAttribute || '__default__'}
                        clearLabel="Reset search attribute"
                        onClear={() => handleSearchAttributeChange('')}
                        onFocus={(e: React.FocusEvent<HTMLInputElement>) => {
                          e.target.select();
                        }}
                        onChange={(val: any) => {
                          if (val && typeof val === 'string' && val !== '__none__') {
                            handleSearchAttributeChange(val);
                          }
                        }}
                      >
                        {memoizedSearchComboboxOptions}
                      </Combobox>
                    </Field.Root>
                  </Box>

                  {/* Operator Select */}
                  <Box style={{ width: 200, minWidth: 170 }}>
                    <SingleSelect
                      label={effectiveSearchAttribute ? `Condition for "${effectiveSearchAttribute}"` : 'Filter condition'}
                      value={filterOperator}
                      onChange={(val) => setFilterOperator(String(val) as FilterOperator)}
                    >
                      <SingleSelectOption value="none">Show All (No Value Filter)</SingleSelectOption>
                      <SingleSelectOption value="empty">Is Empty or Null</SingleSelectOption>
                      <SingleSelectOption value="not_empty">Is Not Empty</SingleSelectOption>
                      <SingleSelectOption value="equals">Equals Exact Text</SingleSelectOption>
                      <SingleSelectOption value="contains">Contains Substring</SingleSelectOption>
                      <SingleSelectOption value="starts_with">Starts With</SingleSelectOption>
                    </SingleSelect>
                  </Box>

                  {/* Value query input if needed */}
                  {(filterOperator === 'equals' || filterOperator === 'contains' || filterOperator === 'starts_with') && (
                    <Box style={{ flex: 1, minWidth: 200 }}>
                      {effectiveSearchAttribute && relationsMeta[effectiveSearchAttribute] ? (
                        <Field.Root>
                          <Field.Label>{`Target ${relationsMeta[effectiveSearchAttribute].targetDisplayName} Relation`}</Field.Label>
                          <Combobox
                            autocomplete={{ type: 'list', filter: 'contains' }}
                            placeholder={
                              searchRelationOptionsLoading
                                ? 'Loading entities...'
                                : `Search & pick ${relationsMeta[effectiveSearchAttribute].targetDisplayName} or type text...`
                            }
                            value={filterQuery}
                            onClear={() => setFilterQuery('')}
                            onChange={(val: any) => {
                              if (typeof val === 'string') {
                                setFilterQuery(val);
                              }
                            }}
                            onInputChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                              setFilterQuery(e.target.value);
                            }}
                          >
                            {searchRelationOptions.map((opt) => (
                              <ComboboxOption key={opt.documentId} value={opt.label} textValue={opt.label}>
                                {opt.label}
                              </ComboboxOption>
                            ))}
                          </Combobox>
                        </Field.Root>
                      ) : (
                        <TextInput
                          label={effectiveSearchAttribute ? `Value for "${effectiveSearchAttribute}"` : 'Value to match'}
                          placeholder="Type value to match..."
                          value={filterQuery}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFilterQuery(e.target.value)}
                        />
                      )}
                    </Box>
                  )}

                  {/* Full-text search across entries */}
                  <Box style={{ flex: 1, minWidth: 180 }}>
                    <TextInput
                      label="Full-text Entry Search"
                      placeholder="Search title, name, or text across records..."
                      value={entrySearch}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEntrySearch(e.target.value)}
                    />
                  </Box>

                  {/* Lifecycle Status Filter */}
                  <Box style={{ width: 190, minWidth: 160 }}>
                    <SingleSelect
                      label="Lifecycle Status"
                      value={statusFilter}
                      onChange={(val) => setStatusFilter(String(val) as any)}
                    >
                      <SingleSelectOption value="all">All Statuses</SingleSelectOption>
                      <SingleSelectOption value="pending_review">Pending Review (Due)</SingleSelectOption>
                      <SingleSelectOption value="draft">Draft</SingleSelectOption>
                      <SingleSelectOption value="published">Published</SingleSelectOption>
                      <SingleSelectOption value="modified">Modified</SingleSelectOption>
                      <SingleSelectOption value="unknown">Unknown</SingleSelectOption>
                    </SingleSelect>
                  </Box>

                  {/* Quick Action Buttons when filter is active */}
                  {isFilterActive && (
                    <Flex gap={2} alignItems="center">
                      <Button
                        variant="default"
                        size="S"
                        onClick={selectAllMatching}
                        disabled={matchingEntriesCount === 0}
                      >
                        Select All Loaded
                      </Button>
                      <Button
                        variant="tertiary"
                        size="S"
                        onClick={deselectAllMatching}
                        disabled={matchingEntriesCount === 0}
                      >
                        Deselect All Loaded
                      </Button>
                    </Flex>
                  )}
                </Flex>

                {/* Pro Feature: Regex Search & Pattern Subsection */}
                <Box marginTop={3} paddingTop={3} style={{ borderTop: '1px solid #dcdce4' }}>
                  <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
                    <Flex gap={2} alignItems="center">
                      <Checkbox
                        checked={useRegex}
                        onCheckedChange={(checked: boolean) => setUseRegex(Boolean(checked))}
                      >
                        <Typography fontWeight="bold">Enable Regex Search &amp; Replace</Typography>
                      </Checkbox>
                      <Badge
                        backgroundColor={useRegex ? 'secondary100' : 'neutral200'}
                        textColor={useRegex ? 'secondary700' : 'neutral600'}
                        size="S"
                      >
                        {useRegex ? 'REGEX SEARCH ACTIVE' : 'REGEX OFF'}
                      </Badge>
                    </Flex>
                    {useRegex && (
                      <Box style={{ flex: 1, minWidth: 260 }}>
                        <TextInput
                          placeholder={`Regex pattern to search in "${effectiveSearchAttribute || 'target'}" (e.g. \\b(OldName)\\b)...`}
                          value={regexPattern}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setRegexPattern(e.target.value)
                          }
                        />
                      </Box>
                    )}
                  </Flex>
                  {useRegex && (
                    <Typography variant="pi" textColor="neutral600" marginTop={1}>
                      Searches {effectiveSearchAttribute ? <strong>{effectiveSearchAttribute}</strong> : 'target entries'} for text matching this regular expression pattern. Matches will be substituted with the Replacement Value configured in Section 1.
                    </Typography>
                  )}
                </Box>

                {isFilterActive && (
                  <Flex gap={2} alignItems="center" marginTop={1}>
                    <Badge backgroundColor="success100" textColor="success700" size="S">
                      ✓ Filter active: Showing only matching entries. All returned matching records are pre-selected.
                    </Badge>
                  </Flex>
                )}
              </Flex>
            </Box>

            {!selectedCol ? (
              <Box padding={6} background="neutral100" hasRadius style={{ textAlign: 'center' }}>
                <Typography variant="pi" textColor="neutral600">
                  Please select a collection type above to display entries.
                </Typography>
              </Box>
            ) : (() => {
              const col = selectedCol;
              const pageState = collectionPages[col.uid];
              const entries = pageState ? pageState.entries : (col.entries || []);
              const totalEntries = pageState ? pageState.total : (col.totalEntries !== undefined ? col.totalEntries : entries.length);
              const page = pageState ? pageState.page : 1;
              const pageCount = pageState ? pageState.pageCount : 1;
              const pageSize = pageState ? pageState.pageSize : defaultPageSize;
              const hasAttr = selectedAttribute ? col.attributes.includes(selectedAttribute) : false;
              const visibleEntries = getVisibleEntries(col);
              const matchingColCount = selectedAttribute ? entries.filter((e) => entryMatchesFilter(e, effectiveSearchAttribute)).length : 0;
              const isFullySelected = isCollectionFullySelected(col);
              const isPartiallySelected = isCollectionPartiallySelected(col);
              const currentSort = collectionSorts[col.uid] || { field: 'createdAt', order: 'desc' };
              const availableColumns = getAvailableColumnsForCollection(col, selectedAttribute, searchAttribute);
              const savedColKeys = collectionColumnVisibility[col.uid];
              const activeColumns = savedColKeys
                ? availableColumns.filter((c) => c.isPermanent || savedColKeys.includes(c.key))
                : availableColumns.filter((c) => c.defaultVisible);

              return (
                <Box
                    key={col.uid}
                    marginBottom={5}
                    padding={4}
                    hasRadius
                    borderStyle="solid"
                    borderWidth="1px"
                    borderColor="neutral200"
                    background="neutral0"
                    style={{ width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}
                  >
                    {/* Collection Header */}
                    <Flex justifyContent="space-between" alignItems="center" marginBottom={3} wrap="wrap" gap={2}>
                      <Flex gap={3} alignItems="center" wrap="wrap">
                        <Checkbox
                          checked={isFullySelected}
                          indeterminate={isPartiallySelected ? true : undefined}
                          onCheckedChange={() => toggleCollection(col)}
                        >
                          <Typography variant="beta" fontWeight="bold">
                            {col.displayName} {col.isSingleType ? '(Single Type)' : 'Collection'}
                          </Typography>
                        </Checkbox>
                        {col.isSingleType ? (
                          <Badge backgroundColor="secondary100" textColor="secondary700">
                            Single Type
                          </Badge>
                        ) : selectedAttribute ? (
                          <Badge
                            backgroundColor={hasAttr ? 'success100' : 'warning100'}
                            textColor={hasAttr ? 'success700' : 'warning700'}
                          >
                            {hasAttr
                              ? `Schema has "${selectedAttribute}"`
                              : `Schema lacks "${selectedAttribute}" (will skip)`}
                          </Badge>
                        ) : null}
                      </Flex>

                      <Flex gap={3} alignItems="center" wrap="wrap">
                        {!col.isSingleType && (
                          <Box style={{ position: 'relative', display: 'inline-block' }}>
                            <Button
                              variant={openSortPickerUid === col.uid ? 'secondary' : 'tertiary'}
                              size="S"
                              onClick={() => {
                                setOpenSortPickerUid(openSortPickerUid === col.uid ? null : col.uid);
                                setSortSearchTerm('');
                                if (openColumnPickerUid === col.uid) setOpenColumnPickerUid(null);
                              }}
                            >
                              <Flex gap={1} alignItems="center">
                                <Typography variant="pi" textColor="neutral600" fontWeight="bold">
                                  Sort:
                                </Typography>
                                <Typography variant="pi" fontWeight="semiBold">
                                  {getActiveSortLabel(currentSort, col)}
                                </Typography>
                              </Flex>
                            </Button>

                            {openSortPickerUid === col.uid && (
                              <Box
                                style={{
                                  position: 'absolute',
                                  top: 'calc(100% + 6px)',
                                  left: 0,
                                  zIndex: 220,
                                  width: 330,
                                  maxHeight: 440,
                                  background: '#ffffff',
                                  borderRadius: 8,
                                  boxShadow: '0 10px 25px rgba(33, 33, 52, 0.18)',
                                  border: '1px solid #dcdce4',
                                  padding: 12,
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 8,
                                }}
                              >
                                <Flex justifyContent="space-between" alignItems="center">
                                  <Typography variant="pi" fontWeight="bold">
                                    Sort by Column
                                  </Typography>
                                  <Button
                                    variant="ghost"
                                    size="S"
                                    onClick={() => setOpenSortPickerUid(null)}
                                    style={{ padding: '2px 6px', height: 'auto', minWidth: 'unset' }}
                                  >
                                    ✕
                                  </Button>
                                </Flex>

                                <TextInput
                                  size="S"
                                  placeholder="Search columns to sort..."
                                  value={sortSearchTerm}
                                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSortSearchTerm(e.target.value)}
                                />

                                <Box
                                  style={{
                                    maxHeight: 320,
                                    overflowY: 'auto',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 4,
                                  }}
                                >
                                  {getSortOptionsForCollection(col, selectedAttribute, searchAttribute)
                                    .filter((opt) => {
                                      if (!sortSearchTerm.trim()) return true;
                                      const term = sortSearchTerm.toLowerCase().trim();
                                      return opt.label.toLowerCase().includes(term) || opt.field.toLowerCase().includes(term);
                                    })
                                    .map((opt) => {
                                      const isSelected =
                                        (currentSort.field === opt.field ||
                                          (currentSort.field === 'updatedAt' && opt.field === 'updated_at') ||
                                          (currentSort.field === 'updated_at' && opt.field === 'updatedAt') ||
                                          (currentSort.field === 'createdAt' && opt.field === 'created_at') ||
                                          (currentSort.field === 'created_at' && opt.field === 'createdAt')
                                        ) && currentSort.order === opt.order;

                                      return (
                                        <Box
                                          key={`${opt.field}:${opt.order}`}
                                          onClick={() => {
                                            handleCollectionSortChange(col.uid, opt.field, opt.order);
                                            setOpenSortPickerUid(null);
                                            setSortSearchTerm('');
                                          }}
                                          style={{
                                            padding: '6px 10px',
                                            borderRadius: 6,
                                            cursor: 'pointer',
                                            background: isSelected ? 'rgba(73, 69, 255, 0.12)' : 'transparent',
                                            border: isSelected ? '1px solid #4945ff' : '1px solid transparent',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            transition: 'background 0.15s ease',
                                          }}
                                          onMouseEnter={(e) => {
                                            if (!isSelected) e.currentTarget.style.background = '#f6f6f9';
                                          }}
                                          onMouseLeave={(e) => {
                                            if (!isSelected) e.currentTarget.style.background = 'transparent';
                                          }}
                                        >
                                          <Typography
                                            variant="omega"
                                            fontWeight={isSelected ? 'bold' : 'normal'}
                                            textColor={isSelected ? 'primary700' : 'neutral800'}
                                          >
                                            {opt.label}
                                          </Typography>
                                          {isSelected && (
                                            <Badge size="S" backgroundColor="primary100" textColor="primary700">
                                              Active
                                            </Badge>
                                          )}
                                        </Box>
                                      );
                                    })}
                                </Box>
                              </Box>
                            )}
                          </Box>
                        )}

                        {/* Searchable Columns Dropdown Popover */}
                        <Box style={{ position: 'relative', display: 'inline-block' }}>
                          <Button
                            variant={openColumnPickerUid === col.uid ? 'secondary' : 'tertiary'}
                            size="S"
                            startIcon={<Cog />}
                            onClick={() => {
                              setOpenColumnPickerUid(openColumnPickerUid === col.uid ? null : col.uid);
                              setColumnSearchTerm('');
                              if (openSortPickerUid === col.uid) setOpenSortPickerUid(null);
                            }}
                          >
                            Columns ({activeColumns.filter((c) => !c.isPermanent).length}/{availableColumns.filter((c) => !c.isPermanent).length})
                          </Button>

                          {openColumnPickerUid === col.uid && (
                            <Box
                              style={{
                                position: 'absolute',
                                top: 'calc(100% + 6px)',
                                right: 0,
                                zIndex: 200,
                                width: 320,
                                maxHeight: 420,
                                background: '#ffffff',
                                borderRadius: 8,
                                boxShadow: '0 10px 25px rgba(33, 33, 52, 0.18)',
                                border: '1px solid #dcdce4',
                                padding: 12,
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 8,
                              }}
                            >
                              <Flex justifyContent="space-between" alignItems="center">
                                <Typography variant="pi" fontWeight="bold">
                                  Configure Columns
                                </Typography>
                                <Button
                                  variant="ghost"
                                  size="S"
                                  onClick={() => setOpenColumnPickerUid(null)}
                                  style={{ padding: '2px 6px', height: 'auto', minWidth: 'unset' }}
                                >
                                  ✕
                                </Button>
                              </Flex>

                              <TextInput
                                size="S"
                                placeholder="Search columns..."
                                value={columnSearchTerm}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setColumnSearchTerm(e.target.value)}
                              />

                              <Flex justifyContent="space-between" alignItems="center" style={{ borderBottom: '1px solid #f0f0f5', paddingBottom: 6 }}>
                                <Button
                                  variant="ghost"
                                  size="S"
                                  onClick={() => showAllColumns(col.uid, availableColumns)}
                                  style={{ fontSize: 11, padding: 0 }}
                                >
                                  Show All
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="S"
                                  onClick={() => {
                                    setCollectionColumnVisibility((prev) => ({
                                      ...prev,
                                      [col.uid]: [],
                                    }));
                                  }}
                                  style={{ fontSize: 11, padding: 0 }}
                                >
                                  Hide All
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="S"
                                  onClick={() => resetDefaultColumns(col.uid, availableColumns)}
                                  style={{ fontSize: 11, padding: 0 }}
                                >
                                  Reset
                                </Button>
                              </Flex>

                              <Box
                                style={{
                                  maxHeight: 250,
                                  overflowY: 'auto',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 4,
                                }}
                              >
                                {availableColumns
                                  .filter((c) => {
                                    if (!columnSearchTerm.trim()) return true;
                                    const term = columnSearchTerm.toLowerCase().trim();
                                    return c.label.toLowerCase().includes(term) || c.key.toLowerCase().includes(term);
                                  })
                                  .map((c) => {
                                    const isChecked = activeColumns.some((ac) => ac.key === c.key);
                                    const isNested = c.key.includes('.');
                                    const depth = isNested ? c.key.split('.').length - 1 : 0;
                                    return (
                                      <Flex
                                        key={c.key}
                                        justifyContent="space-between"
                                        alignItems="center"
                                        style={{
                                          padding: '4px 6px',
                                          borderRadius: 4,
                                          background: isChecked ? '#f0f0ff' : 'transparent',
                                        }}
                                      >
                                        <Box style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                                          <Checkbox
                                            checked={isChecked}
                                            disabled={c.isPermanent}
                                            onCheckedChange={() => {
                                              if (!c.isPermanent) {
                                                toggleColumn(col.uid, c.key, availableColumns);
                                              }
                                            }}
                                          >
                                            <Typography
                                              variant="pi"
                                              ellipsis
                                              style={{
                                                color: c.isPermanent ? '#8e8ea9' : '#272833',
                                                fontWeight: isChecked ? 600 : 400,
                                              }}
                                              title={c.key}
                                            >
                                              {c.label}
                                            </Typography>
                                          </Checkbox>
                                        </Box>
                                        {c.isPermanent ? (
                                          <Badge size="S" backgroundColor="neutral150" textColor="neutral700">
                                            Fixed
                                          </Badge>
                                        ) : depth > 0 ? (
                                          <Badge size="S" backgroundColor="secondary100" textColor="secondary700">
                                            L{depth}
                                          </Badge>
                                        ) : null}
                                      </Flex>
                                    );
                                  })}
                              </Box>
                            </Box>
                          )}
                        </Box>

                        <Button
                          variant="tertiary"
                          size="S"
                          startIcon={<Download />}
                          onClick={async () => {
                            try {
                              const params = new URLSearchParams();
                              if (selectedAttribute) params.set('attribute', selectedAttribute);
                              if (filterOperator && filterOperator !== 'none') {
                                params.set('filterOperator', filterOperator);
                                if (filterQuery) params.set('filterQuery', filterQuery);
                              }
                              if (entrySearch && entrySearch.trim()) {
                                params.set('search', entrySearch.trim());
                              }

                              // If entries are checked in this collection, export only checked entries
                              const colSelectedDocIds = col.entries
                                .filter((e) => selectedEntries[`${col.uid}${KEY_SEP}${e.documentId}`])
                                .map((e) => e.documentId);
                              if (colSelectedDocIds.length > 0) {
                                params.set('documentIds', colSelectedDocIds.join(','));
                              }

                              const res = await get(`/bulk-updater/csv/export/${col.uid}?${params.toString()}`);
                              const csvStr = res.data?.csvContent || (typeof res.data === 'string' ? res.data : '');
                              if (!csvStr) {
                                toggleNotification({
                                  type: 'warning',
                                  message: 'No CSV content returned for this collection',
                                });
                                return;
                              }
                              const safeContent = csvStr.startsWith('\uFEFF') ? csvStr : '\uFEFF' + csvStr;
                              const blob = new Blob([safeContent], { type: 'text/csv;charset=utf-8;' });
                              const url = URL.createObjectURL(blob);
                              const link = document.createElement('a');
                              link.href = url;
                              link.setAttribute('download', `${col.singularName || 'export'}_entries.csv`);
                              document.body.appendChild(link);
                              link.click();
                              document.body.removeChild(link);
                              URL.revokeObjectURL(url);
                              toggleNotification({
                                type: 'success',
                                message: `Exported ${res.data?.count ?? (colSelectedDocIds.length || col.entries.length)} ${col.displayName} entries to Excel CSV`,
                              });
                            } catch (e: any) {
                              toggleNotification({
                                type: 'danger',
                                message: e.message || 'Failed exporting CSV',
                              });
                            }
                          }}
                        >
                          Export CSV
                        </Button>

                        <Typography variant="pi" textColor="neutral500">
                          {col.isSingleType
                            ? '1 single entry'
                            : isFilterActive
                            ? `${totalEntries} matching entries in DB`
                            : `${totalEntries} entries`}
                        </Typography>
                      </Flex>
                    </Flex>

                    {/* Entries Table */}
                    <Box className="bulk-updater-table-container" style={{ width: '100%', maxWidth: '100%', minWidth: 0, overflowX: 'auto' }}>
                      <Table colCount={activeColumns.length} rowCount={visibleEntries.length + 1} style={{ width: '100%' }}>
                        <Thead>
                          <Tr>
                            {activeColumns.map((colDef) =>
                              renderHeaderCell(colDef, col, currentSort, selectedAttribute, searchAttribute, handleHeaderSortClick)
                            )}
                          </Tr>
                        </Thead>
                        <Tbody>
                          {visibleEntries.length === 0 ? (
                            <Tr>
                              <Td colSpan={activeColumns.length}>
                                <Box padding={4} style={{ textAlign: 'center' }}>
                                  <Typography variant="pi" textColor="neutral500">
                                    No entries in this content type match the active filter criteria.
                                  </Typography>
                                </Box>
                              </Td>
                            </Tr>
                          ) : (
                            visibleEntries.map((entry) => {
                              const key = `${col.uid}${KEY_SEP}${entry.documentId}`;
                              const isSelected = Boolean(selectedEntries[key]);
                              const isMatch = isFilterActive;
                              const isDzExpanded = Boolean(expandedDzEntries[key]);
                              const onToggleExpandDz = () =>
                                setExpandedDzEntries((prev) => ({
                                  ...prev,
                                  [key]: !prev[key],
                                }));

                              const dzFields = Object.keys(entry).filter(
                                (k) => Array.isArray(entry[k]) && entry[k].length > 0 && entry[k].some((item: any) => item && item.__component)
                              );

                              return (
                                <React.Fragment key={key}>
                                  <Tr
                                    style={{
                                      backgroundColor: isSelected
                                        ? 'rgba(73, 69, 255, 0.14)'
                                        : isMatch
                                        ? 'rgba(46, 213, 115, 0.08)'
                                        : undefined,
                                      boxShadow: isSelected
                                        ? 'inset 3px 0 0 0 #4945ff'
                                        : isMatch
                                        ? 'inset 3px 0 0 0 #2ed573'
                                        : undefined,
                                    }}
                                  >
                                    {activeColumns.map((colDef) => (
                                      <Td key={colDef.key}>
                                        {renderCellContent(
                                          colDef,
                                          entry,
                                          col,
                                          selectedAttribute,
                                          searchAttribute,
                                          isMatch,
                                          hasAttr,
                                          isSelected,
                                          () => toggleEntry(col.uid, entry.documentId),
                                          pendingBatches,
                                          isDzExpanded,
                                          onToggleExpandDz,
                                          filterQuery
                                        )}
                                      </Td>
                                    ))}
                                  </Tr>

                                  {/* Dynamic Zone Expandable Drawer Sub-Table */}
                                  {isDzExpanded && dzFields.map((dzKey) => {
                                    const blocks = entry[dzKey] || [];
                                    const targetParsed = parseDynamicZonePath(selectedAttribute);
                                    const isBlockApplicable = (blockItem: any) => {
                                      if (!targetParsed.subPath) return true;
                                      const scopedPath = `${dzKey}[${blockItem?.__component}].${targetParsed.subPath}`;
                                      const componentSupports = (col?.attributes || attributes || []).includes(scopedPath);
                                      return componentSupports || getNestedValue(blockItem, targetParsed.subPath) !== undefined;
                                    };
                                    const allApplicableIndexes = blocks
                                      .map((_: any, i: number) => i)
                                      .filter((i: number) => isBlockApplicable(blocks[i]));

                                    return (
                                      <Tr key={`${key}-dz-${dzKey}`}>
                                        <Td colSpan={activeColumns.length} style={{ padding: '12px 16px', backgroundColor: 'rgba(73, 69, 255, 0.02)', borderBottom: '2px solid rgba(73, 69, 255, 0.15)' }}>
                                          <Box
                                            padding={3}
                                            background="neutral0"
                                            hasRadius
                                            style={{ border: '1px solid rgba(73, 69, 255, 0.25)', boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}
                                          >
                                            <Flex justifyContent="space-between" alignItems="center" marginBottom={2}>
                                              <Flex gap={2} alignItems="center">
                                                <Typography variant="sigma" textColor="primary700">
                                                  DYNAMIC ZONE: &quot;{dzKey}&quot; ({blocks.length} blocks)
                                                </Typography>
                                                <Badge backgroundColor="primary100" textColor="primary700">
                                                  Selective Block Targeting
                                                </Badge>
                                              </Flex>
                                              <Typography variant="pi" textColor="neutral500">
                                                Selectively choose which blocks to update for this entry
                                              </Typography>
                                            </Flex>

                                            <Table colCount={5} rowCount={blocks.length + 1} style={{ width: '100%', background: '#fff' }}>
                                              <Thead>
                                                <Tr>
                                                  <Th style={{ width: 64 }}><Typography variant="sigma">Update?</Typography></Th>
                                                  <Th style={{ width: 60 }}><Typography variant="sigma">Pos</Typography></Th>
                                                  <Th style={{ width: 220 }}><Typography variant="sigma">Component</Typography></Th>
                                                  <Th><Typography variant="sigma">Target Field Value ({selectedAttribute || 'selected'})</Typography></Th>
                                                  <Th><Typography variant="sigma">Block Summary</Typography></Th>
                                                </Tr>
                                              </Thead>
                                              <Tbody>
                                                {blocks.map((block: any, bIdx: number) => {
                                                  const compUid = block.__component;
                                                  const compLabel = formatComponentName(compUid);
                                                  const scopedPath = `${dzKey}[${compUid}].${targetParsed.subPath}`;
                                                  const componentSupports = (col?.attributes || attributes || []).includes(scopedPath);
                                                  const blockVal = targetParsed.subPath ? getNestedValue(block, targetParsed.subPath) : undefined;
                                                  const hasTargetAttr = componentSupports || blockVal !== undefined;

                                                  const isBlockChecked = hasTargetAttr && isSelected && (selectedDzBlocks[key] !== undefined ? selectedDzBlocks[key].includes(bIdx) : true);

                                                  return (
                                                    <Tr
                                                      key={bIdx}
                                                      style={{
                                                        backgroundColor: isBlockChecked ? 'rgba(73, 69, 255, 0.08)' : undefined,
                                                      }}
                                                    >
                                                      <Td>
                                                        <Checkbox
                                                          checked={isBlockChecked}
                                                          disabled={!hasTargetAttr}
                                                          onCheckedChange={() => {
                                                            toggleDzBlock(col.uid, entry.documentId, bIdx, allApplicableIndexes);
                                                          }}
                                                        />
                                                      </Td>
                                                      <Td>
                                                        <Typography variant="pi" fontWeight="bold">#{bIdx}</Typography>
                                                      </Td>
                                                      <Td>
                                                        <Badge backgroundColor="neutral150" textColor="neutral800">
                                                          {compLabel}
                                                        </Badge>
                                                        <Typography variant="pi" textColor="neutral500" display="block" style={{ fontSize: '0.68rem', marginTop: 2 }}>
                                                          {compUid}
                                                        </Typography>
                                                      </Td>
                                                      <Td>
                                                        {hasTargetAttr ? (
                                                          <Typography variant="omega" fontWeight="semiBold" textColor="primary700">
                                                            {formatDisplayValue(blockVal)}
                                                          </Typography>
                                                        ) : (
                                                          <Badge backgroundColor="neutral100" textColor="neutral500">
                                                            Does not contain attribute
                                                          </Badge>
                                                        )}
                                                      </Td>
                                                      <Td>
                                                        <Typography variant="pi" textColor="neutral600" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                          {block.title || block.name || block.heading || block.body || Object.keys(block).filter((k: string) => !k.startsWith('_') && k !== 'id').slice(0, 3).map((k: string) => `${k}: ${formatDisplayValue(block[k])}`).join(', ') || '-'}
                                                        </Typography>
                                                      </Td>
                                                    </Tr>
                                                  );
                                                })}
                                              </Tbody>
                                            </Table>
                                          </Box>
                                        </Td>
                                      </Tr>
                                    );
                                  })}
                                </React.Fragment>
                              );
                            })
                          )}
                        </Tbody>
                      </Table>
                    </Box>

                    {/* Server-Side Pagination & Page Size Controls */}
                    {!col.isSingleType && (
                      <Flex justifyContent="space-between" alignItems="center" marginTop={4} wrap="wrap" gap={3}>
                        <Flex gap={3} alignItems="center" wrap="wrap">
                          <Typography variant="pi" textColor="neutral600">
                            Showing {totalEntries === 0 ? 0 : Math.min((page - 1) * pageSize + 1, totalEntries)} to {Math.min(page * pageSize, totalEntries)} of {totalEntries} {isFilterActive ? 'matching entries' : 'entries'}
                          </Typography>
                          <Flex gap={1} alignItems="center">
                            <Typography variant="pi" textColor="neutral600">Show:</Typography>
                            <Box style={{ width: 85 }}>
                              <SingleSelect
                                size="S"
                                value={String(pageSize)}
                                onChange={(val) => handleCollectionPageSizeChange(col.uid, Number(val))}
                              >
                                <SingleSelectOption value="5">5</SingleSelectOption>
                                <SingleSelectOption value="10">10</SingleSelectOption>
                                <SingleSelectOption value="25">25</SingleSelectOption>
                                <SingleSelectOption value="50">50</SingleSelectOption>
                                <SingleSelectOption value="100">100</SingleSelectOption>
                                <SingleSelectOption value="250">250</SingleSelectOption>
                                <SingleSelectOption value="500">500</SingleSelectOption>
                              </SingleSelect>
                            </Box>
                            <Typography variant="pi" textColor="neutral500">per page</Typography>
                          </Flex>
                          {totalEntries > visibleEntries.length && (
                            <Button
                              variant="tertiary"
                              size="S"
                              onClick={() => handleCollectionPageSizeChange(col.uid, Math.min(totalEntries, 500))}
                            >
                              Load all {totalEntries} entries
                            </Button>
                          )}
                        </Flex>

                        {pageCount > 1 && (
                          <Flex gap={2} alignItems="center">
                            <Button
                              variant="tertiary"
                              size="S"
                              disabled={page <= 1 || pageState?.loading}
                              onClick={() => loadCollectionPage(col.uid, page - 1)}
                            >
                              &larr; Previous
                            </Button>
                            <Typography variant="pi" fontWeight="bold" textColor="neutral800">
                              Page {page} of {pageCount}
                            </Typography>
                            <Button
                              variant="tertiary"
                              size="S"
                              disabled={page >= pageCount || pageState?.loading}
                              onClick={() => loadCollectionPage(col.uid, page + 1)}
                            >
                              Next &rarr;
                            </Button>
                          </Flex>
                        )}
                      </Flex>
                    )}
                  </Box>
                );
              })()}
          </Box>

          {/* 2. Configure Attribute Update & Execution */}
          <Box
            padding={6}
            background="neutral0"
            shadow="filterShadow"
            hasRadius
            marginBottom={6}
            style={{ width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}
          >
            <Flex justifyContent="space-between" alignItems="center" marginBottom={4} wrap="wrap" gap={3}>
              <Box>
                <Typography variant="delta" tag="h2" fontWeight="semiBold">
                  2. Configure Attribute Update
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  Select the target attribute to update and configure the replacement value for your selected entries.
                </Typography>
              </Box>
            </Flex>

            <Flex gap={3} alignItems="flex-end" wrap="wrap">
              {/* Attribute Dropdown (Searchable Combobox) */}
              <Box style={{ width: 280, minWidth: 230 }}>
                <Field.Root>
                  <Field.Label>Attribute to Update</Field.Label>
                  <Combobox
                    key={`update-attr-${selectedCollectionUid}`}
                    autocomplete={{ type: 'list', filter: 'contains' }}
                    placeholder="Search attribute by name or relation..."
                    value={selectedAttribute || undefined}
                    clearLabel="Clear attribute selection"
                    onClear={() => handleAttributeChange('')}
                    onFocus={(e: React.FocusEvent<HTMLInputElement>) => {
                      e.target.select();
                    }}
                    loading={loading && attributes.length === 0}
                    loadingMessage="Discovering schema attributes..."
                    onChange={(val: any) => {
                      if (val && typeof val === 'string' && val !== '__none__') {
                        handleAttributeChange(val);
                      }
                    }}
                  >
                    {memoizedComboboxOptions}
                  </Combobox>
                </Field.Root>
              </Box>

              {/* New Value Input or Relation Target Selector */}
              <Box style={{ flex: 1, minWidth: 340 }}>
                {relationsMeta[selectedAttribute] ? (
                  <Flex direction="column" gap={1} style={{ width: '100%' }}>
                    <Flex gap={2} alignItems="center" wrap="wrap">
                      <Typography variant="pi" fontWeight="bold" textColor="neutral700">
                        Target {relationsMeta[selectedAttribute].targetDisplayName} Relation:
                      </Typography>
                      <Badge backgroundColor="secondary100" textColor="secondary700">
                        {relationsMeta[selectedAttribute].relationType} &rarr; {relationsMeta[selectedAttribute].targetDisplayName}
                      </Badge>
                      {relationsMeta[selectedAttribute].isMulti && (
                        <Badge backgroundColor="primary100" textColor="primary700">
                          Multi-Relation
                        </Badge>
                      )}
                    </Flex>
                    <Flex gap={2} alignItems="center" style={{ width: '100%' }}>
                      <Box style={{ flex: 1, minWidth: 200 }}>
                        <Field.Root>
                          <Field.Label>{`Choose ${relationsMeta[selectedAttribute].targetDisplayName}`}</Field.Label>
                          <Combobox
                            autocomplete={{ type: 'list', filter: 'contains' }}
                            placeholder={relationOptionsLoading ? 'Loading entities...' : `Search & pick ${relationsMeta[selectedAttribute].targetDisplayName}...`}
                            value={selectedRelationDocId}
                            onChange={(val: any) => {
                              const docId = val ? String(val) : '';
                              setSelectedRelationDocId(docId);
                              if (docId === '__clear__') {
                                setAttributeValue(JSON.stringify({ mode: 'clear', label: '(clear relation)' }));
                              } else {
                                const opt = relationOptions.find((o) => o.documentId === docId);
                                setAttributeValue(JSON.stringify({ mode: relationMode, documentIds: [docId], label: opt?.label || docId }));
                              }
                            }}
                          >
                            <ComboboxOption value="__clear__" textValue="Clear / Unlink Relation">
                              -- Clear / Unlink Relation --
                            </ComboboxOption>
                            {relationOptions.map((opt) => (
                              <ComboboxOption key={opt.documentId} value={opt.documentId} textValue={opt.label}>
                                {opt.label}
                              </ComboboxOption>
                            ))}
                          </Combobox>
                        </Field.Root>
                      </Box>
                      {relationsMeta[selectedAttribute].isMulti && (
                        <Box style={{ width: 170 }}>
                          <SingleSelect
                            label="Action Mode"
                            value={relationMode}
                            onChange={(val) => {
                              const m = String(val) as 'set' | 'connect' | 'disconnect' | 'clear';
                              setRelationMode(m);
                              if (selectedRelationDocId) {
                                if (selectedRelationDocId === '__clear__' || m === 'clear') {
                                  setAttributeValue(JSON.stringify({ mode: 'clear', label: '(clear relation)' }));
                                } else {
                                  const opt = relationOptions.find((o) => o.documentId === selectedRelationDocId);
                                  setAttributeValue(JSON.stringify({ mode: m, documentIds: [selectedRelationDocId], label: opt?.label || selectedRelationDocId }));
                                }
                              }
                            }}
                          >
                            <SingleSelectOption value="set">Set / Overwrite</SingleSelectOption>
                            <SingleSelectOption value="connect">Add / Connect</SingleSelectOption>
                            <SingleSelectOption value="disconnect">Remove / Disconnect</SingleSelectOption>
                            <SingleSelectOption value="clear">Clear All</SingleSelectOption>
                          </SingleSelect>
                        </Box>
                      )}
                    </Flex>
                  </Flex>
                ) : (
                  <TextInput
                    label={useRegex ? 'Replacement Value' : 'New Attribute Value'}
                    name="attributeValue"
                    placeholder={useRegex ? 'Replace matched pattern with...' : 'Enter the value to apply...'}
                    value={attributeValue}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setAttributeValue(e.target.value)
                    }
                  />
                )}
              </Box>

              {/* Action Buttons: Preview, Update & Publish */}
              <Flex gap={2} alignItems="center" wrap="wrap">
                <Button
                  startIcon={<Eye />}
                  variant="secondary"
                  size="L"
                  onClick={handleOpenPreviewModal}
                  loading={previewLoading}
                  disabled={loading || totalSelectedCount === 0 || !selectedAttribute || !selectedAttribute.trim()}
                >
                  Preview Changes ({totalSelectedCount})
                </Button>
                <Button
                  startIcon={<Play />}
                  variant="default"
                  size="L"
                  onClick={handleOpenConfirmModal}
                  loading={updating}
                  disabled={loading || totalSelectedCount === 0 || !selectedAttribute || !selectedAttribute.trim()}
                >
                  Update Selected ({totalSelectedCount})
                </Button>
                <Button
                  startIcon={<Check />}
                  variant="success-light"
                  size="L"
                  onClick={handleOpenPublishModal}
                  loading={publishing}
                  disabled={loading || totalSelectedCount === 0}
                  title="Directly publish selected draft records across collections"
                >
                  Publish Selected ({totalSelectedCount})
                </Button>
                <Button
                  startIcon={<Download />}
                  variant="tertiary"
                  size="L"
                  onClick={handleBulkExportSelected}
                  loading={bulkExporting}
                  disabled={loading || totalSelectedCount === 0}
                  title="Export selected entries to Excel-compatible CSV with full nested component support"
                >
                  Export Selected ({totalSelectedCount})
                </Button>
              </Flex>
            </Flex>

            {/* Auto-Publish upon Update Setting */}
            <Box marginTop={4} padding={4} background="neutral100" hasRadius style={{ border: '1px solid #eaeaef' }}>
              <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
                <Flex gap={2} alignItems="center">
                  <Checkbox
                    checked={publishOnApproval}
                    onCheckedChange={(checked: boolean) => setPublishOnApproval(Boolean(checked))}
                  >
                    <Typography fontWeight="bold">Auto-Publish after Update</Typography>
                  </Checkbox>
                  <Badge
                    backgroundColor={publishOnApproval ? 'success100' : 'warning100'}
                    textColor={publishOnApproval ? 'success700' : 'warning700'}
                  >
                    {publishOnApproval ? '✓ LIVE PUBLISH' : 'DRAFT ONLY'}
                  </Badge>
                </Flex>
                <Typography variant="pi" textColor="neutral600">
                  {publishOnApproval
                    ? 'When enabled, entries will be published live immediately upon batch execution for draft-enabled content types.'
                    : 'When disabled, entries will be saved as draft versions without publishing to live visitors.'}
                </Typography>
              </Flex>

              {/* Selection Alert: Unreviewed Content Warning Banner */}
              {publishOnApproval && selectedLifecycleStats.unreviewedCount > 0 && (
                <Box marginTop={3} padding={3} background="warning100" hasRadius style={{ border: '1px solid #f5c0b8' }}>
                  <Flex gap={2} alignItems="flex-start">
                    <Typography variant="pi" fontWeight="bold" textColor="warning700">
                      ⚠️ Unreviewed Content Alert:
                    </Typography>
                    <Typography variant="pi" textColor="warning700">
                      {selectedLifecycleStats.unreviewedCount} of {totalSelectedCount} selected record(s) contain unreviewed draft changes ({selectedLifecycleStats.draft} Draft, {selectedLifecycleStats.modified} Modified).
                      Publishing them live will push all unreviewed draft content across all fields to live visitors. You can select safe publishing (recommended) or provide explicit consent at review time.
                    </Typography>
                  </Flex>
                </Box>
              )}
            </Box>

            {/* Selected Attribute & Collection Context */}
            {selectedCol && selectedAttribute && (
              <Box marginTop={4} padding={3} background="neutral100" hasRadius style={{ border: '1px solid #eaeaef' }}>
                <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
                  <Flex gap={2} alignItems="center" wrap="wrap">
                    <Typography variant="pi" fontWeight="bold">
                      Target Selection:
                    </Typography>
                    <Badge backgroundColor="primary100" textColor="primary700">
                      Collection: {selectedCol.displayName}
                    </Badge>
                    <Badge backgroundColor="secondary100" textColor="secondary700">
                      Attribute: {selectedAttribute} {attributesMeta[selectedAttribute]?.type ? `(${attributesMeta[selectedAttribute].type})` : ''}
                    </Badge>
                    {attributesMeta[selectedAttribute]?.depth ? (
                      <Badge backgroundColor="neutral200" textColor="neutral700">
                        Nesting Level: L{attributesMeta[selectedAttribute].depth}
                      </Badge>
                    ) : null}
                    {selectedCol.draftAndPublish ? (
                      <Badge backgroundColor="success100" textColor="success700">
                        Draft &amp; Publish Enabled
                      </Badge>
                    ) : (
                      <Badge backgroundColor="warning100" textColor="warning700">
                        Direct Publish Only
                      </Badge>
                    )}
                  </Flex>
                </Flex>
              </Box>
            )}
          </Box>


          {/* Execution Results Feedback */}
          {updateSummary && (
            <Box
              padding={6}
              background="neutral0"
              shadow="filterShadow"
              hasRadius
              marginBottom={6}
            >
              <Typography variant="delta" tag="h2" fontWeight="semiBold" marginBottom={3}>
                3. Execution Results
              </Typography>

              <Alert
                title="Batch Update Completed"
                variant={updateSummary.updatedCount > 0 ? 'success' : 'default'}
                closeLabel="Close"
                onClose={() => setUpdateSummary(null)}
                marginBottom={4}
              >
                <Flex direction="column" alignItems="flex-start" gap={3} width="100%">
                  <Typography variant="omega">
                    Successfully updated <strong>{updateSummary.updatedCount}</strong> records.
                    Skipped <strong>{updateSummary.skippedCount}</strong> records.
                    {updateSummary.batchId && (
                      <span>
                        {' '}Transaction Batch ID: <code>{updateSummary.batchId}</code> (logged to audit trail).
                      </span>
                    )}
                  </Typography>
                  {updateSummary.batchId && (
                    <Flex gap={2} marginTop={1}>
                      <Button
                        variant="danger-light"
                        size="S"
                        startIcon={<ArrowClockwise />}
                        onClick={() => handleRollback(updateSummary.batchId!)}
                        loading={rollingBackBatchId === updateSummary.batchId}
                      >
                        Rollback This Batch
                      </Button>
                      <Button
                        variant="tertiary"
                        size="S"
                        onClick={() => setActiveTab('audit')}
                      >
                        View in Audit Trail &amp; Rollback History →
                      </Button>
                    </Flex>
                  )}
                </Flex>
              </Alert>

              {lastResults && lastResults.length > 0 && (
                <Table colCount={4} rowCount={lastResults.length + 1}>
                  <Thead>
                    <Tr>
                      <Th>
                        <Typography variant="sigma">Collection</Typography>
                      </Th>
                      <Th>
                        <Typography variant="sigma">Entry</Typography>
                      </Th>
                      <Th>
                        <Typography variant="sigma">Status</Typography>
                      </Th>
                      <Th>
                        <Typography variant="sigma">Details</Typography>
                      </Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {lastResults.map((res, idx) => (
                  <Tr key={idx}>
                    <Td>
                      <Typography fontWeight="bold">{res.collectionName}</Typography>
                    </Td>
                    <Td>
                      <Typography>{res.label}</Typography>
                    </Td>
                    <Td>
                      {res.status === 'updated' && (
                        <Badge backgroundColor="success100" textColor="success700">
                          Updated
                        </Badge>
                      )}
                      {res.status === 'skipped' && (
                        <Badge backgroundColor="warning100" textColor="warning700">
                          Skipped
                        </Badge>
                      )}
                      {res.status === 'error' && (
                        <Badge backgroundColor="danger100" textColor="danger700">
                          Error
                        </Badge>
                      )}
                    </Td>
                    <Td>
                      <Typography variant="pi" textColor="neutral700">
                        {res.message}
                      </Typography>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Box>
      )}
    </>
  ) : null}

      {/* ======================================================== */}
      {/* TAB 2: AUDIT TRAIL & ROLLBACK HISTORY                    */}
      {/* ======================================================== */}
      {activeTab === 'audit' && (
        <Box
          padding={6}
          background="neutral0"
          shadow="filterShadow"
          hasRadius
          style={{ width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}
        >
          <Flex justifyContent="space-between" alignItems="center" marginBottom={4}>
            <Box>
              <Typography variant="delta" tag="h2" fontWeight="semiBold">
                Audit Trail &amp; Version History
              </Typography>
              <Typography variant="pi" textColor="neutral600">
                Deterministic record of all batch updates, timestamps, admin authorship, and one-click rollback.
              </Typography>
            </Box>
            <Button
              variant="tertiary"
              size="S"
              startIcon={<ArrowClockwise />}
              onClick={() => {
                fetchAuditHistory();
                fetchPendingBatches();
              }}
              loading={auditLoading || pendingBatchesLoading}
            >
              Refresh History
            </Button>
          </Flex>

          {/* Pending Approvals & Queued Batches Section */}
          <Box marginBottom={6} padding={5} background="neutral100" hasRadius style={{ border: '1px solid #e6e6ef' }}>
            <Flex justifyContent="space-between" alignItems="center" marginBottom={3}>
              <Box>
                <Flex gap={2} alignItems="center">
                  <Typography variant="epsilon" fontWeight="bold">
                    Pending Approvals &amp; Queued Batches
                  </Typography>
                  {pendingBatches.filter((b) => b.status === 'pending_approval' || b.status === 'queued_offpeak').length > 0 && (
                    <Badge backgroundColor="warning100" textColor="warning700">
                      {pendingBatches.filter((b) => b.status === 'pending_approval' || b.status === 'queued_offpeak').length} Action Required
                    </Badge>
                  )}
                </Flex>
                <Typography variant="pi" textColor="neutral600">
                  Four-Eyes Maker-Checker authorization queue and off-peak scheduled maintenance batches.
                </Typography>
              </Box>
              <Button
                variant="tertiary"
                size="S"
                startIcon={<ArrowClockwise />}
                onClick={fetchPendingBatches}
                loading={pendingBatchesLoading}
              >
                Refresh Queue
              </Button>
            </Flex>

            {pendingBatches.length === 0 ? (
              <Box padding={4} background="neutral0" hasRadius style={{ textAlign: 'center' }}>
                <Typography variant="pi" textColor="neutral600">
                  No batches pending approval or queued for off-peak execution.
                </Typography>
              </Box>
            ) : (
              <Box className="bulk-updater-table-container" style={{ width: '100%', maxWidth: '100%', minWidth: 0, overflowX: 'auto' }}>
                <Table colCount={6} rowCount={pendingBatches.length + 1} style={{ width: '100%' }}>
                  <Thead>
                    <Tr>
                      <Th style={{ minWidth: 160 }}><Typography variant="sigma">Batch ID &amp; Created</Typography></Th>
                      <Th style={{ minWidth: 130 }}><Typography variant="sigma">Maker</Typography></Th>
                      <Th style={{ minWidth: 200 }}><Typography variant="sigma">Target Details</Typography></Th>
                      <Th style={{ minWidth: 150 }}><Typography variant="sigma">Status</Typography></Th>
                      <Th style={{ minWidth: 180 }}><Typography variant="sigma">Notes</Typography></Th>
                      <Th style={{ minWidth: 180, textAlign: 'right' }}><Typography variant="sigma">Actions</Typography></Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {pendingBatches.map((batch) => (
                      <Tr key={batch.id}>
                        <Td>
                          <Typography fontWeight="bold">{batch.id}</Typography>
                          <Typography variant="pi" textColor="neutral600" display="block">
                            {new Date(batch.createdAt).toLocaleString()}
                          </Typography>
                        </Td>
                        <Td>
                          <Typography variant="omega">{batch.createdBy?.email || 'admin'}</Typography>
                        </Td>
                        <Td>
                          <Typography variant="omega" fontWeight="semiBold">
                            {batch.summary.attribute}: "{formatDisplayValue(batch.summary.value)}"
                          </Typography>
                          <Flex gap={1} alignItems="center" marginTop={1}>
                            {(batch.payload?.action === 'csv_import' || batch.id?.startsWith('csv_')) && (
                              <Badge backgroundColor="secondary100" textColor="secondary700">
                                📊 CSV IMPORT
                              </Badge>
                            )}
                            <Badge
                              backgroundColor={batch.summary.publishOnApproval === false ? 'warning100' : 'success100'}
                              textColor={batch.summary.publishOnApproval === false ? 'warning700' : 'success700'}
                            >
                              {batch.summary.publishOnApproval === false ? 'DRAFT ONLY' : 'AUTO-PUBLISH'}
                            </Badge>
                            {batch.summary.publishStrategy === 'safe' && (
                              <Badge backgroundColor="secondary100" textColor="secondary700">
                                SAFE PUBLISH
                              </Badge>
                            )}
                            {batch.summary.publishStrategy === 'all' && (
                              <Badge backgroundColor="warning100" textColor="warning700">
                                PUBLISH ALL (CONSENTED)
                              </Badge>
                            )}
                            {Boolean(batch.summary.unreviewedCount) && (
                              <Badge backgroundColor="neutral150" textColor="neutral700">
                                Unreviewed: {batch.summary.unreviewedCount}
                              </Badge>
                            )}
                            <Typography variant="pi" textColor="neutral600">
                              • {batch.summary.totalTargets} records across {Object.keys(batch.summary.collectionBreakdown || {}).length} collections
                            </Typography>
                          </Flex>
                        </Td>
                        <Td>
                          {batch.status === 'pending_approval' && (
                            <Badge backgroundColor="warning100" textColor="warning700">
                              PENDING CHECKER APPROVAL
                            </Badge>
                          )}
                          {batch.status === 'queued_offpeak' && (
                            <Badge backgroundColor="primary100" textColor="primary700">
                              QUEUED OFF-PEAK ({batch.scheduledFor || '18:00'})
                            </Badge>
                          )}
                          {batch.status === 'approved' && (
                            <Badge backgroundColor="success100" textColor="success700">
                              APPROVED
                            </Badge>
                          )}
                          {batch.status === 'rejected' && (
                            <Badge backgroundColor="danger100" textColor="danger700">
                              REJECTED
                            </Badge>
                          )}
                          {batch.status === 'executed' && (
                            <Badge backgroundColor="neutral200" textColor="neutral700">
                              EXECUTED
                            </Badge>
                          )}
                        </Td>
                        <Td>
                          <Typography variant="pi" textColor="neutral700">
                            {batch.makerNotes || '—'}
                            {batch.approval?.rejectionReason && (
                              <span style={{ color: '#d9534f', display: 'block' }}>
                                Rejection Reason: {batch.approval.rejectionReason}
                              </span>
                            )}
                          </Typography>
                        </Td>
                        <Td style={{ textAlign: 'right' }}>
                          <Flex gap={2} justifyContent="flex-end">
                            <Button
                              size="S"
                              variant="secondary"
                              startIcon={<Eye />}
                              onClick={() => setInspectingPendingBatch(batch)}
                            >
                              Review Changes
                            </Button>
                            <Button
                              size="S"
                              variant="tertiary"
                              startIcon={<Download />}
                              onClick={() => handleExportPendingBatch(batch.id)}
                              loading={exportingPendingBatchId === batch.id}
                            >
                              Export CSV
                            </Button>
                            {batch.status === 'pending_approval' && (
                              <>
                                <Button
                                  size="S"
                                  variant="success-light"
                                  onClick={() => handleApproveBatch(batch.id)}
                                  loading={approvingBatchId === batch.id}
                                >
                                  Approve &amp; Execute
                                </Button>
                                <Button
                                  size="S"
                                  variant="danger-light"
                                  onClick={() => handleRejectBatch(batch.id)}
                                  loading={rejectingBatchId === batch.id}
                                >
                                  Reject
                                </Button>
                              </>
                            )}
                            {batch.status === 'queued_offpeak' && (
                              <Button
                                size="S"
                                variant="default"
                                onClick={() => handleExecuteNow(batch.id)}
                                loading={executingNowBatchId === batch.id}
                              >
                                Run Now
                              </Button>
                            )}
                          </Flex>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </Box>
            )}
          </Box>

          {auditNotice && (
            <Alert variant="warning" title="Audit Configuration Status" marginBottom={4}>
              {auditNotice}
            </Alert>
          )}

          {auditHistory.length === 0 && !auditLoading && (
            <Box padding={8} background="neutral100" hasRadius style={{ textAlign: 'center' }}>
              <Typography variant="beta" textColor="neutral600">
                No batch operations recorded in the audit trail yet.
              </Typography>
              <Typography variant="pi" textColor="neutral500" display="block" marginTop={2}>
                When you execute a bulk update in the editor, its transactional diff will be logged here.
              </Typography>
            </Box>
          )}

          {auditHistory.length > 0 && (
            <Box className="bulk-updater-table-container" style={{ width: '100%', maxWidth: '100%', minWidth: 0, overflowX: 'auto' }}>
              <Table colCount={6} rowCount={auditHistory.length + 1} style={{ width: '100%' }}>
                <Thead>
                  <Tr>
                    <Th style={{ minWidth: 140 }}>
                      <Typography variant="sigma">Date &amp; Time</Typography>
                    </Th>
                    <Th style={{ minWidth: 130 }}>
                      <Typography variant="sigma">Performed By</Typography>
                    </Th>
                    <Th style={{ minWidth: 160 }}>
                      <Typography variant="sigma">Attribute &amp; Value</Typography>
                    </Th>
                    <Th style={{ minWidth: 90 }}>
                      <Typography variant="sigma">Impact</Typography>
                    </Th>
                    <Th style={{ minWidth: 120 }}>
                      <Typography variant="sigma">Status</Typography>
                    </Th>
                    <Th style={{ minWidth: 160, textAlign: 'right' }}>
                      <Typography variant="sigma">Actions</Typography>
                    </Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {auditHistory.map((rec) => {
                    const isExpanded = expandedDiffBatchId === rec.batchId;
                    const dateStr = new Date(rec.executedAt).toLocaleString();

                    return (
                      <React.Fragment key={rec.batchId}>
                        <Tr
                          style={{
                            backgroundColor: rec.isRolledBack ? 'rgba(255, 255, 255, 0.04)' : undefined,
                            opacity: rec.isRolledBack ? 0.85 : 1,
                          }}
                        >
                          <Td style={{ minWidth: 140 }}>
                            <Typography fontWeight="semiBold">{dateStr}</Typography>
                            <Typography variant="pi" textColor="neutral500" display="block" style={{ wordBreak: 'break-all' }}>
                              Batch ID: {rec.batchId}
                            </Typography>
                          </Td>
                          <Td style={{ minWidth: 130 }}>
                            <Typography fontWeight="semiBold">{rec.userName}</Typography>
                            <Typography variant="pi" textColor="neutral500" display="block" style={{ wordBreak: 'break-all' }}>
                              {rec.userEmail}
                            </Typography>
                          </Td>
                          <Td style={{ minWidth: 200 }}>
                            {(() => {
                              const isCsv = rec.attribute === 'CSV_IMPORT' || rec.attribute?.startsWith('CSV');
                              let attrText = rec.attribute;
                              let valText = formatDisplayValue(rec.value);

                              if (rec.attribute === 'CSV_IMPORT' && rec.diffs && rec.diffs.length > 0) {
                                const colName = rec.diffs[0]?.collectionName || 'Collection';
                                const attrs = Array.from(new Set(rec.diffs.map((d: any) => d.attribute).filter(Boolean))).join(', ');
                                attrText = `CSV [${colName}]: ${attrs || 'fields'}`;

                                if (rec.value.startsWith('Mode:') && rec.diffs.length === 1) {
                                  const d = rec.diffs[0];
                                  valText = `"${d.label || d.documentId}": ${d.attribute || 'field'} → "${formatDisplayValue(d.newValue)}"`;
                                } else if (rec.value.startsWith('Mode:')) {
                                  valText = `${rec.diffs.length} attribute${rec.diffs.length > 1 ? 's' : ''} updated in ${colName}`;
                                }
                              }

                              return (
                                <Flex gap={2} alignItems="center" wrap="wrap">
                                  {isCsv && (
                                    <Badge backgroundColor="secondary100" textColor="secondary700">
                                      CSV IMPORT
                                    </Badge>
                                  )}
                                  <Typography
                                    style={{
                                      display: 'inline-block',
                                      maxWidth: '100%',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                    }}
                                    title={`${attrText} → "${valText}"`}
                                  >
                                    <strong>{attrText.replace(/^CSV\s*\[?([^\]]+)\]?:\s*/, '$1: ')}</strong> &rarr; &ldquo;{valText}&rdquo;
                                  </Typography>
                                </Flex>
                              );
                            })()}
                          </Td>
                          <Td style={{ minWidth: 90, whiteSpace: 'nowrap' }}>
                            <Badge backgroundColor="success100" textColor="success700">
                              {rec.updatedCount} updated
                            </Badge>
                            {rec.skippedCount > 0 && (
                              <Badge backgroundColor="warning100" textColor="warning700" style={{ marginLeft: 6 }}>
                                {rec.skippedCount} skipped
                              </Badge>
                            )}
                            {rec.publishStrategy === 'safe' && (
                              <Badge backgroundColor="secondary100" textColor="secondary700" style={{ marginLeft: 6 }}>
                                Safe Publish
                              </Badge>
                            )}
                            {rec.publishStrategy === 'all' && (
                              <Badge backgroundColor="warning100" textColor="warning700" style={{ marginLeft: 6 }}>
                                Publish All (Consented)
                              </Badge>
                            )}
                          </Td>
                          <Td style={{ minWidth: 120 }}>
                            {rec.isRolledBack ? (
                              <Box>
                                <Badge backgroundColor="neutral200" textColor="neutral700">
                                  ROLLED BACK
                                </Badge>
                                {rec.rolledBackAt && (
                                  <Typography variant="pi" textColor="neutral500" display="block" style={{ wordBreak: 'break-word', marginTop: 2 }}>
                                    {new Date(rec.rolledBackAt).toLocaleTimeString()} by {rec.rolledBackBy || 'Admin'}
                                  </Typography>
                                )}
                              </Box>
                            ) : (
                              <Badge backgroundColor="success100" textColor="success700">
                                ACTIVE (APPLIED)
                              </Badge>
                            )}
                          </Td>
                          <Td style={{ minWidth: 160, textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <Flex gap={2} justifyContent="flex-end">
                              <Button
                                variant="secondary"
                                size="S"
                                startIcon={<Download />}
                                onClick={() => {
                                  setDashboardBatchId(rec.batchId);
                                  setShowProcessingDashboard(true);
                                }}
                              >
                                Report
                              </Button>
                              <Button
                                variant="tertiary"
                                size="S"
                                onClick={() =>
                                  setExpandedDiffBatchId(isExpanded ? null : rec.batchId)
                                }
                              >
                                {isExpanded ? 'Hide Diffs' : 'View Diffs'}
                              </Button>
                              {!rec.isRolledBack && (
                                <Button
                                  variant="danger"
                                  size="S"
                                  loading={rollingBackBatchId === rec.batchId}
                                  onClick={() => handleRollback(rec.batchId)}
                                >
                                  Rollback
                                </Button>
                              )}
                            </Flex>
                          </Td>
                        </Tr>

                        {/* Expandable Diffs Breakdown */}
                        {isExpanded && (
                          <Tr>
                            <Td colSpan={6} style={{ background: 'rgba(0, 0, 0, 0.06)', padding: 16 }}>
                              <Box
                                className="bulk-updater-table-container"
                                padding={3}
                                background="neutral0"
                                hasRadius
                                borderStyle="solid"
                                borderWidth="1px"
                                borderColor="neutral200"
                                style={{ width: '100%', maxWidth: '100%', minWidth: 0, overflowX: 'auto' }}
                              >
                                <Typography variant="delta" fontWeight="bold" marginBottom={2}>
                                  Detailed Before/After Snapshots for Batch {rec.batchId}:
                                </Typography>
                                <Table colCount={5} rowCount={rec.diffs.length + 1}>
                                  <Thead>
                                    <Tr>
                                      <Th><Typography variant="sigma">Collection</Typography></Th>
                                      <Th><Typography variant="sigma">Document / Entry</Typography></Th>
                                      <Th><Typography variant="sigma">Attribute</Typography></Th>
                                      <Th><Typography variant="sigma">Previous Value</Typography></Th>
                                      <Th><Typography variant="sigma">Applied Value</Typography></Th>
                                    </Tr>
                                  </Thead>
                                  <Tbody>
                                    {rec.diffs.map((d, dIdx) => (
                                      <Tr key={dIdx}>
                                        <Td><Typography fontWeight="semiBold">{d.collectionName}</Typography></Td>
                                        <Td><Typography>{d.label}</Typography></Td>
                                        <Td>
                                          <Badge backgroundColor="secondary100" textColor="secondary700">
                                            {d.attribute || 'field'}
                                          </Badge>
                                        </Td>
                                        <Td><Typography textColor="danger600">{formatDisplayValue(d.oldValue)}</Typography></Td>
                                        <Td><Typography textColor="success600" fontWeight="semiBold">{formatDisplayValue(d.newValue)}</Typography></Td>
                                      </Tr>
                                    ))}
                                  </Tbody>
                                </Table>
                              </Box>
                            </Td>
                          </Tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </Tbody>
              </Table>
            </Box>
          )}
        </Box>
      )}

      {/* Tab 3: Validation & Quota Rules */}
      {activeTab === 'rules' && (
        <ValidationRulesTab />
      )}

      {/* Tab 4: CSV Import / Export & Override */}
      {activeTab === 'csv' && (
        <CsvManagerTab />
      )}

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(20, 20, 30, 0.65)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 16,
            boxSizing: 'border-box',
            overflowY: 'auto',
          }}
          onClick={() => setShowConfirmModal(false)}
        >
          <Box
            background="neutral0"
            hasRadius
            shadow="popupShadow"
            style={{
              maxWidth: 680,
              width: '100%',
              maxHeight: 'calc(100vh - 48px)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              position: 'relative',
              boxShadow: '0 24px 48px rgba(0, 0, 0, 0.32), 0 0 1px rgba(0, 0, 0, 0.2)',
            }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {/* Modal Header - Fixed Top */}
            <Box
              padding={5}
              background="neutral100"
              style={{
                borderBottom: '1px solid rgba(120, 120, 150, 0.2)',
                flexShrink: 0,
              }}
            >
              <Flex justifyContent="space-between" alignItems="center">
                <Box>
                  <Typography variant="delta" fontWeight="bold">
                    Confirm Bulk Update
                  </Typography>
                  <Typography variant="pi" textColor="neutral600" display="block">
                    Review target attributes, affected counts, and server execution policy before proceeding.
                  </Typography>
                </Box>
              </Flex>
            </Box>

            {/* Modal Body - Smooth Scrollable Middle */}
            <Box
              padding={5}
              style={{
                flex: '1 1 auto',
                minHeight: 0,
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
              }}
            >
              {/* Target Summary */}
              <Box padding={4} background="neutral100" hasRadius marginBottom={4}>
                <Typography variant="sigma" textColor="neutral600" marginBottom={2} display="block">
                  UPDATE DETAILS
                </Typography>
                <Flex direction="column" gap={2}>
                  <Flex justifyContent="space-between">
                    <Typography fontWeight="semiBold">Target Attribute:</Typography>
                    <Badge backgroundColor="primary100" textColor="primary700">
                      {selectedAttribute}
                    </Badge>
                  </Flex>
                  <Flex justifyContent="space-between" alignItems="center">
                    <Typography fontWeight="semiBold">Target Value:</Typography>
                    <Typography variant="omega" style={{ wordBreak: 'break-all', maxWidth: 360 }}>
                      {relationsMeta[selectedAttribute] ? (
                        <span>
                          {selectedRelationDocId === '__clear__' ? (
                            <Badge backgroundColor="danger100" textColor="danger700">Clear / Unlink Relation</Badge>
                          ) : (
                            <Badge backgroundColor="secondary100" textColor="secondary700">
                              {relationsMeta[selectedAttribute].isMulti ? `[${relationMode.toUpperCase()}] ` : ''}
                              {relationOptions.find((o) => o.documentId === selectedRelationDocId)?.label || selectedRelationDocId || '(none selected)'}
                            </Badge>
                          )}
                        </span>
                      ) : useRegex ? (
                        <span>
                          Replace <code>/{regexPattern}/g</code> with <strong>"{attributeValue}"</strong>
                        </span>
                      ) : (
                        <strong>"{attributeValue || '(empty string)'}"</strong>
                      )}
                    </Typography>
                  </Flex>
                  <Flex justifyContent="space-between">
                    <Typography fontWeight="semiBold">Total Selected Records:</Typography>
                    <Typography fontWeight="bold" textColor="primary600">
                      {totalSelectedCount} records
                    </Typography>
                  </Flex>
                  <Flex justifyContent="space-between" alignItems="center">
                    <Typography fontWeight="semiBold">Publishing Mode:</Typography>
                    <Badge
                      backgroundColor={publishOnApproval ? 'success100' : 'warning100'}
                      textColor={publishOnApproval ? 'success700' : 'warning700'}
                    >
                      {publishOnApproval ? 'Publish Immediately' : 'Keep as Draft'}
                    </Badge>
                  </Flex>
                  <Flex justifyContent="space-between" alignItems="center" marginTop={2} paddingTop={2} style={{ borderTop: '1px solid #eaeaef' }}>
                    <Typography variant="pi" textColor="neutral600">
                      Need to inspect before &amp; after values?
                    </Typography>
                    <Button
                      variant="secondary"
                      size="S"
                      startIcon={<Eye />}
                      onClick={() => {
                        setShowConfirmModal(false);
                        handleOpenPreviewModal();
                      }}
                    >
                      Open Change Preview
                    </Button>
                  </Flex>
                </Flex>
              </Box>

              {/* Lifecycle Status Breakdown */}
              <Box marginBottom={4} padding={3} background="neutral100" hasRadius style={{ border: '1px solid rgba(120, 120, 150, 0.15)' }}>
                <Typography variant="sigma" textColor="neutral600" marginBottom={2} display="block">
                  LIFECYCLE STATUS BREAKDOWN ({totalSelectedCount} Selected)
                </Typography>
                <Flex gap={2} wrap="wrap">
                  <Badge backgroundColor="success100" textColor="success700">
                    ✓ Published / Approved: {selectedLifecycleStats.published}
                  </Badge>
                  {selectedLifecycleStats.modified > 0 && (
                    <Badge backgroundColor="primary100" textColor="primary700">
                      📝 Modified (Unreviewed Revisions): {selectedLifecycleStats.modified}
                    </Badge>
                  )}
                  {selectedLifecycleStats.draft > 0 && (
                    <Badge backgroundColor="neutral200" textColor="neutral800">
                      📄 Draft (Never Published): {selectedLifecycleStats.draft}
                    </Badge>
                  )}
                  {selectedLifecycleStats.pendingReview > 0 && (
                    <Badge backgroundColor="warning100" textColor="warning700">
                      ⏳ Pending Review: {selectedLifecycleStats.pendingReview}
                    </Badge>
                  )}
                </Flex>
              </Box>

              {/* Collections Breakdown */}
              <Box marginBottom={4}>
                <Typography variant="sigma" textColor="neutral600" marginBottom={2} display="block">
                  COLLECTION BREAKDOWN
                </Typography>
                <Flex direction="column" gap={1}>
                  {Object.entries(getSelectedBreakdown()).map(([name, count]) => (
                    <Flex
                      key={name}
                      justifyContent="space-between"
                      padding={2}
                      background="neutral100"
                      hasRadius
                      style={{ border: '1px solid rgba(120, 120, 150, 0.15)' }}
                    >
                      <Typography variant="omega">{name}</Typography>
                      <Badge backgroundColor="neutral200" textColor="neutral800">
                        {count} {count === 1 ? 'record' : 'records'}
                      </Badge>
                    </Flex>
                  ))}
                </Flex>
              </Box>

              {/* Developer Server Execution Window Policy */}
              <Box padding={4} hasRadius marginBottom={4} background={executionWindow?.isBusinessHours ? 'warning100' : 'success100'}>
                <Flex direction="column" gap={1}>
                  <Flex gap={2} alignItems="center">
                    <Typography fontWeight="bold" textColor={executionWindow?.isBusinessHours ? 'warning700' : 'success700'}>
                      {executionWindow?.isBusinessHours ? '⏰ Peak Business Hours Restriction Active' : '✅ Server Off-Peak Window Active'}
                    </Typography>
                  </Flex>
                  <Typography variant="pi" textColor={executionWindow?.isBusinessHours ? 'warning700' : 'success700'}>
                    {executionWindow?.policyMessage || (executionWindow?.isBusinessHours
                      ? 'Server policy restricts bulk updates during peak business hours (09:00 - 18:00). Direct execution is paused to preserve API throughput.'
                      : 'Currently outside peak business hours. Direct execution is permitted.')}
                  </Typography>
                </Flex>
              </Box>

              {/* Publish Immediately vs Keep as Draft Option */}
              <Box
                padding={4}
                background="neutral100"
                hasRadius
                marginBottom={4}
                style={{ border: '1px solid rgba(120, 120, 150, 0.15)' }}
              >
                <Flex gap={3} alignItems="flex-start">
                  <Checkbox
                    name="publishOnApproval"
                    checked={publishOnApproval}
                    onCheckedChange={(checked: boolean) => setPublishOnApproval(Boolean(checked))}
                  />
                  <Box style={{ cursor: 'pointer' }} onClick={() => setPublishOnApproval(!publishOnApproval)}>
                    <Typography fontWeight="bold" display="block">
                      Publish immediately upon checker approval / execution
                    </Typography>
                    <Typography variant="pi" textColor="neutral600">
                      When checked (default), content types with Draft &amp; Publish enabled will have their updated documents published immediately upon execution. When unchecked, changes remain in Draft for further editorial review.
                    </Typography>
                  </Box>
                </Flex>
              </Box>

              {/* Publishing Strategy Selection when Unreviewed Records are Selected */}
              {publishOnApproval && selectedLifecycleStats.unreviewedCount > 0 && (
                <Box
                  padding={4}
                  background="neutral100"
                  hasRadius
                  marginBottom={4}
                  style={{ border: '1px solid #d9d8ff' }}
                >
                  <Typography variant="sigma" textColor="neutral600" marginBottom={3} display="block">
                    PUBLISHING STRATEGY &amp; GOVERNANCE CONSENT
                  </Typography>
                  <Flex direction="column" gap={3}>
                    {/* Strategy 1: Safe Publishing (Recommended) */}
                    <Box
                      padding={3}
                      hasRadius
                      style={{
                        border: publishStrategy === 'safe' ? '2px solid #4945ff' : '1px solid #eaeaef',
                        backgroundColor: publishStrategy === 'safe' ? '#f0f0ff' : '#ffffff',
                        cursor: 'pointer',
                      }}
                      onClick={() => {
                        setPublishStrategy('safe');
                        setUnreviewedConsent(false);
                      }}
                    >
                      <Flex gap={2} alignItems="flex-start">
                        <input
                          type="radio"
                          id="strategy-safe"
                          name="publishStrategy"
                          checked={publishStrategy === 'safe'}
                          onChange={() => {
                            setPublishStrategy('safe');
                            setUnreviewedConsent(false);
                          }}
                          style={{ marginTop: 3 }}
                        />
                        <Box>
                          <Typography fontWeight="bold" display="block">
                            🛡️ Safe Publishing (Recommended)
                          </Typography>
                          <Typography variant="pi" textColor="neutral600">
                            Only publish records that are already approved &amp; live ({selectedLifecycleStats.published} record{selectedLifecycleStats.published === 1 ? '' : 's'}). The {selectedLifecycleStats.unreviewedCount} unreviewed or draft record(s) will receive the bulk update in Draft mode without publishing unreviewed draft revisions to visitors.
                          </Typography>
                        </Box>
                      </Flex>
                    </Box>

                    {/* Strategy 2: Publish All Selected */}
                    <Box
                      padding={3}
                      hasRadius
                      style={{
                        border: publishStrategy === 'all' ? '2px solid #d02b20' : '1px solid #eaeaef',
                        backgroundColor: publishStrategy === 'all' ? '#fff5f5' : '#ffffff',
                        cursor: 'pointer',
                      }}
                      onClick={() => setPublishStrategy('all')}
                    >
                      <Flex gap={2} alignItems="flex-start">
                        <input
                          type="radio"
                          id="strategy-all"
                          name="publishStrategy"
                          checked={publishStrategy === 'all'}
                          onChange={() => setPublishStrategy('all')}
                          style={{ marginTop: 3 }}
                        />
                        <Box>
                          <Typography fontWeight="bold" textColor="danger700" display="block">
                            ⚠️ Publish All Selected Records (Includes Unreviewed Drafts)
                          </Typography>
                          <Typography variant="pi" textColor="neutral600">
                            Publish all {totalSelectedCount} records live to production immediately, pushing all pending unreviewed draft edits in the {selectedLifecycleStats.unreviewedCount} draft/modified record(s) live.
                          </Typography>
                        </Box>
                      </Flex>
                    </Box>

                    {/* Mandatory Consent Checkbox for Force Publish All */}
                    {publishStrategy === 'all' && (
                      <Box
                        padding={3}
                        background="danger100"
                        hasRadius
                        style={{ border: '1px solid #f5c0b8' }}
                      >
                        <Flex gap={3} alignItems="flex-start">
                          <Checkbox
                            name="unreviewedConsent"
                            checked={unreviewedConsent}
                            onCheckedChange={(checked: boolean) => setUnreviewedConsent(Boolean(checked))}
                          />
                          <Box style={{ cursor: 'pointer' }} onClick={() => setUnreviewedConsent(!unreviewedConsent)}>
                            <Typography fontWeight="bold" textColor="danger700" display="block">
                              Mandatory Risk Consent Required
                            </Typography>
                            <Typography variant="pi" textColor="danger700">
                              I understand and explicitly consent that {selectedLifecycleStats.unreviewedCount} record(s) with unreviewed draft revisions or saved draft states will be published live to production visitors.
                            </Typography>
                          </Box>
                        </Flex>
                      </Box>
                    )}
                  </Flex>
                </Box>
              )}

              {/* Notes / Release Ticket (Maker Notes) */}
              <Box marginBottom={2}>
                <TextInput
                  label="Change Request / Release Notes (Optional)"
                  name="makerNotes"
                  placeholder="e.g. REL-4021: Updating summer pricing & promo attributes"
                  value={makerNotesInput}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMakerNotesInput(e.target.value)}
                />
              </Box>
            </Box>

            {/* Modal Footer - Fixed Sticky Bottom CTAs */}
            <Box
              padding={4}
              background="neutral100"
              style={{
                borderTop: '1px solid rgba(120, 120, 150, 0.2)',
                flexShrink: 0,
                position: 'sticky',
                bottom: 0,
                zIndex: 20,
                boxShadow: '0 -4px 16px rgba(0, 0, 0, 0.08)',
              }}
            >
              <Flex direction="column" gap={2} style={{ width: '100%' }}>
                {publishOnApproval && selectedLifecycleStats.unreviewedCount > 0 && publishStrategy === 'all' && !unreviewedConsent && (
                  <Typography variant="pi" textColor="danger700" fontWeight="bold">
                    ⚠️ Explicit consent is required before publishing records with unreviewed draft revisions.
                  </Typography>
                )}
                <Flex justifyContent="space-between" alignItems="center" gap={3} style={{ width: '100%' }}>
                  <Button variant="tertiary" size="M" onClick={() => setShowConfirmModal(false)}>
                    Cancel
                  </Button>
                  <Flex gap={2} wrap="wrap" justifyContent="flex-end" alignItems="center">
                    {/* Maker-Checker Button */}
                    <Button
                      variant={executionWindow?.isBusinessHours ? 'default' : 'secondary'}
                      size="M"
                      onClick={() => executeBatchWithMode('maker_checker')}
                      loading={updating}
                      disabled={updating || (publishOnApproval && selectedLifecycleStats.unreviewedCount > 0 && publishStrategy === 'all' && !unreviewedConsent)}
                    >
                      Submit for Checker Approval
                    </Button>

                    {/* Scheduled Off-Peak Queue or Immediate Button */}
                    {executionWindow?.isBusinessHours ? (
                      <>
                        <Button
                          variant="secondary"
                          size="M"
                          onClick={() => executeBatchWithMode('queue_offpeak')}
                          loading={updating}
                          disabled={updating || (publishOnApproval && selectedLifecycleStats.unreviewedCount > 0 && publishStrategy === 'all' && !unreviewedConsent)}
                        >
                          Queue for Off-Peak ({executionWindow?.offPeakStartTime || '18:00'})
                        </Button>
                        <Button
                          variant="danger-light"
                          size="S"
                          onClick={() => executeBatchWithMode('immediate', true)}
                          loading={updating}
                          disabled={updating || (publishOnApproval && selectedLifecycleStats.unreviewedCount > 0 && publishStrategy === 'all' && !unreviewedConsent)}
                        >
                          Force Run Now
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="default"
                        size="M"
                        onClick={() => executeBatchWithMode('immediate')}
                        loading={updating}
                        disabled={updating || (publishOnApproval && selectedLifecycleStats.unreviewedCount > 0 && publishStrategy === 'all' && !unreviewedConsent)}
                      >
                        Confirm &amp; Execute Now
                      </Button>
                    )}
                  </Flex>
                </Flex>
              </Flex>
            </Box>
          </Box>
        </div>
      )}

      {/* Confirmation Modal for Direct Bulk Publish */}
      {showPublishConfirmModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
          onClick={() => setShowPublishConfirmModal(false)}
        >
          <Box
            background="neutral0"
            hasRadius
            style={{
              width: '90%',
              maxWidth: 620,
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 10px 40px rgba(0, 0, 0, 0.25)',
              overflow: 'hidden',
            }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <Box
              padding={5}
              background="neutral100"
              style={{
                borderBottom: '1px solid rgba(120, 120, 150, 0.2)',
                flexShrink: 0,
              }}
            >
              <Flex justifyContent="space-between" alignItems="center">
                <Box>
                  <Typography variant="beta" fontWeight="bold">
                    Confirm Bulk Publish
                  </Typography>
                  <Box marginTop={1}>
                    <Typography variant="pi" textColor="neutral600">
                      Publish selected draft records live to visitors across content types
                    </Typography>
                  </Box>
                </Box>
                <Badge backgroundColor="success100" textColor="success700">
                  {totalSelectedCount} Selected
                </Badge>
              </Flex>
            </Box>

            {/* Modal Scrollable Body */}
            <Box
              padding={5}
              style={{
                overflowY: 'auto',
                flexGrow: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
              }}
            >
              {/* Lifecycle Status Breakdown */}
              <Box padding={3} background="neutral100" hasRadius style={{ border: '1px solid #eaeaef' }}>
                <Typography variant="sigma" textColor="neutral600" marginBottom={2} display="block">
                  LIFECYCLE STATUS BREAKDOWN ({totalSelectedCount} Selected)
                </Typography>
                <Flex gap={2} wrap="wrap">
                  <Badge backgroundColor="success100" textColor="success700">
                    ✓ Published: {selectedLifecycleStats.published}
                  </Badge>
                  {selectedLifecycleStats.modified > 0 && (
                    <Badge backgroundColor="primary100" textColor="primary700">
                      📝 Modified (Unreviewed Revisions): {selectedLifecycleStats.modified}
                    </Badge>
                  )}
                  {selectedLifecycleStats.draft > 0 && (
                    <Badge backgroundColor="neutral200" textColor="neutral800">
                      📄 Draft (Never Published): {selectedLifecycleStats.draft}
                    </Badge>
                  )}
                </Flex>
              </Box>

              <Box padding={4} background="neutral100" hasRadius style={{ border: '1px solid #eaeaef' }}>
                <Typography variant="omega" fontWeight="bold">
                  Collection Breakdown:
                </Typography>
                <Box marginTop={2}>
                  {collections
                    .filter((col) =>
                      col.entries.some((entry) => selectedEntries[`${col.uid}${KEY_SEP}${entry.documentId}`])
                    )
                    .map((col) => {
                      const count = col.entries.filter(
                        (entry) => selectedEntries[`${col.uid}${KEY_SEP}${entry.documentId}`]
                      ).length;
                      const hasDraftAndPublish = col.draftAndPublish !== false;

                      return (
                        <Flex
                          key={col.uid}
                          justifyContent="space-between"
                          alignItems="center"
                          paddingTop={2}
                          paddingBottom={2}
                          style={{ borderBottom: '1px dashed #eaeaef' }}
                        >
                          <Typography variant="pi">
                            <strong>{col.displayName}</strong> ({col.uid})
                          </Typography>
                          <Flex gap={2} alignItems="center">
                            <Badge backgroundColor="neutral150" textColor="neutral700">
                              {count} {count === 1 ? 'entry' : 'entries'}
                            </Badge>
                            {hasDraftAndPublish ? (
                              <Badge backgroundColor="success100" textColor="success700">
                                ✓ Draft &amp; Publish Enabled
                              </Badge>
                            ) : (
                              <Badge backgroundColor="warning100" textColor="warning700">
                                ⚠️ Skipped (Drafts Disabled)
                              </Badge>
                            )}
                          </Flex>
                        </Flex>
                      );
                    })}
                </Box>
              </Box>

              {/* Explicit Consent Checkbox for Unreviewed Records */}
              {selectedLifecycleStats.unreviewedCount > 0 && (
                <Box
                  padding={4}
                  background="danger100"
                  hasRadius
                  style={{ border: '1px solid #f5c0b8' }}
                >
                  <Flex gap={3} alignItems="flex-start">
                    <Checkbox
                      name="publishConsent"
                      checked={publishConsent}
                      onCheckedChange={(checked: boolean) => setPublishConsent(Boolean(checked))}
                    />
                    <Box style={{ cursor: 'pointer' }} onClick={() => setPublishConsent(!publishConsent)}>
                      <Typography fontWeight="bold" textColor="danger700" display="block">
                        Mandatory Risk Consent Required
                      </Typography>
                      <Typography variant="pi" textColor="danger700">
                        I understand and explicitly consent that {selectedLifecycleStats.unreviewedCount} record(s) contain unreviewed draft changes ({selectedLifecycleStats.draft} Draft, {selectedLifecycleStats.modified} Modified) and will be published live to production visitors.
                      </Typography>
                    </Box>
                  </Flex>
                </Box>
              )}

              {/* Business Hours Warning Banner */}
              {executionWindow?.isBusinessHours && (
                <Box
                  padding={4}
                  background="warning100"
                  hasRadius
                  style={{ border: '1px solid #f5c0b8' }}
                >
                  <Typography variant="pi" fontWeight="bold" textColor="warning700">
                    ⚠️ Business Hours Active:
                  </Typography>
                  <Typography variant="pi" textColor="warning700" style={{ display: 'block', marginTop: 4 }}>
                    It is currently business peak hours ({executionWindow.currentTime}). To prevent API latency spikes, publish requests should be queued for off-peak hours ({executionWindow.offPeakStartTime}) or submitted for governance review.
                  </Typography>
                </Box>
              )}

              {/* Maker-Checker Notes Input */}
              <Box>
                <Typography variant="pi" fontWeight="bold">
                  Governance Notes / Reason (Optional):
                </Typography>
                <Box marginTop={1}>
                  <TextInput
                    name="publishMakerNotes"
                    placeholder="e.g. Publishing Q3 catalog release updates"
                    value={publishMakerNotesInput}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPublishMakerNotesInput(e.target.value)}
                  />
                </Box>
              </Box>
            </Box>

            {/* Modal Footer */}
            <Box
              padding={4}
              background="neutral100"
              style={{
                borderTop: '1px solid rgba(120, 120, 150, 0.2)',
                flexShrink: 0,
                boxShadow: '0 -4px 16px rgba(0, 0, 0, 0.08)',
              }}
            >
              <Flex direction="column" gap={2} style={{ width: '100%' }}>
                {selectedLifecycleStats.unreviewedCount > 0 && !publishConsent && (
                  <Typography variant="pi" textColor="danger700" fontWeight="bold">
                    ⚠️ Please check the mandatory consent box above to confirm publishing unreviewed draft records.
                  </Typography>
                )}
                <Flex justifyContent="space-between" alignItems="center" gap={3} style={{ width: '100%' }}>
                  <Button variant="tertiary" size="M" onClick={() => setShowPublishConfirmModal(false)}>
                    Cancel
                  </Button>
                  <Flex gap={2} wrap="wrap" justifyContent="flex-end" alignItems="center">
                    <Button
                      variant={executionWindow?.isBusinessHours ? 'default' : 'secondary'}
                      size="M"
                      onClick={() => executeBatchPublish('maker_checker')}
                      loading={publishing}
                      disabled={publishing || (selectedLifecycleStats.unreviewedCount > 0 && !publishConsent)}
                    >
                      Submit for Checker Approval
                    </Button>

                    {executionWindow?.isBusinessHours ? (
                      <>
                        <Button
                          variant="secondary"
                          size="M"
                          onClick={() => executeBatchPublish('queue_offpeak')}
                          loading={publishing}
                          disabled={publishing || (selectedLifecycleStats.unreviewedCount > 0 && !publishConsent)}
                        >
                          Queue for Off-Peak ({executionWindow?.offPeakStartTime || '18:00'})
                        </Button>
                        <Button
                          variant="danger-light"
                          size="S"
                          onClick={() => executeBatchPublish('immediate', true)}
                          loading={publishing}
                          disabled={publishing || (selectedLifecycleStats.unreviewedCount > 0 && !publishConsent)}
                        >
                          Force Publish Now
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="default"
                        size="M"
                        onClick={() => executeBatchPublish('immediate')}
                        loading={publishing}
                        disabled={publishing || (selectedLifecycleStats.unreviewedCount > 0 && !publishConsent)}
                      >
                        Confirm &amp; Publish Now
                      </Button>
                    )}
                  </Flex>
                </Flex>
              </Flex>
            </Box>
          </Box>
        </div>
      )}

      {/* Pre-Update Change Preview Modal */}
      <BulkUpdatePreviewModal
        isOpen={showPreviewModal}
        onClose={() => setShowPreviewModal(false)}
        onProceed={() => {
          setShowPreviewModal(false);
          handleOpenConfirmModal();
        }}
        loading={previewLoading}
        previewData={previewData}
        attribute={selectedAttribute}
        publishOnApproval={publishOnApproval}
        lifecycleStats={selectedLifecycleStats}
        targetValueDisplay={
          relationsMeta[selectedAttribute]
            ? (selectedRelationDocId === '__clear__'
                ? 'Clear / Unlink Relation'
                : relationOptions.find((o) => o.documentId === selectedRelationDocId)?.label || selectedRelationDocId || '(none)')
            : useRegex
            ? `Replace /${regexPattern}/g with "${attributeValue}"`
            : attributeValue
        }
      />

      {/* Processing Dashboard & Status Tracker Modal */}
      <ProcessingDashboardModal
        isOpen={showProcessingDashboard}
        onClose={() => setShowProcessingDashboard(false)}
        batchId={dashboardBatchId}
        initialJob={dashboardJob}
        isSubmitting={isSubmittingBatch}
      />

      {/* Checker 4-Eyes Review Modal */}
      <CheckerReviewModal
        isOpen={Boolean(inspectingPendingBatch)}
        onClose={() => setInspectingPendingBatch(null)}
        batch={inspectingPendingBatch}
        onApprove={handleApproveBatch}
        onReject={handleRejectBatch}
        approving={Boolean(inspectingPendingBatch && approvingBatchId === inspectingPendingBatch.id)}
        rejecting={Boolean(inspectingPendingBatch && rejectingBatchId === inspectingPendingBatch.id)}
      />
    </Box>
  );
};

export default BulkUpdater;
