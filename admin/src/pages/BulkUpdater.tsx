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
import { Play, ArrowClockwise, Check, Download, Eye } from '@strapi/icons';
import ValidationRulesTab from './ValidationRulesTab';
import CsvManagerTab from './CsvManagerTab';
import ProcessingDashboardModal from '../components/ProcessingDashboardModal';
import BulkUpdatePreviewModal from '../components/BulkUpdatePreviewModal';

interface Entry {
  id: number | string;
  documentId: string;
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
    attribute: string;
    value: string;
    selectedEntries?: Array<{ uid: string; documentId: string }>;
    selectedCollections?: string[];
    isRegex?: boolean;
    regexPattern?: string;
    publishOnApproval?: boolean;
  };
  summary: {
    attribute: string;
    value: string;
    totalTargets: number;
    collectionBreakdown: Record<string, number>;
    publishOnApproval?: boolean;
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
 * Safely resolves a nested dot-notation property (e.g. "defaultSeo.metaDescription")
 */
export function getNestedValue(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  if (!path.includes('.')) return obj[path];
  return path.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
}

/**
 * Flat helper: Generates the list of available columns for a given collection model.
 * Zero deep nesting: returns a flat array of ColumnDef.
 */
export function getAvailableColumnsForCollection(
  col: CollectionModel,
  selectedAttribute: string
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
    if (attr === 'name' || attr === 'title' || attr === selectedAttribute) {
      return;
    }
    const formattedLabel = attr.includes('.')
      ? attr.split('.').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' > ')
      : attr.charAt(0).toUpperCase() + attr.slice(1);
    cols.push({
      key: `attr_${attr}`,
      label: formattedLabel,
      sortable: !col.isSingleType,
      defaultVisible: ['department', 'email', 'location'].includes(attr),
    });
  });

  // Target attribute column
  cols.push({
    key: 'target_attr',
    label: `Current "${selectedAttribute}"`,
    sortable: !col.isSingleType && col.attributes.includes(selectedAttribute),
    defaultVisible: true,
  });

  // Status column
  cols.push({
    key: 'status',
    label: 'Status',
    sortable: false,
    defaultVisible: true,
  });

  return cols;
}

/**
 * Flat helper: Renders table header cell without nested JSX.
 */
function renderHeaderCell(
  colDef: ColumnDef,
  col: CollectionModel,
  currentSort: { field: string; order: 'asc' | 'desc' },
  selectedAttribute: string,
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
    (colDef.key === 'identifier' && (currentSort.field === 'name' || currentSort.field === 'title')) ||
    (colDef.key === 'target_attr' && currentSort.field === selectedAttribute) ||
    (colDef.key.startsWith('attr_') && currentSort.field === colDef.key.replace('attr_', ''));

  const sortArrow = isCurrentSorted ? (currentSort.order === 'asc' ? '▲' : '▼') : '⇅';

  const handleClick = () => {
    if (!colDef.sortable) return;
    if (colDef.key === 'identifier') {
      const field = col.attributes.includes('name') ? 'name' : col.attributes.includes('title') ? 'title' : 'createdAt';
      onSort(col.uid, field);
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
 * Flat helper: Formats attribute values, gracefully handling relation objects and arrays.
 */
export function formatDisplayValue(val: any): string {
  if (val === undefined || val === null || val === '') {
    return '(empty / not set)';
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
  isMatch: boolean,
  hasAttr: boolean,
  isSelected: boolean,
  onToggleSelect: () => void
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
      return (
        <Box>
          <Typography fontWeight="semiBold">{mainText}</Typography>
          {entry.email && (
            <Typography variant="pi" textColor="neutral500" display="block">
              {entry.email}
            </Typography>
          )}
        </Box>
      );
    }

    case 'target_attr': {
      const val = getNestedValue(entry, selectedAttribute);
      const displayStr = formatDisplayValue(val);
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

    case 'status': {
      if (!hasAttr) {
        return (
          <Badge backgroundColor="neutral200" textColor="neutral600">
            Ignored
          </Badge>
        );
      }
      return (
        <Flex gap={1} alignItems="center">
          <Badge backgroundColor="success100" textColor="success700">
            Supported
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
  const [executingNowBatchId, setExecutingNowBatchId] = useState<string | null>(null);
  const [makerNotesInput, setMakerNotesInput] = useState<string>('');
  const [publishOnApproval, setPublishOnApproval] = useState<boolean>(true);

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

  // Managed Cache Keys
  const MODELS_CACHE_KEY = 'strapi_bulk_updater_models_cache';
  const LAST_ATTR_KEY = 'strapi_bulk_updater_last_attr';

  // Selected state
  const getInitialAttribute = (): string => {
    try {
      const stored = localStorage.getItem(LAST_ATTR_KEY);
      if (stored) return stored;
    } catch {}
    return 'metaDescription';
  };
  const [selectedAttribute, setSelectedAttribute] = useState<string>(getInitialAttribute);
  const [attributeValue, setAttributeValue] = useState<string>('');
  const [selectedEntries, setSelectedEntries] = useState<Record<string, boolean>>({});

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

  // Target Value Filter state ("Find items with a certain value first")
  type FilterOperator = 'none' | 'empty' | 'not_empty' | 'equals' | 'contains' | 'starts_with';
  const [filterOperator, setFilterOperator] = useState<FilterOperator>('none');
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [entrySearch, setEntrySearch] = useState<string>('');

  const isFilterActive =
    (filterOperator !== 'none' &&
      (['empty', 'not_empty'].includes(filterOperator) || Boolean(filterQuery.trim()))) ||
    Boolean(entrySearch.trim());

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
      pages[col.uid] = {
        page: 1,
        pageSize: initialPageSize,
        total,
        pageCount: col.isSingleType ? 1 : (Math.ceil(total / initialPageSize) || 1),
        entries: (col.entries || []).slice(0, initialPageSize),
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

    let storedAttr: string | null = null;
    try {
      storedAttr = localStorage.getItem(LAST_ATTR_KEY);
    } catch {}

    const resolvedAttr =
      storedAttr && attrs.includes(storedAttr)
        ? storedAttr
        : (selectedAttribute && attrs.includes(selectedAttribute) ? selectedAttribute : '');

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
      const isAborted =
        err?.name === 'AbortError' ||
        err?.name === 'CanceledError' ||
        err?.code === 'ERR_CANCELED' ||
        err?.message?.includes('aborted') ||
        err?.message?.includes('canceled');

      if (!isAborted) {
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
    autoSelectReturned = true
  ) => {
    const currentPageState = collectionPages[colUid];
    const size = customPageSize || currentPageState?.pageSize || defaultPageSize;
    const currentSort = collectionSorts[colUid] || { field: 'createdAt', order: 'desc' };
    const sortField = customSortField !== undefined ? customSortField : currentSort.field;
    const sortOrder = customSortOrder !== undefined ? customSortOrder : currentSort.order;

    const op = overrideFilterOp !== undefined ? overrideFilterOp : filterOperator;
    const q = overrideFilterQuery !== undefined ? overrideFilterQuery : filterQuery;
    const s = overrideEntrySearch !== undefined ? overrideEntrySearch : entrySearch;

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

        setCollectionPages((prev) => ({
          ...prev,
          [colUid]: {
            page: pageNum,
            pageSize: pageSizeNum,
            total: totalNum,
            pageCount: pageCountNum,
            entries: fetchedEntries,
            loading: false,
          },
        }));

        // If a filter or search is active, pre-select all returned matching entries!
        const isFilterActiveNow =
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
      const isAborted =
        err?.name === 'AbortError' ||
        err?.name === 'CanceledError' ||
        err?.code === 'ERR_CANCELED' ||
        err?.message?.includes('aborted') ||
        err?.message?.includes('canceled');

      if (!isAborted) {
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
      const isAborted =
        err?.name === 'AbortError' ||
        err?.name === 'CanceledError' ||
        err?.code === 'ERR_CANCELED' ||
        err?.message?.includes('aborted') ||
        err?.message?.includes('canceled');

      if (!isAborted) {
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
      if (collections.length > 0) {
        const isFilterActiveNow =
          (filterOperator !== 'none' &&
            (['empty', 'not_empty'].includes(filterOperator) || Boolean(filterQuery.trim()))) ||
          Boolean(entrySearch.trim());

        if (isFilterActiveNow) {
          setSelectedEntries({});
        }

        // Targeted Collection Querying: Only query visible collections possessing the attribute
        const targetCols = collections.filter((col) => {
          if (visibleTypeUids[col.uid] === false) return false;
          if (filterOperator !== 'none' && !col.attributes.includes(selectedAttribute)) return false;
          return true;
        });

        targetCols.forEach((col) => {
          loadCollectionPage(
            col.uid,
            1,
            undefined,
            undefined,
            undefined,
            filterOperator,
            filterQuery,
            entrySearch,
            true
          );
        });
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [filterOperator, filterQuery, entrySearch]);

  const KEY_SEP = '@@@';

  // Handle attribute selection change: unchecks all existing selections if attribute changes
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
      setSelectedEntries({});
      setFilterOperator('none');
      setFilterQuery('');
      setEntrySearch('');
      setSelectedRelationDocId('');
      setAttributeValue('');

      if (newAttr && relationsMeta[newAttr]) {
        fetchRelationOptions(relationsMeta[newAttr].targetUid);
      } else {
        setRelationOptions([]);
      }

      if (newAttr) {
        const collectionsToLoad = collections.filter(
          (col) =>
            visibleTypeUids[col.uid] !== false &&
            col.attributes.includes(newAttr) &&
            (!collectionPages[col.uid]?.entries || collectionPages[col.uid].entries.length === 0)
        );

        collectionsToLoad.forEach((col) => {
          loadCollectionPage(col.uid, 1);
        });
      }
    }
  };

  const filteredCollections = collections.filter(
    (c) =>
      visibleTypeUids[c.uid] !== false &&
      (!collectionSearch.trim() ||
        c.displayName.toLowerCase().includes(collectionSearch.toLowerCase().trim()) ||
        c.uid.toLowerCase().includes(collectionSearch.toLowerCase().trim()))
  );

  // Memoized collections classification for 100+ collection enterprise UX
  const supportedCollections = useMemo(() => {
    return collections.filter((c) => c.attributes.includes(selectedAttribute));
  }, [collections, selectedAttribute]);

  const unsupportedCollections = useMemo(() => {
    return collections.filter((c) => !c.attributes.includes(selectedAttribute));
  }, [collections, selectedAttribute]);

  // One-click helper: focus workspace visibility strictly on collections supporting the attribute
  const handleFocusOnlySupported = () => {
    const newVis: Record<string, boolean> = {};
    collections.forEach((c) => {
      newVis[c.uid] = c.attributes.includes(selectedAttribute);
    });
    setVisibleTypeUids(newVis);
    toggleNotification({
      type: 'info',
      message: `Workspace focused: Showing ${supportedCollections.length} of ${collections.length} collections supporting "${selectedAttribute}".`,
    });
  };

  const handleShowAllTypes = () => {
    const newVis: Record<string, boolean> = {};
    collections.forEach((c) => {
      newVis[c.uid] = true;
    });
    setVisibleTypeUids(newVis);
  };

  const handleHideAllTypes = () => {
    const newVis: Record<string, boolean> = {};
    collections.forEach((c) => {
      newVis[c.uid] = false;
    });
    setVisibleTypeUids(newVis);
  };

  const [attributeSearch, setAttributeSearch] = useState('');

  // Filtered attributes based on user search query (handles camelCase, dot-notation, relations)
  const filteredAttributes = useMemo(() => {
    if (!attributeSearch.trim()) {
      return attributes;
    }
    const q = attributeSearch.toLowerCase().trim();
    const cleanQ = q.replace(/[^a-z0-9]/g, '');

    return attributes.filter((attr) => {
      const lower = attr.toLowerCase();
      const cleanLower = lower.replace(/[^a-z0-9]/g, '');
      const rel = relationsMeta[attr];
      const relTarget = (rel?.targetDisplayName || '').toLowerCase();

      return (
        lower.includes(q) ||
        cleanLower.includes(cleanQ) ||
        relTarget.includes(q)
      );
    });
  }, [attributes, attributeSearch, relationsMeta]);

  // Memoized Combobox options to guarantee 60fps typing even with 1000+ attributes
  const memoizedComboboxOptions = useMemo(() => {
    if (filteredAttributes.length === 0) {
      return (
        <ComboboxOption value="__none__" disabled textValue="No matching attributes found">
          <Typography variant="pi" textColor="neutral600">
            No matching attributes found for "{attributeSearch}"
          </Typography>
        </ComboboxOption>
      );
    }

    return filteredAttributes.map((attr) => {
      const rel = relationsMeta[attr];
      return (
        <ComboboxOption key={attr} value={attr} textValue={attr}>
          <Flex justifyContent="space-between" alignItems="center" width="100%" gap={2}>
            <Typography variant="omega" fontWeight={attr === selectedAttribute ? 'bold' : 'regular'}>
              {attr}
            </Typography>
            {rel ? (
              <Badge backgroundColor="secondary100" textColor="secondary700" size="S">
                relation ➔ {rel.targetDisplayName}
              </Badge>
            ) : attr.includes('.') ? (
              <Badge backgroundColor="neutral150" textColor="neutral700" size="S">
                component
              </Badge>
            ) : null}
          </Flex>
        </ComboboxOption>
      );
    });
  }, [filteredAttributes, relationsMeta, selectedAttribute, attributeSearch]);

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
    setSelectedEntries((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // Value filter evaluation
  const entryMatchesFilter = (entry: Entry, attr: string): boolean => {
    if (filterOperator === 'none') return true;
    const val = getNestedValue(entry, attr);
    const displayStr = formatDisplayValue(val);
    const isValEmpty =
      val === undefined ||
      val === null ||
      displayStr.trim() === '' ||
      displayStr.trim().toLowerCase() === '(not set)' ||
      displayStr.trim().toLowerCase() === '(empty / not set)' ||
      displayStr.trim().toLowerCase() === '(empty / unlinked)';

    switch (filterOperator) {
      case 'empty':
        return isValEmpty;
      case 'not_empty':
        return !isValEmpty;
      case 'equals':
        return !isValEmpty && displayStr.trim().toLowerCase() === filterQuery.trim().toLowerCase();
      case 'contains':
        return !isValEmpty && displayStr.toLowerCase().includes(filterQuery.trim().toLowerCase());
      case 'starts_with':
        return !isValEmpty && displayStr.trim().toLowerCase().startsWith(filterQuery.trim().toLowerCase());
      default:
        return true;
    }
  };

  const getVisibleEntries = (col: CollectionModel) => {
    const pageState = collectionPages[col.uid];
    return pageState ? pageState.entries : (col.entries || []);
  };

  const matchingEntriesCount = React.useMemo(() => {
    if (!isFilterActive) return 0;
    let count = 0;
    filteredCollections.forEach((col) => {
      const pageState = collectionPages[col.uid];
      if (pageState) {
        count += pageState.total;
      }
    });
    return count;
  }, [filteredCollections, collectionPages, isFilterActive]);

  const selectAllMatching = () => {
    const updated = { ...selectedEntries };
    filteredCollections.forEach((col) => {
      const pageState = collectionPages[col.uid];
      const entries = pageState ? pageState.entries : (col.entries || []);
      entries.forEach((e) => {
        updated[`${col.uid}${KEY_SEP}${e.documentId}`] = true;
      });
    });
    setSelectedEntries(updated);
  };

  const deselectAllMatching = () => {
    const updated = { ...selectedEntries };
    filteredCollections.forEach((col) => {
      const pageState = collectionPages[col.uid];
      const entries = pageState ? pageState.entries : (col.entries || []);
      entries.forEach((e) => {
        delete updated[`${col.uid}${KEY_SEP}${e.documentId}`];
      });
    });
    setSelectedEntries(updated);
  };

  const clearFilter = () => {
    setFilterOperator('none');
    setFilterQuery('');
    setEntrySearch('');
    setSelectedEntries({});
    collections.forEach((col) => {
      loadCollectionPage(col.uid, 1, undefined, undefined, undefined, 'none', '', '', false);
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
      toggleNotification({
        type: 'danger',
        message: err.message || 'Failed to fetch preview diffs',
      });
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
      };

      const res = await post('/bulk-updater/batch-update', payload);

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
        results: [],
      });

      const payload = {
        selectedEntries: targets,
        executionMode,
        makerNotes: publishMakerNotesInput,
        forceImmediate,
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
  const handleRejectBatch = async (batchId: string) => {
    const reason = window.prompt('Enter reason for rejection:', 'Does not meet release criteria') || 'Rejected by Checker';
    try {
      setRejectingBatchId(batchId);
      const res = await post(`/bulk-updater/batches/${batchId}/reject`, { reason });
      if (res.data && res.data.success) {
        toggleNotification({
          type: 'info',
          message: `Batch ${batchId} rejected: ${reason}`,
        });
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
          {/* Main Control Panel: Attribute Dropdown + Value Input + Action Button */}
          <Box
            padding={6}
            background="neutral0"
            shadow="filterShadow"
            hasRadius
            marginBottom={6}
            style={{ width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}
          >
            <Typography variant="delta" tag="h2" marginBottom={4} fontWeight="semiBold">
              1. Configure Attribute Update
            </Typography>

            <Flex gap={4} alignItems="flex-end" wrap="wrap">
              {/* Attribute Dropdown (Searchable Combobox) */}
              <Box style={{ minWidth: 280, flex: 1, maxWidth: 440 }}>
                <Field.Root>
                  <Field.Label>Attribute to Update</Field.Label>
                  <Combobox
                    autocomplete="none"
                    placeholder="Search attribute by name or relation..."
                    value={selectedAttribute || undefined}
                    clearLabel="Clear attribute selection"
                    onClear={() => {
                      handleAttributeChange('');
                      setAttributeSearch('');
                    }}
                    onInputChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setAttributeSearch(e.target.value);
                    }}
                    onOpenChange={(isOpen: boolean) => {
                      if (!isOpen) {
                        setAttributeSearch('');
                      }
                    }}
                    loading={loading && attributes.length === 0}
                    loadingMessage="Discovering schema attributes..."
                    onChange={(val: any) => {
                      if (val && typeof val === 'string' && val !== '__none__') {
                        handleAttributeChange(val);
                        setAttributeSearch('');
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
                  disabled={loading || totalSelectedCount === 0 || !selectedAttribute}
                >
                  Preview Changes ({totalSelectedCount})
                </Button>
                <Button
                  startIcon={<Play />}
                  variant="default"
                  size="L"
                  onClick={handleOpenConfirmModal}
                  loading={updating}
                  disabled={loading || totalSelectedCount === 0 || !selectedAttribute}
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
            </Box>

            {/* Pro Feature: Regex Search & Replace */}
            <Box marginTop={4} padding={4} background="neutral100" hasRadius>
              <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
                <Flex gap={2} alignItems="center">
                  <Checkbox
                    checked={useRegex}
                    onCheckedChange={(checked: boolean) => setUseRegex(Boolean(checked))}
                  >
                    <Typography fontWeight="bold">Enable Regex Find &amp; Replace</Typography>
                  </Checkbox>
                </Flex>
                {useRegex && (
                  <Box style={{ flex: 1, minWidth: 240 }}>
                    <TextInput
                      placeholder="Regex pattern (e.g. \b(OldName)\b)..."
                      value={regexPattern}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setRegexPattern(e.target.value)
                      }
                    />
                  </Box>
                )}
              </Flex>
            </Box>

            {/* Selected Attribute Context & Schema Intelligence Dashboard */}
            {selectedAttribute && (
              <Box marginTop={4} padding={4} background="neutral100" hasRadius style={{ border: '1px solid #eaeaef' }}>
                <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
                  <Flex gap={2} alignItems="center" wrap="wrap">
                    <Typography variant="pi" fontWeight="bold">
                      Attribute Info:
                    </Typography>
                    <Typography variant="pi">
                      Targeting attribute <strong><code>{selectedAttribute}</code></strong>
                    </Typography>
                    <Badge backgroundColor="success100" textColor="success700">
                      ✓ Supported in {supportedCollections.length} of {collections.length} Collections
                    </Badge>
                    {unsupportedCollections.length > 0 && (
                      <Badge backgroundColor="neutral200" textColor="neutral700">
                        — Not in schema: {unsupportedCollections.length}
                      </Badge>
                    )}
                  </Flex>

                  <Flex gap={2} alignItems="center">
                    <Button
                      variant="secondary"
                      size="S"
                      onClick={handleFocusOnlySupported}
                    >
                      Focus Workspace: Show Supported Only ({supportedCollections.length})
                    </Button>
                    <Button
                      variant="tertiary"
                      size="S"
                      onClick={() => setAttributeInfoExpanded((prev) => !prev)}
                    >
                      {attributeInfoExpanded ? 'Hide Schema Breakdown ▲' : 'Inspect Breakdown ▼'}
                    </Button>
                  </Flex>
                </Flex>

                {attributeInfoExpanded && (
                  <Box marginTop={3} paddingTop={3} style={{ borderTop: '1px solid #dcdce4' }}>
                    <Flex justifyContent="space-between" alignItems="center" marginBottom={3} wrap="wrap" gap={2}>
                      <Typography variant="pi" textColor="neutral600">
                        Showing collection types schema compatibility. Type to filter:
                      </Typography>
                      <Box style={{ width: 220 }}>
                        <TextInput
                          placeholder="Filter collection name..."
                          size="S"
                          value={attributeInfoSearch}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setAttributeInfoSearch(e.target.value)
                          }
                        />
                      </Box>
                    </Flex>
                    <Flex wrap="wrap" gap={2} alignItems="center" style={{ maxHeight: 180, overflowY: 'auto' }}>
                      {collections
                        .filter(
                          (c) =>
                            !attributeInfoSearch.trim() ||
                            c.displayName.toLowerCase().includes(attributeInfoSearch.toLowerCase().trim()) ||
                            c.uid.toLowerCase().includes(attributeInfoSearch.toLowerCase().trim())
                        )
                        .map((c) => {
                          const hasAttr = c.attributes.includes(selectedAttribute);
                          return (
                            <Badge
                              key={c.uid}
                              backgroundColor={hasAttr ? 'success100' : 'neutral200'}
                              textColor={hasAttr ? 'success700' : 'neutral600'}
                              size="S"
                            >
                              {c.displayName}: {hasAttr ? '✓ Supported' : '— Not in schema'}
                            </Badge>
                          );
                        })}
                    </Flex>
                  </Box>
                )}
              </Box>
            )}
          </Box>

          {/* Target Selection: Collections & Entries */}
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
                  2. Select Targets
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  Pick entire collection types or individual entries to apply the update to.
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
                  <Flex gap={2} alignItems="center">
                    <Typography variant="omega" fontWeight="bold">
                      Search &amp; Filter Targets:
                    </Typography>
                    {isFilterActive && (
                      <Badge backgroundColor="primary100" textColor="primary700">
                        {matchingEntriesCount} matching {matchingEntriesCount === 1 ? 'entry' : 'entries'} found in database
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
                  {/* Operator Select */}
                  <Box style={{ width: 220, minWidth: 180 }}>
                    <SingleSelect
                      label={selectedAttribute ? `Filter condition for "${selectedAttribute}"` : 'Filter condition'}
                      value={filterOperator}
                      onChange={(val) => setFilterOperator(String(val) as FilterOperator)}
                    >
                      <SingleSelectOption value="none">Show All (No Attribute Filter)</SingleSelectOption>
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
                      <TextInput
                        label={selectedAttribute ? `Value for "${selectedAttribute}"` : 'Value to match'}
                        placeholder="Type value to match..."
                        value={filterQuery}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFilterQuery(e.target.value)}
                      />
                    </Box>
                  )}

                  {/* Full-text search across entries */}
                  <Box style={{ flex: 1, minWidth: 200 }}>
                    <TextInput
                      label="Full-text Entry Search"
                      placeholder="Search title, name, or text across records..."
                      value={entrySearch}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEntrySearch(e.target.value)}
                    />
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

                {isFilterActive && (
                  <Flex gap={2} alignItems="center" marginTop={1}>
                    <Badge backgroundColor="success100" textColor="success700" size="S">
                      ✓ Filter active: Showing only matching entries. All returned matching records are pre-selected.
                    </Badge>
                  </Flex>
                )}
              </Flex>
            </Box>

            {/* Advanced Content Type Visibility Filter - Enterprise High-Density UX */}
            {collections.length > 0 && (
              <Box
                padding={4}
                background="neutral100"
                hasRadius
                marginBottom={4}
                style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box', border: '1px solid #eaeaef' }}
              >
                <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3} marginBottom={3}>
                  <Flex gap={2} alignItems="center" wrap="wrap">
                    <Typography variant="omega" fontWeight="bold">
                      Filter Visible Content Types:
                    </Typography>
                    <Badge backgroundColor="primary100" textColor="primary700">
                      {filteredCollections.length} of {collections.length} visible
                    </Badge>
                    <Badge backgroundColor="success100" textColor="success700">
                      {supportedCollections.filter((c) => visibleTypeUids[c.uid] !== false).length} of {supportedCollections.length} supported visible
                    </Badge>
                  </Flex>

                  {/* Inline Quick Search & Action Buttons */}
                  <Flex gap={2} alignItems="center" wrap="wrap">
                    <Box style={{ width: 220 }}>
                      <TextInput
                        placeholder="Search types..."
                        size="S"
                        value={typeVisibilitySearch}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setTypeVisibilitySearch(e.target.value)
                        }
                      />
                    </Box>
                    <Button
                      variant="secondary"
                      size="S"
                      onClick={handleFocusOnlySupported}
                    >
                      Show Supported Only ({supportedCollections.length})
                    </Button>
                    <Button
                      variant="tertiary"
                      size="S"
                      onClick={handleShowAllTypes}
                    >
                      Show All
                    </Button>
                    <Button
                      variant="tertiary"
                      size="S"
                      onClick={handleHideAllTypes}
                    >
                      Hide All
                    </Button>
                  </Flex>
                </Flex>

                {/* High-Density Scrollable Responsive Grid */}
                <Box
                  style={{
                    maxHeight: 220,
                    overflowY: 'auto',
                    padding: 8,
                    background: '#ffffff',
                    borderRadius: 4,
                    border: '1px solid #dcdce4',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                    gap: 8,
                  }}
                >
                  {collections
                    .filter(
                      (col) =>
                        !typeVisibilitySearch.trim() ||
                        col.displayName.toLowerCase().includes(typeVisibilitySearch.toLowerCase().trim()) ||
                        col.uid.toLowerCase().includes(typeVisibilitySearch.toLowerCase().trim())
                    )
                    .map((col) => {
                      const isVisible = visibleTypeUids[col.uid] !== false;
                      const hasAttr = selectedAttribute ? col.attributes.includes(selectedAttribute) : false;
                      return (
                        <Box
                          key={col.uid}
                          padding={2}
                          paddingLeft={3}
                          paddingRight={3}
                          background={isVisible ? '#f0f0ff' : '#f6f6f9'}
                          hasRadius
                          style={{
                            border: isVisible ? '1px solid #4945ff' : '1px solid #eaeaef',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <Flex justifyContent="space-between" alignItems="center" gap={2}>
                            <Checkbox
                              checked={isVisible}
                              onCheckedChange={(checked: boolean) =>
                                setVisibleTypeUids((prev) => ({ ...prev, [col.uid]: Boolean(checked) }))
                              }
                            >
                              <Typography variant="pi" fontWeight={isVisible ? 'bold' : 'regular'}>
                                {col.displayName}
                              </Typography>
                            </Checkbox>
                            <Flex gap={1} alignItems="center">
                              {col.isSingleType ? (
                                <Badge backgroundColor="secondary100" textColor="secondary700" size="S">
                                  Single
                                </Badge>
                              ) : null}
                              {hasAttr ? (
                                <Badge backgroundColor="success100" textColor="success700" size="S">
                                  ✓ Supports
                                </Badge>
                              ) : (
                                <Badge backgroundColor="neutral150" textColor="neutral600" size="S">
                                  —
                                </Badge>
                              )}
                            </Flex>
                          </Flex>
                        </Box>
                      );
                    })}
                </Box>
              </Box>
            )}

            {/* Filter Search & Global Page Size Controls */}
            <Flex justifyContent="space-between" alignItems="center" marginBottom={4} wrap="wrap" gap={3}>
              {collections.length > 1 && (
                <Box style={{ flex: 1, maxWidth: 360, minWidth: 220 }}>
                  <TextInput
                    label="Search Content Types"
                    placeholder="Search by name or UID..."
                    value={collectionSearch}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setCollectionSearch(e.target.value)
                    }
                  />
                </Box>
              )}
              <Flex gap={2} alignItems="center" style={{ marginLeft: 'auto' }}>
                <Typography variant="pi" textColor="neutral600">
                  Default page size (max 500):
                </Typography>
                <Box style={{ width: 130 }}>
                  <SingleSelect
                    size="S"
                    value={String(defaultPageSize)}
                    onChange={(val) => handleGlobalPageSizeChange(Number(val))}
                  >
                    <SingleSelectOption value="5">5 / page</SingleSelectOption>
                    <SingleSelectOption value="10">10 / page</SingleSelectOption>
                    <SingleSelectOption value="25">25 / page</SingleSelectOption>
                    <SingleSelectOption value="50">50 / page</SingleSelectOption>
                    <SingleSelectOption value="100">100 / page</SingleSelectOption>
                    <SingleSelectOption value="250">250 / page</SingleSelectOption>
                    <SingleSelectOption value="500">500 / page</SingleSelectOption>
                  </SingleSelect>
                </Box>
              </Flex>
            </Flex>

            {filteredCollections.length === 0 ? (
              <Box padding={6} background="neutral100" hasRadius style={{ textAlign: 'center' }}>
                <Typography variant="pi" textColor="neutral600">
                  No content types match the visibility or search filters.
                </Typography>
              </Box>
            ) : (
              filteredCollections.map((col) => {
                const pageState = collectionPages[col.uid];
                const entries = pageState ? pageState.entries : (col.entries || []);
                const totalEntries = pageState ? pageState.total : (col.totalEntries !== undefined ? col.totalEntries : entries.length);
                const page = pageState ? pageState.page : 1;
                const pageCount = pageState ? pageState.pageCount : 1;
                const pageSize = pageState ? pageState.pageSize : defaultPageSize;
                const hasAttr = selectedAttribute ? col.attributes.includes(selectedAttribute) : false;
                const visibleEntries = getVisibleEntries(col);
                const matchingColCount = selectedAttribute ? entries.filter((e) => entryMatchesFilter(e, selectedAttribute)).length : 0;
                const isFullySelected = isCollectionFullySelected(col);
                const isPartiallySelected = isCollectionPartiallySelected(col);
                const currentSort = collectionSorts[col.uid] || { field: 'createdAt', order: 'desc' };
                const availableColumns = getAvailableColumnsForCollection(col, selectedAttribute);
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
                          <Flex gap={2} alignItems="center">
                            <Typography variant="pi" textColor="neutral600">
                              Sort:
                            </Typography>
                            <Box style={{ width: 190 }}>
                              <SingleSelect
                                size="S"
                                value={`${currentSort.field}:${currentSort.order}`}
                                onChange={(val) => {
                                  const [f, o] = String(val).split(':');
                                  handleCollectionSortChange(col.uid, f, o as 'asc' | 'desc');
                                }}
                              >
                                <SingleSelectOption value="createdAt:desc">Created: Newest</SingleSelectOption>
                                <SingleSelectOption value="createdAt:asc">Created: Oldest</SingleSelectOption>
                                {hasAttr && (
                                  <>
                                    <SingleSelectOption value={`${selectedAttribute}:asc`}>
                                      {selectedAttribute} (A &rarr; Z)
                                    </SingleSelectOption>
                                    <SingleSelectOption value={`${selectedAttribute}:desc`}>
                                      {selectedAttribute} (Z &rarr; A)
                                    </SingleSelectOption>
                                  </>
                                )}
                                {col.attributes.includes('name') && (
                                  <>
                                    <SingleSelectOption value="name:asc">Name (A &rarr; Z)</SingleSelectOption>
                                    <SingleSelectOption value="name:desc">Name (Z &rarr; A)</SingleSelectOption>
                                  </>
                                )}
                                {col.attributes.includes('title') && (
                                  <>
                                    <SingleSelectOption value="title:asc">Title (A &rarr; Z)</SingleSelectOption>
                                    <SingleSelectOption value="title:desc">Title (Z &rarr; A)</SingleSelectOption>
                                  </>
                                )}
                              </SingleSelect>
                            </Box>
                          </Flex>
                        )}

                        <Button
                          variant={openColumnPickerUid === col.uid ? 'secondary' : 'tertiary'}
                          size="S"
                          onClick={() => setOpenColumnPickerUid(openColumnPickerUid === col.uid ? null : col.uid)}
                        >
                          Columns ({activeColumns.filter((c) => !c.isPermanent).length}/{availableColumns.filter((c) => !c.isPermanent).length})
                        </Button>

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
                              const res = await get(`/bulk-updater/csv/export/${col.uid}?${params.toString()}`);
                              const csvStr = res.data?.csvContent || (typeof res.data === 'string' ? res.data : '');
                              if (!csvStr) {
                                toggleNotification({
                                  type: 'warning',
                                  message: 'No CSV content returned for this collection',
                                });
                                return;
                              }
                              const blob = new Blob([csvStr], { type: 'text/csv;charset=utf-8;' });
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
                                message: `Exported ${col.displayName} entries to CSV`,
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

                    {/* Column Visibility Selector Panel */}
                    {openColumnPickerUid === col.uid && (
                      <Box
                        padding={3}
                        marginBottom={3}
                        background="neutral100"
                        hasRadius
                        borderColor="neutral200"
                        style={{ border: '1px solid #dcdce4' }}
                      >
                        <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
                          <Flex gap={3} alignItems="center" wrap="wrap">
                            <Typography variant="pi" fontWeight="bold" textColor="neutral700">
                              Columns for {col.displayName}:
                            </Typography>
                            {availableColumns
                              .filter((c) => !c.isPermanent)
                              .map((c) => {
                                const isChecked = activeColumns.some((ac) => ac.key === c.key);
                                return (
                                  <Box key={c.key}>
                                    <Checkbox
                                      checked={isChecked}
                                      onCheckedChange={() => toggleColumn(col.uid, c.key, availableColumns)}
                                    >
                                      <Typography variant="pi">{c.label}</Typography>
                                    </Checkbox>
                                  </Box>
                                );
                              })}
                          </Flex>
                          <Flex gap={2}>
                            <Button
                              variant="tertiary"
                              size="S"
                              onClick={() => showAllColumns(col.uid, availableColumns)}
                            >
                              Show All
                            </Button>
                            <Button
                              variant="tertiary"
                              size="S"
                              onClick={() => resetDefaultColumns(col.uid, availableColumns)}
                            >
                              Reset
                            </Button>
                            <Button
                              variant="ghost"
                              size="S"
                              onClick={() => setOpenColumnPickerUid(null)}
                            >
                              Close
                            </Button>
                          </Flex>
                        </Flex>
                      </Box>
                    )}

                    {/* Entries Table */}
                    <Box className="bulk-updater-table-container" style={{ width: '100%', maxWidth: '100%', minWidth: 0, overflowX: 'auto' }}>
                      <Table colCount={activeColumns.length} rowCount={visibleEntries.length + 1} style={{ width: '100%' }}>
                        <Thead>
                          <Tr>
                            {activeColumns.map((colDef) =>
                              renderHeaderCell(colDef, col, currentSort, selectedAttribute, handleHeaderSortClick)
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

                              return (
                                <Tr
                                  key={key}
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
                                        isMatch,
                                        hasAttr,
                                        isSelected,
                                        () => toggleEntry(col.uid, entry.documentId)
                                      )}
                                    </Td>
                                  ))}
                                </Tr>
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
              })
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
                            <Badge
                              backgroundColor={batch.summary.publishOnApproval === false ? 'warning100' : 'success100'}
                              textColor={batch.summary.publishOnApproval === false ? 'warning700' : 'success700'}
                            >
                              {batch.summary.publishOnApproval === false ? 'DRAFT ONLY' : 'AUTO-PUBLISH'}
                            </Badge>
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
                          <Td style={{ minWidth: 160 }}>
                            <Typography
                              style={{
                                display: 'inline-block',
                                maxWidth: '100%',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={`${rec.attribute} → "${formatDisplayValue(rec.value)}"`}
                            >
                              <strong>{rec.attribute}</strong> &rarr; &ldquo;{formatDisplayValue(rec.value)}&rdquo;
                            </Typography>
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
                                <Table colCount={4} rowCount={rec.diffs.length + 1}>
                                  <Thead>
                                    <Tr>
                                      <Th><Typography variant="sigma">Collection</Typography></Th>
                                      <Th><Typography variant="sigma">Document / Entry</Typography></Th>
                                      <Th><Typography variant="sigma">Previous Value</Typography></Th>
                                      <Th><Typography variant="sigma">Applied Value</Typography></Th>
                                    </Tr>
                                  </Thead>
                                  <Tbody>
                                    {rec.diffs.map((d, dIdx) => (
                                      <Tr key={dIdx}>
                                        <Td><Typography fontWeight="semiBold">{d.collectionName}</Typography></Td>
                                        <Td><Typography>{d.label}</Typography></Td>
                                        <Td><Typography textColor="danger600">{formatDisplayValue(d.oldValue)}</Typography></Td>
                                        <Td><Typography textColor="success600">{formatDisplayValue(d.newValue)}</Typography></Td>
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
                      >
                        Queue for Off-Peak ({executionWindow?.offPeakStartTime || '18:00'})
                      </Button>
                      <Button
                        variant="danger-light"
                        size="S"
                        onClick={() => executeBatchWithMode('immediate', true)}
                        loading={updating}
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
                    >
                      Confirm &amp; Execute Now
                    </Button>
                  )}
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
                      >
                        Queue for Off-Peak ({executionWindow?.offPeakStartTime || '18:00'})
                      </Button>
                      <Button
                        variant="danger-light"
                        size="S"
                        onClick={() => executeBatchPublish('immediate', true)}
                        loading={publishing}
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
                    >
                      Confirm &amp; Publish Now
                    </Button>
                  )}
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
    </Box>
  );
};

export default BulkUpdater;
