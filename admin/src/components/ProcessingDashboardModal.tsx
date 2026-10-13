import React, { useState, useEffect, useMemo } from 'react';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import {
  Box,
  Flex,
  Typography,
  Button,
  Badge,
  Alert,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  TextInput,
  Loader,
} from '@strapi/design-system';
import { Check, Download, ArrowClockwise } from '@strapi/icons';

export interface BatchResultItem {
  uid: string;
  collectionName: string;
  documentId: string;
  label: string;
  attribute: string;
  oldValue: any;
  newValue: any;
  status: 'updated' | 'skipped' | 'error';
  isLive?: boolean;
  message: string;
}

export interface BatchJob {
  id: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  createdBy: { id?: string | number; email?: string; firstname?: string; lastname?: string; username?: string };
  status: 'pending_approval' | 'queued_offpeak' | 'processing' | 'successful' | 'partial_failure' | 'failed';
  executionMode: 'immediate' | 'maker_checker' | 'queue_offpeak';
  scheduledFor?: string;
  attribute: string;
  value: string;
  totalTargets: number;
  processedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  isLive: boolean;
  publishOnApproval: boolean;
  policyMessage?: string;
  makerNotes?: string;
  results: BatchResultItem[];
  error?: string;
}

interface ProcessingDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  batchId?: string;
  initialJob?: Partial<BatchJob> | null;
  isSubmitting?: boolean;
}

function formatVal(v: any): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'object') {
    if (v.display) return v.display;
    if (v.label) return v.label;
    return JSON.stringify(v);
  }
  return String(v);
}

function downloadFile(content: string, filename: string, mimeType: string = 'text/csv;charset=utf-8;') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function ProcessingDashboardModal({
  isOpen,
  onClose,
  batchId,
  initialJob,
  isSubmitting = false,
}: ProcessingDashboardModalProps) {
  const { get } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [job, setJob] = useState<BatchJob | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'updated' | 'skipped' | 'error'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [downloading, setDownloading] = useState<boolean>(false);
  const [copiedBatchId, setCopiedBatchId] = useState<boolean>(false);

  // Sync initialJob if passed directly from submission
  useEffect(() => {
    if (initialJob && initialJob.id) {
      setJob((prev) => ({
        id: initialJob.id!,
        createdAt: initialJob.createdAt || new Date().toISOString(),
        startedAt: initialJob.startedAt,
        completedAt: initialJob.completedAt,
        createdBy: initialJob.createdBy || { email: 'admin@system.local' },
        status: initialJob.status || (isSubmitting ? 'processing' : 'successful'),
        executionMode: initialJob.executionMode || 'immediate',
        scheduledFor: initialJob.scheduledFor,
        attribute: initialJob.attribute || '',
        value: initialJob.value || '',
        totalTargets: initialJob.totalTargets || 0,
        processedCount: initialJob.processedCount || 0,
        updatedCount: initialJob.updatedCount || 0,
        skippedCount: initialJob.skippedCount || 0,
        failedCount: initialJob.failedCount || 0,
        isLive: Boolean(initialJob.isLive),
        publishOnApproval: initialJob.publishOnApproval ?? true,
        policyMessage: initialJob.policyMessage,
        makerNotes: initialJob.makerNotes,
        results: initialJob.results || [],
        error: initialJob.error,
      }));
    }
  }, [initialJob, isSubmitting]);

  // Fetch status if batchId is provided
  const fetchStatus = async () => {
    const targetId = batchId || initialJob?.id;
    if (!targetId) return;

    try {
      setLoading(true);
      const res = await get(`/bulk-updater/batches/${targetId}/status`);
      if (res.data?.success && res.data.batch) {
        setJob(res.data.batch);
      }
    } catch (err: any) {
      // If still in-flight or not saved yet, don't crash
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && (batchId || initialJob?.id)) {
      fetchStatus();
      // Poll every 2 seconds if processing or submitting
      if (isSubmitting || job?.status === 'processing') {
        const interval = setInterval(fetchStatus, 2000);
        return () => clearInterval(interval);
      }
    }
  }, [isOpen, batchId, initialJob?.id, isSubmitting, job?.status]);

  const handleCopyId = () => {
    const idToCopy = job?.id || batchId;
    if (idToCopy) {
      navigator.clipboard.writeText(idToCopy);
      setCopiedBatchId(true);
      setTimeout(() => setCopiedBatchId(false), 2000);
    }
  };

  const handleDownloadReport = async (format: 'csv' | 'json' = 'csv') => {
    const targetId = job?.id || batchId;
    if (!targetId) return;

    try {
      setDownloading(true);
      const res = await get(`/bulk-updater/batches/${targetId}/report?format=${format}`);
      if (res.data?.success) {
        if (format === 'csv' && res.data.csvContent) {
          downloadFile(res.data.csvContent, res.data.filename);
        } else if (format === 'json') {
          const jsonStr = JSON.stringify(res.data.batch || job, null, 2);
          downloadFile(jsonStr, `bulk_update_report_${targetId}.json`, 'application/json');
        }
        toggleNotification({
          type: 'success',
          message: `Execution report downloaded (${format.toUpperCase()})`,
        });
      } else {
        throw new Error(res.data?.error || 'Failed generating report');
      }
    } catch (err: any) {
      // Fallback: Client-side generation from job.results
      if (job && job.results) {
        const csvRows = [
          'Batch ID,Collection Name,Document ID,Record Label,Attribute,Old Value,New Value,Status,Live On Site,Message',
          ...job.results.map((r) =>
            [
              job.id,
              `"${r.collectionName}"`,
              r.documentId,
              `"${r.label.replace(/"/g, '""')}"`,
              `"${r.attribute}"`,
              `"${formatVal(r.oldValue).replace(/"/g, '""')}"`,
              `"${formatVal(r.newValue).replace(/"/g, '""')}"`,
              r.status,
              r.isLive ? 'YES' : 'NO',
              `"${r.message.replace(/"/g, '""')}"`,
            ].join(',')
          ),
        ];
        downloadFile(csvRows.join('\n'), `bulk_update_report_${targetId}.csv`);
        toggleNotification({
          type: 'success',
          message: 'Execution report downloaded successfully',
        });
      } else {
        toggleNotification({
          type: 'danger',
          message: err.message || 'Error downloading execution report',
        });
      }
    } finally {
      setDownloading(false);
    }
  };

  const filteredResults = useMemo(() => {
    if (!job?.results) return [];
    return job.results.filter((item) => {
      if (filterStatus !== 'all' && item.status !== filterStatus) return false;
      if (searchQuery.trim() !== '') {
        const q = searchQuery.toLowerCase();
        const matchesCol = item.collectionName?.toLowerCase().includes(q);
        const matchesLabel = item.label?.toLowerCase().includes(q);
        const matchesId = item.documentId?.toLowerCase().includes(q);
        const matchesMsg = item.message?.toLowerCase().includes(q);
        if (!matchesCol && !matchesLabel && !matchesId && !matchesMsg) return false;
      }
      return true;
    });
  }, [job?.results, filterStatus, searchQuery]);

  if (!isOpen) return null;

  const currentStatus = isSubmitting ? 'processing' : job?.status || 'processing';
  const progressPercent =
    job && job.totalTargets > 0
      ? Math.min(Math.round(((job.updatedCount + job.skippedCount + job.failedCount) / job.totalTargets) * 100), 100)
      : isSubmitting
      ? 50
      : 100;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(20, 20, 30, 0.75)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: 16,
        boxSizing: 'border-box',
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <Box
        background="neutral0"
        hasRadius
        shadow="popupShadow"
        style={{
          maxWidth: 960,
          width: '100%',
          maxHeight: 'calc(100vh - 40px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.35)',
        }}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* Header */}
        <Box
          padding={5}
          background="neutral100"
          style={{ borderBottom: '1px solid #dcdce4', flexShrink: 0 }}
        >
          <Flex justifyContent="space-between" alignItems="center">
            <Box>
              <Flex alignItems="center" gap={3}>
                <Typography variant="delta" fontWeight="bold">
                  Bulk Update Processing Dashboard
                </Typography>
                {currentStatus === 'processing' && (
                  <Badge backgroundColor="primary100" textColor="primary700">
                    🔄 PROCESSING
                  </Badge>
                )}
                {currentStatus === 'successful' && (
                  <Badge backgroundColor="success100" textColor="success700">
                    🟢 CHANGES LIVE ({job?.updatedCount} UPDATED)
                  </Badge>
                )}
                {currentStatus === 'partial_failure' && (
                  <Badge backgroundColor="warning100" textColor="warning700">
                    ⚠️ PARTIAL ({job?.updatedCount} LIVE, {job?.failedCount} FAILED)
                  </Badge>
                )}
                {currentStatus === 'failed' && (
                  <Badge backgroundColor="danger100" textColor="danger700">
                    🔴 FAILED
                  </Badge>
                )}
                {currentStatus === 'pending_approval' && (
                  <Badge backgroundColor="warning100" textColor="warning700">
                    ⏳ PENDING CHECKER APPROVAL
                  </Badge>
                )}
                {currentStatus === 'queued_offpeak' && (
                  <Badge backgroundColor="secondary100" textColor="secondary700">
                    🕒 QUEUED FOR OFF-PEAK
                  </Badge>
                )}
              </Flex>
              <Flex alignItems="center" gap={2} marginTop={1}>
                <Typography variant="pi" textColor="neutral600">
                  Batch ID: <code style={{ fontWeight: 'bold' }}>{job?.id || batchId || 'Generating...'}</code>
                </Typography>
                <button
                  type="button"
                  onClick={handleCopyId}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '0 4px',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: '#4945ff',
                  }}
                >
                  {copiedBatchId ? '✓ Copied' : 'Copy ID'}
                </button>
                {job?.createdAt && (
                  <Typography variant="pi" textColor="neutral500">
                    • Submitted at {new Date(job.createdAt).toLocaleTimeString()}
                  </Typography>
                )}
                {job?.createdBy?.email && (
                  <Typography variant="pi" textColor="neutral500">
                    • Operator: {job.createdBy.email}
                  </Typography>
                )}
              </Flex>
            </Box>
            <Flex gap={2}>
              <Button variant="tertiary" size="S" startIcon={<ArrowClockwise />} onClick={fetchStatus} loading={loading}>
                Refresh
              </Button>
              <Button variant="secondary" size="S" onClick={onClose}>
                Close
              </Button>
            </Flex>
          </Flex>
        </Box>

        {/* Scrollable Body */}
        <Box padding={5} style={{ flex: '1 1 auto', overflowY: 'auto' }}>
          {/* Real-Time Stepper & Processing Bar */}
          <Box marginBottom={5} padding={4} background="neutral100" hasRadius style={{ border: '1px solid #eaeaef' }}>
            <Flex justifyContent="space-between" alignItems="center" marginBottom={2}>
              <Typography variant="sigma" textColor="neutral700">
                PROCESSING PIPELINE &amp; VERIFICATION
              </Typography>
              <Typography variant="pi" fontWeight="bold" textColor={currentStatus === 'successful' ? 'success700' : 'primary700'}>
                {currentStatus === 'processing'
                  ? `In Progress... (${progressPercent}%)`
                  : currentStatus === 'successful'
                  ? '100% Completed (Live on Server)'
                  : currentStatus === 'pending_approval'
                  ? 'Awaiting Checker Decision'
                  : currentStatus === 'queued_offpeak'
                  ? 'Scheduled for Off-Peak'
                  : 'Completed'}
              </Typography>
            </Flex>

            {/* Progress Bar */}
            <div
              style={{
                width: '100%',
                height: 8,
                backgroundColor: '#dcdce4',
                borderRadius: 4,
                overflow: 'hidden',
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${progressPercent}%`,
                  backgroundColor:
                    currentStatus === 'failed'
                      ? '#d02b20'
                      : currentStatus === 'successful'
                      ? '#2f6846'
                      : '#4945ff',
                  transition: 'width 0.4s ease',
                }}
              />
            </div>

            {/* Visual Stepper */}
            <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={2}>
              {/* Step 1 */}
              <Flex alignItems="center" gap={2}>
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    backgroundColor: '#2f6846',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 'bold',
                  }}
                >
                  ✓
                </div>
                <Typography variant="pi" fontWeight="bold">
                  1. Target Batch Queued
                </Typography>
              </Flex>

              {/* Step 2 */}
              <Flex alignItems="center" gap={2}>
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    backgroundColor: currentStatus === 'failed' && !job?.updatedCount ? '#d02b20' : '#2f6846',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 'bold',
                  }}
                >
                  ✓
                </div>
                <Typography variant="pi" fontWeight="bold">
                  2. Schema &amp; Quotas Validated
                </Typography>
              </Flex>

              {/* Step 3 */}
              <Flex alignItems="center" gap={2}>
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    backgroundColor:
                      currentStatus === 'processing'
                        ? '#4945ff'
                        : currentStatus === 'failed' && !job?.updatedCount
                        ? '#dcdce4'
                        : '#2f6846',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 'bold',
                  }}
                >
                  {currentStatus === 'processing' ? '•' : '✓'}
                </div>
                <Typography variant="pi" fontWeight="bold">
                  3. Applied to Database
                </Typography>
              </Flex>

              {/* Step 4 */}
              <Flex alignItems="center" gap={2}>
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    backgroundColor:
                      currentStatus === 'successful'
                        ? '#2f6846'
                        : currentStatus === 'pending_approval'
                        ? '#f5c000'
                        : currentStatus === 'queued_offpeak'
                        ? '#666687'
                        : currentStatus === 'processing'
                        ? '#dcdce4'
                        : '#d02b20',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 'bold',
                  }}
                >
                  {currentStatus === 'successful' ? '✓' : currentStatus === 'pending_approval' ? '⏳' : '•'}
                </div>
                <Typography variant="pi" fontWeight="bold">
                  4. Live Verification &amp; Audit
                </Typography>
              </Flex>
            </Flex>
          </Box>

          {/* Live Status Banner ("Did changes go live?") */}
          <Box marginBottom={5}>
            {currentStatus === 'processing' && (
              <Alert variant="default" title="Bulk Update In Progress">
                <Flex alignItems="center" gap={3}>
                  <Loader small />
                  <Typography variant="omega">
                    The engine is updating records across selected collections. Do not refresh or navigate away.
                  </Typography>
                </Flex>
              </Alert>
            )}

            {currentStatus === 'successful' && (
              <Alert variant="success" title="🟢 CHANGES ARE CURRENTLY LIVE ON SERVER">
                <Typography variant="omega" display="block">
                  All <strong>{job?.updatedCount || 0}</strong> matching records were successfully updated in the database
                  {job?.publishOnApproval ? ' and auto-published' : ''}.
                  Your changes are now live and accessible in Strapi Content Manager and public APIs.
                </Typography>
              </Alert>
            )}

            {currentStatus === 'partial_failure' && (
              <Alert variant="warning" title="⚠️ PARTIAL EXECUTION (SOME RECORDS ENCOUNTERED ERRORS)">
                <Typography variant="omega" display="block">
                  <strong>{job?.updatedCount || 0}</strong> records were updated and are currently live, but{' '}
                  <strong>{job?.failedCount || 0}</strong> records failed. Inspect the itemized table below for exact error details.
                </Typography>
              </Alert>
            )}

            {currentStatus === 'failed' && (
              <Alert variant="danger" title="🔴 EXECUTION FAILED (CHANGES NOT APPLIED)">
                <Typography variant="omega" display="block">
                  The bulk update failed: {job?.error || 'One or more database mutations failed. No records were published.'}
                </Typography>
              </Alert>
            )}

            {currentStatus === 'pending_approval' && (
              <Alert variant="warning" title="⏳ PENDING CHECKER APPROVAL (CHANGES NOT LIVE YET)">
                <Typography variant="omega" display="block">
                  This batch was submitted under the <strong>4-Eyes Maker-Checker Policy</strong>.
                  Changes will <strong>not</strong> go live until a Checker reviews and approves this batch in the{' '}
                  <strong>Audit Trail &amp; Approvals</strong> tab.
                </Typography>
              </Alert>
            )}

            {currentStatus === 'queued_offpeak' && (
              <Alert variant="default" title={`🕒 SCHEDULED FOR OFF-PEAK WINDOW (${job?.scheduledFor || '18:00'})`}>
                <Typography variant="omega" display="block">
                  This batch was scheduled to avoid peak database load during business hours.
                  The scheduled background worker will automatically execute and publish these changes at{' '}
                  <strong>{job?.scheduledFor || 'off-peak'}</strong>.
                </Typography>
              </Alert>
            )}
          </Box>

          {/* Metric Cards Grid */}
          <Box marginBottom={5}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 16,
              }}
            >
              {/* Card 1: Total Targets */}
              <Box padding={4} background="neutral100" hasRadius style={{ border: '1px solid #eaeaef' }}>
                <Typography variant="sigma" textColor="neutral600" display="block">
                  TOTAL TARGETS
                </Typography>
                <Typography variant="alpha" fontWeight="bold" textColor="neutral800" marginTop={1} display="block">
                  {job?.totalTargets || 0}
                </Typography>
                <Typography variant="pi" textColor="neutral500">
                  Targeted entities
                </Typography>
              </Box>

              {/* Card 2: Live / Updated */}
              <Box padding={4} background="success100" hasRadius style={{ border: '1px solid #b7eb8f' }}>
                <Typography variant="sigma" textColor="success700" display="block">
                  LIVE / UPDATED
                </Typography>
                <Typography variant="alpha" fontWeight="bold" textColor="success700" marginTop={1} display="block">
                  {job?.updatedCount || 0}
                </Typography>
                <Typography variant="pi" textColor="success700">
                  {job?.isLive ? '✓ Active on site' : 'Pending live'}
                </Typography>
              </Box>

              {/* Card 3: Skipped */}
              <Box padding={4} background="neutral100" hasRadius style={{ border: '1px solid #eaeaef' }}>
                <Typography variant="sigma" textColor="neutral600" display="block">
                  SKIPPED
                </Typography>
                <Typography variant="alpha" fontWeight="bold" textColor="neutral800" marginTop={1} display="block">
                  {job?.skippedCount || 0}
                </Typography>
                <Typography variant="pi" textColor="neutral500">
                  Attribute not in schema
                </Typography>
              </Box>

              {/* Card 4: Failed */}
              <Box
                padding={4}
                background={(job?.failedCount || 0) > 0 ? 'danger100' : 'neutral100'}
                hasRadius
                style={{ border: (job?.failedCount || 0) > 0 ? '1px solid #ffa39e' : '1px solid #eaeaef' }}
              >
                <Typography variant="sigma" textColor={(job?.failedCount || 0) > 0 ? 'danger700' : 'neutral600'} display="block">
                  FAILED / ERRORS
                </Typography>
                <Typography
                  variant="alpha"
                  fontWeight="bold"
                  textColor={(job?.failedCount || 0) > 0 ? 'danger700' : 'neutral800'}
                  marginTop={1}
                  display="block"
                >
                  {job?.failedCount || 0}
                </Typography>
                <Typography variant="pi" textColor={(job?.failedCount || 0) > 0 ? 'danger700' : 'neutral500'}>
                  {(job?.failedCount || 0) > 0 ? 'Requires attention' : '0 errors'}
                </Typography>
              </Box>
            </div>
          </Box>

          {/* Action Bar with Download Report Button */}
          <Box marginBottom={4} padding={4} background="neutral100" hasRadius style={{ border: '1px solid #eaeaef' }}>
            <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
              <Box>
                <Typography variant="delta" fontWeight="bold" display="block">
                  Execution Report &amp; Verification Audit
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  Download an itemized verification report showing every record's old value, new value, and live deployment status.
                </Typography>
              </Box>
              <Flex gap={2}>
                <Button
                  variant="default"
                  startIcon={<Download />}
                  onClick={() => handleDownloadReport('csv')}
                  loading={downloading}
                >
                  Download Execution Report (.csv)
                </Button>
                <Button
                  variant="secondary"
                  startIcon={<Download />}
                  onClick={() => handleDownloadReport('json')}
                  loading={downloading}
                >
                  JSON Report
                </Button>
              </Flex>
            </Flex>
          </Box>

          {/* Itemized Results Breakdown */}
          {job && job.results && job.results.length > 0 && (
            <Box>
              <Flex justifyContent="space-between" alignItems="center" marginBottom={3} wrap="wrap" gap={2}>
                <Typography variant="delta" fontWeight="bold">
                  Itemized Changes ({filteredResults.length} / {job.results.length})
                </Typography>
                <Flex gap={2}>
                  <Button
                    variant={filterStatus === 'all' ? 'secondary' : 'tertiary'}
                    size="S"
                    onClick={() => setFilterStatus('all')}
                  >
                    All ({job.results.length})
                  </Button>
                  <Button
                    variant={filterStatus === 'updated' ? 'secondary' : 'tertiary'}
                    size="S"
                    onClick={() => setFilterStatus('updated')}
                  >
                    Live / Updated ({job.updatedCount})
                  </Button>
                  <Button
                    variant={filterStatus === 'skipped' ? 'secondary' : 'tertiary'}
                    size="S"
                    onClick={() => setFilterStatus('skipped')}
                  >
                    Skipped ({job.skippedCount})
                  </Button>
                  {job.failedCount > 0 && (
                    <Button
                      variant={filterStatus === 'error' ? 'secondary' : 'tertiary'}
                      size="S"
                      onClick={() => setFilterStatus('error')}
                    >
                      Failed ({job.failedCount})
                    </Button>
                  )}
                </Flex>
              </Flex>

              <Box marginBottom={3}>
                <TextInput
                  placeholder="Filter by collection name, title, or document ID..."
                  value={searchQuery}
                  onChange={(e: any) => setSearchQuery(e.target.value)}
                  size="S"
                />
              </Box>

              <Table colCount={6} rowCount={filteredResults.length + 1}>
                <Thead>
                  <Tr>
                    <Th style={{ width: 140 }}>
                      <Typography variant="sigma">Status</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">Collection</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">Record / Document ID</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">Previous Value</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">New Live Value</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">Details</Typography>
                    </Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {filteredResults.map((item, idx) => (
                    <Tr key={idx}>
                      <Td>
                        {item.status === 'updated' ? (
                          <Badge backgroundColor="success100" textColor="success700">
                            🟢 Live / Updated
                          </Badge>
                        ) : item.status === 'error' ? (
                          <Badge backgroundColor="danger100" textColor="danger700">
                            ❌ Failed
                          </Badge>
                        ) : (
                          <Badge backgroundColor="neutral150" textColor="neutral700">
                            ⚠️ Skipped
                          </Badge>
                        )}
                      </Td>
                      <Td>
                        <Typography variant="omega" fontWeight="bold">
                          {item.collectionName}
                        </Typography>
                      </Td>
                      <Td>
                        <Box>
                          <Typography variant="omega" display="block">
                            {item.label}
                          </Typography>
                          <Typography variant="pi" textColor="neutral500">
                            <code>{item.documentId}</code>
                          </Typography>
                        </Box>
                      </Td>
                      <Td>
                        <Typography variant="omega" textColor="neutral600">
                          {formatVal(item.oldValue)}
                        </Typography>
                      </Td>
                      <Td>
                        <Typography variant="omega" fontWeight="bold" textColor="primary700">
                          {formatVal(item.newValue)}
                        </Typography>
                      </Td>
                      <Td>
                        <Typography variant="pi" textColor={item.status === 'error' ? 'danger700' : 'neutral600'}>
                          {item.message}
                        </Typography>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          )}
        </Box>

        {/* Footer */}
        <Box padding={4} background="neutral100" style={{ borderTop: '1px solid #dcdce4', flexShrink: 0 }}>
          <Flex justifyContent="space-between" alignItems="center">
            <Typography variant="pi" textColor="neutral600">
              {job?.completedAt
                ? `Finished at ${new Date(job.completedAt).toLocaleTimeString()}`
                : isSubmitting
                ? 'Processing live batch...'
                : 'Status active'}
            </Typography>
            <Flex gap={3}>
              <Button
                variant="default"
                size="M"
                startIcon={<Download />}
                onClick={() => handleDownloadReport('csv')}
                loading={downloading}
              >
                Download Report (.csv)
              </Button>
              <Button variant="secondary" size="M" onClick={onClose}>
                Done
              </Button>
            </Flex>
          </Flex>
        </Box>
      </Box>
    </div>
  );
}
