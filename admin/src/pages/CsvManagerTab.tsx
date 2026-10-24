import React, { useState, useEffect } from 'react';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import {
  Box,
  Flex,
  Typography,
  Button,
  SingleSelect,
  SingleSelectOption,
  Badge,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Alert,
  Checkbox,
  TextInput,
} from '@strapi/design-system';
import { Download, Upload, ArrowClockwise, Check, ChevronLeft, ChevronRight, Eye } from '@strapi/icons';
import { parseCsv, extractDocId } from '../utils/csvParser';
import { isAbortError } from '../utils/isAbortError';

interface CollectionModel {
  uid: string;
  displayName: string;
  singularName: string;
  pluralName: string;
  attributes: string[];
  totalEntries?: number;
}

export default function CsvManagerTab() {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [collections, setCollections] = useState<CollectionModel[]>([]);
  const [loadingCollections, setLoadingCollections] = useState<boolean>(true);
  const [selectedUid, setSelectedUid] = useState<string>('');

  // Export filters (0 = Unlimited / All records)
  const [exportLimit, setExportLimit] = useState<number>(0);
  const [exportOnlyViolations, setExportOnlyViolations] = useState<boolean>(false);
  const [rules, setRules] = useState<any[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string>('');

  // Import states
  const [importMode, setImportMode] = useState<'auto' | 'update' | 'create_or_override'>('auto');
  const [publishOnImport, setPublishOnImport] = useState<boolean>(true);
  const [csvRawText, setCsvRawText] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [allParsedRecords, setAllParsedRecords] = useState<Array<Record<string, string>>>([]);
  const [previewPage, setPreviewPage] = useState<number>(1);
  const [previewPageSize, setPreviewPageSize] = useState<number>(10);
  const [importing, setImporting] = useState<boolean>(false);
  const [importProgress, setImportProgress] = useState<{
    currentChunk: number;
    totalChunks: number;
    percent: number;
    processedRows: number;
    totalRows: number;
    liveCreated: number;
    liveUpdated: number;
    liveSkipped: number;
    liveErrors: number;
  } | null>(null);
  const [importResult, setImportResult] = useState<any>(null);

  // Enterprise Guardrail State (Execution Windows, Business Hours, Maker-Checker 4-Eyes, Pre-Flight Dry Run)
  const [executionWindow, setExecutionWindow] = useState<{
    enabled: boolean;
    timeZone: string;
    isBusinessHours: boolean;
    policyMessage: string;
    offPeakStartTime: string;
    currentServerTime: string;
  } | null>(null);

  const [preflightLoading, setPreflightLoading] = useState<boolean>(false);
  const [preflightReport, setPreflightReport] = useState<{
    totalRows: number;
    validRows: number;
    estimatedUpdates: number;
    estimatedCreates: number;
    lifecycleStats?: {
      isDraftAndPublish: boolean;
      totalChecked: number;
      published: number;
      modified: number;
      draft: number;
      unreviewedCount: number;
    };
    hasErrors: boolean;
    hasWarnings: boolean;
    errors: Array<{ row: number; documentId?: string; error: string }>;
    warnings: Array<{ row: number; documentId?: string; warning: string }>;
    totalErrorCount: number;
    totalWarningCount: number;
  } | null>(null);

  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [makerNotesInput, setMakerNotesInput] = useState<string>('');
  const [submittingBatch, setSubmittingBatch] = useState<boolean>(false);
  const [publishStrategy, setPublishStrategy] = useState<'safe' | 'all'>('safe');
  const [unreviewedConsent, setUnreviewedConsent] = useState<boolean>(false);

  useEffect(() => {
    fetchInitialData();
  }, []);

  const fetchInitialData = async () => {
    try {
      setLoadingCollections(true);
      const [modelsRes, rulesRes] = await Promise.all([
        get('/bulk-updater/models'),
        get('/bulk-updater/validation-rules'),
      ]);

      if (modelsRes.data?.executionWindow) {
        setExecutionWindow(modelsRes.data.executionWindow);
      }

      if (modelsRes.data?.collections) {
        setCollections(modelsRes.data.collections);
        if (modelsRes.data.collections.length > 0) {
          setSelectedUid(modelsRes.data.collections[0].uid);
        }
      }

      if (rulesRes.data?.rules) {
        setRules(rulesRes.data.rules);
        if (rulesRes.data.rules.length > 0) {
          setSelectedRuleId(rulesRes.data.rules[0].id);
        }
      }
    } catch (err: any) {
      if (isAbortError(err)) return;
      toggleNotification({
        type: 'danger',
        message: err.message || 'Failed loading collections for CSV Manager',
      });
    } finally {
      setLoadingCollections(false);
    }
  };

  const handleDownloadTemplate = async () => {
    if (!selectedUid) return;
    try {
      const res = await get(`/bulk-updater/csv/template/${selectedUid}`);
      const csvStr = res.data?.csvContent || (typeof res.data === 'string' ? res.data : '');
      const filename = res.data?.filename || `${selectedUid.split('.').pop()}_template.csv`;
      downloadCsvFile(csvStr, filename);
      toggleNotification({
        type: 'success',
        message: 'CSV Template downloaded successfully',
      });
    } catch (err: any) {
      if (isAbortError(err)) return;
      toggleNotification({
        type: 'danger',
        message: err.message || 'Failed downloading CSV template',
      });
    }
  };

  const handleExportCollection = async () => {
    if (!selectedUid) return;
    try {
      const res = await get(`/bulk-updater/csv/export/${selectedUid}?limit=${exportLimit}`);
      const csvStr = res.data?.csvContent || (typeof res.data === 'string' ? res.data : '');
      const filename = res.data?.filename || `${selectedUid.split('.').pop()}_export.csv`;
      downloadCsvFile(csvStr, filename);
      toggleNotification({
        type: 'success',
        message: `Collection exported successfully (${res.data?.count ?? 0} records)`,
      });
    } catch (err: any) {
      if (isAbortError(err)) return;
      toggleNotification({
        type: 'danger',
        message: err.message || 'Failed exporting collection to CSV',
      });
    }
  };

  const handleExportViolations = async () => {
    if (!selectedRuleId) return;
    try {
      const res = await get(`/bulk-updater/csv/export-violations/${selectedRuleId}`);
      const csvStr = res.data?.csvContent || (typeof res.data === 'string' ? res.data : '');
      const filename = res.data?.filename || `violations_${selectedRuleId}.csv`;
      downloadCsvFile(csvStr, filename);
      toggleNotification({
        type: 'success',
        message: 'Rule violations exported to CSV successfully',
      });
    } catch (err: any) {
      if (isAbortError(err)) return;
      toggleNotification({
        type: 'danger',
        message: err.message || 'Failed exporting violations to CSV',
      });
    }
  };

  const downloadCsvFile = (content: string, fallbackName: string) => {
    if (!content) {
      toggleNotification({
        type: 'warning',
        message: 'No CSV content to download',
      });
      return;
    }
    const safeContent = content.startsWith('\uFEFF') ? content : '\uFEFF' + content;
    const blob = new Blob([safeContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', fallbackName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // RFC-4180 client-side file upload & parser
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setImportResult(null);
    setImportProgress(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setCsvRawText(text);

      try {
        const records = parseCsv(text);
        setAllParsedRecords(records);
        setPreviewPage(1);
      } catch (err) {
        setAllParsedRecords([]);
      }
    };
    reader.readAsText(file);
  };

  // Chunked batch import engine (batches of 100 rows prevent HTTP 413 "Request entity too large")
  const handleExecuteImport = async () => {
    if (!selectedUid || allParsedRecords.length === 0) return;

    const totalRows = allParsedRecords.length;
    const CHUNK_SIZE = 100;
    const totalChunks = Math.ceil(totalRows / CHUNK_SIZE);
    const batchId = `csv_batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    try {
      setImporting(true);
      setImportResult(null);

      let liveCreated = 0;
      let liveUpdated = 0;
      let liveSkipped = 0;
      let liveErrors = 0;
      let finalResultData: any = null;

      setImportProgress({
        currentChunk: 0,
        totalChunks,
        percent: 0,
        processedRows: 0,
        totalRows,
        liveCreated: 0,
        liveUpdated: 0,
        liveSkipped: 0,
        liveErrors: 0,
      });

      for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
        const startIdx = chunkIdx * CHUNK_SIZE;
        const endIdx = Math.min(startIdx + CHUNK_SIZE, totalRows);
        const chunkRows = allParsedRecords.slice(startIdx, endIdx);
        const isFirst = chunkIdx === 0;
        const isLast = chunkIdx === totalChunks - 1;
        const startRowNumber = startIdx + 2;

        const res = await post('/bulk-updater/csv/import-chunk', {
          uid: selectedUid,
          rows: chunkRows,
          batchId,
          isFirstChunk: isFirst,
          isLastChunk: isLast,
          startRowNumber,
          mode: importMode,
          publish: publishOnImport,
          publishStrategy,
          unreviewedConsent,
        });

        if (!res.data || !res.data.success) {
          throw new Error(res.data?.error || `Chunk ${chunkIdx + 1} failed to process`);
        }

        const chunkStats = res.data.chunkStats;
        if (chunkStats) {
          liveCreated += chunkStats.created || 0;
          liveUpdated += chunkStats.updated || 0;
          liveSkipped += chunkStats.skipped || 0;
          liveErrors += chunkStats.errors?.length || 0;
        }

        const currentProgressPercent = Math.round(((chunkIdx + 1) / totalChunks) * 100);

        setImportProgress({
          currentChunk: chunkIdx + 1,
          totalChunks,
          percent: currentProgressPercent,
          processedRows: endIdx,
          totalRows,
          liveCreated,
          liveUpdated,
          liveSkipped,
          liveErrors,
        });

        if (isLast) {
          finalResultData = res.data;
        }
      }

      if (finalResultData && finalResultData.stats) {
        setImportResult(finalResultData);
        const stats = finalResultData.stats;
        let notifMsg = `CSV Import complete: ${stats.created} created, ${stats.updated} updated across ${stats.total} records.`;
        if (stats.newWithoutDocId && stats.newWithoutDocId > 0) {
          notifMsg += ` (${stats.newWithoutDocId} new entries created due to omitted documentId)`;
        }
        toggleNotification({
          type: 'success',
          message: notifMsg,
        });
      }
    } catch (err: any) {
      if (isAbortError(err)) return;
      toggleNotification({
        type: 'danger',
        message: err.message || 'Error processing CSV import batch',
      });
    } finally {
      setImporting(false);
    }
  };

  // Pre-Flight Dry-Run: Non-destructive validation check before import execution
  const handleRunPreflight = async () => {
    if (!selectedUid || allParsedRecords.length === 0) return;
    try {
      setPreflightLoading(true);
      const res = await post('/bulk-updater/csv/validate-preflight', {
        uid: selectedUid,
        rows: allParsedRecords,
        mode: importMode,
      });
      if (res.data && res.data.success) {
        setPreflightReport(res.data);
        if (res.data.hasErrors) {
          toggleNotification({
            type: 'warning',
            message: `Pre-flight validation: ${res.data.totalErrorCount} error(s) and ${res.data.totalWarningCount} warning(s) detected.`,
          });
        } else if (res.data.hasWarnings) {
          toggleNotification({
            type: 'warning',
            message: `Pre-flight validation passed with ${res.data.totalWarningCount} warning(s).`,
          });
        } else {
          toggleNotification({
            type: 'success',
            message: `Pre-flight validation passed! All ${res.data.validRows} rows are ready for import.`,
          });
        }
      }
    } catch (err: any) {
      if (isAbortError(err)) return;
      toggleNotification({
        type: 'danger',
        message: err.message || 'Failed running pre-flight validation',
      });
    } finally {
      setPreflightLoading(false);
    }
  };

  // Submit CSV Batch with Chosen Execution Mode (Maker-Checker 4-Eyes, Off-Peak Scheduling, Immediate)
  const submitBatchWithMode = async (
    executionMode: 'immediate' | 'queue_offpeak' | 'maker_checker',
    forceImmediate = false
  ) => {
    if (!selectedUid || allParsedRecords.length === 0) return;

    if (executionMode === 'immediate') {
      setShowConfirmModal(false);
      await handleExecuteImport();
      return;
    }

    try {
      setSubmittingBatch(true);
      const res = await post('/bulk-updater/csv/submit-batch', {
        uid: selectedUid,
        rows: allParsedRecords,
        executionMode,
        makerNotes: makerNotesInput,
        forceImmediate,
        mode: importMode,
        publish: publishOnImport,
        publishStrategy,
        unreviewedConsent,
        unreviewedCount: preflightReport?.lifecycleStats?.unreviewedCount || 0,
      });

      setShowConfirmModal(false);

      if (res.data && res.data.pending) {
        setMakerNotesInput('');
        toggleNotification({
          type: 'success',
          message: res.data.message || 'CSV batch submitted for Checker authorization.',
        });
      } else if (res.data && res.data.executeNow) {
        await handleExecuteImport();
      }
    } catch (err: any) {
      if (isAbortError(err)) return;
      toggleNotification({
        type: 'danger',
        message: err.message || 'Failed submitting CSV batch',
      });
    } finally {
      setSubmittingBatch(false);
    }
  };

  const selectedCol = collections.find((c) => c.uid === selectedUid);

  return (
    <Box padding={6} background="neutral0" hasRadius shadow="filterShadow">
      <Flex direction="column" alignItems="stretch" gap={6}>
        {/* Header */}
        <Flex justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="beta" tag="h2" fontWeight="bold">
              CSV Export &amp; Import Center
            </Typography>
            <Typography variant="pi" textColor="neutral600">
              Export all records (including 10,000+ datasets), filtered subsets, or rule violations into CSV. Correct or add records in spreadsheets and re-upload with high-performance chunked batch processing.
            </Typography>
          </Box>
          <Button variant="secondary" startIcon={<ArrowClockwise />} onClick={fetchInitialData}>
            Refresh
          </Button>
        </Flex>

        {/* Target Collection Selector */}
        <Box padding={4} background="neutral100" hasRadius>
          <Flex gap={4} alignItems="flex-end">
            <Box style={{ flex: 1 }}>
              <Typography variant="pi" fontWeight="bold" textColor="neutral800" marginBottom={2}>
                Target Collection Type
              </Typography>
              <SingleSelect
                value={selectedUid}
                onChange={(val: string) => {
                  setSelectedUid(val);
                  setImportResult(null);
                  setImportProgress(null);
                }}
                disabled={loadingCollections}
                placeholder="Select a collection..."
              >
                {collections.map((col) => (
                  <SingleSelectOption key={col.uid} value={col.uid}>
                    {col.displayName} ({col.totalEntries ?? 0} records)
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Box>

            <Button
              variant="tertiary"
              startIcon={<Download />}
              onClick={handleDownloadTemplate}
              disabled={!selectedUid}
            >
              Download Sample CSV Template
            </Button>
          </Flex>
        </Box>

        {/* Section 1: Export Hub */}
        <Box padding={5} background="neutral100" hasRadius>
          <Typography variant="delta" tag="h3" fontWeight="bold" marginBottom={2}>
            1. Export Data to CSV
          </Typography>
          <Typography variant="pi" textColor="neutral600" marginBottom={4}>
            Extract entire collections without artificial limits (streams 10,000+ records in paged chunks) or pinpoint records violating validation quotas.
          </Typography>

          <Flex gap={4} wrap="wrap" alignItems="center" marginTop={3}>
            {/* Export Limit Selector */}
            <Box style={{ width: 220 }}>
              <SingleSelect
                value={String(exportLimit)}
                onChange={(val: string) => setExportLimit(Number(val))}
                placeholder="Export Limit"
              >
                <SingleSelectOption value="0">All Records (No Limit)</SingleSelectOption>
                <SingleSelectOption value="10000">Up to 10,000 Records</SingleSelectOption>
                <SingleSelectOption value="5000">Up to 5,000 Records</SingleSelectOption>
                <SingleSelectOption value="1000">Up to 1,000 Records</SingleSelectOption>
              </SingleSelect>
            </Box>

            {/* Standard Collection Export */}
            <Button
              variant="default"
              startIcon={<Download />}
              onClick={handleExportCollection}
              disabled={!selectedUid}
            >
              Export {exportLimit === 0 ? 'All' : `${exportLimit}`} {selectedCol?.displayName || 'Collection'} Records (.csv)
            </Button>

            {/* Violations Export */}
            {rules.length > 0 && (
              <Flex gap={2} alignItems="center" style={{ marginLeft: 'auto' }}>
                <SingleSelect
                  value={selectedRuleId}
                  onChange={(val: string) => setSelectedRuleId(val)}
                  placeholder="Select Quota Rule..."
                >
                  {rules.map((r) => (
                    <SingleSelectOption key={r.id} value={r.id}>
                      Rule: {r.name}
                    </SingleSelectOption>
                  ))}
                </SingleSelect>

                <Button
                  variant="danger-light"
                  startIcon={<Download />}
                  onClick={handleExportViolations}
                  disabled={!selectedRuleId}
                >
                  Export Violators CSV
                </Button>
              </Flex>
            )}
          </Flex>
        </Box>

        {/* Section 2: Import & Override Hub */}
        <Box padding={5} background="neutral100" hasRadius>
          <Typography variant="delta" tag="h3" fontWeight="bold" marginBottom={2}>
            2. Import &amp; Batch Override CSV
          </Typography>
          <Typography variant="pi" textColor="neutral600" marginBottom={4}>
            Upload an updated CSV file (supports 10,000+ records via chunked streaming) to bulk update existing records or insert new records.
          </Typography>

          {/* Configuration Modes */}
          <Flex justifyContent="space-between" alignItems="center" marginBottom={4} wrap="wrap" gap={4}>
            <Box>
              <Typography variant="pi" fontWeight="bold" textColor="neutral800" marginBottom={1} display="block">
                Operation Mode
              </Typography>
              <Flex gap={2} alignItems="center" wrap="wrap">
                <Badge backgroundColor="primary100" textColor="primary700">
                  ⚡ Smart Auto-Detect
                </Badge>
                <Typography variant="pi" textColor="neutral600">
                  Automatically updates matching records by <code>documentId</code> and creates new entries when ID is omitted.
                </Typography>
              </Flex>
            </Box>

            <Box>
              <Typography variant="pi" fontWeight="bold" textColor="neutral800" marginBottom={1} display="block">
                Publish Options
              </Typography>
              <Checkbox
                checked={publishOnImport}
                onValueChange={(val: boolean) => setPublishOnImport(val)}
              >
                Auto-publish on import
              </Checkbox>
            </Box>
          </Flex>

          {/* File Picker */}
          <Box
            padding={6}
            background="neutral0"
            hasRadius
            style={{
              border: '2px dashed #dcdce4',
              textAlign: 'center',
              cursor: 'pointer',
            }}
          >
            <input
              type="file"
              accept=".csv"
              id="csv-file-input"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
            <label htmlFor="csv-file-input" style={{ cursor: 'pointer', display: 'block' }}>
              <Upload style={{ width: 32, height: 32, margin: '0 auto 8px', color: '#4945ff' }} />
              <Typography variant="delta" fontWeight="bold" display="block">
                {fileName ? `Selected: ${fileName}` : 'Click here or drag a .csv file to upload'}
              </Typography>
              <Typography variant="pi" textColor="neutral500">
                UTF-8 encoded CSV matching collection schema headers
              </Typography>
            </label>
          </Box>

          {/* Parsed Preview Table with Full-Dataset Inspection & Pagination */}
          {allParsedRecords.length > 0 && (() => {
            const totalRows = allParsedRecords.length;
            const missingDocIdCount = allParsedRecords.filter((row) => !extractDocId(row)).length;
            const updateCount = totalRows - missingDocIdCount;
            const headers = Object.keys(allParsedRecords[0]);

            const totalPages = Math.ceil(totalRows / previewPageSize) || 1;
            const safePage = Math.min(Math.max(1, previewPage), totalPages);
            const startIndex = (safePage - 1) * previewPageSize;
            const endIndex = Math.min(startIndex + previewPageSize, totalRows);
            const displayedRows = allParsedRecords.slice(startIndex, endIndex);

            return (
              <Box marginTop={4} background="neutral0" padding={4} hasRadius>
                <Flex justifyContent="space-between" alignItems="center" marginBottom={3} wrap="wrap" gap={2}>
                  <Box>
                    <Typography variant="sigma" textColor="neutral700">
                      FILE PREVIEW — {totalRows.toLocaleString()} RECORDS DETECTED IN CSV
                    </Typography>
                    <Typography variant="pi" textColor="neutral500" display="block">
                      {totalRows.toLocaleString()} total row{totalRows > 1 ? 's' : ''} •{' '}
                      {updateCount > 0 ? `${updateCount.toLocaleString()} updates` : ''}
                      {updateCount > 0 && missingDocIdCount > 0 ? ', ' : ''}
                      {missingDocIdCount > 0
                        ? `${missingDocIdCount.toLocaleString()} new entries (missing documentId)`
                        : ''}
                    </Typography>
                  </Box>
                  <Flex gap={2}>
                    <Badge backgroundColor="primary100" textColor="primary700">
                      🔄 {updateCount.toLocaleString()} Updates
                    </Badge>
                    {missingDocIdCount > 0 && (
                      <Badge backgroundColor="warning100" textColor="warning700">
                        ➕ {missingDocIdCount.toLocaleString()} New (No ID)
                      </Badge>
                    )}
                  </Flex>
                </Flex>

                {/* Pre-Flight Inspection Card */}
                {preflightReport && (
                  <Box
                    marginBottom={3}
                    padding={4}
                    background={preflightReport.hasErrors ? 'danger100' : preflightReport.hasWarnings ? 'warning100' : 'success100'}
                    hasRadius
                    style={{ border: `1px solid ${preflightReport.hasErrors ? '#d9534f' : preflightReport.hasWarnings ? '#f0ad4e' : '#5cb85c'}` }}
                  >
                    <Flex direction="column" gap={2}>
                      <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={2}>
                        <Typography fontWeight="bold" textColor={preflightReport.hasErrors ? 'danger700' : preflightReport.hasWarnings ? 'warning700' : 'success700'}>
                          {preflightReport.hasErrors
                            ? `⚠️ Pre-Flight Check: ${preflightReport.totalErrorCount} error(s) detected`
                            : preflightReport.hasWarnings
                            ? `⚡ Pre-Flight Check: ${preflightReport.validRows} valid rows with ${preflightReport.totalWarningCount} warning(s)`
                            : `✅ Pre-Flight Check Passed: All ${preflightReport.validRows} rows are ready for import`}
                        </Typography>
                        <Flex gap={2}>
                          <Badge backgroundColor="success100" textColor="success700">
                            ✓ {preflightReport.validRows} Valid Rows
                          </Badge>
                          <Badge backgroundColor="primary100" textColor="primary700">
                            🔄 {preflightReport.estimatedUpdates} Updates
                          </Badge>
                          <Badge backgroundColor="warning100" textColor="warning700">
                            ➕ {preflightReport.estimatedCreates} New
                          </Badge>
                        </Flex>
                      </Flex>

                      {preflightReport.hasErrors && (
                        <Box marginTop={2} background="neutral0" padding={3} hasRadius style={{ maxHeight: 160, overflowY: 'auto' }}>
                          <Typography variant="pi" fontWeight="bold" textColor="danger700" display="block" marginBottom={1}>
                            Validation Errors ({preflightReport.totalErrorCount}):
                          </Typography>
                          {preflightReport.errors.map((e: any, idx: number) => (
                            <Typography key={idx} variant="pi" textColor="danger700" display="block">
                              • Row {e.row}: {e.error}
                            </Typography>
                          ))}
                        </Box>
                      )}

                      {preflightReport.hasWarnings && (
                        <Box marginTop={2} background="neutral0" padding={3} hasRadius style={{ maxHeight: 140, overflowY: 'auto' }}>
                          <Typography variant="pi" fontWeight="bold" textColor="warning700" display="block" marginBottom={1}>
                            Warnings ({preflightReport.totalWarningCount}):
                          </Typography>
                          {preflightReport.warnings.map((w: any, idx: number) => (
                            <Typography key={idx} variant="pi" textColor="warning700" display="block">
                              • Row {w.row}: {w.warning}
                            </Typography>
                          ))}
                        </Box>
                      )}
                    </Flex>
                  </Box>
                )}

                {missingDocIdCount > 0 && (
                  <Box marginBottom={3}>
                    <Alert variant="default" title="Smart Auto-Detect Active">
                      <Typography variant="omega">
                        {missingDocIdCount.toLocaleString()} row{missingDocIdCount > 1 ? 's have' : ' has'} no <code>documentId</code>.{' '}
                        Because no documentId is provided, the engine will automatically treat them as new entries and generate new database IDs for them.
                      </Typography>
                    </Alert>
                  </Box>
                )}

                {/* Table */}
                <Box style={{ overflowX: 'auto', maxWidth: '100%', border: '1px solid #e0e0e0', borderRadius: 4 }}>
                  <Table colCount={headers.length + 1} rowCount={displayedRows.length + 1}>
                    <Thead>
                      <Tr>
                        <Th style={{ width: 150, minWidth: 150 }}>
                          <Typography variant="sigma">Detected Action</Typography>
                        </Th>
                        {headers.map((h) => (
                          <Th key={h} style={{ minWidth: 160 }}>
                            <Typography variant="sigma">{h}</Typography>
                          </Th>
                        ))}
                      </Tr>
                    </Thead>
                    <Tbody>
                      {displayedRows.map((row, rIdx) => {
                        const hasDocId = !!extractDocId(row);
                        const actualRowIndex = startIndex + rIdx + 1;
                        return (
                          <Tr key={rIdx}>
                            <Td>
                              <Flex direction="column" gap={1}>
                                {hasDocId ? (
                                  <Badge backgroundColor="primary100" textColor="primary700">
                                    🔄 Update
                                  </Badge>
                                ) : (
                                  <Badge backgroundColor="warning100" textColor="warning700">
                                    ➕ New Entry
                                  </Badge>
                                )}
                                <Typography variant="pi" textColor="neutral500">
                                  Row #{actualRowIndex}
                                </Typography>
                              </Flex>
                            </Td>
                            {headers.map((h) => (
                              <Td key={h} style={{ verticalAlign: 'top', maxWidth: 300 }}>
                                {(h === 'documentId' || h === 'id') && !row[h]?.trim() ? (
                                  <Typography variant="pi" textColor="warning700" fontWeight="bold">
                                    (Auto-generate ID)
                                  </Typography>
                                ) : (
                                  <Typography
                                    variant="omega"
                                    style={{
                                      display: '-webkit-box',
                                      WebkitLineClamp: 3,
                                      WebkitBoxOrient: 'vertical',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-word',
                                      maxHeight: 65,
                                    }}
                                    title={row[h] || ''}
                                  >
                                    {row[h] || '-'}
                                  </Typography>
                                )}
                              </Td>
                            ))}
                          </Tr>
                        );
                      })}
                    </Tbody>
                  </Table>
                </Box>

                {/* Pagination Controls */}
                <Flex justifyContent="space-between" alignItems="center" marginTop={3} wrap="wrap" gap={3}>
                  <Flex gap={2} alignItems="center">
                    <Typography variant="pi" textColor="neutral600">
                      Rows per page:
                    </Typography>
                    <Box style={{ width: 80 }}>
                      <SingleSelect
                        value={String(previewPageSize)}
                        onChange={(val: string) => {
                          setPreviewPageSize(Number(val));
                          setPreviewPage(1);
                        }}
                      >
                        <SingleSelectOption value="10">10</SingleSelectOption>
                        <SingleSelectOption value="25">25</SingleSelectOption>
                        <SingleSelectOption value="50">50</SingleSelectOption>
                        <SingleSelectOption value="100">100</SingleSelectOption>
                      </SingleSelect>
                    </Box>
                    <Typography variant="pi" textColor="neutral600">
                      Showing {startIndex + 1}–{endIndex} of {totalRows.toLocaleString()} rows
                    </Typography>
                  </Flex>

                  <Flex gap={2} alignItems="center">
                    <Button
                      variant="tertiary"
                      size="S"
                      startIcon={<ChevronLeft />}
                      disabled={safePage <= 1 || importing}
                      onClick={() => setPreviewPage((p) => Math.max(1, p - 1))}
                    >
                      Prev
                    </Button>
                    <Typography variant="pi" fontWeight="bold" textColor="neutral700">
                      Page {safePage} of {totalPages}
                    </Typography>
                    <Button
                      variant="tertiary"
                      size="S"
                      endIcon={<ChevronRight />}
                      disabled={safePage >= totalPages || importing}
                      onClick={() => setPreviewPage((p) => Math.min(totalPages, p + 1))}
                    >
                      Next
                    </Button>
                  </Flex>
                </Flex>

                {/* Pre-Flight and Import Action CTAs */}
                <Flex justifyContent="space-between" alignItems="center" marginTop={4} wrap="wrap" gap={3}>
                  <Button
                    variant="secondary"
                    size="L"
                    startIcon={<Eye />}
                    onClick={handleRunPreflight}
                    loading={preflightLoading}
                    disabled={importing}
                  >
                    Run Pre-Flight Dry Run
                  </Button>

                  <Button
                    variant="default"
                    size="L"
                    startIcon={<Check />}
                    onClick={() => {
                      setPublishStrategy('safe');
                      setUnreviewedConsent(false);
                      setShowConfirmModal(true);
                    }}
                    loading={importing || submittingBatch}
                  >
                    Review &amp; Import ({totalRows.toLocaleString()} Records)...
                  </Button>
                </Flex>
              </Box>
            );
          })()}

          {/* Real-time Chunked Import Progress Card */}
          {importProgress && (
            <Box marginTop={4} padding={4} background="neutral0" hasRadius style={{ border: '1px solid #4945ff' }}>
              <Flex justifyContent="space-between" alignItems="center" marginBottom={2}>
                <Typography variant="delta" fontWeight="bold" textColor="primary700">
                  {importing ? `Processing Batch Chunk ${importProgress.currentChunk} of ${importProgress.totalChunks} (${importProgress.percent}%)` : 'Batch Import Complete'}
                </Typography>
                <Typography variant="pi" fontWeight="bold" textColor="neutral700">
                  {importProgress.processedRows.toLocaleString()} / {importProgress.totalRows.toLocaleString()} rows processed
                </Typography>
              </Flex>

              {/* Visual Progress Bar */}
              <Box style={{ width: '100%', height: 10, background: '#e0e0e0', borderRadius: 5, overflow: 'hidden', marginBottom: 12 }}>
                <Box
                  style={{
                    width: `${importProgress.percent}%`,
                    height: '100%',
                    background: importProgress.percent === 100 ? '#2f6846' : '#4945ff',
                    transition: 'width 0.2s ease-in-out',
                  }}
                />
              </Box>

              <Flex gap={3} wrap="wrap" alignItems="center">
                <Badge backgroundColor="success100" textColor="success700">
                  Created: {importProgress.liveCreated.toLocaleString()}
                </Badge>
                <Badge backgroundColor="primary100" textColor="primary700">
                  Updated: {importProgress.liveUpdated.toLocaleString()}
                </Badge>
                <Badge backgroundColor="neutral150" textColor="neutral700">
                  Skipped: {importProgress.liveSkipped.toLocaleString()}
                </Badge>
                {importProgress.liveErrors > 0 && (
                  <Badge backgroundColor="danger100" textColor="danger700">
                    Errors: {importProgress.liveErrors.toLocaleString()}
                  </Badge>
                )}
              </Flex>
            </Box>
          )}

          {/* Execution Result Banner */}
          {importResult && (
            <Box marginTop={4}>
              <Alert
                variant={importResult.stats.errors.length > 0 ? 'warning' : 'success'}
                title="CSV Import Results"
              >
                <Typography variant="omega" display="block" marginBottom={1}>
                  Successfully processed: <strong>{importResult.stats.created.toLocaleString()} created</strong>
                  {importResult.stats.newWithoutDocId > 0 && (
                    <span> ({importResult.stats.newWithoutDocId.toLocaleString()} created as new entries because documentId was omitted)</span>
                  )}
                  , <strong>{importResult.stats.updated.toLocaleString()} updated</strong>,{' '}
                  <strong>{importResult.stats.skipped.toLocaleString()} skipped</strong> out of {importResult.stats.total.toLocaleString()} total rows.
                </Typography>
                {importResult.stats.newWithoutDocId > 0 && (
                  <Box marginTop={2} padding={2} background="neutral100" hasRadius>
                    <Typography variant="pi" textColor="neutral700">
                      ℹ️ <strong>Note on new entries:</strong> {importResult.stats.newWithoutDocId} row{importResult.stats.newWithoutDocId > 1 ? 's' : ''} had no <code>documentId</code> specified in the CSV. The engine generated brand-new database entries with assigned document IDs. If you export this collection now, you will see their generated document IDs.
                    </Typography>
                  </Box>
                )}
                {importResult.stats.errors.length > 0 && (
                  <Box marginTop={2}>
                    <Typography variant="pi" textColor="danger700" fontWeight="bold">
                      Errors encountered ({importResult.stats.errors.length}):
                    </Typography>
                    <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                      {importResult.stats.errors.slice(0, 10).map((err: any, idx: number) => (
                        <li key={idx} style={{ marginBottom: '2px' }}>
                          <Typography variant="pi" textColor="danger600">
                            Row {err.row}: {err.error}
                          </Typography>
                        </li>
                      ))}
                    </ul>
                    {importResult.stats.errors.length > 10 && (
                      <Typography variant="pi" textColor="neutral600" style={{ display: 'block', marginTop: 4, fontStyle: 'italic' }}>
                        ...and {importResult.stats.errors.length - 10} more error{importResult.stats.errors.length - 10 > 1 ? 's' : ''}
                      </Typography>
                    )}
                  </Box>
                )}

                {importResult.stats.diffs && importResult.stats.diffs.length > 0 && (
                  <Box marginTop={3} padding={3} background="neutral0" hasRadius style={{ border: '1px solid #dcdce4' }}>
                    <Typography variant="sigma" textColor="neutral800" fontWeight="bold" display="block" marginBottom={2}>
                      CHANGES APPLIED ({importResult.stats.diffs.length.toLocaleString()}):
                    </Typography>
                    <Box style={{ overflowX: 'auto' }}>
                      <Table colCount={4} rowCount={importResult.stats.diffs.length + 1}>
                        <Thead>
                          <Tr>
                            <Th><Typography variant="sigma">Entry / Document</Typography></Th>
                            <Th><Typography variant="sigma">Attribute</Typography></Th>
                            <Th><Typography variant="sigma">Previous Value</Typography></Th>
                            <Th><Typography variant="sigma">Applied Value</Typography></Th>
                          </Tr>
                        </Thead>
                        <Tbody>
                          {importResult.stats.diffs.slice(0, 10).map((d: any, idx: number) => {
                            const oldDisplay = d.oldValue !== null && d.oldValue !== undefined
                              ? (typeof d.oldValue === 'object' ? JSON.stringify(d.oldValue) : String(d.oldValue))
                              : '(empty)';
                            const newDisplay = d.newValue !== null && d.newValue !== undefined
                              ? (typeof d.newValue === 'object' ? JSON.stringify(d.newValue) : String(d.newValue))
                              : '(empty)';

                            return (
                              <Tr key={idx}>
                                <Td>
                                  <Typography fontWeight="semiBold">{d.label || d.documentId}</Typography>
                                  {d.documentId && (
                                    <Typography variant="pi" textColor="neutral500" display="block">
                                      {d.documentId}
                                    </Typography>
                                  )}
                                </Td>
                                <Td>
                                  <Badge backgroundColor="secondary100" textColor="secondary700">
                                    {d.attribute || 'field'}
                                  </Badge>
                                </Td>
                                <Td>
                                  <Typography textColor="danger600">{oldDisplay}</Typography>
                                </Td>
                                <Td>
                                  <Typography textColor="success600" fontWeight="semiBold">{newDisplay}</Typography>
                                </Td>
                              </Tr>
                            );
                          })}
                        </Tbody>
                      </Table>
                    </Box>
                    {importResult.stats.diffs.length > 10 && (
                      <Typography variant="pi" textColor="neutral600" style={{ display: 'block', marginTop: 6, fontStyle: 'italic' }}>
                        ...and {importResult.stats.diffs.length - 10} more change{importResult.stats.diffs.length - 10 > 1 ? 's' : ''} recorded in Audit Trail &amp; Version History.
                      </Typography>
                    )}
                  </Box>
                )}
              </Alert>
            </Box>
          )}
        </Box>
      </Flex>

      {/* Confirmation Modal with Enterprise Guardrails (Maker-Checker, Execution Windows, Off-Peak Scheduling) */}
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
                  <Typography variant="delta" fontWeight="bold">
                    Confirm CSV Bulk Import
                  </Typography>
                  <Typography variant="pi" textColor="neutral600" display="block">
                    Review import target, record actions, publishing mode, and execution window policies before proceeding.
                  </Typography>
                </Box>
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
              {/* Target Summary */}
              <Box padding={4} background="neutral100" hasRadius marginBottom={4}>
                <Typography variant="sigma" textColor="neutral600" marginBottom={2} display="block">
                  IMPORT DETAILS
                </Typography>
                <Flex direction="column" gap={2}>
                  <Flex justifyContent="space-between" alignItems="center">
                    <Typography fontWeight="semiBold">Target Collection:</Typography>
                    <Badge backgroundColor="primary100" textColor="primary700">
                      {selectedCol?.displayName || selectedUid}
                    </Badge>
                  </Flex>

                  <Flex justifyContent="space-between" alignItems="center">
                    <Typography fontWeight="semiBold">Total Detected Records:</Typography>
                    <Typography fontWeight="bold" textColor="primary600">
                      {allParsedRecords.length.toLocaleString()} records
                    </Typography>
                  </Flex>

                  <Flex justifyContent="space-between" alignItems="center">
                    <Typography fontWeight="semiBold">Action Breakdown:</Typography>
                    <Flex gap={2}>
                      <Badge backgroundColor="primary100" textColor="primary700">
                        🔄 {allParsedRecords.filter((r) => !!extractDocId(r)).length.toLocaleString()} Updates
                      </Badge>
                      <Badge backgroundColor="warning100" textColor="warning700">
                        ➕ {allParsedRecords.filter((r) => !extractDocId(r)).length.toLocaleString()} New (No ID)
                      </Badge>
                    </Flex>
                  </Flex>

                  <Flex justifyContent="space-between" alignItems="center">
                    <Typography fontWeight="semiBold">Import Mode:</Typography>
                    <Badge backgroundColor="neutral200" textColor="neutral800">
                      {importMode === 'update'
                        ? 'Update Only (Exact Document IDs)'
                        : importMode === 'create_or_override'
                        ? 'Create or Override'
                        : 'Smart Auto-Detect'}
                    </Badge>
                  </Flex>

                  <Flex justifyContent="space-between" alignItems="center">
                    <Typography fontWeight="semiBold">Publishing Mode:</Typography>
                    <Badge
                      backgroundColor={publishOnImport ? 'success100' : 'warning100'}
                      textColor={publishOnImport ? 'success700' : 'warning700'}
                    >
                      {publishOnImport ? 'Publish Immediately' : 'Keep as Draft'}
                    </Badge>
                  </Flex>

                  {preflightReport && (
                    <Flex justifyContent="space-between" alignItems="center" marginTop={2} paddingTop={2} style={{ borderTop: '1px solid #eaeaef' }}>
                      <Typography variant="pi" textColor="neutral600">
                        Pre-Flight Status:
                      </Typography>
                      <Typography
                        variant="pi"
                        fontWeight="bold"
                        textColor={preflightReport.hasErrors ? 'danger700' : preflightReport.hasWarnings ? 'warning700' : 'success700'}
                      >
                        {preflightReport.hasErrors
                          ? `⚠️ ${preflightReport.totalErrorCount} errors found`
                          : preflightReport.hasWarnings
                          ? `⚡ Passed with ${preflightReport.totalWarningCount} warnings`
                          : '✅ 100% Passed'}
                      </Typography>
                    </Flex>
                  )}
                </Flex>
              </Box>

              {/* Lifecycle Status Breakdown */}
              {preflightReport?.lifecycleStats && preflightReport.lifecycleStats.isDraftAndPublish && (
                <Box marginBottom={4} padding={3} background="neutral100" hasRadius style={{ border: '1px solid rgba(120, 120, 150, 0.15)' }}>
                  <Typography variant="sigma" textColor="neutral600" marginBottom={2} display="block">
                    LIFECYCLE STATUS BREAKDOWN ({preflightReport.lifecycleStats.totalChecked} Existing Records)
                  </Typography>
                  <Flex gap={2} wrap="wrap">
                    <Badge backgroundColor="success100" textColor="success700">
                      ✓ Published / Approved: {preflightReport.lifecycleStats.published}
                    </Badge>
                    {preflightReport.lifecycleStats.modified > 0 && (
                      <Badge backgroundColor="primary100" textColor="primary700">
                        📝 Modified (Unreviewed Revisions): {preflightReport.lifecycleStats.modified}
                      </Badge>
                    )}
                    {preflightReport.lifecycleStats.draft > 0 && (
                      <Badge backgroundColor="neutral200" textColor="neutral800">
                        📄 Draft (Never Published): {preflightReport.lifecycleStats.draft}
                      </Badge>
                    )}
                  </Flex>
                </Box>
              )}

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
                      ? 'Server policy restricts bulk operations during peak business hours (09:00 - 18:00). Direct execution is paused to preserve API throughput.'
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
                    checked={publishOnImport}
                    onValueChange={(val: boolean) => setPublishOnImport(Boolean(val))}
                  />
                  <Box style={{ cursor: 'pointer' }} onClick={() => setPublishOnImport(!publishOnImport)}>
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
              {publishOnImport && (preflightReport?.lifecycleStats?.unreviewedCount ?? 0) > 0 && (
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
                          id="csv-strategy-safe"
                          name="csvPublishStrategy"
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
                            Only publish records that are already approved &amp; live ({preflightReport?.lifecycleStats?.published ?? 0} record{(preflightReport?.lifecycleStats?.published ?? 0) === 1 ? '' : 's'}). The {preflightReport?.lifecycleStats?.unreviewedCount ?? 0} unreviewed or draft record(s) will receive the CSV update in Draft mode without publishing unreviewed draft revisions to visitors.
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
                          id="csv-strategy-all"
                          name="csvPublishStrategy"
                          checked={publishStrategy === 'all'}
                          onChange={() => setPublishStrategy('all')}
                          style={{ marginTop: 3 }}
                        />
                        <Box>
                          <Typography fontWeight="bold" textColor="danger700" display="block">
                            ⚠️ Publish All Imported Records (Includes Unreviewed Drafts)
                          </Typography>
                          <Typography variant="pi" textColor="neutral600">
                            Publish all affected records live to production immediately, pushing all pending unreviewed draft edits in the {preflightReport?.lifecycleStats?.unreviewedCount ?? 0} draft/modified record(s) live.
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
                            checked={unreviewedConsent}
                            onValueChange={(checked: boolean) => setUnreviewedConsent(Boolean(checked))}
                          />
                          <Box style={{ cursor: 'pointer' }} onClick={() => setUnreviewedConsent(!unreviewedConsent)}>
                            <Typography fontWeight="bold" textColor="danger700" display="block">
                              Mandatory Risk Consent Required
                            </Typography>
                            <Typography variant="pi" textColor="danger700">
                              I understand and explicitly consent that {preflightReport?.lifecycleStats?.unreviewedCount ?? 0} record(s) with unreviewed draft revisions or saved draft states will be published live to production visitors.
                            </Typography>
                          </Box>
                        </Flex>
                      </Box>
                    )}
                  </Flex>
                </Box>
              )}

              {/* Change Request / Release Notes */}
              <Box marginBottom={2}>
                <TextInput
                  label="Change Request / Release Notes (Optional)"
                  name="makerNotes"
                  placeholder="e.g. REL-5040: Bulk updating catalog attributes via CSV"
                  value={makerNotesInput}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMakerNotesInput(e.target.value)}
                />
              </Box>
            </Box>

            {/* Modal Footer */}
            {(() => {
              const isConsentRequired = publishOnImport && (preflightReport?.lifecycleStats?.unreviewedCount ?? 0) > 0 && publishStrategy === 'all' && !unreviewedConsent;
              return (
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
                        onClick={() => submitBatchWithMode('maker_checker')}
                        loading={submittingBatch}
                        disabled={isConsentRequired}
                      >
                        Submit for Checker Approval
                      </Button>

                      {/* Scheduled Off-Peak Queue or Immediate Button */}
                      {executionWindow?.isBusinessHours ? (
                        <>
                          <Button
                            variant="secondary"
                            size="M"
                            onClick={() => submitBatchWithMode('queue_offpeak')}
                            loading={submittingBatch}
                            disabled={isConsentRequired}
                          >
                            Queue for Off-Peak ({executionWindow?.offPeakStartTime || '18:00'})
                          </Button>
                          <Button
                            variant="danger-light"
                            size="S"
                            onClick={() => submitBatchWithMode('immediate', true)}
                            loading={importing}
                            disabled={isConsentRequired}
                          >
                            Force Run Now
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="default"
                          size="M"
                          onClick={() => submitBatchWithMode('immediate')}
                          loading={importing}
                          disabled={isConsentRequired}
                        >
                          Confirm &amp; Execute Now
                        </Button>
                      )}
                    </Flex>
                  </Flex>
                </Box>
              );
            })()}
          </Box>
        </div>
      )}
    </Box>
  );
}
