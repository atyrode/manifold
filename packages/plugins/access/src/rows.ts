import type { PrincipalCredentials } from "@manifold/protocol";

/**
 * The Sessions section's one policy decision, as a pure function (#145).
 *
 * A principal with no live credential cannot act again until somebody mints for it anew, so
 * its row is HISTORY, not status — and on a workspace that has hosted gate runs and agent
 * re-enrolments, history outnumbers the living by an order of magnitude (~250 dead agent
 * rows beside 8 real identities on the operator's own instance, 2026-09-01). The section
 * shows the living by default and folds the rest into one collapsed disclosure: never
 * deleted, never hidden from a reader who asks, never again the first thing a reader wades
 * through.
 *
 * Order within each half is the server's own (`listCredentials` answers newest-last today),
 * because re-sorting here would make this module a second opinion about a list the server
 * already owns.
 */
export interface PartitionedCredentials {
  /** Principals holding at least one live credential — the rows that can still act. */
  readonly live: readonly PrincipalCredentials[];
  /** Credential-less principals: the audit trail, folded shut by default. */
  readonly inactive: readonly PrincipalCredentials[];
}

export function partitionCredentials(
  rows: readonly PrincipalCredentials[],
): PartitionedCredentials {
  const live: PrincipalCredentials[] = [];
  const inactive: PrincipalCredentials[] = [];
  for (const row of rows) {
    (row.sessions.length > 0 ? live : inactive).push(row);
  }
  return { live, inactive };
}
