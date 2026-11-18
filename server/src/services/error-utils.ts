/**
 * Shared network / undici error diagnostics, sanitization, bounded concurrency,
 * and server-stability helpers for Bulk Updater Workspace and CSV Import/Export Override.
 */

const CRASH_GUARD_SYMBOL = Symbol.for('strapi-plugin-bulk-updater.undiciCrashGuardInstalled');

let activeBulkOperations = 0;

/**
 * Returns the count of currently executing bulk-update or CSV-import operations.
 */
export function getActiveBulkOperationCount(): number {
  return activeBulkOperations;
}

/**
 * Tracks an active bulk operation so process-level diagnostics can attribute
 * asynchronous webhook / lifecycle network failures accurately.
 */
export async function trackActiveBulkOperation<T>(fn: () => Promise<T>): Promise<T> {
  activeBulkOperations++;
  try {
    return await fn();
  } finally {
    activeBulkOperations = Math.max(0, activeBulkOperations - 1);
  }
}

/**
 * Resolves bounded batch concurrency to prevent outbound undici socket exhaustion
 * and database connection pool contention during concurrent Strapi Document Service updates.
 * Defaults to 5 (configurable via `plugin::bulk-updater.batchConcurrency`, clamped to 1..10).
 */
export function getBatchConcurrency(strapi?: any): number {
  const DEFAULT_CONCURRENCY = 5;
  const MIN_CONCURRENCY = 1;
  const MAX_CONCURRENCY = 10;

  try {
    const configured = strapi?.config?.get?.('plugin::bulk-updater.batchConcurrency');
    if (configured !== undefined && configured !== null && configured !== '') {
      const parsed = Number(configured);
      if (Number.isFinite(parsed) && parsed >= MIN_CONCURRENCY) {
        return Math.min(MAX_CONCURRENCY, Math.floor(parsed));
      }
    }
  } catch {
    // Fallback to safe default
  }

  return DEFAULT_CONCURRENCY;
}

/**
 * Redacts potential authorization headers, bearer tokens, passwords, or query secrets
 * from error messages before logging or returning to callers.
 */
export function sanitizeSensitiveErrorText(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;'"}\]]+/gi, '$1=[REDACTED]')
    .replace(/([?&](?:token|key|api_key|apikey|secret|password|auth)=)[^&\s]+/gi, '$1[REDACTED]');
}

/**
 * Detects Node.js native undici `TypeError: fetch failed` and related network/socket errors.
 */
export function isFetchFailedError(err: any): boolean {
  if (!err) return false;

  const visited = new Set<any>();
  let current: any = err;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);

    const msg = typeof current.message === 'string' ? current.message : '';
    const code = typeof current.code === 'string' ? current.code : '';
    const stack = typeof current.stack === 'string' ? current.stack : '';

    if (
      /fetch failed/i.test(msg) ||
      code.startsWith('UND_ERR_') ||
      stack.includes('node:internal/deps/undici')
    ) {
      return true;
    }

    if (Array.isArray(current.errors)) {
      for (const sub of current.errors) {
        if (isFetchFailedError(sub)) return true;
      }
    }

    current = current.cause;
  }

  return false;
}

/**
 * Extracts a concise, sanitized diagnostic error string including nested `err.cause`
 * (such as undici ECONNREFUSED, ENOTFOUND, ECONNRESET, UND_ERR_SOCKET, UND_ERR_CONNECT_TIMEOUT).
 */
export function formatErrorWithCause(err: any, fallback = 'Unknown error'): string {
  if (!err) return fallback;
  if (typeof err === 'string') return sanitizeSensitiveErrorText(err) || fallback;

  const primaryMsg =
    typeof err.message === 'string' && err.message.trim() && err.message !== '[object Object]'
      ? err.message.trim()
      : fallback;

  const causeParts: string[] = [];
  const visited = new Set<any>([err]);
  let current = err.cause;

  while (current && !visited.has(current) && causeParts.length < 4) {
    visited.add(current);

    if (typeof current === 'string') {
      if (current.trim()) causeParts.push(current.trim());
      break;
    }

    if (typeof current === 'object') {
      const code = typeof current.code === 'string' ? current.code.trim() : '';
      const msg = typeof current.message === 'string' ? current.message.trim() : '';
      const addr = typeof current.address === 'string' ? current.address.trim() : '';
      const port = current.port !== undefined && current.port !== null ? String(current.port) : '';

      const endpoint = addr ? (port ? `${addr}:${port}` : addr) : '';
      const pieces: string[] = [];
      if (code) pieces.push(code);
      if (msg && msg !== code) pieces.push(msg);
      if (endpoint && !msg.includes(endpoint)) pieces.push(endpoint);

      if (pieces.length > 0) {
        causeParts.push(pieces.join(' - '));
      } else if (Array.isArray(current.errors) && current.errors.length > 0) {
        const subMsgs = current.errors
          .slice(0, 2)
          .map((e: any) => {
            const subCode = e?.code ? `${e.code}: ` : '';
            return `${subCode}${e?.message || ''}`.trim();
          })
          .filter(Boolean);
        if (subMsgs.length > 0) {
          causeParts.push(subMsgs.join('; '));
        }
      }

      current = current.cause;
    } else {
      break;
    }
  }

  let formatted = primaryMsg;
  if (causeParts.length > 0) {
    formatted = `${primaryMsg} (${causeParts.join(' -> ')})`;
  }

  if (isFetchFailedError(err) && !formatted.toLowerCase().includes('webhook')) {
    formatted += ' — downstream webhook or lifecycle HTTP request failed';
  }

  return sanitizeSensitiveErrorText(formatted);
}

/**
 * Installs a single, idempotent process-level `unhandledRejection` safety guard
 * strictly scoped to Node.js `undici` `TypeError: fetch failed` rejections
 * (e.g. detached Strapi webhookRunner or lifecycle fetch failures triggered during
 * Document Service updates/publishes). Prevents server crashes while logging full
 * sanitized diagnostics.
 */
export function installUndiciCrashGuard(strapi?: any): () => void {
  const globalObj = globalThis as any;
  if (globalObj[CRASH_GUARD_SYMBOL]) {
    return globalObj[CRASH_GUARD_SYMBOL];
  }

  const handler = (reason: any) => {
    if (!isFetchFailedError(reason)) {
      return;
    }

    const formatted = formatErrorWithCause(reason, 'fetch failed');
    const inBulk = activeBulkOperations > 0;
    const contextNote = inBulk
      ? `during active bulk/CSV operation (${activeBulkOperations} active)`
      : 'outside active bulk operation';

    const logMsg =
      `[bulk-updater] Prevented server crash from unhandled undici fetch rejection ${contextNote}: ` +
      `${formatted}. Check Strapi Settings > Webhooks or custom lifecycle hooks for unreachable/slow endpoints.`;

    if (strapi?.log?.error) {
      strapi.log.error(logMsg);
    } else {
      console.error(logMsg);
    }
  };

  process.on('unhandledRejection', handler);

  const uninstall = () => {
    process.removeListener('unhandledRejection', handler);
    if (globalObj[CRASH_GUARD_SYMBOL] === uninstall) {
      delete globalObj[CRASH_GUARD_SYMBOL];
    }
  };

  globalObj[CRASH_GUARD_SYMBOL] = uninstall;
  return uninstall;
}
