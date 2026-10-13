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
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', fallbackName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Simple client-side preview parser
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
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 0) {
          const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());
          const previewRows: Array<Record<string, string>> = [];
          for (let i = 1; i < Math.min(lines.length, 6); i++) {
            const vals = lines[i].split(',').map((v) => v.replace(/^"|"$/g, '').trim());
            const row: Record<string, string> = {};
            headers.forEach((h, idx) => {
              row[h] = vals[idx] || '';
            });
            previewRows.push(row);
          }
          setParsedPreview(previewRows);
        }
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
          <Flex gap={6} marginBottom={4} wrap="wrap">
            <Box>
              <Typography variant="pi" fontWeight="bold" textColor="neutral800" marginBottom={2}>
                Operation Mode
              </Typography>
              <Flex gap={4} wrap="wrap">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="importMode"
                    value="auto"
                    checked={importMode === 'auto'}
                    onChange={() => setImportMode('auto')}
                  />
                  <Typography variant="omega" fontWeight={importMode === 'auto' ? 'bold' : 'normal'}>
                    Smart Auto-Detect (Auto-updates matching documentId, creates new if missing)
                  </Typography>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="importMode"
                    value="update"
                    checked={importMode === 'update'}
                    onChange={() => setImportMode('update')}
                  />
                  <Typography variant="omega" fontWeight={importMode === 'update' ? 'bold' : 'normal'}>
                    Update Existing Only (Requires documentId)
                  </Typography>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="importMode"
                    value="create_or_override"
                    checked={importMode === 'create_or_override'}
                    onChange={() => setImportMode('create_or_override')}
                  />
                  <Typography variant="omega" fontWeight={importMode === 'create_or_override' ? 'bold' : 'normal'}>
                    Add / Override (Inserts new or replaces existing)
                  </Typography>
                </label>
              </Flex>
            </Box>

            <Box style={{ marginLeft: 'auto' }}>
              <Typography variant="pi" fontWeight="bold" textColor="neutral800" marginBottom={2}>
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
              (row) => !(row.documentId || row.id || '').trim()
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
                      variant={importMode === 'update' ? 'warning' : 'default'}
                      title={importMode === 'update' ? 'Warning: Missing Document IDs' : 'Smart Auto-Detect Active'}
                    >
                      <Typography variant="omega">
                        {missingDocIdCount} row{missingDocIdCount > 1 ? 's have' : ' has'} no <code>documentId</code>.{' '}
                        {importMode === 'auto'
                          ? 'Because no documentId is provided, the engine will automatically treat them as new entries and generate new database IDs for them.'
                          : importMode === 'update'
                          ? 'In "Update Existing Only" mode, rows without a documentId will be skipped. Switch to "Smart Auto-Detect" to automatically create them as new entries.'
                          : 'These will be created as new entries.'}
                      </Typography>
                    </Alert>
                  </Box>
                )}

                <Table colCount={headers.length + 1} rowCount={parsedPreview.length + 1}>
                  <Thead>
                    <Tr>
                      <Th style={{ width: 140 }}>
                        <Typography variant="sigma">Detected Action</Typography>
                      </Th>
                      {headers.map((h) => (
                        <Th key={h}>
                          <Typography variant="sigma">{h}</Typography>
                        </Th>
                      ))}
                    </Tr>
                  </Thead>
                  <Tbody>
                    {parsedPreview.map((row, rIdx) => {
                      const hasDocId = !!(row.documentId || row.id || '').trim();
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
                            <Td key={h}>
                              {(h === 'documentId' || h === 'id') && !row[h]?.trim() ? (
                                <Typography variant="pi" textColor="warning700" fontWeight="bold">
                                  (Auto-generate ID)
                                </Typography>
                              ) : (
                                <Typography variant="omega">{row[h] || '-'}</Typography>
                              )}
                            </Td>
                          ))}
                        </Tr>
                      );
                    })}
                  </Tbody>
                </Table>

                <Flex justifyContent="flex-end" marginTop={4}>
                  <Button
                    variant="default"
                    size="L"
                    startIcon={<Check />}
                    onClick={handleExecuteImport}
                    loading={importing}
                  >
                    {importMode === 'auto'
                      ? 'Execute Smart Import (Auto-Detect)'
                      : importMode === 'update'
                      ? 'Execute Bulk Update'
                      : 'Execute Add / Override'}
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
                      {importResult.stats.errors.slice(0, 5).map((err: any, idx: number) => (
                        <li key={idx}>
                          <Typography variant="pi" textColor="danger600">
                            Row {err.row}: {err.error}
                          </Typography>
                        </li>
                      ))}
                    </ul>
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
