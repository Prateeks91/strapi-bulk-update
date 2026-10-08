import React, { useState, useEffect } from 'react';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import {
  Box,
  Flex,
  Typography,
  Button,
  TextInput,
  Textarea,
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
} from '@strapi/design-system';
import { Plus, Trash, Check, ArrowClockwise, Search, Download } from '@strapi/icons';

export interface ValidationRule {
  id: string;
  name: string;
  description?: string;
  targetField: string;
  quotas: Record<string, number>;
  exceededAction: 'disable' | 'hide';
  enabled: boolean;
  scope: 'entry' | 'document';
  createdAt?: string;
  updatedAt?: string;
}

export default function ValidationRulesTab() {
  const { get, post, del } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [rules, setRules] = useState<ValidationRule[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editingRule, setEditingRule] = useState<ValidationRule | null>(null);

  // Form state for creating/editing a rule
  const [formName, setFormName] = useState<string>('');
  const [formDesc, setFormDesc] = useState<string>('');
  const [formField, setFormField] = useState<string>('');
  const [formAction, setFormAction] = useState<'disable' | 'hide'>('disable');
  const [formQuotas, setFormQuotas] = useState<Array<{ key: string; maxAllowed: number }>>([
    { key: 'h1', maxAllowed: 1 },
    { key: 'h2', maxAllowed: 3 },
  ]);
  const [saving, setSaving] = useState<boolean>(false);

  // Scan modal state
  const [scanModalOpen, setScanModalOpen] = useState<boolean>(false);
  const [scanningRuleId, setScanningRuleId] = useState<string | null>(null);
  const [scanReport, setScanReport] = useState<any>(null);

  const handleScanRule = async (rule: ValidationRule) => {
    try {
      setScanningRuleId(rule.id);
      const res = await get(`/bulk-updater/validation-rules/${rule.id}/scan`);
      if (res.data && res.data.success) {
        setScanReport(res.data);
        setScanModalOpen(true);
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: `Scan failed: ${err.message}`,
      });
    } finally {
      setScanningRuleId(null);
    }
  };

  const fetchRules = async () => {
    try {
      setLoading(true);
      const res = await get('/bulk-updater/validation-rules');
      if (res.data && res.data.success) {
        setRules(res.data.rules || []);
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: `Failed to load rules: ${err.message}`,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  const openCreateModal = () => {
    setEditingRule(null);
    setFormName('');
    setFormDesc('');
    setFormField('headingLevel');
    setFormAction('disable');
    setFormQuotas([
      { key: 'h1', maxAllowed: 1 },
      { key: 'h2', maxAllowed: 3 },
    ]);
    setModalOpen(true);
  };

  const openEditModal = (rule: ValidationRule) => {
    setEditingRule(rule);
    setFormName(rule.name);
    setFormDesc(rule.description || '');
    setFormField(rule.targetField);
    setFormAction(rule.exceededAction || 'disable');
    const quotaPairs = Object.entries(rule.quotas || {}).map(([k, v]) => ({
      key: k,
      maxAllowed: v,
    }));
    setFormQuotas(quotaPairs.length > 0 ? quotaPairs : [{ key: 'h1', maxAllowed: 1 }]);
    setModalOpen(true);
  };

  const handleAddQuotaRow = () => {
    setFormQuotas((prev) => [...prev, { key: '', maxAllowed: 1 }]);
  };

  const handleRemoveQuotaRow = (idx: number) => {
    setFormQuotas((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleQuotaChange = (idx: number, field: 'key' | 'maxAllowed', value: any) => {
    setFormQuotas((prev) =>
      prev.map((row, i) => {
        if (i === idx) {
          return {
            ...row,
            [field]: field === 'maxAllowed' ? Math.max(1, parseInt(value, 10) || 1) : String(value).trim(),
          };
        }
        return row;
      })
    );
  };

  const handleSave = async () => {
    if (!formName.trim() || !formField.trim()) {
      toggleNotification({
        type: 'warning',
        message: 'Rule Name and Target Field are required.',
      });
      return;
    }

    const quotasRecord: Record<string, number> = {};
    for (const q of formQuotas) {
      if (q.key.trim()) {
        quotasRecord[q.key.trim().toLowerCase()] = q.maxAllowed;
      }
    }

    if (Object.keys(quotasRecord).length === 0) {
      toggleNotification({
        type: 'warning',
        message: 'At least one quota option with a limit is required.',
      });
      return;
    }

    try {
      setSaving(true);
      const payload: Partial<ValidationRule> = {
        id: editingRule ? editingRule.id : undefined,
        name: formName.trim(),
        description: formDesc.trim(),
        targetField: formField.trim(),
        quotas: quotasRecord,
        exceededAction: formAction,
        enabled: editingRule ? editingRule.enabled : true,
        scope: 'entry',
      };

      const res = await post('/bulk-updater/validation-rules', { rule: payload });
      if (res.data && res.data.success) {
        toggleNotification({
          type: 'success',
          message: `Rule "${payload.name}" saved successfully!`,
        });
        setModalOpen(false);
        fetchRules();
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: `Failed to save rule: ${err.message}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rule: ValidationRule) => {
    try {
      const res = await post(`/bulk-updater/validation-rules/${rule.id}/toggle`, {
        enabled: !rule.enabled,
      });
      if (res.data && res.data.success) {
        setRules((prev) =>
          prev.map((r) => (r.id === rule.id ? { ...r, enabled: !rule.enabled } : r))
        );
        toggleNotification({
          type: 'info',
          message: `Rule "${rule.name}" is now ${!rule.enabled ? 'ACTIVE' : 'DISABLED'}.`,
        });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: `Failed to update rule status: ${err.message}`,
      });
    }
  };

  const handleDelete = async (ruleId: string, ruleName: string) => {
    if (!window.confirm(`Are you sure you want to delete the rule "${ruleName}"?`)) return;

    try {
      const res = await del(`/bulk-updater/validation-rules/${ruleId}`);
      if (res.data && res.data.success) {
        setRules((prev) => prev.filter((r) => r.id !== ruleId));
        toggleNotification({
          type: 'success',
          message: `Rule "${ruleName}" deleted.`,
        });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: `Failed to delete rule: ${err.message}`,
      });
    }
  };

  return (
    <Box>
      {/* Header Panel */}
      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius marginBottom={6}>
        <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
          <Box>
            <Typography variant="delta" tag="h2" fontWeight="bold">
              Cross-Component Validation & Quota Rules
            </Typography>
            <Typography variant="pi" textColor="neutral600" style={{ marginTop: 4 }}>
              Define and enforce limits across Dynamic Zone components without writing code. Changes take effect immediately in both Admin edit view and Document Service APIs.
            </Typography>
          </Box>
          <Flex gap={2}>
            <Button
              variant="tertiary"
              startIcon={<ArrowClockwise />}
              onClick={fetchRules}
              loading={loading}
            >
              Refresh
            </Button>
            <Button
              variant="default"
              startIcon={<Plus />}
              onClick={openCreateModal}
            >
              Create New Rule
            </Button>
          </Flex>
        </Flex>
      </Box>

      {/* Rules Table */}
      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
        <Typography variant="sigma" textColor="neutral600" marginBottom={3} style={{ display: 'block' }}>
          CONFIGURED RULES ({rules.length})
        </Typography>

        {loading ? (
          <Typography variant="omega" textColor="neutral500">Loading validation rules...</Typography>
        ) : rules.length === 0 ? (
          <Alert variant="info" title="No Rules Defined">
            Click "Create New Rule" above to add your first cross-component quota rule.
          </Alert>
        ) : (
          <Table colCount={6} rowCount={rules.length + 1}>
            <Thead>
              <Tr>
                <Th><Typography variant="sigma">RULE NAME & TARGET FIELD</Typography></Th>
                <Th><Typography variant="sigma">DESCRIPTION</Typography></Th>
                <Th><Typography variant="sigma">QUOTA CONSTRAINTS</Typography></Th>
                <Th><Typography variant="sigma">EXCEEDED ACTION</Typography></Th>
                <Th><Typography variant="sigma">STATUS</Typography></Th>
                <Th style={{ textAlign: 'right' }}><Typography variant="sigma">ACTIONS</Typography></Th>
              </Tr>
            </Thead>
            <Tbody>
              {rules.map((rule) => {
                const quotaKeys = Object.entries(rule.quotas || {});
                return (
                  <Tr key={rule.id}>
                    <Td style={{ minWidth: 200 }}>
                      <Typography variant="omega" fontWeight="bold" textColor="neutral800" display="block">
                        {rule.name}
                      </Typography>
                      <Typography variant="pi" textColor="neutral500">
                        Target Field: <code>{rule.targetField}</code>
                      </Typography>
                    </Td>
                    <Td style={{ maxWidth: 300 }}>
                      <Typography variant="pi" textColor="neutral600">
                        {rule.description || '—'}
                      </Typography>
                    </Td>
                    <Td style={{ minWidth: 220 }}>
                      <Flex gap={1} wrap="wrap">
                        {quotaKeys.map(([optVal, maxVal]) => (
                          <Badge key={optVal} backgroundColor="neutral100" textColor="primary700">
                            <strong>{optVal.toUpperCase()}</strong>: max {maxVal}
                          </Badge>
                        ))}
                      </Flex>
                    </Td>
                    <Td style={{ minWidth: 120 }}>
                      <Badge
                        backgroundColor={rule.exceededAction === 'hide' ? 'secondary100' : 'warning100'}
                        textColor={rule.exceededAction === 'hide' ? 'secondary700' : 'warning700'}
                      >
                        {rule.exceededAction.toUpperCase()}
                      </Badge>
                    </Td>
                    <Td style={{ minWidth: 100 }}>
                      <Button
                        variant={rule.enabled ? 'success-light' : 'tertiary'}
                        size="S"
                        onClick={() => handleToggle(rule)}
                      >
                        {rule.enabled ? '● ACTIVE' : '○ DISABLED'}
                      </Button>
                    </Td>
                    <Td style={{ textAlign: 'right', minWidth: 260 }}>
                      <Flex gap={2} justifyContent="flex-end">
                        <Button
                          variant="secondary"
                          size="S"
                          startIcon={<Search />}
                          onClick={() => handleScanRule(rule)}
                          loading={scanningRuleId === rule.id}
                        >
                          Scan Violations
                        </Button>
                        <Button
                          variant="tertiary"
                          size="S"
                          onClick={() => openEditModal(rule)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="danger-light"
                          size="S"
                          startIcon={<Trash />}
                          onClick={() => handleDelete(rule.id, rule.name)}
                        >
                          Delete
                        </Button>
                      </Flex>
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </Box>

      {/* Create / Edit Rule Modal */}
      {modalOpen && (
        <Box
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(33, 33, 52, 0.65)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Box
            background="neutral0"
            hasRadius
            shadow="popupShadow"
            padding={6}
            style={{ width: '90%', maxWidth: 620, maxHeight: '90vh', overflowY: 'auto' }}
          >
            <Typography variant="delta" tag="h2" fontWeight="bold" marginBottom={1}>
              {editingRule ? 'Edit Validation Rule' : 'Create New Validation Rule'}
            </Typography>
            <Typography variant="pi" textColor="neutral600" marginBottom={4} style={{ display: 'block' }}>
              Configure cross-component limits. The rule will automatically apply to any Dynamic Zone or Component using this attribute.
            </Typography>

            <Flex direction="column" gap={4} alignItems="stretch">
              <TextInput
                label="Rule Name"
                placeholder="e.g. SEO Single H1 Rule"
                value={formName}
                onChange={(e: any) => setFormName(e.target.value)}
                required
              />

              <TextInput
                label="Target Field Name"
                placeholder="e.g. headingLevel, titleStyle, or color"
                value={formField}
                onChange={(e: any) => setFormField(e.target.value)}
                hint="Attribute name on the component/customField to monitor across the entry."
                required
              />

              <Textarea
                label="Rule Description"
                placeholder="Briefly explain what this constraint accomplishes..."
                value={formDesc}
                onChange={(e: any) => setFormDesc(e.target.value)}
              />

              <SingleSelect
                label="When Quota Is Exceeded in Another Component"
                value={formAction}
                onChange={(val: any) => setFormAction(val as 'disable' | 'hide')}
              >
                <SingleSelectOption value="disable">
                  Disable Option with Usage Badge [(1/1 used)]
                </SingleSelectOption>
                <SingleSelectOption value="hide">
                  Hide Option completely from dropdown menu
                </SingleSelectOption>
              </SingleSelect>

              {/* Quotas Editor */}
              <Box
                padding={4}
                background="neutral100"
                hasRadius
                style={{ border: '1px solid #e0e0e0' }}
              >
                <Flex justifyContent="space-between" alignItems="center" marginBottom={3}>
                  <Box>
                    <Typography variant="pi" fontWeight="bold" textColor="neutral800">
                      Option Quotas (Max Allowed per Entry)
                    </Typography>
                    <Typography variant="pi" textColor="neutral600" style={{ display: 'block' }}>
                      Options left unlisted will have unlimited usage.
                    </Typography>
                  </Box>
                  <Button
                    variant="secondary"
                    size="S"
                    startIcon={<Plus />}
                    onClick={handleAddQuotaRow}
                  >
                    Add Option
                  </Button>
                </Flex>

                <Flex direction="column" gap={2}>
                  {formQuotas.map((q, idx) => (
                    <Flex key={idx} gap={2} alignItems="center">
                      <Box style={{ flex: 2 }}>
                        <TextInput
                          placeholder="Option key (e.g. h1)"
                          value={q.key}
                          onChange={(e: any) => handleQuotaChange(idx, 'key', e.target.value)}
                        />
                      </Box>
                      <Box style={{ flex: 1 }}>
                        <TextInput
                          type="number"
                          placeholder="Max"
                          value={String(q.maxAllowed)}
                          onChange={(e: any) => handleQuotaChange(idx, 'maxAllowed', e.target.value)}
                        />
                      </Box>
                      <Button
                        variant="ghost"
                        size="S"
                        onClick={() => handleRemoveQuotaRow(idx)}
                        disabled={formQuotas.length <= 1}
                      >
                        ✕
                      </Button>
                    </Flex>
                  ))}
                </Flex>
              </Box>
            </Flex>

            {/* Modal Actions */}
            <Flex justifyContent="flex-end" gap={2} marginTop={6}>
              <Button
                variant="tertiary"
                onClick={() => setModalOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                startIcon={<Check />}
                onClick={handleSave}
                loading={saving}
              >
                Save Rule
              </Button>
            </Flex>
          </Box>
        </Box>
      )}

      {/* Scan Results Modal */}
      {scanModalOpen && scanReport && (
        <Box
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(33, 33, 52, 0.65)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Box
            background="neutral0"
            hasRadius
            shadow="popupShadow"
            padding={6}
            style={{ width: '90%', maxWidth: 780, maxHeight: '85vh', overflowY: 'auto' }}
          >
            <Flex justifyContent="space-between" alignItems="center" marginBottom={4}>
              <Box>
                <Typography variant="beta" tag="h2" fontWeight="bold">
                  Rule Violation Audit: {scanReport.rule?.name}
                </Typography>
                <Typography variant="pi" textColor="neutral600">
                  Target Field: <code>{scanReport.rule?.targetField}</code> • Total Entries Scanned: {scanReport.totalScanned}
                </Typography>
              </Box>
              <Badge
                backgroundColor={scanReport.totalViolations > 0 ? 'danger100' : 'success100'}
                textColor={scanReport.totalViolations > 0 ? 'danger700' : 'success700'}
                size="M"
              >
                {scanReport.totalViolations > 0
                  ? `${scanReport.totalViolations} VIOLATION(S) FOUND`
                  : '100% COMPLIANT'}
              </Badge>
            </Flex>

            {scanReport.totalViolations === 0 ? (
              <Alert variant="success" title="No Pre-Existing Violations Detected" marginBottom={4}>
                All existing documents across your collections adhere strictly to the configured quota limits.
              </Alert>
            ) : (
              <Box>
                <Alert variant="danger" title="Legacy Records Found Exceeding Quota" marginBottom={4}>
                  The following {scanReport.totalViolations} record(s) contain more instances of restricted options than currently permitted by this rule.
                </Alert>

                <Table colCount={4} rowCount={scanReport.violations.length + 1}>
                  <Thead>
                    <Tr>
                      <Th><Typography variant="sigma">CONTENT TYPE & ENTRY</Typography></Th>
                      <Th><Typography variant="sigma">RESTRICTED OPTION</Typography></Th>
                      <Th><Typography variant="sigma">COUNT VS LIMIT</Typography></Th>
                      <Th style={{ textAlign: 'right' }}><Typography variant="sigma">ACTION</Typography></Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {scanReport.violations.map((v: any, idx: number) => (
                      <Tr key={idx}>
                        <Td>
                          <Typography variant="omega" fontWeight="bold">
                            {v.entryLabel}
                          </Typography>
                          <Typography variant="pi" textColor="neutral500" display="block">
                            Collection: {v.collectionDisplayName}
                          </Typography>
                        </Td>
                        <Td>
                          <Badge backgroundColor="warning100" textColor="warning700">
                            {v.violatingOption}
                          </Badge>
                        </Td>
                        <Td>
                          <Typography variant="omega" textColor="danger600" fontWeight="bold">
                            {v.foundCount} used
                          </Typography>
                          <Typography variant="pi" textColor="neutral500">
                            {' '}(Allowed max: {v.maxAllowed})
                          </Typography>
                        </Td>
                        <Td style={{ textAlign: 'right' }}>
                          <Button
                            variant="secondary"
                            size="S"
                            onClick={() => window.open(v.editUrl, '_blank')}
                          >
                            Open in Editor ↗
                          </Button>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </Box>
            )}

            <Flex justifyContent="space-between" alignItems="center" marginTop={6}>
              {scanReport.totalViolations > 0 ? (
                <Button
                  variant="secondary"
                  startIcon={<Download />}
                  onClick={async () => {
                    try {
                      const res = await get(`/bulk-updater/csv/export-violations/${scanReport.rule.id}`);
                      const csvStr = res.data?.csvContent || (typeof res.data === 'string' ? res.data : '');
                      if (!csvStr) {
                        toggleNotification({
                          type: 'warning',
                          message: 'No violation data to export',
                        });
                        return;
                      }
                      const blob = new Blob([csvStr], { type: 'text/csv;charset=utf-8;' });
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement('a');
                      link.href = url;
                      link.setAttribute('download', `violations_${scanReport.rule.id}.csv`);
                      document.body.appendChild(link);
                      link.click();
                      document.body.removeChild(link);
                      URL.revokeObjectURL(url);
                      toggleNotification({
                        type: 'success',
                        message: 'Violations exported to CSV successfully',
                      });
                    } catch (e: any) {
                      toggleNotification({
                        type: 'danger',
                        message: e.message || 'Failed exporting violations CSV',
                      });
                    }
                  }}
                >
                  Export Violations CSV
                </Button>
              ) : (
                <Box />
              )}
              <Button variant="default" onClick={() => setScanModalOpen(false)}>
                Close Report
              </Button>
            </Flex>
          </Box>
        </Box>
      )}
    </Box>
  );
}
