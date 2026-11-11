import React, { useState, useMemo } from 'react';
import {
  Box,
  Flex,
  Typography,
  Button,
  TextInput,
  Badge,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Loader,
} from '@strapi/design-system';
import { Check } from '@strapi/icons';

export interface PreviewDiffItem {
  uid: string;
  collectionName: string;
  documentId: string;
  label: string;
  attribute: string;
  occurrenceKey?: string;
  oldValue: any;
  newValue: any;
  oldDisplay: string;
  newDisplay: string;
  hasChange: boolean;
  status: 'will_update' | 'unchanged' | 'will_skip' | 'will_error';
  validationError?: string;
  message: string;
}

export interface PreviewSummary {
  total: number;
  willUpdate: number;
  unchanged: number;
  skipped: number;
  willError?: number;
}

interface BulkUpdatePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProceed: () => void;
  loading: boolean;
  previewData: {
    editMode?: 'common' | 'grid';
    summary: PreviewSummary;
    diffs: PreviewDiffItem[];
  } | null;
  attribute: string;
  targetValueDisplay: string;
  editMode?: 'common' | 'grid';
  publishOnApproval?: boolean;
  lifecycleStats?: {
    published: number;
    modified: number;
    draft: number;
    pendingReview: number;
    unreviewedCount: number;
  };
}

const BulkUpdatePreviewModal: React.FC<BulkUpdatePreviewModalProps> = ({
  isOpen,
  onClose,
  onProceed,
  loading,
  previewData,
  attribute,
  targetValueDisplay,
  editMode = 'common',
  publishOnApproval = true,
  lifecycleStats,
}) => {
  const [filterTab, setFilterTab] = useState<'all' | 'will_update' | 'unchanged' | 'will_skip' | 'will_error'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const filteredDiffs = useMemo(() => {
    if (!previewData || !previewData.diffs) return [];
    let items = previewData.diffs;

    if (filterTab !== 'all') {
      items = items.filter((d) => d.status === filterTab);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      items = items.filter(
        (d) =>
          d.label.toLowerCase().includes(q) ||
          d.documentId.toLowerCase().includes(q) ||
          d.collectionName.toLowerCase().includes(q) ||
          String(d.attribute || '').toLowerCase().includes(q) ||
          String(d.oldDisplay || '').toLowerCase().includes(q) ||
          String(d.newDisplay || '').toLowerCase().includes(q)
      );
    }

    return items;
  }, [previewData, filterTab, searchQuery]);

  if (!isOpen) return null;

  const isGridMode = editMode === 'grid' || previewData?.editMode === 'grid';
  const willErrorCount = previewData?.summary?.willError || 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(20, 20, 30, 0.7)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: 16,
        boxSizing: 'border-box',
      }}
      onClick={onClose}
    >
      <Box
        background="neutral0"
        hasRadius
        shadow="popupShadow"
        style={{
          maxWidth: 1120,
          width: '95%',
          maxHeight: 'calc(100vh - 48px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.35), 0 0 1px rgba(0, 0, 0, 0.2)',
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
          <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
            <Box>
              <Flex gap={2} alignItems="center" marginBottom={1}>
                <Typography variant="delta" fontWeight="bold">
                  Pre-Update Change Preview
                </Typography>
                <Badge backgroundColor="primary100" textColor="primary700">
                  Target: {attribute}
                </Badge>
                {isGridMode && (
                  <Badge backgroundColor="secondary100" textColor="secondary700">
                    GRID EDITING MODE
                  </Badge>
                )}
              </Flex>
              <Typography variant="pi" textColor="neutral600">
                Inspect exact before &amp; after values across target records before applying changes to the database.
              </Typography>
            </Box>

            <Flex gap={2} alignItems="center" wrap="wrap">
              {!isGridMode ? (
                <>
                  <Typography variant="pi" textColor="neutral600">
                    New Value:
                  </Typography>
                  <Badge backgroundColor="success100" textColor="success700">
                    {targetValueDisplay || '(empty)'}
                  </Badge>
                </>
              ) : (
                <Badge backgroundColor="secondary100" textColor="secondary700">
                  {targetValueDisplay || 'Per-Record & Component Grid Edits'}
                </Badge>
              )}
              <Badge
                backgroundColor={publishOnApproval !== false ? 'success100' : 'warning100'}
                textColor={publishOnApproval !== false ? 'success700' : 'warning700'}
              >
                {publishOnApproval !== false ? '✓ LIVE PUBLISH' : 'DRAFT ONLY'}
              </Badge>
            </Flex>
          </Flex>
        </Box>

        {/* Modal Body */}
        <Box
          padding={5}
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {loading ? (
            <Box padding={8} style={{ textAlign: 'center' }}>
              <Flex direction="column" alignItems="center" gap={3}>
                <Loader>Inspecting target records from database...</Loader>
                <Typography variant="delta" fontWeight="semiBold">
                  Inspecting Target Records...
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  Computing proposed diffs and verifying against database schema.
                </Typography>
              </Flex>
            </Box>
          ) : !previewData ? (
            <Box padding={6} style={{ textAlign: 'center' }}>
              <Typography textColor="neutral600">No preview data available.</Typography>
            </Box>
          ) : (
            <>
              {/* Validation / Quota Error Warning Banner */}
              {willErrorCount > 0 && (
                <Box marginBottom={4} padding={3} background="danger100" hasRadius style={{ border: '1px solid #f5c0b8' }}>
                  <Flex gap={2} alignItems="center">
                    <Typography variant="pi" fontWeight="bold" textColor="danger700">
                      ⚠️ Validation / Quota Violation Detected:
                    </Typography>
                    <Typography variant="pi" textColor="danger700">
                      {willErrorCount} item(s) failed schema or quota validation rules. Inspect the rows marked &quot;Validation Error&quot; below; invalid records will be rejected during batch execution and retained for editing.
                    </Typography>
                  </Flex>
                </Box>
              )}

              {/* Unreviewed Content Notice */}
              {publishOnApproval && lifecycleStats && lifecycleStats.unreviewedCount > 0 && (
                <Box marginBottom={4} padding={3} background="warning100" hasRadius style={{ border: '1px solid #f5c0b8' }}>
                  <Flex gap={2} alignItems="center">
                    <Typography variant="pi" fontWeight="bold" textColor="warning700">
                      ⚠️ Safe Publishing Active:
                    </Typography>
                    <Typography variant="pi" textColor="warning700">
                      {lifecycleStats.unreviewedCount} target record(s) contain unreviewed draft changes ({lifecycleStats.draft} Draft, {lifecycleStats.modified} Modified).
                      By default, these will be updated as drafts without publishing unreviewed revisions to production visitors.
                    </Typography>
                  </Flex>
                </Box>
              )}

              {/* Summary KPI Cards */}
              <Flex gap={3} marginBottom={4} wrap="wrap">
                <Box
                  padding={3}
                  background="neutral100"
                  hasRadius
                  style={{ flex: 1, minWidth: 140, border: '1px solid rgba(120, 120, 150, 0.15)' }}
                >
                  <Typography variant="sigma" textColor="neutral600" display="block">
                    TOTAL TARGETS
                  </Typography>
                  <Typography variant="beta" fontWeight="bold" textColor="neutral800">
                    {previewData.summary.total}
                  </Typography>
                </Box>

                <Box
                  padding={3}
                  background="success100"
                  hasRadius
                  style={{ flex: 1, minWidth: 140, border: '1px solid #b7eb8f' }}
                >
                  <Typography variant="sigma" textColor="success700" display="block">
                    WILL UPDATE
                  </Typography>
                  <Typography variant="beta" fontWeight="bold" textColor="success700">
                    {previewData.summary.willUpdate}
                  </Typography>
                </Box>

                <Box
                  padding={3}
                  background="neutral100"
                  hasRadius
                  style={{ flex: 1, minWidth: 140, border: '1px solid rgba(120, 120, 150, 0.15)' }}
                >
                  <Typography variant="sigma" textColor="neutral600" display="block">
                    ALREADY UP-TO-DATE
                  </Typography>
                  <Typography variant="beta" fontWeight="bold" textColor="neutral600">
                    {previewData.summary.unchanged}
                  </Typography>
                </Box>

                <Box
                  padding={3}
                  background={previewData.summary.skipped > 0 ? 'warning100' : 'neutral100'}
                  hasRadius
                  style={{ flex: 1, minWidth: 140, border: '1px solid rgba(120, 120, 150, 0.15)' }}
                >
                  <Typography
                    variant="sigma"
                    textColor={previewData.summary.skipped > 0 ? 'warning700' : 'neutral600'}
                    display="block"
                  >
                    WILL SKIP
                  </Typography>
                  <Typography
                    variant="beta"
                    fontWeight="bold"
                    textColor={previewData.summary.skipped > 0 ? 'warning700' : 'neutral600'}
                  >
                    {previewData.summary.skipped}
                  </Typography>
                </Box>

                {willErrorCount > 0 && (
                  <Box
                    padding={3}
                    background="danger100"
                    hasRadius
                    style={{ flex: 1, minWidth: 140, border: '1px solid #ffa39e' }}
                  >
                    <Typography variant="sigma" textColor="danger700" display="block">
                      VALIDATION ERRORS
                    </Typography>
                    <Typography variant="beta" fontWeight="bold" textColor="danger700">
                      {willErrorCount}
                    </Typography>
                  </Box>
                )}
              </Flex>

              {/* Filter Tabs & Search Bar */}
              <Flex justifyContent="space-between" alignItems="center" marginBottom={3} wrap="wrap" gap={3}>
                <Flex gap={2} wrap="wrap">
                  <Button
                    variant={filterTab === 'all' ? 'default' : 'tertiary'}
                    size="S"
                    onClick={() => setFilterTab('all')}
                  >
                    All ({isGridMode ? previewData.diffs.length : previewData.summary.total})
                  </Button>
                  <Button
                    variant={filterTab === 'will_update' ? 'default' : 'tertiary'}
                    size="S"
                    onClick={() => setFilterTab('will_update')}
                  >
                    Will Update ({previewData.summary.willUpdate})
                  </Button>
                  <Button
                    variant={filterTab === 'unchanged' ? 'default' : 'tertiary'}
                    size="S"
                    onClick={() => setFilterTab('unchanged')}
                  >
                    Unchanged ({previewData.summary.unchanged})
                  </Button>
                  {previewData.summary.skipped > 0 && (
                    <Button
                      variant={filterTab === 'will_skip' ? 'default' : 'tertiary'}
                      size="S"
                      onClick={() => setFilterTab('will_skip')}
                    >
                      Skipped ({previewData.summary.skipped})
                    </Button>
                  )}
                  {willErrorCount > 0 && (
                    <Button
                      variant={filterTab === 'will_error' ? 'default' : 'tertiary'}
                      size="S"
                      onClick={() => setFilterTab('will_error')}
                    >
                      Errors ({willErrorCount})
                    </Button>
                  )}
                </Flex>

                <Box style={{ width: 260 }}>
                  <TextInput
                    placeholder="Search records or values..."
                    size="S"
                    value={searchQuery}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                  />
                </Box>
              </Flex>

              {/* Diffs Table */}
              <Box
                hasRadius
                style={{
                  border: '1px solid #eaeaef',
                  maxHeight: 380,
                  overflowY: 'auto',
                  overflowX: 'auto',
                }}
              >
                <Table colCount={6} rowCount={filteredDiffs.length + 1} style={{ width: '100%', minWidth: 880 }}>
                  <Thead>
                    <Tr>
                      <Th style={{ width: 140 }}>
                        <Typography variant="sigma" textColor="neutral600">
                          COLLECTION
                        </Typography>
                      </Th>
                      <Th style={{ minWidth: 185 }}>
                        <Typography variant="sigma" textColor="neutral600">
                          RECORD IDENTIFIER
                        </Typography>
                      </Th>
                      <Th style={{ minWidth: 165 }}>
                        <Typography variant="sigma" textColor="neutral600">
                          ATTRIBUTE / BLOCK
                        </Typography>
                      </Th>
                      <Th style={{ minWidth: 170 }}>
                        <Typography variant="sigma" textColor="neutral600">
                          CURRENT VALUE (BEFORE)
                        </Typography>
                      </Th>
                      <Th style={{ minWidth: 170 }}>
                        <Typography variant="sigma" textColor="neutral600">
                          NEW VALUE (AFTER)
                        </Typography>
                      </Th>
                      <Th style={{ width: 150, textAlign: 'right' }}>
                        <Typography variant="sigma" textColor="neutral600">
                          IMPACT
                        </Typography>
                      </Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {filteredDiffs.length === 0 ? (
                      <Tr>
                        <Td colSpan={6} style={{ textAlign: 'center', padding: '24px' }}>
                          <Typography textColor="neutral600">
                            No records match the current filter or search criteria.
                          </Typography>
                        </Td>
                      </Tr>
                    ) : (
                      filteredDiffs.map((diff, idx) => (
                        <Tr key={`${diff.uid}-${diff.documentId}-${diff.attribute || 'root'}-${idx}`}>
                          <Td>
                            <Badge backgroundColor="neutral150" textColor="neutral700">
                              {diff.collectionName}
                            </Badge>
                          </Td>
                          <Td>
                            <Box>
                              <Typography fontWeight="bold" display="block">
                                {diff.label}
                              </Typography>
                              <Typography variant="pi" textColor="neutral500">
                                <code>{diff.documentId}</code>
                              </Typography>
                            </Box>
                          </Td>
                          <Td>
                            <Typography variant="pi" fontWeight="semiBold" textColor="primary700">
                              {diff.attribute || attribute}
                            </Typography>
                          </Td>
                          <Td>
                            <Typography
                              variant="omega"
                              style={{
                                color: diff.hasChange ? '#666687' : '#272635',
                                textDecoration: diff.hasChange ? 'line-through' : 'none',
                                wordBreak: 'break-all',
                              }}
                            >
                              {diff.oldDisplay || '(empty)'}
                            </Typography>
                          </Td>
                          <Td>
                            {diff.status === 'will_error' ? (
                              <Typography variant="pi" textColor="danger700" fontWeight="bold">
                                {diff.validationError || diff.message}
                              </Typography>
                            ) : diff.status === 'will_skip' ? (
                              <Typography variant="pi" textColor="warning700">
                                — Skipped (field absent) —
                              </Typography>
                            ) : diff.hasChange ? (
                              <Typography variant="omega" fontWeight="bold" textColor="success700" style={{ wordBreak: 'break-all' }}>
                                {diff.newDisplay || '(empty)'}
                              </Typography>
                            ) : (
                              <Typography variant="omega" textColor="neutral600">
                                {diff.newDisplay || '(already matching)'}
                              </Typography>
                            )}
                          </Td>
                          <Td style={{ textAlign: 'right' }}>
                            {diff.status === 'will_update' && (
                              <Badge backgroundColor="success100" textColor="success700">
                                ✓ Will Update
                              </Badge>
                            )}
                            {diff.status === 'unchanged' && (
                              <Badge backgroundColor="neutral150" textColor="neutral600">
                                = Unchanged
                              </Badge>
                            )}
                            {diff.status === 'will_skip' && (
                              <Badge backgroundColor="warning100" textColor="warning700">
                                ⚠ Will Skip
                              </Badge>
                            )}
                            {diff.status === 'will_error' && (
                              <Badge backgroundColor="danger100" textColor="danger700">
                                ✕ Error
                              </Badge>
                            )}
                          </Td>
                        </Tr>
                      ))
                    )}
                  </Tbody>
                </Table>
              </Box>
            </>
          )}
        </Box>

        {/* Modal Footer */}
        <Box
          padding={4}
          background="neutral100"
          style={{
            borderTop: '1px solid rgba(120, 120, 150, 0.2)',
            flexShrink: 0,
          }}
        >
          <Flex justifyContent="space-between" alignItems="center">
            <Button variant="tertiary" size="M" onClick={onClose}>
              Close Preview
            </Button>

            <Button
              variant="default"
              size="M"
              startIcon={<Check />}
              onClick={() => {
                onClose();
                onProceed();
              }}
              disabled={loading || !previewData || previewData.summary.total === 0 || (isGridMode && previewData.summary.willUpdate === 0)}
            >
              Proceed to Execute ({previewData?.summary.willUpdate || 0} updates)
            </Button>
          </Flex>
        </Box>
      </Box>
    </div>
  );
};

export default BulkUpdatePreviewModal;
