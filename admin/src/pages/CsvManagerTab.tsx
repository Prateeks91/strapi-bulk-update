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
} from '@strapi/design-system';
import { Download, Upload, ArrowClockwise, Check } from '@strapi/icons';
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

  // Export filters
  const [exportLimit, setExportLimit] = useState<number>(1000);
  const [exportOnlyViolations, setExportOnlyViolations] = useState<boolean>(false);
  const [rules, setRules] = useState<any[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string>('');

  // Import states
  const [importMode, setImportMode] = useState<'auto' | 'update' | 'create_or_override'>('auto');
  const [publishOnImport, setPublishOnImport] = useState<boolean>(true);
  const [csvRawText, setCsvRawText] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [parsedPreview, setParsedPreview] = useState<Array<Record<string, string>>>([]);
  const [importing, setImporting] = useState<boolean>(false);
  const [importResult, setImportResult] = useState<any>(null);

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
        message: 'Collection exported to CSV successfully',
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

  // Robust RFC-4180 client-side preview parser
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setImportResult(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setCsvRawText(text);

      try {
        const records = parseCsv(text);
        setParsedPreview(records.slice(0, 10));
      } catch (err) {
        setParsedPreview([]);
      }
    };
    reader.readAsText(file);
  };

  const handleExecuteImport = async () => {
    if (!selectedUid || !csvRawText) return;

    try {
      setImporting(true);
      setImportResult(null);

      const res = await post('/bulk-updater/csv/import', {
        uid: selectedUid,
        csvText: csvRawText,
        mode: importMode,
        publish: publishOnImport,
      });

      if (res.data && res.data.success) {
        setImportResult(res.data);
        const stats = res.data.stats;
        let notifMsg = `CSV Import complete: ${stats.created} created, ${stats.updated} updated.`;
        if (stats.newWithoutDocId && stats.newWithoutDocId > 0) {
          notifMsg += ` (${stats.newWithoutDocId} new entries created due to omitted documentId)`;
        }
        toggleNotification({
          type: 'success',
          message: notifMsg,
        });
      } else {
        throw new Error(res.data?.error || 'Import failed');
      }
    } catch (err: any) {
      if (isAbortError(err)) return;
      toggleNotification({
        type: 'danger',
        message: err.message || 'Error processing CSV import',
      });
    } finally {
      setImporting(false);
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
              Export all records, filtered subsets, or rule violations into CSV. Correct or add records in spreadsheets and re-upload with full schema &amp; quota enforcement.
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
            Extract entire collections or pinpoint records violating validation quotas.
          </Typography>

          <Flex gap={4} wrap="wrap" alignItems="center" marginTop={3}>
            {/* Standard Collection Export */}
            <Button
              variant="default"
              startIcon={<Download />}
              onClick={handleExportCollection}
              disabled={!selectedUid}
            >
              Export All {selectedCol?.displayName || 'Collection'} Records (.csv)
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
            Upload an updated CSV file to bulk update existing records or insert new records.
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

          {/* Parsed Preview Table */}
          {parsedPreview.length > 0 && (() => {
            const missingDocIdCount = parsedPreview.filter(
              (row) => !extractDocId(row)
            ).length;
            const headers = Object.keys(parsedPreview[0]);

            return (
              <Box marginTop={4} background="neutral0" padding={4} hasRadius>
                <Flex justifyContent="space-between" alignItems="center" marginBottom={3}>
                  <Box>
                    <Typography variant="sigma" textColor="neutral700">
                      FILE PREVIEW (FIRST {parsedPreview.length} ROWS)
                    </Typography>
                    <Typography variant="pi" textColor="neutral500" display="block">
                      {parsedPreview.length} previewed row{parsedPreview.length > 1 ? 's' : ''} •{' '}
                      {missingDocIdCount > 0
                        ? `${missingDocIdCount} row${missingDocIdCount > 1 ? 's' : ''} missing documentId (will be created as new entries)`
                        : 'All previewed rows contain document IDs'}
                    </Typography>
                  </Box>
                  <Badge backgroundColor={missingDocIdCount > 0 ? 'warning100' : 'success100'} textColor={missingDocIdCount > 0 ? 'warning700' : 'success700'}>
                    {missingDocIdCount > 0 ? `${missingDocIdCount} New (No ID)` : 'Ready to Import'}
                  </Badge>
                </Flex>

                {missingDocIdCount > 0 && (
                  <Box marginBottom={3}>
                    <Alert
                      variant="default"
                      title="Smart Auto-Detect Active"
                    >
                      <Typography variant="omega">
                        {missingDocIdCount} row{missingDocIdCount > 1 ? 's have' : ' has'} no <code>documentId</code>.{' '}
                        Because no documentId is provided, the engine will automatically treat them as new entries and generate new database IDs for them.
                      </Typography>
                    </Alert>
                  </Box>
                )}

                <Box style={{ overflowX: 'auto', maxWidth: '100%', border: '1px solid #e0e0e0', borderRadius: 4 }}>
                  <Table colCount={headers.length + 1} rowCount={parsedPreview.length + 1}>
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
                      {parsedPreview.map((row, rIdx) => {
                        const hasDocId = !!extractDocId(row);
                        return (
                          <Tr key={rIdx}>
                            <Td>
                              {hasDocId ? (
                                <Badge backgroundColor="primary100" textColor="primary700">
                                  🔄 Match / Update
                                </Badge>
                              ) : (
                                <Badge backgroundColor="warning100" textColor="warning700">
                                  ➕ New Entry
                                </Badge>
                              )}
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

                <Flex justifyContent="flex-end" marginTop={4}>
                  <Button
                    variant="default"
                    size="L"
                    startIcon={<Check />}
                    onClick={handleExecuteImport}
                    loading={importing}
                  >
                    Execute Smart Import (Auto-Detect)
                  </Button>
                </Flex>
              </Box>
            );
          })()}

          {/* Execution Result Banner */}
          {importResult && (
            <Box marginTop={4}>
              <Alert
                variant={importResult.stats.errors.length > 0 ? 'warning' : 'success'}
                title="CSV Import Results"
              >
                <Typography variant="omega" display="block" marginBottom={1}>
                  Successfully processed: <strong>{importResult.stats.created} created</strong>
                  {importResult.stats.newWithoutDocId > 0 && (
                    <span> ({importResult.stats.newWithoutDocId} created as new entries because documentId was omitted)</span>
                  )}
                  , <strong>{importResult.stats.updated} updated</strong>,{' '}
                  <strong>{importResult.stats.skipped} skipped</strong> out of {importResult.stats.total} total rows.
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
                      CHANGES APPLIED ({importResult.stats.diffs.length}):
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
    </Box>
  );
}
