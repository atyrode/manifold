import type { AnyActionDef } from "@manifold/plugin";
import {
  DrainMachineRequestSchema,
  EnrollMachineRequestSchema,
  ForgetMachineRequestSchema,
  ForgetMachineResultSchema,
  MachineDrainStatusSchema,
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  RevokeMachineRequestSchema,
  RevokeResultSchema,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";
import type { MACHINES_PLUGIN_ID } from "./names.ts";
import {
  HostViewsSchema,
  RemoveHostViewRequestSchema,
  SetHostViewRequestSchema,
} from "./host-views.ts";

export {
  MACHINES_FORGET_ACTION,
  MACHINES_LIST_HOST_VIEWS_ACTION,
  MACHINES_REMOVE_HOST_VIEW_ACTION,
  MACHINES_REVOKE_ACTION,
  MACHINES_SET_HOST_VIEW_ACTION,
} from "./names.ts";
export {
  HostViewMemberSchema,
  HostViewSchema,
  HostViewsSchema,
  RemoveHostViewRequestSchema,
  SetHostViewRequestSchema,
  type HostViewMember,
  type HostView,
  type HostViews,
} from "./host-views.ts";

/**
 * The machine fleet, as a plugin: inventory, enrollment and operator-owned host views.
 * Host views group exact account endpoints for display without changing their execution
 * identity or the released inventory shape. Every fleet operation remains a discoverable
 * action in `GET /api/plugins`.
 *
 * `machines:mint` is the ceiling this manifest declares, and it is genuinely load-bearing:
 * enrolment mints a durable credential for a process nobody in this workspace can see, which
 * is the highest-authority thing the fleet can do. `containers:read` is the list's ceiling, matching
 * the route it replaces exactly.
 */
export const machinesManifest: PluginManifest & { readonly id: typeof MACHINES_PLUGIN_ID } = {
  // A literal because the plugin-package gate reads it (S5); the type keeps it the shared name.
  id: "core.machines",
  version: "1.3.0",
  title: "Machines",
  description:
    "Enrolls machines, lists their live state, groups account endpoints into host views, withdraws credentials, and drains terminal admission.",
  capabilities: ["machines:mint", "containers:read"],
  dataVersion: { major: 1, minor: 0 },
  purges: ["storage"],
  contributes: {
    panels: [],
    sections: [{ id: "machines", title: "Machines", order: 20, setting: "machines" }],
    /*
      ONE PREFERENCE OVER THE ROW (#133). A fleet list is worth its rail height on a machine
      you administer and worth none on one you only draw in, so whether the row is there is
      this reader's call rather than the distribution's. Shipped `true`.

      It gates the SECTION and nothing else: the doors below stay dispatchable, the fleet's
      news keeps arriving, and a terminal born on a machine works exactly as it did — the row
      is one way to reach this plugin, never the plugin.
     */
    settings: [{ id: "machines", title: "Machines", kind: "boolean", default: true }],
    elements: [],
    tools: [],
    /*
      THE FLEET'S NEWS (ADR 0012). Inventory and host-view invalidations share this plugin's
      node, so one subscription covers the roster and its display metadata. Machine IDs in
      payloads still identify exact account endpoints, never synthetic host identities.

      Enrollment, withdrawal, forgetting and host-view CAS commits are announced here.
      Online/offline transitions and committed drain latches belong to the FLOOR, which
      emits under this plugin's declared vocabulary.
     */
    events: [
      { id: "machine_enrolled", title: "Machine enrolled" },
      { id: "machine_online", title: "Machine online" },
      { id: "machine_offline", title: "Machine offline" },
      { id: "machine_inventory_changed", title: "Machine inventory changed" },
      { id: "host_views_changed", title: "Host views changed" },
    ],
  },
  /*
    WHAT THIS BUILD CAN BE COMPILED INTO, never how it runs. The same source packs into a
    server guest, the in-realm web module and the self-contained portable Worker entry, so a
    trusted bootstrap that selects hardened execution (`MANIFOLD_HARDENED_PLUGINS`) compiles
    exactly this manifest and nothing else. In-realm execution, the default, ignores it.
  */
  entry: { server: true, web: "web.js", worker: true },
};

/**
 * Existing machine doors retain the protocol's strict wire shapes for SDK and machine-channel
 * compatibility. Host-view doors publish plugin-owned metadata schemas separately; they do
 * not add fields to `MachineSummary` or change the machine wire.
 */
export const machinesActions: readonly AnyActionDef[] = [
  {
    /*
      A READ, and therefore `scope: "container"`: `GET /api/machines` answered any authenticated
      token including a container-scoped one, because a viewer holding a share link still has to
      paint the machine badge on the terminal in front of it. Declaring the scope keeps that
      reachability through the action door; the handler owes ctx.containerScope the same treatment
      the route gave it, which here is none — the route filtered nothing, and the fleet is a
      workspace-global fact a scoped viewer was always allowed to read in full.
    */
    scope: "container",
    name: "list",
    title: "List the enrolled machines",
    caps: ["containers:read"],
    input: z.strictObject({}),
    result: MachinesResponseSchema,
  },
  {
    scope: "container",
    name: "listHostViews",
    title: "List host views",
    caps: ["containers:read"],
    input: z.strictObject({}),
    result: HostViewsSchema,
  },
  {
    name: "setHostView",
    title: "Create or update a host view",
    caps: ["machines:mint"],
    // Inventory validation is read-only; the caller-bound bridge still proves the read.
    delegates: ["containers:read"],
    input: SetHostViewRequestSchema,
    result: HostViewsSchema,
  },
  {
    name: "removeHostView",
    title: "Remove a host view",
    caps: ["machines:mint"],
    input: RemoveHostViewRequestSchema,
    result: HostViewsSchema,
  },
  {
    name: "enroll",
    title: "Enroll a machine",
    caps: ["machines:mint"],
    input: EnrollMachineRequestSchema,
    result: MachineEnrollResponseSchema,
  },
  {
    /*
      WITHDRAWAL AS AN ACT — the door ADR 0019 §3 names as the one thing missing from this
      plugin. `list` and `enroll` were the whole vocabulary, so a credential minted for "a
      process nobody in this workspace can see" (this manifest's own words for why
      `machines:mint` is load-bearing) could be REPLACED through `enroll { rotateToken: true }`
      and never taken away. The mechanism was always there — `rotateMachineToken` revokes and
      re-mints — and what did not exist was the act.

      ONE DOOR, ONE CONCEPT (docs/CONTRACTS.md §One authoritative implementation): revoking a machine IS revoking that machine's
      credential, and there is no second spelling of it. The inventory row survives, because
      withdrawing a credential and forgetting a box are different verbs and an operator needs
      to see the machine they just cut off.

      `machines:mint`, the same cap `enroll` declares, because minting and withdrawing a
      machine credential are one authority. A `machines:revoke` would be a second answer to
      "who administers the fleet", and grading withdrawal LOWER than enrolment would mean the
      cheaper capability could undo the dearer one.

      `scope: "workspace"` — the default, and the same reasoning `enroll` carries: a machine
      is a workspace-global fact with no container to be inside, so a container-scoped token is
      scoped to something the answer does not describe. That is why `list` declares
      `scope: "container"` and this does not: reading the roster is a viewer's business,
      administering it is not.

      `cleanup: true`, for `core.access.revoke`'s reason exactly: withdrawal is what somebody
      reaches for when a secret has leaked, and an administrator's toggle must never be what
      keeps a compromised machine credential alive.
    */
    cleanup: true,
    name: "revoke",
    title: "Withdraw a machine's credential",
    caps: ["machines:mint"],
    input: RevokeMachineRequestSchema,
    /*
      The same count every other revocation publishes, meaning the same thing: how many
      credentials actually died. `0` is a success — asking twice about a machine already cut
      off is what a careful operator does — and inventing a `{ ok: true }` here would be a
      second shape for one answer.
    */
    result: RevokeResultSchema,
  },
  {
    name: "forget",
    title: "Forget a revoked machine",
    caps: ["machines:mint"],
    input: ForgetMachineRequestSchema,
    result: ForgetMachineResultSchema,
  },
  {
    /*
      ADMISSION AS AN ACT (issue #278). A host activation that replaces a machine's agent has
      to know that no terminal will be born between its last look and the replacement, and
      that what it is about to replace holds nothing — and "the machine looked idle" is not
      that knowledge, because a create can land in the gap. This door closes admission on
      the hub FIRST, then asks the machine's terminal owner to latch the same and report every
      PTY it still holds, behind every create the hub had already sent. The answer is the
      owner's, never inferred: an owner that cannot answer — offline, a pre-v24 agent that
      names no owner, a timeout, a mismatched identity — is a `refused` denial, and admission
      STAYS closed until `draining: false`, which is the only cancellation there is.

      `machines:mint`, the same cap `enroll` and `revoke` carry, because closing a machine to
      new work is fleet administration and grading it lower would let the cheaper capability
      fence a machine the dearer one enrolled. `scope: "workspace"` for `revoke`'s reason: a
      machine is a workspace-global fact with no container to be inside.

      What this door does NOT do: it never kills, exits or forgets a terminal. Replacing an
      owner that still holds work is the caller's decision to make in the open, with the ids
      in hand and `core.terminals.kill` as the named door for each one.
    */
    name: "drain",
    title: "Close or reopen a machine's terminal admission",
    caps: ["machines:mint"],
    input: DrainMachineRequestSchema,
    result: MachineDrainStatusSchema,
  },
];
