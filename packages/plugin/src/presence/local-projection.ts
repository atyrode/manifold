import type { PadPresence, Principal } from "@manifold/protocol";

/**
 * Projects this browser's route immediately while the cross-pad presence poll catches up.
 * Remote principals remain server-owned; only the known local principal is relocated.
 */
export function projectLocalPresence(
  rows: readonly PadPresence[],
  self: Principal,
  padId: string | null,
): readonly PadPresence[] {
  const withoutSelf = rows
    .map((row) => ({
      ...row,
      principals: row.principals.filter((principal) => principal.id !== self.id),
    }))
    .filter((row) => row.principals.length > 0);
  if (padId === null) return withoutSelf;
  const target = withoutSelf.find((row) => row.padId === padId);
  if (target === undefined) return [...withoutSelf, { padId, principals: [self] }];
  return withoutSelf.map((row) =>
    row.padId === padId ? { ...row, principals: [...row.principals, self] } : row,
  );
}
