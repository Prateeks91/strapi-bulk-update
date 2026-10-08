import React from 'react';
import {
  Box,
  Flex,
  Typography,
  Badge,
} from '@strapi/design-system';
import { Check } from '@strapi/icons';
import ValidationRulesTab from './ValidationRulesTab';

const ALL_FEATURES = [
  'Cross-collection batch attribute & relationship updates',
  'Interactive schema compatibility & target selection',
  'Full regex find & replace with live diff previews',
  'Dynamic cross-component quota validation (UI-configurable)',
  'Enterprise Maker-Checker 4-Eyes approval workflow',
  'Server-enforced off-peak execution maintenance window',
  '3-Tier comprehensive audit logging with one-click reversible rollback',
  'Zero-infra memory caching & pod-level ETag optimization',
];

const SettingsPage: React.FC = () => {
  return (
    <Box padding={8} background="neutral100">
      <Flex direction="column" alignItems="flex-start" gap={2} marginBottom={6}>
        <Flex justifyContent="space-between" width="100%">
          <Box>
            <Typography variant="alpha" tag="h1" fontWeight="bold">
              Bulk Attribute Updater Settings
            </Typography>
            <Typography variant="omega" textColor="neutral600">
              Configure cross-component validation rules, manage quotas, and view active plugin capabilities.
            </Typography>
          </Box>
        </Flex>
      </Flex>

      {/* Plugin Status Card */}
      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius marginBottom={6}>
        <Flex justifyContent="space-between" alignItems="center" marginBottom={4}>
          <Box>
            <Typography variant="delta" tag="h2" fontWeight="semiBold">
              Plugin Status
            </Typography>
            <Typography variant="pi" textColor="neutral600">
              All features are fully unlocked, active, and free under the MIT open-source license.
            </Typography>
          </Box>
          <Badge backgroundColor="success100" textColor="success700" size="M">
            COMMUNITY & ENTERPRISE UNLOCKED
          </Badge>
        </Flex>

        {/* Features Checklist */}
        <Box marginTop={4}>
          <Typography variant="pi" fontWeight="bold" textColor="neutral700" marginBottom={3}>
            Active Capabilities:
          </Typography>
          <Flex direction="column" gap={2} alignItems="flex-start" marginTop={2}>
            {ALL_FEATURES.map((feat, i) => (
              <Flex key={i} gap={2} alignItems="center">
                <Check width="16px" height="16px" color="#328048" />
                <Typography variant="omega">{feat}</Typography>
              </Flex>
            ))}
          </Flex>
        </Box>
      </Box>

      {/* Validation Rules Section */}
      <Box marginTop={6}>
        <ValidationRulesTab />
      </Box>
    </Box>
  );
};

export default SettingsPage;
