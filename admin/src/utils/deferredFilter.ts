export type FilterOperator =
  | 'none'
  | 'empty'
  | 'not_empty'
  | 'equals'
  | 'contains'
  | 'starts_with';

export interface SearchFilterSnapshot {
  searchAttribute: string;
  filterOperator: FilterOperator;
  filterQuery: string;
  entrySearch: string;
  statusFilter?: string;
  useRegex?: boolean;
  regexPattern?: string;
}

export const EMPTY_SEARCH_FILTER: SearchFilterSnapshot = {
  searchAttribute: '',
  filterOperator: 'none',
  filterQuery: '',
  entrySearch: '',
  statusFilter: 'all',
  useRegex: false,
  regexPattern: '',
};

/**
 * Compares two filter snapshots to determine if draft controls have unsubmitted changes.
 */
export function areSearchFiltersEqual(
  a: SearchFilterSnapshot,
  b: SearchFilterSnapshot,
  options: { includeWorkspaceExtras?: boolean } = {}
): boolean {
  if (
    (a.searchAttribute || '') !== (b.searchAttribute || '') ||
    (a.filterOperator || 'none') !== (b.filterOperator || 'none') ||
    (a.filterQuery || '') !== (b.filterQuery || '') ||
    (a.entrySearch || '') !== (b.entrySearch || '')
  ) {
    return false;
  }

  if (options.includeWorkspaceExtras) {
    if (
      (a.statusFilter || 'all') !== (b.statusFilter || 'all') ||
      Boolean(a.useRegex) !== Boolean(b.useRegex) ||
      (a.regexPattern || '') !== (b.regexPattern || '')
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Determines whether a filter snapshot actively narrows results.
 */
export function isSearchFilterActive(
  filter: SearchFilterSnapshot,
  selectedTargetAttribute = ''
): boolean {
  const hasAttrFilter =
    Boolean(filter.searchAttribute && filter.searchAttribute !== selectedTargetAttribute);
  const hasOp =
    filter.filterOperator !== 'none' &&
    (['empty', 'not_empty'].includes(filter.filterOperator) ||
      Boolean((filter.filterQuery || '').trim()));
  const hasSearchText = Boolean((filter.entrySearch || '').trim());
  const hasStatus = Boolean(filter.statusFilter && filter.statusFilter !== 'all');
  const hasRegex = Boolean(filter.useRegex && (filter.regexPattern || '').trim());

  return hasAttrFilter || hasOp || hasSearchText || hasStatus || hasRegex;
}

/**
 * Builds `/collections/:uid/entries` query parameters strictly from an applied filter snapshot.
 */
export function buildEntriesQueryParams(options: {
  page: number;
  pageSize: number;
  filter: SearchFilterSnapshot;
  selectedAttribute?: string;
  sortField?: string;
  sortOrder?: string;
  includeAttributeEvenIfSame?: boolean;
}): URLSearchParams {
  const { page, pageSize, filter, selectedAttribute, sortField, sortOrder, includeAttributeEvenIfSame } =
    options;
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });

  if (includeAttributeEvenIfSame) {
    if (filter.searchAttribute) {
      params.set('attribute', filter.searchAttribute);
      params.set('searchAttribute', filter.searchAttribute);
    }
  } else {
    if (selectedAttribute) params.set('attribute', selectedAttribute);
    if (filter.searchAttribute && filter.searchAttribute !== selectedAttribute) {
      params.set('searchAttribute', filter.searchAttribute);
    }
  }

  if (filter.filterOperator && filter.filterOperator !== 'none') {
    params.set('filterOperator', filter.filterOperator);
    if (filter.filterQuery) {
      params.set('filterQuery', filter.filterQuery);
    }
  }

  if (filter.entrySearch && filter.entrySearch.trim()) {
    params.set('search', filter.entrySearch.trim());
  }

  if (sortField) {
    params.set('sortField', sortField);
    if (sortOrder) params.set('sortOrder', sortOrder);
  }

  return params;
}

export type CsvExportMode = 'all' | 'metafields' | 'topbarconfig';

/**
 * Builds `/csv/export/:uid` query parameters strictly from an applied filter snapshot.
 */
export function buildCsvExportQueryParams(options: {
  limit?: number;
  filter: SearchFilterSnapshot;
  exportMode?: CsvExportMode;
}): URLSearchParams {
  const { limit, filter, exportMode } = options;
  const queryParams = new URLSearchParams();

  if (limit && limit > 0) {
    queryParams.set('limit', String(limit));
  }
  if (exportMode) {
    queryParams.set('exportMode', exportMode);
  }
  if (filter.searchAttribute) {
    queryParams.set('searchAttribute', filter.searchAttribute);
  }
  if (filter.filterOperator && filter.filterOperator !== 'none') {
    queryParams.set('filterOperator', filter.filterOperator);
    if (filter.filterQuery) {
      queryParams.set('filterQuery', filter.filterQuery);
    }
  }
  if (filter.entrySearch && filter.entrySearch.trim()) {
    queryParams.set('search', filter.entrySearch.trim());
  }

  return queryParams;
}
