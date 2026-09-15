import React, { useEffect, useState } from 'react';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import {
  Box,
  Flex,
  Typography,
  Button,
  TextInput,
  Badge,
  Alert,
} from '@strapi/design-system';
import { Check, ArrowClockwise } from '@strapi/icons';

interface LicenseStatus {
  isPro: boolean;
  tier: 'free' | 'pro' | 'enterprise';
  licenseKey: string | null;
  licensedTo: string | null;
  activatedAt: string | null;
  features: string[];
}

const SettingsPage: React.FC = () => {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState<string>('');

  const fetchLicense = async () => {
    try {
      setLoading(true);
      const res = await get('/bulk-updater/license');
      if (res.data && res.data.success) {
        setLicense(res.data.license);
        if (res.data.license?.licenseKey) {
          setLicenseKeyInput(res.data.license.licenseKey);
        }
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err.message || 'Failed to fetch license info.',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLicense();
  }, []);

  const handleActivate = async () => {
    if (!licenseKeyInput.trim()) {
      toggleNotification({
        type: 'warning',
        message: 'Please enter a license key to activate.',
      });
      return;
    }

    try {
      setSaving(true);
      const res = await post('/bulk-updater/license/verify', {
        licenseKey: licenseKeyInput.trim(),
      });

      if (res.data && res.data.success) {
        setLicense(res.data.license);
        toggleNotification({
          type: 'success',
          message: 'Pro license activated successfully! Pro features unlocked.',
        });
      } else {
        toggleNotification({
          type: 'danger',
          message: res.data?.error || 'Failed to activate license.',
        });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err.response?.data?.error || err.message || 'Verification error.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async () => {
    try {
      setSaving(true);
      const res = await post('/bulk-updater/license/deactivate');
      if (res.data && res.data.success) {
        setLicense(res.data.license);
        setLicenseKeyInput('');
        toggleNotification({
          type: 'info',
          message: 'License deactivated. Returned to Free tier.',
        });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err.message || 'Deactivation error.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box padding={8} background="neutral100">
      <Flex direction="column" alignItems="flex-start" gap={2} marginBottom={6}>
        <Flex justifyContent="space-between" width="100%">
          <Box>
            <Typography variant="alpha" tag="h1" fontWeight="bold">
              Bulk Attribute Updater - License & Settings
            </Typography>
            <Typography variant="omega" textColor="neutral600">
              Manage your Pro tier license key, view active capabilities, and unlock advanced bulk update features.
            </Typography>
          </Box>
          <Button
            startIcon={<ArrowClockwise />}
            variant="tertiary"
            onClick={fetchLicense}
            loading={loading}
          >
            Refresh
          </Button>
        </Flex>
      </Flex>

      {/* License Status Card */}
      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius marginBottom={6}>
        <Flex justifyContent="space-between" alignItems="center" marginBottom={4}>
          <Box>
            <Typography variant="delta" tag="h2" fontWeight="semiBold">
              Current License Status
            </Typography>
            <Typography variant="pi" textColor="neutral600">
              {license?.isPro
                ? `Active ${license.tier.toUpperCase()} license registered to ${license.licensedTo}.`
                : 'You are currently using the Free Community Edition.'}
            </Typography>
          </Box>
          <Badge
            backgroundColor={license?.isPro ? 'success100' : 'neutral200'}
            textColor={license?.isPro ? 'success700' : 'neutral700'}
            size="M"
          >
            {license?.isPro ? `${license.tier.toUpperCase()} EDITION` : 'COMMUNITY EDITION (FREE)'}
          </Badge>
        </Flex>

        {license?.isPro && (
          <Alert variant="success" title="License Active" marginBottom={4}>
            Pro features are unlocked! Activated on {new Date(license.activatedAt || '').toLocaleDateString()}.
          </Alert>
        )}

        {/* License Input */}
        <Flex gap={4} alignItems="flex-end" wrap="wrap" marginTop={4}>
          <Box style={{ flex: 1, minWidth: 320 }}>
            <TextInput
              label="License Key"
              name="licenseKey"
              placeholder="e.g. PRO-XXXX-XXXX-XXXX"
              value={licenseKeyInput}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setLicenseKeyInput(e.target.value)
              }
              hint="Enter your Gumroad, LemonSqueezy, or Pro license key (keys starting with PRO- or ENTERPRISE- are valid)."
            />
          </Box>
          <Flex gap={2}>
            <Button
              startIcon={<Check />}
              variant="default"
              onClick={handleActivate}
              loading={saving}
              disabled={loading || !licenseKeyInput.trim()}
            >
              Activate Key
            </Button>
            {license?.isPro && (
              <Button
                variant="danger"
                onClick={handleDeactivate}
                loading={saving}
              >
                Deactivate
              </Button>
            )}
          </Flex>
        </Flex>
      </Box>

      {/* Features Checklist */}
      <Box padding={6} background="neutral0" shadow="filterShadow" hasRadius>
        <Typography variant="delta" tag="h2" fontWeight="semiBold" marginBottom={3}>
          Feature Availability
        </Typography>
        <Flex direction="column" gap={2} alignItems="flex-start">
          {(license?.features || []).map((feat, i) => (
            <Flex key={i} gap={2} alignItems="center">
              <Check width="16px" height="16px" color="#328048" />
              <Typography variant="omega">{feat}</Typography>
            </Flex>
          ))}
        </Flex>
      </Box>
    </Box>
  );
};

export default SettingsPage;
