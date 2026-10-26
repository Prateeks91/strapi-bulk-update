import React, { useState, useEffect, useMemo } from 'react';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
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
import { Check, Download, ArrowClockwise } from '@strapi/icons';

export interface DiffItem {
  uid: string;
  collectionName: string;
  documentId: string;
  label: string;
  attribute: string;
  oldValue: any;
  newValue: any;
  oldDisplay: string;
  newDisplay: string;
  hasChange: boolean;
  status: 'will_update' | 'will_create' | 'unchanged' | 'will_skip';
  action?: 'update' | 'create' | 'publish' | 'skip';
  message: string;
}

export interface DiffSummary {
  total: number;
  willUpdate: number;
  willCreate?: number;
  unchanged: number;
  skipped: number;
}

interface CheckerReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  batch: any | null;
  onApprove: (batchId: string) => Promise<void>;
  onReject: (batchId: string, reason: string) => Promise<void>;
  approving: boolean;
  rejecting: boolean;
}

const CheckerReviewModal: React.FC<CheckerReviewModalProps> = ({
  isOpen,
  onClose,
  batch,
  onApprove,
  onReject,
  approving,
  rejecting,
}) => {
  const { get } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<DiffItem[]>([]);
  const [summary, setSummary] = useState<DiffSummary>({
    total: 0,
    willUpdate: 0,
    willCreate: 0,
    unchanged: 0,
    skipped: 0,
  });
  const [filterTab, setFilterTab] = useState<'all' | 'changes' | 'will_update' | 'will_create' | 'unchanged' | 'will_skip'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [showRejectInput, setShowRejectInput] = useState<boolean>(false);
  const [rejectionReason, setRejectionReason] = useState<string>('');

  const fetchBatchDiffs = async () => {
    if (!batch || !batch.id) return;
    try {
      setLoading(true);
      setError(null);
      const res = await get(`/bulk-updater/batches/${batch.id}/diffs`);
      if (res.data && res.data.success) {
        setDiffs(res.data.diffs || []);
        setSummary({
          total: res.data.summary?.total ?? res.data.diffs?.length ?? 0,
          willUpdate: res.data.summary?.willUpdate ?? 0,
          willCreate: res.data.summary?.willCreate ?? 0,
          unchanged: res.data.summary?.unchanged ?? 0,
          skipped: res.data.summary?.skipped ?? 0,
        });
      } else {
        setError(res.data?.error || 'Failed to inspect pending batch changes.');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred while fetching batch diffs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && batch) {
      setShowRejectInput(false);
      setRejectionReason('');
      setFilterTab('all');
      setSearchQuery('');
      fetchBatchDiffs();
    }
  }, [isOpen, batch?.id]);

  const handleExportCsv = async () => {
    if (!batch || !batch.id) return;
    try {
      setIsExporting(true);
      const res = await get(`/bulk-updater/batches/${batch.id}/diffs/export`);
      if (res.data && res.data.success && res.data.csvContent) {
        const safeContent = res.data.csvContent.startsWith('\uFEFF')
          ? res.data.csvContent
          : '\uFEFF' + res.data.csvContent;
        const blob = new Blob([safeContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', res.data.filename || `batch_${batch.id}_review.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toggleNotification({
          type: 'success',
          message: `Exported ${res.data.count || diffs.length} batch changes to audit CSV.`,
        });
      } else {
        toggleNotification({
          type: 'danger',
          message: 'Failed to generate review CSV export.',
        });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err.message || 'Error downloading review CSV.',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const filteredDiffs = useMemo(() => {
    let items = diffs;

    if (filterTab === 'changes') {
      items = items.filter((d) => d.hasChange || d.status === 'will_create');
    } else if (filterTab === 'will_update') {
      items = items.filter((d) => d.status === 'will_update');
    } else if (filterTab === 'will_create') {
      items = items.filter((d) => d.status === 'will_create');
    } else if (filterTab === 'unchanged') {
      items = items.filter((d) => d.status === 'unchanged');
    } else if (filterTab === 'will_skip') {
      items = items.filter((d) => d.status === 'will_skip');
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      items = items.filter(
        (d) =>
          d.label?.toLowerCase().includes(q) ||
          d.documentId?.toLowerCase().includes(q) ||
          d.collectionName?.toLowerCase().includes(q) ||
          d.attribute?.toLowerCase().includes(q) ||
          String(d.oldDisplay || '').toLowerCase().includes(q) ||
          String(d.newDisplay || '').toLowerCase().includes(q)
      );
    }

    return items;
  }, [diffs, filterTab, searchQuery]);

  if (!isOpen || !batch) return null;

  const totalChanges = (summary.willUpdate || 0) + (summary.willCreate || 0);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(20, 20, 30, 0.75)',
        backdropFilter: 'blur(4px)',
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
          maxWidth: 1160,
          width: '96%',
          maxHeight: 'calc(100vh - 40px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
          boxShadow: '0 24px 50px rgba(0, 0, 0, 0.4), 0 0 1px rgba(0, 0, 0, 0.25)',
        }}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* Header */}
        <Box
          padding={5}
          background="neutral100"
          style={{
            borderBottom: '1px solid rgba(120, 120, 150, 0.2)',
            flexShrink: 0,
          }}
        >
          <Flex justifyContent="space-between" alignItems="flex-start" wrap="wrap" gap={3}>
            <Box>
              <Flex gap={2} alignItems="center" marginBottom={1}>
                <Typography variant="delta" fontWeight="bold">
                  Checker Approval: Bulk Change Inspection
                </Typography>
                <Badge backgroundColor="primary100" textColor="primary700">
                  {batch.id}
                </Badge>
                {(batch.payload?.action === 'csv_import' || batch.id?.startsWith('csv_')) && (
                  <Badge backgroundColor="secondary100" textColor="secondary700">
                    📊 CSV IMPORT
                  </Badge>
                )}
                {batch.payload?.action === 'publish' && (
                  <Badge backgroundColor="success100" textColor="success700">
                    🚀 BULK PUBLISH
                  </Badge>
                )}
              </Flex>
              <Typography variant="pi" textColor="neutral600">
                Submitted by <strong>{batch.createdBy?.email || 'admin'}</strong> on {new Date(batch.createdAt).toLocaleString()}
              </Typography>
              {batch.makerNotes && (
                <Box marginTop={2} padding={2} background="neutral150" hasRadius style={{ borderLeft: '3px solid #4945ff' }}>
                  <Typography variant="pi" textColor="neutral700">
                    <strong>Maker Notes:</strong> {batch.makerNotes}
                  </Typography>
                </Box>
              )}
            </Box>

            <Flex gap={2} alignItems="center" wrap="wrap">
              <Button
                variant="tertiary"
                size="S"
                startIcon={<Download />}
                onClick={handleExportCsv}
                loading={isExporting}
              >
                Export Audit CSV
              </Button>
              <Button
                variant="tertiary"
                size="S"
                startIcon={<ArrowClockwise />}
                onClick={fetchBatchDiffs}
                loading={loading}
              >
                Refresh
              </Button>
            </Flex>
          </Flex>
        </Box>

        {/* Body */}
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
                  Generating Itemized Diffs...
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  Comparing proposed values against current database records.
                </Typography>
              </Flex>
            </Box>
          ) : error ? (
            <Box padding={6} style={{ textAlign: 'center' }}>
              <Typography variant="delta" textColor="danger700" fontWeight="bold">
                Failed to load change diffs
              </Typography>
              <Typography variant="pi" textColor="neutral700" display="block" marginTop={1}>
                {error}
              </Typography>
            </Box>
          ) : (
            <>
              {/* Summary KPI Cards */}
              <Flex gap={3} marginBottom={4} wrap="wrap">
                <Box
                  padding={3}
                  background="neutral100"
                  hasRadius
                  style={{ flex: 1, minWidth: 130, border: '1px solid rgba(120, 120, 150, 0.15)' }}
                >
                  <Typography variant="sigma" textColor="neutral600" display="block">
                    TOTAL TARGETS
                  </Typography>
                  <Typography variant="beta" fontWeight="bold" textColor="neutral800">
                    {summary.total}
                  </Typography>
                </Box>

                <Box
                  padding={3}
                  background="warning100"
                  hasRadius
                  style={{ flex: 1, minWidth: 130, border: '1px solid #ffd591' }}
                >
                  <Typography variant="sigma" textColor="warning700" display="block">
                    WILL UPDATE
                  </Typography>
                  <Typography variant="beta" fontWeight="bold" textColor="warning700">
                    {summary.willUpdate}
                  </Typography>
                </Box>

                {(summary.willCreate ?? 0) > 0 && (
                  <Box
                    padding={3}
                    background="success100"
                    hasRadius
                    style={{ flex: 1, minWidth: 130, border: '1px solid #b7eb8f' }}
                  >
                    <Typography variant="sigma" textColor="success700" display="block">
                      WILL CREATE (NEW)
                    </Typography>
                    <Typography variant="beta" fontWeight="bold" textColor="success700">
                      {summary.willCreate}
                    </Typography>
                  </Box>
                )}

                <Box
                  padding={3}
                  background="neutral100"
                  hasRadius
                  style={{ flex: 1, minWidth: 130, border: '1px solid rgba(120, 120, 150, 0.15)' }}
                >
                  <Typography variant="sigma" textColor="neutral600" display="block">
                    UNCHANGED
                  </Typography>
                  <Typography variant="beta" fontWeight="bold" textColor="neutral600">
                    {summary.unchanged}
                  </Typography>
                </Box>

                {summary.skipped > 0 && (
                  <Box
                    padding={3}
                    background="danger100"
                    hasRadius
                    style={{ flex: 1, minWidth: 130, border: '1px solid #ffa39e' }}
                  >
                    <Typography variant="sigma" textColor="danger700" display="block">
                      SKIPPED / ERRORS
                    </Typography>
                    <Typography variant="beta" fontWeight="bold" textColor="danger700">
                      {summary.skipped}
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
                    All Items ({diffs.length})
                  </Button>
                  <Button
                    variant={filterTab === 'changes' ? 'default' : 'tertiary'}
                    size="S"
                    onClick={() => setFilterTab('changes')}
                  >
                    Changes Only ({totalChanges})
                  </Button>
                  <Button
                    variant={filterTab === 'will_update' ? 'default' : 'tertiary'}
                    size="S"
                    onClick={() => setFilterTab('will_update')}
                  >
                    Updates ({summary.willUpdate})
                  </Button>
                  {(summary.willCreate ?? 0) > 0 && (
                    <Button
                      variant={filterTab === 'will_create' ? 'default' : 'tertiary'}
                      size="S"
                      onClick={() => setFilterTab('will_create')}
                    >
                      Creates ({summary.willCreate})
                    </Button>
                  )}
                  <Button
                    variant={filterTab === 'unchanged' ? 'default' : 'tertiary'}
                    size="S"
                    onClick={() => setFilterTab('unchanged')}
                  >
                    Unchanged ({summary.unchanged})
                  </Button>
                  {summary.skipped > 0 && (
                    <Button
                      variant={filterTab === 'will_skip' ? 'default' : 'tertiary'}
                      size="S"
                      onClick={() => setFilterTab('will_skip')}
                    >
                      Skipped ({summary.skipped})
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
                        <Typography variant="sigma" textColor="neutral600">COLLECTION</Typography>
                      </Th>
                      <Th style={{ minWidth: 180 }}>
                        <Typography variant="sigma" textColor="neutral600">RECORD IDENTIFIER</Typography>
                      </Th>
                      <Th style={{ minWidth: 140 }}>
                        <Typography variant="sigma" textColor="neutral600">ATTRIBUTE</Typography>
                      </Th>
                      <Th style={{ minWidth: 180 }}>
                        <Typography variant="sigma" textColor="neutral600">CURRENT VALUE (BEFORE)</Typography>
                      </Th>
                      <Th style={{ minWidth: 180 }}>
                        <Typography variant="sigma" textColor="neutral600">PROPOSED VALUE (AFTER)</Typography>
                      </Th>
                      <Th style={{ width: 130, textAlign: 'right' }}>
                        <Typography variant="sigma" textColor="neutral600">IMPACT</Typography>
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
                        <Tr key={`${diff.uid}-${diff.documentId}-${diff.attribute}-${idx}`}>
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
                            <Typography variant="omega" fontWeight="semiBold">
                              {diff.attribute}
                            </Typography>
                          </Td>
                          <Td>
                            <Typography
                              variant="omega"
                              style={{
                                color: diff.hasChange ? '#9254de' : '#272635',
                                textDecoration: diff.hasChange ? 'line-through' : 'none',
                                wordBreak: 'break-all',
                              }}
                            >
                              {diff.oldDisplay || '(empty)'}
                            </Typography>
                          </Td>
                          <Td>
                            {diff.status === 'will_create' ? (
                              <Typography variant="omega" fontWeight="bold" textColor="success700" style={{ wordBreak: 'break-all' }}>
                                {diff.newDisplay || '(new value)'}
                              </Typography>
                            ) : diff.status === 'will_skip' ? (
                              <Typography variant="pi" textColor="warning700">
                                — Skipped —
                              </Typography>
                            ) : diff.hasChange ? (
                              <Typography variant="omega" fontWeight="bold" textColor="success700" style={{ wordBreak: 'break-all' }}>
                                {diff.newDisplay || '(empty)'}
                              </Typography>
                            ) : (
                              <Typography variant="omega" textColor="neutral600">
                                {diff.newDisplay || '(matching)'}
                              </Typography>
                            )}
                          </Td>
                          <Td style={{ textAlign: 'right' }}>
                            {diff.status === 'will_create' && (
                              <Badge backgroundColor="success100" textColor="success700">
                                + Will Create
                              </Badge>
                            )}
                            {diff.status === 'will_update' && (
                              <Badge backgroundColor="warning100" textColor="warning700">
                                ✎ Will Update
                              </Badge>
                            )}
                            {diff.status === 'unchanged' && (
                              <Badge backgroundColor="neutral150" textColor="neutral600">
                                = Unchanged
                              </Badge>
                            )}
                            {diff.status === 'will_skip' && (
                              <Badge backgroundColor="danger100" textColor="danger700">
                                ⚠ Will Skip
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

          {/* Rejection input popover / drawer */}
          {showRejectInput && (
            <Box marginTop={4} padding={4} background="danger100" hasRadius style={{ border: '1px solid #ffa39e' }}>
              <Typography variant="delta" fontWeight="bold" textColor="danger700" marginBottom={2}>
                Reject Batch
              </Typography>
              <Typography variant="pi" textColor="danger700" marginBottom={2} display="block">
                Please provide a rejection note explaining why this batch was declined. The Maker will see this message.
              </Typography>
              <TextInput
                placeholder="Reason for rejection (e.g., incorrect localized prices in CSV rows 4-8)..."
                value={rejectionReason}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRejectionReason(e.target.value)}
                style={{ marginBottom: 12 }}
              />
              <Flex gap={2} justifyContent="flex-end">
                <Button variant="tertiary" size="S" onClick={() => setShowRejectInput(false)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="S"
                  loading={rejecting}
                  onClick={() => onReject(batch.id, rejectionReason || 'Declined by Checker')}
                >
                  Confirm Rejection
                </Button>
              </Flex>
            </Box>
          )}
        </Box>

        {/* Footer */}
        <Box
          padding={4}
          background="neutral100"
          style={{
            borderTop: '1px solid rgba(120, 120, 150, 0.2)',
            flexShrink: 0,
          }}
        >
          <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
            <Button variant="tertiary" onClick={onClose} disabled={approving || rejecting}>
              Close Preview
            </Button>

            <Flex gap={3}>
              {!showRejectInput && (
                <Button
                  variant="danger-light"
                  onClick={() => setShowRejectInput(true)}
                  disabled={approving || rejecting}
                >
                  Reject Batch
                </Button>
              )}
              <Button
                variant="success"
                startIcon={<Check />}
                onClick={() => onApprove(batch.id)}
                loading={approving}
                disabled={rejecting}
              >
                Approve &amp; Execute Batch
              </Button>
            </Flex>
          </Flex>
        </Box>
      </Box>
    </div>
  );
};

export default CheckerReviewModal;
