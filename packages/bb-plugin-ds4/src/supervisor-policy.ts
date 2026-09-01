/** Return true when a supervisor start must yield to a provider turn lease. */
export function providerLeaseVetoesStart(
  onlyIfNoProviderLease: boolean,
  providerLeaseActive: boolean,
): boolean {
  return onlyIfNoProviderLease && providerLeaseActive;
}

/**
 * An orphan may be cleaned immediately when no demand timestamp exists.
 * Otherwise, wait until the configured idle grace has elapsed.
 */
export function orphanCleanupIsDue(
  lastDemandAt: number | null,
  now: number,
  idleTimeoutMs: number,
): boolean {
  return lastDemandAt === null || now - lastDemandAt >= idleTimeoutMs;
}
