/**
 * Helper to determine if an error was caused by an aborted or canceled HTTP request.
 * Useful for suppressing user-facing notifications when unmounting components or switching tabs.
 */
export function isAbortError(err: any): boolean {
  if (!err) return false;
  return (
    err.name === 'AbortError' ||
    err.name === 'CanceledError' ||
    err.code === 'ERR_CANCELED' ||
    (typeof err.message === 'string' &&
      (err.message.includes('aborted') ||
        err.message.includes('canceled') ||
        err.message.includes('cancelled')))
  );
}
