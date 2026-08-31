import { defineAction } from "@manifold/plugin";
import {
  EnrollMachineRequestSchema,
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
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
 * is the highest-authority thing the fleet can do. `pads:read` is the list's ceiling, matching
 * the route it replaces exactly.
 */
export const machinesManifest: PluginManifest = {
  id: "core.machines",
  version: "1.0.0",
  title: "Machines",
  description: "Enrolls machines, lists them with live online state, and births terminals.",
  capabilities: ["machines:mint", "pads:read"],
  contributes: {
    panels: [],
    sections: [{ id: "machines", title: "Machines", order: 20 }],
    elements: [],
    tools: [],
    events: [],
  },
};

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
      A READ, and therefore `scope: "pad"`: `GET /api/machines` answered any authenticated
      token including a pad-scoped one, because a viewer holding a share link still has to
      paint the machine badge on the terminal in front of it. Declaring the scope keeps that
      reachability through the action door; the handler owes ctx.padScope the same treatment
      the route gave it, which here is none — the route filtered nothing, and the fleet is a
      workspace-global fact a scoped viewer was always allowed to read in full.
    */
    scope: "pad",
    name: "list",
    title: "List the enrolled machines",
    caps: ["pads:read"],
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
];
