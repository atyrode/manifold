import { defineAction } from "@manifold/plugin";
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

/**
 * The machine fleet, as a plugin: the inventory a workspace can see and the enrolment that
 * puts something in it. Both verbs were bespoke HTTP routes (`GET`/`POST /api/machines`)
 * and are now the two doors below, so "which machines exist" and "add one" are discoverable
 * in `GET /api/plugins` beside every other capability instead of only in the CONTRACTS table.
 *
 * `machines:mint` is the ceiling this manifest declares, and it is genuinely load-bearing:
 * enrolment mints a durable credential for a process nobody in this workspace can see, which
 * is the highest-authority thing the fleet can do. `containers:read` is the list's ceiling, matching
 * the route it replaces exactly.
 */
export const machinesManifest: PluginManifest = {
  id: "core.machines",
  version: "1.2.0",
  title: "Machines",
  description:
    "Enrolls machines, lists them with live online state, withdraws a machine's credential, drains a machine's terminal admission, and births terminals.",
  capabilities: ["machines:mint", "containers:read"],
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
      THE FLEET'S NEWS (ADR 0012). A machine has no `manifold://` form of its own — the
      grammar's seven forms address containers, their contents, principals, plugins and
      actions, and a machine is none of them — so all three are addressed to this plugin's own
      node, which is the node that publishes the roster and the one subscription the Machines
      section needs to stop polling. WHICH machine moved is the payload.

      `machine_enrolled` is emitted by this plugin's own door below; the online pair is emitted
      by the FLOOR, because only the socket registry knows when a machine's connection appears
      or dies. That is ADR 0012 §1 exactly: the engine emits, the plugin declares.
     */
    events: [
      { id: "machine_enrolled", title: "Machine enrolled" },
      { id: "machine_online", title: "Machine online" },
      { id: "machine_offline", title: "Machine offline" },
    ],
  },
};

/**
 * The withdrawal door's full name, built from the manifest id rather than spelled: the chrome
 * that dispatches it and the `data-action` attribute that names it in the DOM (invariant 12)
 * cannot drift from the declaration below. `core.keys` set this precedent.
 */
export const MACHINES_REVOKE_ACTION = `${machinesManifest.id}.revoke`;
export const MACHINES_FORGET_ACTION = `${machinesManifest.id}.forget`;

/**
 * The wire shapes are the protocol's, not this plugin's, and deliberately: `MachineSummary`
 * is what the SDK's `machines()` parses and what the machine channel's own vocabulary is
 * described in. A plugin re-declaring the same object under a private name would be the
 * second convention invariant 14 forbids — so the actions publish the protocol schemas and
 * the roster's JSON Schema is that shape, byte for byte.
 */
export const machinesActions = [
  defineAction({
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
  }),
  defineAction({
    name: "enroll",
    title: "Enroll a machine",
    caps: ["machines:mint"],
    input: EnrollMachineRequestSchema,
    result: MachineEnrollResponseSchema,
  }),
  defineAction({
    /*
      WITHDRAWAL AS AN ACT — the door ADR 0019 §3 names as the one thing missing from this
      plugin. `list` and `enroll` were the whole vocabulary, so a credential minted for "a
      process nobody in this workspace can see" (this manifest's own words for why
      `machines:mint` is load-bearing) could be REPLACED through `enroll { rotateToken: true }`
      and never taken away. The mechanism was always there — `rotateMachineToken` revokes and
      re-mints — and what did not exist was the act.

      ONE DOOR, ONE CONCEPT (invariant 14): revoking a machine IS revoking that machine's
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
  }),
  defineAction({
    name: "forget",
    title: "Forget a revoked machine",
    caps: ["machines:mint"],
    input: ForgetMachineRequestSchema,
    result: ForgetMachineResultSchema,
  }),
  defineAction({
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
  }),
];
