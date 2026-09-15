import { PLUGIN_ID } from './pluginId';
import { Pencil } from '@strapi/icons';

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
        defaultMessage: 'Bulk Updater License',
      },
      to: `${PLUGIN_ID}`,
      Component: () => import('./pages/SettingsPage'),
      permissions: [],
    });

    app.registerPlugin({
      id: PLUGIN_ID,
      name: PLUGIN_ID,
    });
  },
  bootstrap(app: any) {},
};
