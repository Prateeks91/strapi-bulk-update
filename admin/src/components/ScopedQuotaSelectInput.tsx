import * as React from 'react';
import {
  Field,
  SingleSelect,
  SingleSelectOption,
  Box,
  Typography,
} from '@strapi/design-system';
import { useForm } from '@strapi/admin/strapi-admin';
import { useFetchClient } from '@strapi/strapi/admin';

export interface QuotaItem {
  value: string;
  label: string;
  maxAllowed?: number | null; // e.g. 1 for H1, 3 for H2, null for unlimited
}

export interface ScopedQuotaSelectProps {
  name: string;
  value?: string | null;
  onChange: (e: { target: { name: string; value: string } }) => void;
  attribute?: {
    type?: string;
    customField?: string;
    options?: {
      scope?: 'entry' | 'zone';
      disabledBehavior?: 'disable' | 'hide';
      items?: QuotaItem[];
    };
  };
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  label?: React.ReactNode;
  hint?: React.ReactNode;
}

// Default fallback options if none configured on the attribute
const DEFAULT_HEADING_ITEMS: QuotaItem[] = [
  { value: 'h1', label: 'H1 - Main Page Title', maxAllowed: 1 },
  { value: 'h2', label: 'H2 - Primary Section Heading', maxAllowed: 3 },
  { value: 'h3', label: 'H3 - Sub-section Heading', maxAllowed: null },
  { value: 'h4', label: 'H4 - Component Title', maxAllowed: null },
  { value: 'h5', label: 'H5 - Card / Item Heading', maxAllowed: null },
  { value: 'h6', label: 'H6 - Minor Heading', maxAllowed: null },
];

function cleanKey(str: string): string {
  return (str || '').replace(/[-_]/g, '').toLowerCase().trim();
}

function matchesPath(normalizedPath: string, leafKey: string, targetField: string): boolean {
  if (!targetField) return false;
  const pClean = cleanKey(normalizedPath);
  const kClean = cleanKey(leafKey);
  const tClean = cleanKey(targetField);

  if (kClean === tClean || pClean === tClean) return true;

  const targetSegments = targetField
    .replace(/^api::/i, '')
    .split('.')
    .map(cleanKey)
    .filter(Boolean);

  const pathSegments = normalizedPath
    .split('.')
    .map(cleanKey)
    .filter(Boolean);

  if (targetSegments.length === 0 || pathSegments.length === 0) return false;

  if (targetSegments.length === 1) {
    const single = targetSegments[0];
    return kClean === single || pathSegments[pathSegments.length - 1] === single;
  }

  let isSuffix = true;
  for (let i = 0; i < targetSegments.length; i++) {
    const tSeg = targetSegments[targetSegments.length - 1 - i];
    const pSeg = pathSegments[pathSegments.length - 1 - i];
    if (tSeg !== '*' && tSeg !== pSeg) {
      isSuffix = false;
      break;
    }
  }
  if (isSuffix) return true;

  for (let startIdx = 1; startIdx < targetSegments.length; startIdx++) {
    const subTarget = targetSegments.slice(startIdx);
    if (subTarget.length > pathSegments.length) continue;
    let subSuffix = true;
    for (let i = 0; i < subTarget.length; i++) {
      const tSeg = subTarget[subTarget.length - 1 - i];
      const pSeg = pathSegments[pathSegments.length - 1 - i];
      if (tSeg !== '*' && tSeg !== pSeg) {
        subSuffix = false;
        break;
      }
    }
    if (subSuffix) return true;
  }

  let pIdx = 0;
  let matchesInOrder = true;
  let tStart = 0;
  if (targetSegments.length > 2 && targetSegments[0] !== pathSegments[0] && targetSegments[0] !== '*') {
    tStart = 1;
  }
  for (let tIdx = tStart; tIdx < targetSegments.length; tIdx++) {
    const tSeg = targetSegments[tIdx];
    if (tSeg === '*') continue;
    let found = false;
    while (pIdx < pathSegments.length) {
      if (pathSegments[pIdx] === tSeg) {
        found = true;
        pIdx++;
        break;
      }
      pIdx++;
    }
    if (!found) {
      matchesInOrder = false;
      break;
    }
  }

  return matchesInOrder;
}

/**
 * Recursively traverses the entire form data tree to count occurrences of target field values,
 * excluding the current input's exact field path.
 */
function computeCrossComponentUsage(
  data: any,
  targetFieldRule: string,
  fieldLeafName: string,
  excludePath: string,
  includeRichTextHtml: boolean = false
): Record<string, number> {
  const counts: Record<string, number> = {};

  function traverse(current: any, currentPath: string) {
    if (!current || typeof current !== 'object') return;

    for (const key of Object.keys(current)) {
      const val = current[key];
      const fullPath = currentPath ? `${currentPath}.${key}` : key;
      const normalizedPath = fullPath.replace(/\.\d+/g, '');

      const isTargetMatch = matchesPath(normalizedPath, key, targetFieldRule || fieldLeafName);

      if (isTargetMatch && fullPath !== excludePath && typeof val === 'string' && val.trim()) {
        const valNorm = val.toLowerCase().trim();
        counts[valNorm] = (counts[valNorm] || 0) + 1;
      }

      // If rule checks rich text HTML, scan strings with HTML or Markdown headings
      if (includeRichTextHtml && typeof val === 'string' && (val.includes('<h') || val.includes('#'))) {
        for (let level = 1; level <= 6; level++) {
          const tag = `h${level}`;
          const htmlMatches = val.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi'));
          if (htmlMatches) {
            counts[tag] = (counts[tag] || 0) + htmlMatches.length;
          }
          const mdMatches = val.match(new RegExp(`(?:^|\\n)${'#'.repeat(level)}\\s+[^\\n]+`, 'g'));
          if (mdMatches) {
            counts[tag] = (counts[tag] || 0) + mdMatches.length;
          }
        }
      }

      if (typeof val === 'object' && val !== null) {
        traverse(val, fullPath);
      }
    }
  }

  traverse(data, '');
  return counts;
}

export default function ScopedQuotaSelectInput({
  name,
  value,
  onChange,
  attribute,
  disabled = false,
  required = false,
  placeholder,
  label,
  hint,
}: ScopedQuotaSelectProps) {
  const { get } = useFetchClient();

  // Subscribe to live Formik/Form values in Strapi v5 Admin Edit View
  const formValues = useForm('ScopedQuotaSelectInput', (state) => state.values) || {};

  // Extract the leaf property name (e.g., 'titleStyle' from 'blocks.0.titleStyle')
  const fieldLeafName = name.split('.').pop() || name;
  const normalizedFieldPath = name.replace(/\.\d+/g, '');

  // Active UI-configured rule state
  const [activeUiRule, setActiveUiRule] = React.useState<any>(null);

  React.useEffect(() => {
    let isMounted = true;
    get('/bulk-updater/validation-rules')
      .then((res: any) => {
        if (isMounted && res.data && res.data.success && Array.isArray(res.data.rules)) {
          const matching = res.data.rules.find((r: any) => {
            if (!r.enabled || !r.targetField) return false;
            return matchesPath(normalizedFieldPath, fieldLeafName, r.targetField);
          });

          if (matching) {
            setActiveUiRule(matching);
          }
        }
      })
      .catch(() => {
        // Fall back gracefully to schema options on network/auth failure
      });
    return () => {
      isMounted = false;
    };
  }, [fieldLeafName, normalizedFieldPath]);

  const optionsConfig = attribute?.options || {};

  // Dynamically merge items: include items from attribute options, UI rules, or default headings
  const items: QuotaItem[] = React.useMemo(() => {
    const rawItems: QuotaItem[] = optionsConfig.items && optionsConfig.items.length > 0
      ? optionsConfig.items
      : [];

    const map = new Map<string, QuotaItem>();
    rawItems.forEach((it) => {
      map.set((it.value || '').toLowerCase().trim(), { ...it });
    });

    if (activeUiRule?.quotas) {
      for (const [k, max] of Object.entries(activeUiRule.quotas)) {
        const lowerK = k.toLowerCase().trim();
        if (map.has(lowerK)) {
          const existing = map.get(lowerK)!;
          map.set(lowerK, {
            ...existing,
            maxAllowed: typeof max === 'number' ? max : existing.maxAllowed,
          });
        } else {
          // If option not in schema items, add it preserving the user-defined casing
          map.set(lowerK, {
            value: k, // preserve original casing from rule, e.g. "H1"
            label: k.toUpperCase(),
            maxAllowed: typeof max === 'number' ? max : null,
          });
        }
      }
    }

    if (map.size === 0) {
      DEFAULT_HEADING_ITEMS.forEach((it) => map.set(it.value.toLowerCase().trim(), { ...it }));
    }

    return Array.from(map.values());
  }, [optionsConfig.items, activeUiRule]);

  const disabledBehavior = activeUiRule?.exceededAction || optionsConfig.disabledBehavior || 'disable';

  // Compute other components' usage across the entire entry (and rich text HTML if rule enabled)
  const otherUsage = React.useMemo(() => {
    return computeCrossComponentUsage(
      formValues,
      activeUiRule?.targetField || fieldLeafName,
      fieldLeafName,
      name,
      Boolean(activeUiRule?.includeRichTextHtml)
    );
  }, [formValues, fieldLeafName, name, activeUiRule]);

  // Compute processed options: evaluate quotas and apply disable or hide rules
  const processedOptions = React.useMemo(() => {
    return items
      .map((item) => {
        const itemValLower = (item.value || '').toLowerCase().trim();
        const usedCount = otherUsage[itemValLower] || 0;
        const max = item.maxAllowed;

        // Quota is exhausted if other components have already reached maxAllowed
        const isQuotaReached = typeof max === 'number' && max > 0 && usedCount >= max;

        // Check if current field already holds this value (case-insensitively)
        const isCurrentValue = (value || '').toLowerCase().trim() === itemValLower;
        const isDisabled = isQuotaReached && !isCurrentValue;

        let quotaNotice = '';
        if (typeof max === 'number' && max > 0) {
          quotaNotice = `(${usedCount}/${max} used)`;
        }

        return {
          ...item,
          isDisabled,
          quotaNotice,
          isQuotaReached,
        };
      })
      .filter((item) => {
        if (disabledBehavior === 'hide' && item.isDisabled) {
          return false;
        }
        return true;
      });
  }, [items, otherUsage, value, disabledBehavior]);

  // Identify options whose quota has been exhausted by other components
  const exhaustedItems = React.useMemo(() => {
    return items.filter((i) => {
      const iValLower = (i.value || '').toLowerCase().trim();
      const isCurrentValue = (value || '').toLowerCase().trim() === iValLower;
      return (
        typeof i.maxAllowed === 'number' &&
        i.maxAllowed > 0 &&
        (otherUsage[iValLower] || 0) >= i.maxAllowed &&
        !isCurrentValue
      );
    });
  }, [items, otherUsage, value]);

  const handleChange = (selectedVal: string) => {
    if (onChange) {
      onChange({ target: { name, value: selectedVal } });
    }
  };

  const displayLabel = label || activeUiRule?.name || (fieldLeafName.charAt(0).toUpperCase() + fieldLeafName.slice(1));
  const displayPlaceholder = placeholder || `Select ${displayLabel}...`;
  const matchedItemValue = items.find((it) => (it.value || '').toLowerCase().trim() === (value || '').toLowerCase().trim())?.value || (value || '');

  return (
    <Field.Root name={name} required={required}>
      {displayLabel && <Field.Label>{displayLabel}</Field.Label>}
      <SingleSelect
        placeholder={displayPlaceholder}
        value={matchedItemValue}
        onChange={handleChange}
        disabled={disabled}
      >
        {processedOptions.map((opt) => (
          <SingleSelectOption
            key={opt.value}
            value={opt.value}
            disabled={opt.isDisabled}
          >
            {opt.label}{' '}
            {opt.quotaNotice && (
              <span style={{ opacity: 0.65, fontSize: '0.85em', marginLeft: 6 }}>
                [{opt.quotaNotice}]
              </span>
            )}
          </SingleSelectOption>
        ))}
      </SingleSelect>
      {hint && <Field.Hint>{hint}</Field.Hint>}

      {exhaustedItems.length > 0 && (
        <Box paddingTop={1}>
          {exhaustedItems.map((item) => (
            <Typography
              key={item.value}
              variant="pi"
              textColor="neutral600"
              style={{ display: 'block', marginTop: 2 }}
            >
              ℹ️ <strong>{item.label}</strong> quota reached (Max {item.maxAllowed} per entry).
            </Typography>
          ))}
        </Box>
      )}
    </Field.Root>
  );
}
