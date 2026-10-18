import React from 'react';
import { PLUGIN_ID } from './pluginId';
import { Pencil, ClockCounterClockwise } from '@strapi/icons';

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
