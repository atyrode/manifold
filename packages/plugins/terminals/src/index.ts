import { defineAction } from "@manifold/plugin";
import {
  ContainerTerminalSummarySchema,
  TerminalSummarySchema,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";

/**
 * Terminals, as a plugin: every question about a terminal that has an ANSWER a principal
 * could argue with lives here. Whether one may be created in this container, by whom, what
 * a name change means, what a kill means, which terminals a caller may see — all of it.
 *
 * The PTY plane stays floor and always will: the broker, the attach state machine, the
 * no-gap snapshot invariant and the byte frames (`terminal_input`, `terminal_resize`,
 * output) are a plane transport, neutral over what runs in the shell (ADR 0013 §Terminals).
 * The session channel therefore still carries `terminal_open`/`terminal_kill` as FRAMES —
 * a creation is a socket gesture whose reply is a socket reply — but the transport no
 * longer decides anything: it asks this plugin's doors first and moves bytes afterwards.
 *
 * Disabling refuses new terminals and administration, and never touches removal:
 * `kill` is `cleanup`, so nobody is locked out of tidying up by an administrator turning a
 * plugin off (D12).
 */
export const terminalsManifest: PluginManifest = {
  id: "core.terminals",
  version: "1.0.0",
  title: "Terminals",
  description: "Owns terminal creation policy, naming, killing, and the terminal indexes.",
  capabilities: ["containers:read", "terminals:spawn", "terminals:write"],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [],
    /*
      A TERMINAL'S LIFE, declared here and emitted by the FLOOR (ADR 0012 §1: the engine emits,
      the plugin declares). Every one of these is a fact only the broker holds — a PTY that
      came up, stopped on its own, was renamed, was rebound into another composition, or was
      deliberately destroyed — and the broker may not name a plugin, so it emits under whichever
      plugin `assembly.ts` says owns terminal vocabulary. This manifest is that owner.

      Four of the five are addressed to the terminal's own node. `terminal_killed` is addressed
      to its former HOME CONTAINER, because a killed terminal's address stops resolving the
      instant its row is gone: it is the same distinction between KILLED and EXITED that the
      broker's own predicate is built on — an exit leaves a node standing to be news about, a
      kill does not.
     */
    events: [
      { id: "terminal_opened", title: "Terminal opened" },
      { id: "terminal_exited", title: "Terminal exited" },
      { id: "terminal_renamed", title: "Terminal renamed" },
      { id: "terminal_bound", title: "Terminal rehomed" },
      { id: "terminal_killed", title: "Terminal killed" },
    ],
  },
};

/** A terminal's geometry, with the wire's own bounds: the door is asked the whole question. */
const geometry = {
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
};

/**
 * Six doors, three authorities, and two scopes — every one of them chosen to reproduce the
 * authority the replaced ref enforced rather than to look tidy:
 *
 * - `open` carries `terminals:spawn`, the cap the broker itself demanded before this door
 *   existed, and is `scope: "container"` because a terminal is born INSIDE one container and the
 *   per-terminal agent token minted for it is container-scoped WITH that cap (`auth.ts`
 *   `mint`). A workspace-graded creation door would have quietly ended
 *   agents spawning their own terminals, which is A2's whole promise.
 * - `rename`, `take` and `kill` carry `terminals:write` at `scope: "container"`: the authority the
 *   terminal channel's `terminal_kill` verb has always enforced, and the one the browser's own
 *   `canKill` rule is computed from. The deleted `PATCH/DELETE /api/terminals/:id` routes
 *   asked for `containers:write` instead — two doors onto one concept answering differently, which
 *   invariant 14 gives exactly one reading. This is that reading.
 * - `list` and `terminals` are READS, and reads are doors too (discoverable in
 *   `GET /api/plugins` like any other). `terminals` is `scope: "container"` because the container-terminals
 *   route it replaces answered a container-scoped token with its own container's rows; `list` keeps the
 *   default workspace scope because the terminal index it replaces refused scoped tokens
 *   outright — the ladder's scope rung now says so in the published vocabulary.
 */
export const terminalsActions = [
  defineAction({
    /*
      The CREATION POLICY door. Its result is the decision, not the terminal: the PTY is
      born on the session channel, because a create is a round trip to a machine whose
      reply — snapshot watermark, controller lease, the opener's correlation ref — is
      socket traffic the floor owns. So `core.terminals.open` answers "may a terminal be
      created here, now, by you", and `terminal_open` on the channel is the gesture that
      asks it and then moves the bytes. Everything a policy could want to judge is in the
      arguments, including the machine, so a future rule (fleet allowlists, geometry caps)
      lands here and nowhere else — the RULE, never the birth. Dispatching this door over
      `POST /api/actions/…` creates nothing; the birth is `terminal_open` on the session
      socket, which the gateway sends through here first (`docs/PLUGINS.md` §3, issue #185
      for whether an action should ever create one).
     */
    name: "open",
    title: "Authorize a new terminal in a container",
    caps: ["terminals:spawn"],
    scope: "container",
    input: z.strictObject({
      /** The container the terminal is born in: the channel's own container. */
      containerId: z.string().min(1),
      /** The opener's correlation token, echoed on every reply and error. */
      elementId: z.string().min(1),
      ...geometry,
      /** An explicit machine choice; absent leaves the fleet rule to the broker. */
      machineId: z.string().min(1).optional(),
      /** Who authors the placement — the canvas opener, or the composition itself. */
      placement: z.enum(["element", "tile"]).optional(),
    }),
    result: z.strictObject({}),
  }),
  defineAction({
    name: "rename",
    title: "Rename a terminal",
    caps: ["terminals:write"],
    scope: "container",
    input: z.strictObject({
      terminalId: z.string().min(1),
      name: z.string().min(1).max(120),
    }),
    result: z.strictObject({}),
  }),
  defineAction({
    /*
      THE CONTROLLER LEASE, as a door. Who may hold a live PTY is a policy question with an
      answer a principal can argue with — "no, somebody else is typing in it" — so it belongs
      here rather than in the transport, and the shape is `open`'s: the action decides, and the
      channel that asked carries out the transfer and announces it, because a lease is held BY
      a connection and the `controller_changed` broadcast goes to the room that connection is
      joined to.

      NOT `cleanup`. Claiming a lease is administration, not tidying up: `kill` is the carve-out
      that keeps removal reachable while this plugin is off (D12), and widening the carve-out to
      cover taking control from a live principal would make a disabled plugin more capable than
      the rule it is meant to suspend.
     */
    name: "take",
    title: "Take a terminal's controller lease",
    caps: ["terminals:write"],
    scope: "container",
    input: z.strictObject({ terminalId: z.string().min(1) }),
    result: z.strictObject({}),
  }),
  defineAction({
    // D12: kill is CLEANUP — it stays dispatchable while this plugin is disabled, so a
    // disable can refuse new terminals without ever locking anyone out of removing one.
    cleanup: true,
    name: "kill",
    title: "Kill a terminal",
    caps: ["terminals:write"],
    scope: "container",
    input: z.strictObject({ terminalId: z.string().min(1) }),
    result: z.strictObject({}),
  }),
  defineAction({
    name: "listAll",
    title: "Every terminal in the workspace",
    caps: ["containers:read"],
    input: z.strictObject({}),
    result: z.strictObject({ terminals: TerminalSummarySchema.array() }),
  }),
  defineAction({
    name: "listByContainer",
    title: "Terminals by container",
    caps: ["containers:read"],
    scope: "container",
    input: z.strictObject({}),
    result: z.strictObject({ terminals: ContainerTerminalSummarySchema.array() }),
  }),
];
