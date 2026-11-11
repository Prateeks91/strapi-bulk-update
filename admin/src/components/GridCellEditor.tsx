import React, { useState, useEffect, useMemo } from 'react';
import { useFetchClient } from '@strapi/strapi/admin';
import {
  Box,
  Flex,
  Typography,
  Button,
  TextInput,
  Textarea,
  SingleSelect,
  SingleSelectOption,
  Combobox,
  ComboboxOption,
  Badge,
  Checkbox,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Loader,
} from '@strapi/design-system';
import { ArrowClockwise, Check, Search } from '@strapi/icons';
import {
  AttributeMetaRich,
  EnumeratedClientOccurrence,
  GridRecordEdits,
  MediaOptionItem,
  RelationOptionItem,
  ValidationRuleMeta,
  areClientValuesEqual,
  computeRecordQuotaUsage,
  extractRelationEditCommand,
  formatComponentNameFriendly,
  validateClientFieldValue,
} from '../utils/gridEdit';

const DEFAULT_HEADING_ITEMS: Array<{ value: string; label: string; maxAllowed?: number | null }> = [
  { value: 'h1', label: 'H1 - Main Page Title', maxAllowed: 1 },
  { value: 'h2', label: 'H2 - Primary Section Heading', maxAllowed: 3 },
  { value: 'h3', label: 'H3 - Sub-section Heading', maxAllowed: null },
  { value: 'h4', label: 'H4 - Component Title', maxAllowed: null },
  { value: 'h5', label: 'H5 - Card / Item Heading', maxAllowed: null },
  { value: 'h6', label: 'H6 - Minor Heading', maxAllowed: null },
];

export interface GridCellEditorProps {
  entry: any;
  attribute: string;
  occurrence: EnumeratedClientOccurrence;
  attrMeta?: AttributeMetaRich;
  editedValue: any;
  isDirty: boolean;
  validationError?: string | null;
  relationOptions?: RelationOptionItem[];
  relationOptionsLoading?: boolean;
  relationIsMulti?: boolean;
  validationRules?: ValidationRuleMeta[];
  recordEdits?: GridRecordEdits;
  colAttributes?: string[];
  compact?: boolean;
  onCommit: (occurrence: EnumeratedClientOccurrence, newValue: any, error: string | null) => void;
  onReset: (occurrenceKey: string) => void;
}

function toTextInputString(val: any, type: string): string {
  if (val === null || val === undefined) return '';
  if (type === 'date' && typeof val === 'string') {
    return val.slice(0, 10);
  }
  if (type === 'datetime' && typeof val === 'string') {
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return val.slice(0, 16);
  }
  if (type === 'time' && typeof val === 'string') {
    return val.slice(0, 8);
  }
  if (typeof val === 'object') {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

export const GridCellEditor: React.FC<GridCellEditorProps> = React.memo(
  ({
    entry,
    attribute,
    occurrence,
    attrMeta,
    editedValue,
    isDirty,
    validationError,
    relationOptions = [],
    relationOptionsLoading = false,
    relationIsMulti = false,
    validationRules = [],
    recordEdits,
    colAttributes,
    compact = false,
    onCommit,
    onReset,
  }) => {
    const { get } = useFetchClient();
    const fieldType = String(attrMeta?.type || '').toLowerCase();
    const isScopedSelect =
      attrMeta?.customField === 'plugin::bulk-updater.scoped-select' ||
      attrMeta?.customField === 'global::scoped-select';
    const isRelation = Boolean(attrMeta?.isRelation || fieldType === 'relation');
    const isMultiRelation = isRelation && Boolean(relationIsMulti || ['oneToMany', 'manyToMany'].includes(attrMeta?.relationType || ''));

    const effectiveValue = isDirty ? editedValue : occurrence.value;

    const [localText, setLocalText] = useState<string>(() => toTextInputString(effectiveValue, fieldType));
    const [showRichModal, setShowRichModal] = useState(false);
    const [richDraft, setRichDraft] = useState('');
    const [richError, setRichError] = useState<string | null>(null);

    const [showMultiRelModal, setShowMultiRelModal] = useState(false);
    const [multiRelSelected, setMultiRelSelected] = useState<string[]>([]);
    const [multiRelMode, setMultiRelMode] = useState<'set' | 'connect' | 'disconnect' | 'clear'>('set');
    const [multiRelSearch, setMultiRelSearch] = useState('');

    const [showMediaModal, setShowMediaModal] = useState(false);
    const [mediaOptions, setMediaOptions] = useState<MediaOptionItem[]>([]);
    const [mediaSearch, setMediaSearch] = useState('');
    const [mediaLoading, setMediaLoading] = useState(false);
    const [selectedMediaIds, setSelectedMediaIds] = useState<number[]>([]);

    useEffect(() => {
      setLocalText(toTextInputString(effectiveValue, fieldType));
    }, [effectiveValue, fieldType, occurrence.occurrenceKey]);

    const commitTypedValue = (rawVal: any) => {
      if (areClientValuesEqual(rawVal, occurrence.value)) {
        onReset(occurrence.occurrenceKey);
        return;
      }
      const err = validateClientFieldValue(rawVal, attrMeta);
      onCommit(occurrence, rawVal, err);
    };

    const loadMediaLibrary = async (query = '') => {
      try {
        setMediaLoading(true);
        const res = await get(`/bulk-updater/media-options?search=${encodeURIComponent(query)}`);
        if (res.data?.success && Array.isArray(res.data.options)) {
          setMediaOptions(res.data.options);
        }
      } catch {
        setMediaOptions([]);
      } finally {
        setMediaLoading(false);
      }
    };

    const quotaContext = useMemo(() => {
      if (!isScopedSelect) return null;
      return computeRecordQuotaUsage(
        entry,
        attribute,
        occurrence.occurrenceKey,
        recordEdits,
        colAttributes,
        attrMeta,
        validationRules
      );
    }, [isScopedSelect, entry, attribute, occurrence.occurrenceKey, recordEdits, colAttributes, attrMeta, validationRules]);

    const scopedItems = useMemo(() => {
      if (!isScopedSelect) return [];
      const base = attrMeta?.options?.items && attrMeta.options.items.length > 0 ? attrMeta.options.items : DEFAULT_HEADING_ITEMS;
      const quotas = quotaContext?.quotas || {};
      return base.map((it) => {
        const key = it.value.toLowerCase().trim();
        const maxAllowed = typeof quotas[key] === 'number' ? quotas[key] : it.maxAllowed;
        const usedBySiblings = quotaContext?.usageCounts?.[key] || 0;
        return {
          ...it,
          maxAllowed,
          usedBySiblings,
          atLimit: typeof maxAllowed === 'number' && maxAllowed > 0 && usedBySiblings >= maxAllowed,
        };
      });
    }, [isScopedSelect, attrMeta, quotaContext]);

    const wrapperStyle: React.CSSProperties = {
      borderLeft: isDirty ? '3px solid #4945ff' : '3px solid transparent',
      paddingLeft: 6,
      backgroundColor: validationError
        ? 'rgba(208, 43, 32, 0.06)'
        : isDirty
        ? 'rgba(73, 69, 255, 0.05)'
        : 'transparent',
      borderRadius: 4,
      minWidth: compact ? 180 : 210,
      maxWidth: 320,
    };

    const renderResetBtn = () =>
      isDirty ? (
        <Button
          variant="ghost"
          size="S"
          onClick={() => onReset(occurrence.occurrenceKey)}
          title="Revert this cell back to original database value"
          style={{ padding: '4px 6px', minWidth: 28, height: 28 }}
        >
          <ArrowClockwise />
        </Button>
      ) : null;

    // 1. Scoped Quota Custom Field (e.g. titleStyle)
    if (isScopedSelect) {
      const currentValStr = effectiveValue !== null && effectiveValue !== undefined ? String(effectiveValue) : '__clear__';
      return (
        <Box style={wrapperStyle}>
          <Flex gap={1} alignItems="center">
            <Box style={{ flex: 1, minWidth: 145 }}>
              <SingleSelect
                size="S"
                aria-label={`Edit ${occurrence.displayPath}`}
                value={currentValStr}
                onChange={(val: any) => {
                  const s = String(val);
                  commitTypedValue(s === '__clear__' ? null : s);
                }}
              >
                <SingleSelectOption value="__clear__">-- Unset --</SingleSelectOption>
                {scopedItems.map((it) => {
                  const isCurrentlySelected = currentValStr.toLowerCase() === it.value.toLowerCase();
                  const quotaNote =
                    typeof it.maxAllowed === 'number' && it.maxAllowed > 0
                      ? ` (${it.usedBySiblings + (isCurrentlySelected ? 1 : 0)}/${it.maxAllowed})`
                      : '';
                  return (
                    <SingleSelectOption key={it.value} value={it.value}>
                      {it.label}
                      {quotaNote}
                      {it.atLimit && !isCurrentlySelected ? ' [QUOTA FULL]' : ''}
                    </SingleSelectOption>
                  );
                })}
              </SingleSelect>
            </Box>
            {renderResetBtn()}
          </Flex>
          {validationError && (
            <Typography variant="pi" textColor="danger700" display="block" style={{ fontSize: '0.7rem', marginTop: 2 }}>
              {validationError}
            </Typography>
          )}
        </Box>
      );
    }

    // 2. Enumeration
    if (fieldType === 'enumeration' && Array.isArray(attrMeta?.enumOptions)) {
      const currentValStr = effectiveValue !== null && effectiveValue !== undefined && effectiveValue !== '' ? String(effectiveValue) : '__clear__';
      return (
        <Box style={wrapperStyle}>
          <Flex gap={1} alignItems="center">
            <Box style={{ flex: 1, minWidth: 145 }}>
              <SingleSelect
                size="S"
                aria-label={`Edit ${occurrence.displayPath}`}
                value={currentValStr}
                onChange={(val: any) => {
                  const s = String(val);
                  commitTypedValue(s === '__clear__' ? null : s);
                }}
              >
                {!attrMeta.required && <SingleSelectOption value="__clear__">-- Clear (null) --</SingleSelectOption>}
                {attrMeta.enumOptions.map((opt) => (
                  <SingleSelectOption key={opt} value={opt}>
                    {opt}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Box>
            {renderResetBtn()}
          </Flex>
          {validationError && (
            <Typography variant="pi" textColor="danger700" display="block" style={{ fontSize: '0.7rem' }}>
              {validationError}
            </Typography>
          )}
        </Box>
      );
    }

    // 3. Boolean
    if (fieldType === 'boolean') {
      const strVal = effectiveValue === true ? 'true' : effectiveValue === false ? 'false' : '__unset__';
      return (
        <Box style={wrapperStyle}>
          <Flex gap={1} alignItems="center">
            <Box style={{ flex: 1, minWidth: 120 }}>
              <SingleSelect
                size="S"
                aria-label={`Edit ${occurrence.displayPath}`}
                value={strVal}
                onChange={(val: any) => {
                  const s = String(val);
                  commitTypedValue(s === 'true' ? true : s === 'false' ? false : null);
                }}
              >
                {!attrMeta?.required && <SingleSelectOption value="__unset__">-- Unset --</SingleSelectOption>}
                <SingleSelectOption value="true">true</SingleSelectOption>
                <SingleSelectOption value="false">false</SingleSelectOption>
              </SingleSelect>
            </Box>
            {renderResetBtn()}
          </Flex>
          {validationError && (
            <Typography variant="pi" textColor="danger700" display="block" style={{ fontSize: '0.7rem' }}>
              {validationError}
            </Typography>
          )}
        </Box>
      );
    }

    // 4. Relation (Single or Multi)
    if (isRelation) {
      const cmd = extractRelationEditCommand(effectiveValue, occurrence.value, isMultiRelation);

      if (!isMultiRelation) {
        const selectedDocId = cmd.mode === 'clear' ? '__clear__' : cmd.documentIds[0] || '__clear__';
        return (
          <Box style={wrapperStyle}>
            <Flex gap={1} alignItems="center">
              <Box style={{ flex: 1, minWidth: 165 }}>
                <Combobox
                  autocomplete={{ type: 'list', filter: 'contains' }}
                  placeholder={relationOptionsLoading ? 'Loading...' : 'Pick relation...'}
                  value={selectedDocId}
                  onChange={(val: any) => {
                    const docId = val ? String(val) : '__clear__';
                    if (docId === '__clear__') {
                      commitTypedValue({ mode: 'clear', documentIds: [], label: '(cleared / unlinked)' });
                    } else {
                      const opt = relationOptions.find((o) => o.documentId === docId);
                      commitTypedValue({ mode: 'set', documentIds: [docId], label: opt?.label || docId });
                    }
                  }}
                >
                  <ComboboxOption value="__clear__" textValue="Clear / Unlink Relation">
                    -- Clear / Unlink --
                  </ComboboxOption>
                  {relationOptions.map((opt) => (
                    <ComboboxOption key={opt.documentId} value={opt.documentId} textValue={opt.label}>
                      {opt.label}
                    </ComboboxOption>
                  ))}
                </Combobox>
              </Box>
              {renderResetBtn()}
            </Flex>
            {validationError && (
              <Typography variant="pi" textColor="danger700" display="block" style={{ fontSize: '0.7rem' }}>
                {validationError}
              </Typography>
            )}
          </Box>
        );
      }

      // Multi-Relation Modal Trigger
      const displaySummary =
        cmd.mode === 'clear'
          ? '(cleared / empty)'
          : cmd.label || (cmd.documentIds.length > 0 ? `${cmd.documentIds.length} linked (${cmd.mode})` : '(unlinked)');
      const filteredRelOpts = relationOptions.filter((o) =>
        !multiRelSearch.trim() || o.label.toLowerCase().includes(multiRelSearch.toLowerCase())
      );

      return (
        <Box style={wrapperStyle}>
          <Flex gap={1} alignItems="center">
            <Button
              variant="tertiary"
              size="S"
              onClick={() => {
                setMultiRelSelected(cmd.documentIds || []);
                setMultiRelMode(cmd.mode === 'clear' && (cmd.documentIds || []).length === 0 ? 'set' : cmd.mode);
                setMultiRelSearch('');
                setShowMultiRelModal(true);
              }}
              style={{ maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {displaySummary}
            </Button>
            {renderResetBtn()}
          </Flex>

          {showMultiRelModal && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(20, 20, 30, 0.55)',
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 16,
              }}
              onClick={() => setShowMultiRelModal(false)}
            >
              <Box
                padding={5}
                background="neutral0"
                hasRadius
                shadow="popupShadow"
                style={{ width: '92%', maxWidth: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              >
                <Typography variant="delta" fontWeight="bold" marginBottom={2}>
                  Edit Multi-Relation: {occurrence.displayPath}
                </Typography>
                <Flex gap={2} marginBottom={3} alignItems="center">
                  <Box style={{ width: 180 }}>
                    <SingleSelect
                      label="Operation"
                      value={multiRelMode}
                      onChange={(v: any) => setMultiRelMode(String(v) as any)}
                    >
                      <SingleSelectOption value="set">Set / Replace All</SingleSelectOption>
                      <SingleSelectOption value="connect">Add / Connect</SingleSelectOption>
                      <SingleSelectOption value="disconnect">Remove / Disconnect</SingleSelectOption>
                      <SingleSelectOption value="clear">Clear All</SingleSelectOption>
                    </SingleSelect>
                  </Box>
                  <Box style={{ flex: 1 }}>
                    <TextInput
                      label="Filter items"
                      placeholder="Search relations..."
                      value={multiRelSearch}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMultiRelSearch(e.target.value)}
                    />
                  </Box>
                </Flex>

                {multiRelMode !== 'clear' && (
                  <Box
                    padding={2}
                    hasRadius
                    style={{ border: '1px solid #eaeaef', overflowY: 'auto', maxHeight: 280, marginBottom: 16 }}
                  >
                    {filteredRelOpts.length === 0 ? (
                      <Typography variant="pi" textColor="neutral600">
                        No target entities found.
                      </Typography>
                    ) : (
                      filteredRelOpts.map((opt) => {
                        const checked = multiRelSelected.includes(opt.documentId);
                        return (
                          <Box key={opt.documentId} padding={1}>
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(isChecked: boolean) => {
                                setMultiRelSelected((prev) =>
                                  isChecked ? [...prev, opt.documentId] : prev.filter((id) => id !== opt.documentId)
                                );
                              }}
                            >
                              <Typography variant="omega">{opt.label}</Typography>
                            </Checkbox>
                          </Box>
                        );
                      })
                    )}
                  </Box>
                )}

                <Flex justifyContent="flex-end" gap={2}>
                  <Button variant="tertiary" onClick={() => setShowMultiRelModal(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="default"
                    startIcon={<Check />}
                    onClick={() => {
                      if (multiRelMode === 'clear') {
                        commitTypedValue({ mode: 'clear', documentIds: [], label: '(cleared / unlinked)' });
                      } else {
                        const labels = relationOptions
                          .filter((o) => multiRelSelected.includes(o.documentId))
                          .map((o) => o.label)
                          .join(', ');
                        commitTypedValue({
                          mode: multiRelMode,
                          documentIds: multiRelSelected,
                          label: labels || `${multiRelSelected.length} selected`,
                        });
                      }
                      setShowMultiRelModal(false);
                    }}
                  >
                    Apply Relation Edit
                  </Button>
                </Flex>
              </Box>
            </div>
          )}
        </Box>
      );
    }

    // 5. Media Picker
    if (fieldType === 'media') {
      const isMultiMedia = Boolean(attrMeta?.multiple);
      const currentIds: number[] = Array.isArray(effectiveValue)
        ? effectiveValue.map((v: any) => (typeof v === 'object' ? Number(v?.id) : Number(v))).filter((n: number) => !isNaN(n))
        : typeof effectiveValue === 'object' && effectiveValue?.id
        ? [Number(effectiveValue.id)]
        : typeof effectiveValue === 'number'
        ? [effectiveValue]
        : [];
      const mediaSummary =
        currentIds.length === 0
          ? '(no media — pick)'
          : Array.isArray(effectiveValue)
          ? `${currentIds.length} asset(s)`
          : effectiveValue?.name
          ? `${effectiveValue.name} (#${currentIds[0]})`
          : `Media #${currentIds[0]}`;

      return (
        <Box style={wrapperStyle}>
          <Flex gap={1} alignItems="center">
            <Button
              variant="tertiary"
              size="S"
              onClick={() => {
                setSelectedMediaIds(currentIds);
                setMediaSearch('');
                setShowMediaModal(true);
                loadMediaLibrary('');
              }}
              style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {mediaSummary}
            </Button>
            {renderResetBtn()}
          </Flex>

          {showMediaModal && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(20, 20, 30, 0.55)',
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 16,
              }}
              onClick={() => setShowMediaModal(false)}
            >
              <Box
                padding={5}
                background="neutral0"
                hasRadius
                shadow="popupShadow"
                style={{ width: '92%', maxWidth: 620, maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              >
                <Typography variant="delta" fontWeight="bold" marginBottom={3}>
                  Select Media Asset{isMultiMedia ? 's' : ''}: {occurrence.displayPath}
                </Typography>

                <Flex gap={2} marginBottom={3}>
                  <Box style={{ flex: 1 }}>
                    <TextInput
                      placeholder="Search media filename or MIME..."
                      value={mediaSearch}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMediaSearch(e.target.value)}
                    />
                  </Box>
                  <Button
                    variant="secondary"
                    startIcon={<Search />}
                    onClick={() => loadMediaLibrary(mediaSearch)}
                    loading={mediaLoading}
                  >
                    Search
                  </Button>
                </Flex>

                <Box
                  padding={2}
                  hasRadius
                  style={{ border: '1px solid #eaeaef', overflowY: 'auto', maxHeight: 320, marginBottom: 16 }}
                >
                  {mediaLoading ? (
                    <Flex justifyContent="center" padding={4}>
                      <Loader small>Loading Media Library...</Loader>
                    </Flex>
                  ) : mediaOptions.length === 0 ? (
                    <Typography variant="pi" textColor="neutral600">
                      No media files matched.
                    </Typography>
                  ) : (
                    mediaOptions.map((file) => {
                      const isChecked = selectedMediaIds.includes(file.id);
                      return (
                        <Box key={file.id} padding={2} style={{ borderBottom: '1px solid #f0f0f5' }}>
                          <Checkbox
                            checked={isChecked}
                            onCheckedChange={(checked: boolean) => {
                              if (isMultiMedia) {
                                setSelectedMediaIds((prev) =>
                                  checked ? [...prev, file.id] : prev.filter((id) => id !== file.id)
                                );
                              } else {
                                setSelectedMediaIds(checked ? [file.id] : []);
                              }
                            }}
                          >
                            <Flex gap={2} alignItems="center">
                              <Badge backgroundColor="neutral150" textColor="neutral700" size="S">
                                #{file.id}
                              </Badge>
                              <Typography variant="omega" fontWeight="semiBold">
                                {file.name}
                              </Typography>
                              <Typography variant="pi" textColor="neutral500">
                                ({file.mime})
                              </Typography>
                            </Flex>
                          </Checkbox>
                        </Box>
                      );
                    })
                  )}
                </Box>

                <Flex justifyContent="space-between" gap={2}>
                  <Button
                    variant="danger-light"
                    onClick={() => {
                      commitTypedValue(isMultiMedia ? [] : null);
                      setShowMediaModal(false);
                    }}
                  >
                    Clear Media
                  </Button>
                  <Flex gap={2}>
                    <Button variant="tertiary" onClick={() => setShowMediaModal(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="default"
                      startIcon={<Check />}
                      onClick={() => {
                        commitTypedValue(isMultiMedia ? selectedMediaIds : selectedMediaIds[0] ?? null);
                        setShowMediaModal(false);
                      }}
                    >
                      Apply Selection
                    </Button>
                  </Flex>
                </Flex>
              </Box>
            </div>
          )}
        </Box>
      );
    }

    // 6. Rich Text / Strapi Blocks / JSON Popover Editor
    if (fieldType === 'richtext' || fieldType === 'blocks' || fieldType === 'json') {
      const isJsonOrBlocks = fieldType === 'blocks' || fieldType === 'json';
      const displayLabel =
        effectiveValue === null || effectiveValue === undefined || effectiveValue === ''
          ? '(empty — edit)'
          : typeof effectiveValue === 'object'
          ? JSON.stringify(effectiveValue).slice(0, 32) + (JSON.stringify(effectiveValue).length > 32 ? '…' : '')
          : String(effectiveValue).slice(0, 32) + (String(effectiveValue).length > 32 ? '…' : '');

      return (
        <Box style={wrapperStyle}>
          <Flex gap={1} alignItems="center">
            <Button
              variant="tertiary"
              size="S"
              onClick={() => {
                const formatted =
                  effectiveValue === null || effectiveValue === undefined
                    ? ''
                    : typeof effectiveValue === 'object'
                    ? JSON.stringify(effectiveValue, null, 2)
                    : String(effectiveValue);
                setRichDraft(formatted);
                setRichError(null);
                setShowRichModal(true);
              }}
              style={{ maxWidth: 230, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {displayLabel}
            </Button>
            {renderResetBtn()}
          </Flex>
          {validationError && (
            <Typography variant="pi" textColor="danger700" display="block" style={{ fontSize: '0.7rem' }}>
              {validationError}
            </Typography>
          )}

          {showRichModal && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                backgroundColor: 'rgba(20, 20, 30, 0.55)',
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 16,
              }}
              onClick={() => setShowRichModal(false)}
            >
              <Box
                padding={5}
                background="neutral0"
                hasRadius
                shadow="popupShadow"
                style={{ width: '92%', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 12 }}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              >
                <Typography variant="delta" fontWeight="bold">
                  Edit {fieldType.toUpperCase()}: {occurrence.displayPath}
                </Typography>
                <Textarea
                  name="richDraft"
                  aria-label="Rich content editor"
                  value={richDraft}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                    setRichDraft(e.target.value);
                    if (isJsonOrBlocks && e.target.value.trim()) {
                      try {
                        const parsed = JSON.parse(e.target.value);
                        if (fieldType === 'blocks' && !Array.isArray(parsed)) {
                          setRichError('Strapi Blocks value must be a JSON array.');
                        } else {
                          setRichError(null);
                        }
                      } catch (err: any) {
                        setRichError(`Invalid JSON: ${err.message}`);
                      }
                    } else {
                      setRichError(null);
                    }
                  }}
                  style={{ minHeight: 220, fontFamily: isJsonOrBlocks ? 'monospace' : 'inherit' }}
                />
                {richError && (
                  <Typography variant="pi" textColor="danger700" fontWeight="bold">
                    {richError}
                  </Typography>
                )}
                <Flex justifyContent="space-between" gap={2}>
                  <Button
                    variant="danger-light"
                    onClick={() => {
                      commitTypedValue(isJsonOrBlocks ? null : '');
                      setShowRichModal(false);
                    }}
                  >
                    Clear Value
                  </Button>
                  <Flex gap={2}>
                    <Button variant="tertiary" onClick={() => setShowRichModal(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="default"
                      disabled={Boolean(richError)}
                      startIcon={<Check />}
                      onClick={() => {
                        if (isJsonOrBlocks) {
                          if (!richDraft.trim()) {
                            commitTypedValue(null);
                          } else {
                            commitTypedValue(JSON.parse(richDraft));
                          }
                        } else {
                          commitTypedValue(richDraft);
                        }
                        setShowRichModal(false);
                      }}
                    >
                      Apply Edit
                    </Button>
                  </Flex>
                </Flex>
              </Box>
            </div>
          )}
        </Box>
      );
    }

    // 7. Date / Time / Datetime
    if (fieldType === 'date' || fieldType === 'time' || fieldType === 'datetime') {
      const inputType = fieldType === 'datetime' ? 'datetime-local' : fieldType;
      return (
        <Box style={wrapperStyle}>
          <Flex gap={1} alignItems="center">
            <input
              type={inputType}
              aria-label={`Edit ${occurrence.displayPath}`}
              value={localText}
              step={fieldType === 'time' ? 1 : undefined}
              onChange={(e) => {
                const v = e.target.value;
                setLocalText(v);
                commitTypedValue(v === '' ? null : v);
              }}
              style={{
                padding: '6px 8px',
                borderRadius: 4,
                border: '1px solid #dcdce4',
                fontSize: '0.85rem',
                minWidth: 165,
              }}
            />
            {renderResetBtn()}
          </Flex>
          {validationError && (
            <Typography variant="pi" textColor="danger700" display="block" style={{ fontSize: '0.7rem' }}>
              {validationError}
            </Typography>
          )}
        </Box>
      );
    }

    // 8. Default scalar & numeric inputs (string, text, email, uid, integer, biginteger, float, decimal)
    const isNumeric = ['integer', 'biginteger', 'float', 'decimal', 'number'].includes(fieldType);
    const inputStep = fieldType === 'integer' || fieldType === 'biginteger' ? '1' : isNumeric ? 'any' : undefined;

    return (
      <Box style={wrapperStyle}>
        <Flex gap={1} alignItems="center">
          <Box style={{ flex: 1, minWidth: 150 }}>
            <TextInput
              size="S"
              type={isNumeric && fieldType !== 'biginteger' ? 'number' : 'text'}
              step={inputStep}
              aria-label={`Edit ${occurrence.displayPath}`}
              placeholder={occurrence.isMissingIntermediate ? 'Click to initialize...' : '(empty)'}
              value={localText}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                const next = e.target.value;
                setLocalText(next);
                commitTypedValue(isNumeric && next === '' ? null : next);
              }}
            />
          </Box>
          {renderResetBtn()}
        </Flex>
        {validationError && (
          <Typography variant="pi" textColor="danger700" display="block" style={{ fontSize: '0.7rem', marginTop: 2 }}>
            {validationError}
          </Typography>
        )}
      </Box>
    );
  }
);

export interface ComponentOccurrencesDrawerProps {
  colUid: string;
  rootKey?: string;
  entry: any;
  selectedAttribute: string;
  attrMeta?: AttributeMetaRich;
  colAttributes: string[];
  gridEditMode: boolean;
  isSelected: boolean;
  selectedDzBlocks?: number[];
  occurrences: EnumeratedClientOccurrence[];
  recordEdits?: GridRecordEdits;
  relationOptions?: RelationOptionItem[];
  relationOptionsLoading?: boolean;
  relationIsMulti?: boolean;
  validationRules?: ValidationRuleMeta[];
  onToggleDzBlock: (colUid: string, documentId: string, blockIdx: number, allApplicableIndexes: number[]) => void;
  onCommitEdit: (entry: any, colUid: string, occ: EnumeratedClientOccurrence, val: any, error: string | null) => void;
  onResetEdit: (colUid: string, documentId: string, occKey: string) => void;
}

/**
 * Unified expandable block/item drawer for BOTH Dynamic Zones and Repeatable Components,
 * supporting Legacy checkbox targeting (Common Mode) and inline per-block editing (Grid Mode).
 */
export const ComponentOccurrencesDrawer: React.FC<ComponentOccurrencesDrawerProps> = React.memo(
  ({
    colUid,
    rootKey,
    entry,
    selectedAttribute,
    attrMeta,
    colAttributes,
    gridEditMode,
    isSelected,
    selectedDzBlocks,
    occurrences,
    recordEdits,
    relationOptions,
    relationOptionsLoading,
    relationIsMulti,
    validationRules,
    onToggleDzBlock,
    onCommitEdit,
    onResetEdit,
  }) => {
    const cleanRootKey = rootKey || (selectedAttribute || '').split('[')[0].split('.')[0];
    const selectedRootKey = selectedAttribute ? selectedAttribute.split('[')[0].split('.')[0] : '';
    const targetsThisRoot = Boolean(selectedAttribute && selectedRootKey === cleanRootKey);
    const blocks: any[] = Array.isArray(entry?.[cleanRootKey]) ? entry[cleanRootKey] : [];
    const isDynamicZone = blocks.some((b) => Boolean(b?.__component));

    if (blocks.length === 0) return null;

    const occByRootIndex = new Map<number, EnumeratedClientOccurrence[]>();
    occurrences.forEach((occ) => {
      if (occ.segments?.[0]?.key !== cleanRootKey || occ.segments?.[0]?.index === undefined) return;
      const rootIdx = occ.segments[0].index;
      const list = occByRootIndex.get(rootIdx) || [];
      list.push(occ);
      occByRootIndex.set(rootIdx, list);
    });

    const allApplicableIndexes = blocks
      .map((_, bIdx) => bIdx)
      .filter((bIdx) => (targetsThisRoot ? (occByRootIndex.get(bIdx) || []).length > 0 : true));

    return (
      <Box
        padding={3}
        background="neutral0"
        hasRadius
        style={{ border: '1px solid rgba(73, 69, 255, 0.25)', boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}
      >
        <Flex justifyContent="space-between" alignItems="center" marginBottom={2}>
          <Flex gap={2} alignItems="center">
            <Typography variant="sigma" textColor="primary700">
              {isDynamicZone ? 'DYNAMIC ZONE' : 'REPEATABLE COMPONENT'}: &quot;{cleanRootKey}&quot; ({blocks.length}{' '}
              {blocks.length === 1 ? 'item' : 'items'})
            </Typography>
            <Badge backgroundColor="primary100" textColor="primary700">
              {gridEditMode ? 'Inline Per-Block Grid Editing' : 'Selective Block Targeting'}
            </Badge>
          </Flex>
          <Typography variant="pi" textColor="neutral500">
            {gridEditMode
              ? 'Edit each occurrence independently — component IDs & sibling blocks stay intact'
              : 'Selectively choose which blocks to update for this entry'}
          </Typography>
        </Flex>

        <Table colCount={gridEditMode ? 4 : 5} rowCount={blocks.length + 1} style={{ width: '100%', background: '#fff' }}>
          <Thead>
            <Tr>
              {!gridEditMode && (
                <Th style={{ width: 64 }}>
                  <Typography variant="sigma">Update?</Typography>
                </Th>
              )}
              <Th style={{ width: 85 }}>
                <Typography variant="sigma">Pos / ID</Typography>
              </Th>
              <Th style={{ width: 210 }}>
                <Typography variant="sigma">Component</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">
                  Target Field Value ({selectedAttribute || 'selected'})
                </Typography>
              </Th>
              <Th>
                <Typography variant="sigma">Block Summary</Typography>
              </Th>
            </Tr>
          </Thead>
          <Tbody>
            {blocks.map((block: any, bIdx: number) => {
              const compUid = block?.__component || attrMeta?.component;
              const compLabel = formatComponentNameFriendly(compUid);
              const blockOccs = occByRootIndex.get(bIdx) || [];
              const hasTargetAttr = blockOccs.length > 0;
              const isBlockSelectable = targetsThisRoot ? hasTargetAttr : true;

              const isBlockChecked =
                !gridEditMode &&
                isBlockSelectable &&
                isSelected &&
                (selectedDzBlocks !== undefined ? selectedDzBlocks.includes(bIdx) : true);

              const hasDirtyOcc = blockOccs.some((o) => Boolean(recordEdits?.occurrences?.[o.occurrenceKey]));

              const blockSummaryText =
                block?.title ||
                block?.name ||
                block?.heading ||
                block?.body ||
                Object.keys(block || {})
                  .filter((k) => !k.startsWith('_') && k !== 'id')
                  .slice(0, 3)
                  .map((k) => {
                    const v = block[k];
                    if (v === null || v === undefined) return null;
                    return `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 24) : String(v).slice(0, 24)}`;
                  })
                  .filter(Boolean)
                  .join(', ') ||
                '-';

              return (
                <Tr
                  key={block?.id ? `id_${block.id}_idx_${bIdx}` : `idx_${bIdx}`}
                  style={{
                    backgroundColor: hasDirtyOcc || isBlockChecked ? 'rgba(73, 69, 255, 0.07)' : undefined,
                  }}
                >
                  {!gridEditMode && (
                    <Td>
                      <Checkbox
                        checked={isBlockChecked}
                        disabled={!isBlockSelectable}
                        onCheckedChange={() => {
                          onToggleDzBlock(colUid, entry.documentId, bIdx, allApplicableIndexes);
                        }}
                      />
                    </Td>
                  )}
                  <Td>
                    <Typography variant="pi" fontWeight="bold" display="block">
                      #{bIdx}
                    </Typography>
                    {block?.id !== undefined && (
                      <Typography variant="pi" textColor="neutral500" style={{ fontSize: '0.68rem' }}>
                        id:{block.id}
                      </Typography>
                    )}
                  </Td>
                  <Td>
                    <Badge backgroundColor="neutral150" textColor="neutral800">
                      {compLabel}
                    </Badge>
                    {compUid && (
                      <Typography variant="pi" textColor="neutral500" display="block" style={{ fontSize: '0.68rem', marginTop: 2 }}>
                        {compUid}
                      </Typography>
                    )}
                  </Td>
                  <Td>
                    {!targetsThisRoot ? (
                      <Typography variant="pi" textColor="neutral500">
                        {selectedAttribute ? `(targets "${selectedAttribute}")` : '(select attribute to inspect)'}
                      </Typography>
                    ) : !hasTargetAttr ? (
                      <Badge backgroundColor="neutral100" textColor="neutral500">
                        Does not contain attribute
                      </Badge>
                    ) : gridEditMode ? (
                      <Flex direction="column" gap={2} alignItems="flex-start">
                        {blockOccs.map((occ) => {
                          const editObj = recordEdits?.occurrences?.[occ.occurrenceKey];
                          return (
                            <Box key={occ.occurrenceKey} style={{ width: '100%' }}>
                              {blockOccs.length > 1 && (
                                <Typography variant="pi" textColor="neutral600" display="block" style={{ fontSize: '0.7rem', marginBottom: 2 }}>
                                  {occ.displayPath}
                                </Typography>
                              )}
                              <GridCellEditor
                                entry={entry}
                                attribute={selectedAttribute}
                                occurrence={occ}
                                attrMeta={attrMeta}
                                editedValue={editObj?.value}
                                isDirty={Boolean(editObj)}
                                validationError={editObj?.validationError}
                                relationOptions={relationOptions}
                                relationOptionsLoading={relationOptionsLoading}
                                relationIsMulti={relationIsMulti}
                                validationRules={validationRules}
                                recordEdits={recordEdits}
                                colAttributes={colAttributes}
                                onCommit={(o, val, err) => onCommitEdit(entry, colUid, o, val, err)}
                                onReset={(k) => onResetEdit(colUid, entry.documentId, k)}
                              />
                            </Box>
                          );
                        })}
                      </Flex>
                    ) : (
                      <Flex direction="column" gap={1} alignItems="flex-start">
                        {blockOccs.map((occ) => (
                          <Typography key={occ.occurrenceKey} variant="omega" fontWeight="semiBold" textColor="primary700">
                            {occ.value !== null && occ.value !== undefined && occ.value !== ''
                              ? typeof occ.value === 'object'
                                ? JSON.stringify(occ.value)
                                : String(occ.value)
                              : '(empty / not set)'}
                          </Typography>
                        ))}
                      </Flex>
                    )}
                  </Td>
                  <Td>
                    <Typography
                      variant="pi"
                      textColor="neutral600"
                      style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {blockSummaryText}
                    </Typography>
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      </Box>
    );
  }
);
