import routes from './routes';
import bulkUpdaterController from './controllers/bulk-updater';
import licenseController from './controllers/license';
import auditController from './controllers/audit';
import bulkUpdaterService from './services/bulk-updater';
import licenseService from './services/license';
import auditService from './services/audit';

export default {
  register({ strapi }: { strapi: any }) {},
  bootstrap({ strapi }: { strapi: any }) {},
  routes,
  controllers: {
    bulkUpdater: bulkUpdaterController,
    license: licenseController,
    audit: auditController,
  },
  services: {
    bulkUpdater: bulkUpdaterService,
    license: licenseService,
    audit: auditService,
  },
};
