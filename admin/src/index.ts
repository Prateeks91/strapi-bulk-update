import React from 'react';
import { PLUGIN_ID } from './pluginId';
import { Pencil, ClockCounterClockwise } from '@strapi/icons';

function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showQuotaErrorToast(message: string) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('strapi-quota-validation-banner');
  if (existing) existing.remove();

  let title = 'Validation Error';
  let detail = message;
  const match = message.match(/^(Validation Error \([^)]+\)):\s*(.+)$/s);
  if (match) {
    title = match[1];
    detail = match[2];
  }

  const banner = document.createElement('div');
  banner.id = 'strapi-quota-validation-banner';
  banner.style.position = 'fixed';
  banner.style.top = '24px';
  banner.style.left = '50%';
  banner.style.transform = 'translateX(-50%)';
  banner.style.zIndex = '999999';
  banner.style.minWidth = '420px';
  banner.style.maxWidth = '720px';
  banner.style.backgroundColor = '#D02B20';
  banner.style.color = '#FFFFFF';
  banner.style.padding = '14px 20px';
  banner.style.borderRadius = '6px';
  banner.style.boxShadow = '0 10px 25px rgba(0,0,0,0.35)';
  banner.style.display = 'flex';
  banner.style.alignItems = 'flex-start';
  banner.style.gap = '12px';
  banner.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  banner.style.fontSize = '14px';
  banner.style.lineHeight = '1.45';
  banner.style.transition = 'opacity 0.2s ease-in-out';

  banner.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; margin-top: 1px;">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="12"></line>
      <line x1="12" y1="16" x2="12.01" y2="16"></line>
    </svg>
    <div style="flex: 1;">
      <div style="font-weight: 700; margin-bottom: 2px;">${escapeHtml(title)}</div>
      <div style="opacity: 0.95;">${escapeHtml(detail)}</div>
    </div>
    <button style="background: none; border: none; color: #FFF; cursor: pointer; padding: 0 4px; font-size: 18px; line-height: 1; opacity: 0.8;" onclick="this.parentElement.remove()">×</button>
  `;

  document.body.appendChild(banner);

  setTimeout(() => {
    if (banner.parentElement) {
      banner.style.opacity = '0';
      setTimeout(() => banner.remove(), 250);
    }
  }, 10000);
}

export default {
  register(app: any) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: Pencil,
      intlLabel: {
        id: `${PLUGIN_ID}.plugin.name`,
        defaultMessage: 'Bulk Attribute Updater',
      },
      Component: () => import('./pages/BulkUpdater'),
      permissions: [],
      position: 3,
    });

    app.addSettingsLink('global', {
      id: `${PLUGIN_ID}-settings`,
      intlLabel: {
        id: `${PLUGIN_ID}.settings.name`,
        defaultMessage: 'Bulk Updater Settings',
      },
      to: `${PLUGIN_ID}`,
      Component: () => import('./pages/SettingsPage'),
      permissions: [],
    });

    app.registerPlugin({
      id: PLUGIN_ID,
      name: PLUGIN_ID,
    });

    app.customFields.register({
      name: 'scoped-select',
      pluginId: PLUGIN_ID,
      type: 'string',
      intlLabel: {
        id: `${PLUGIN_ID}.scoped-select.label`,
        defaultMessage: 'Scoped Quota Select',
      },
      intlDescription: {
        id: `${PLUGIN_ID}.scoped-select.description`,
        defaultMessage: 'Dropdown with dynamic cross-component usage quota enforcement',
      },
      components: {
        Input: async () => import('./components/ScopedQuotaSelectInput'),
      },
    });
  },
  bootstrap(app: any) {
    // Install global response interceptor for quota validation rule error banners
    if (typeof window !== 'undefined' && !(window as any).__bulk_updater_interceptor_installed) {
      (window as any).__bulk_updater_interceptor_installed = true;

      if (window.fetch) {
        const origFetch = window.fetch;
        window.fetch = async function (...args) {
          const response = await origFetch.apply(this, args);
          if (response.status === 400 || response.status === 422 || response.status === 500) {
            try {
              const clone = response.clone();
              const data = await clone.json();
              const errMsg = data?.error?.message || data?.message;
              if (
                typeof errMsg === 'string' &&
                (errMsg.startsWith('Validation Error') || errMsg.includes('cannot appear more than'))
              ) {
                showQuotaErrorToast(errMsg);
              }
            } catch {}
          }
          return response;
        };
      }

      if ((window as any).XMLHttpRequest) {
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (...args: any[]) {
          this.addEventListener('load', function () {
            if (this.status === 400 || this.status === 422 || this.status === 500) {
              try {
                const data = JSON.parse(this.responseText);
                const errMsg = data?.error?.message || data?.message;
                if (
                  typeof errMsg === 'string' &&
                  (errMsg.startsWith('Validation Error') || errMsg.includes('cannot appear more than'))
                ) {
                  showQuotaErrorToast(errMsg);
                }
              } catch {}
            }
          });
          return origOpen.apply(this, args as any);
        };
      }
    }
    try {
      const contentManagerPlugin = app.getPlugin('content-manager');
      if (contentManagerPlugin?.apis?.addDocumentAction) {
        contentManagerPlugin.apis.addDocumentAction((actions: any[]) => {
          if (window.strapi?.features?.isEnabled?.('cms-content-history')) {
            return actions;
          }

          const hasHistory = actions.some((a: any) => a.type === 'history' || a.id === 'content-history');
          if (hasHistory) return actions;

          const customHistoryAction = ({ model, document }: any) => {
            if (window.strapi?.features?.isEnabled?.('cms-content-history')) {
              return null;
            }

            return {
              icon: React.createElement(ClockCounterClockwise, {}),
              label: 'Content History',
              onClick: () => {
                const currentPath = window.location.pathname.replace(/\/$/, '');
                if (!currentPath.endsWith('/history')) {
                  window.location.href = `${currentPath}/history${window.location.search}`;
                }
              },
              disabled: !document || !document.id || !model?.startsWith('api::'),
              position: 'header',
            };
          };
          customHistoryAction.type = 'history';
          customHistoryAction.position = 'header';

          const deleteIndex = actions.findIndex((a: any) => a.type === 'delete');
          if (deleteIndex !== -1) {
            actions.splice(deleteIndex, 0, customHistoryAction);
          } else {
            actions.push(customHistoryAction);
          }
          return actions;
        });
      }
    } catch {}
  },
};
