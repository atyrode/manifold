import type { Attendance, Principal } from "@manifold/protocol";

/**
 * Projects this browser's route immediately while the cross-container presence poll catches up.
 * Remote principals remain server-owned; only the known local principal is relocated.
 */
export function projectLocalPresence(
  rows: readonly Attendance[],
  self: Principal,
  containerId: string | null,
): readonly Attendance[] {
  const withoutSelf = rows
    .map((row) => ({
      ...row,
      principals: row.principals.filter((principal) => principal.id !== self.id),
    }))
    .filter((row) => row.principals.length > 0);
  if (containerId === null) return withoutSelf;
  const target = withoutSelf.find((row) => row.containerId === containerId);
  if (target === undefined) return [...withoutSelf, { containerId, principals: [self] }];
  return withoutSelf.map((row) =>
    row.containerId === containerId ? { ...row, principals: [...row.principals, self] } : row,
  );
}
