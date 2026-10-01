#!/usr/bin/env bun
import { compareVersions } from "./release-core.ts";

const REPLICA_GUARD_BOUNDARY = "0.22.0";

/**
 * This historical boundary alone, not general replica admission. `adoptRecovery` is valid
 * only after the workflow's existing serving-recovery/fresh-checkpoint classification.
 */
export function promotionReplicaBoundary(
  incumbentBuild: string,
  candidateTag: string,
  adoptRecovery: boolean,
): string | null {
  if (!/^v\d+\.\d+\.\d+$/.test(candidateTag)) {
    throw new Error("Replica boundary preflight requires an exact vX.Y.Z candidate release tag");
  }
  const beforeGuard = compareVersions(incumbentBuild, REPLICA_GUARD_BOUNDARY) < 0;
  const candidateGuarded = compareVersions(candidateTag.slice(1), REPLICA_GUARD_BOUNDARY) >= 0;
  if (!beforeGuard || !candidateGuarded || adoptRecovery) return null;
  return (
    `replica_guard_boundary_requires_adoption: Ordinary promotion from v${incumbentBuild} to ${candidateTag} crosses the v${REPLICA_GUARD_BOUNDARY} replica-guard boundary. ` +
    "Preserve existing replica histories and follow the reviewed offline maintenance procedure in docs/SELF-HOST.md §Adopting an untracked replica. " +
    "For a serving recovery image, follow §Environments / Recovery adoption with a fresh checkpoint and --adopt-recovery; the workflow must verify that recovery state. " +
    "Do not initialize or hand-seal the existing history."
  );
}

// Trusted workflow entry: the final argument is its classified recovery.adopt output,
// never the requested adopt_recovery input. A zero exit clears only this boundary.
if (import.meta.main) {
  const [incumbentBuild, candidateTag, classifiedAdoption, ...extra] = process.argv.slice(2);
  if (
    incumbentBuild === undefined ||
    candidateTag === undefined ||
    (classifiedAdoption !== "true" && classifiedAdoption !== "false") ||
    extra.length !== 0
  ) {
    console.error(
      "Usage: bun scripts/promotion-replica-admission.ts INCUMBENT_BUILD vX.Y.Z CLASSIFIED_ADOPTION_TRUE_OR_FALSE",
    );
    process.exit(1);
  }
  try {
    const refusal = promotionReplicaBoundary(incumbentBuild, candidateTag, classifiedAdoption === "true");
    if (refusal !== null) {
      console.error(refusal);
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
