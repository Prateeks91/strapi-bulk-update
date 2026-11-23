export interface HasPermissionsPolicyConfig {
  actions: string[];
  mode?: 'all' | 'any';
}

/**
 * Granular RBAC policy for Strapi 5 Bulk Updater plugin.
 *
 * Supports:
 * - Single action checks
 * - Multiple actions with 'all' (AND) or 'any' (OR) logic
 * - Super admin automatic bypass (Strapi 5 admin super admin)
 * - CASL Ability (userAbility.can)
 * - Permissions list fallback (for standalone / mock execution)
 */
export default (policyContext: any, config: any, { strapi }: { strapi?: any } = {}) => {
  const ctx = policyContext?.isSelect ? policyContext : (policyContext?.context || policyContext);

  let actions: string[] = [];
  let mode: 'all' | 'any' = 'all';

  if (Array.isArray(config)) {
    actions = config;
  } else if (config && typeof config === 'object') {
    actions = Array.isArray(config.actions) ? config.actions : [];
    if (config.mode === 'any') {
      mode = 'any';
    }
  } else if (typeof config === 'string') {
    actions = [config];
  }

  // If no action required, allow through
  if (!actions || actions.length === 0) {
    return true;
  }

  const user = ctx?.state?.user;
  const userAbility = ctx?.state?.userAbility;

  // 1. Super Admin universal bypass
  if (user?.isSuperAdmin === true) {
    return true;
  }

  // 2. CASL Ability check (standard Strapi 5 Admin auth)
  if (userAbility && typeof userAbility.can === 'function') {
    const isAllowed =
      mode === 'any'
        ? actions.some((act) => userAbility.can(act))
        : actions.every((act) => userAbility.can(act));

    if (isAllowed) {
      return true;
    }

    if (ctx) {
      ctx.status = 403;
      ctx.body = {
        data: null,
        error: {
          status: 403,
          name: 'ForbiddenError',
          message: 'You do not have permission to perform this action.',
        },
      };
    }
    return false;
  }

  // 3. Fallback permission check (for mock / service context)
  const permissions: string[] = Array.isArray(ctx?.state?.permissions)
    ? ctx.state.permissions
    : Array.isArray(user?.permissions)
    ? user.permissions.map((p: any) => (typeof p === 'string' ? p : p?.action)).filter(Boolean)
    : [];

  if (permissions.includes('*')) {
    return true;
  }

  const isAllowed =
    mode === 'any'
      ? actions.some((act) => permissions.includes(act))
      : actions.every((act) => permissions.includes(act));

  if (isAllowed) {
    return true;
  }

  if (ctx) {
    ctx.status = 403;
    ctx.body = {
      data: null,
      error: {
        status: 403,
        name: 'ForbiddenError',
        message: 'You do not have permission to perform this action.',
      },
    };
  }
  return false;
};
