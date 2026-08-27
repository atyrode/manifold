/**
 * Shared reconnect backoff policy: half-jittered exponential, capped. Used by every
 * long-lived dialer in the repo (SDK session channel, agent machine channel) so the
 * jitter/ceiling math lives — and is tested — exactly once.
 */

/**
 * Delay before reconnect `attempt` (0-based): uniform in [0.5, 1.0] × min(capMs, baseMs·2^attempt).
 * The half-jitter floor keeps retries from synchronizing across a fleet while never
 * collapsing below half the deterministic ceiling.
 */
export function reconnectDelayMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return ceiling * (0.5 + random() * 0.5);
}
