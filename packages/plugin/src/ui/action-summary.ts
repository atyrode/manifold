import type { ActionSummary } from "@manifold/protocol";

import type { HostServices } from "../host.ts";

/** The current published summary for one composed action, or null when it is not composed. */
export function actionSummary(action: string, host: HostServices): ActionSummary | null {
  for (const entry of host.assembly.roster()) {
    const found = entry.actions.find((candidate) => candidate.name === action);
    if (found !== undefined) return found;
  }
  return null;
}
