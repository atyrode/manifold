import { defineAction } from "@manifold/plugin";
import {
  ContainerTerminalSummarySchema,
  TerminalCwdSchema,
  TerminalEnvSchema,
  TerminalProgramSchema,
  TerminalRuntimeSchema,
  TerminalInfoSchema,
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
 * The session channel still carries terminal byte/control frames, while `core.terminals.create`
 * gives bearer-only callers the same birth mechanism without pretending HTTP owns a PTY stream.
 * Both paths converge in the broker; policy stays in this plugin and bytes stay on the floor.
 *
 * Disabling refuses new terminals and administration, and never touches removal:
 * `kill` is `cleanup`, so nobody is locked out of tidying up by an administrator turning a
 * plugin off (D12).
 */
export const terminalsManifest: PluginManifest = {
  id: "core.terminals",
  version: "1.0.0",
  title: "Terminals",
  description: "Owns terminal creation policy, naming, restart, killing, and the terminal indexes.",
  capabilities: ["containers:read", "terminals:spawn", "terminals:write"],
  contributes: {
    panels: [],
    sections: [],
    settings: [
      {
        id: "copy-on-select",
        title: "Copy selection automatically",
        kind: "boolean",
        default: false,
      },
      {
        id: "paste-on-right-click",
        title: "Paste on right-click",
        kind: "boolean",
        default: false,
      },
    ],
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
      { id: "terminal_cwd", title: "Terminal working directory changed" },
      { id: "terminal_restarted", title: "Terminal restarted" },
    ],
  },
};

/** A terminal's geometry, with the wire's own bounds: the door is asked the whole question. */
const geometry = {
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
};
const optionalGeometry = {
  cols: geometry.cols.optional(),
  rows: geometry.rows.optional(),
};

/**
 * Eight doors, three authorities, and two scopes — every one of them chosen to reproduce the
 * authority the replaced ref enforced rather than to look tidy:
 *
 * - `open` is the session frame's policy gate and `create` is the bearer-reachable birth door.
 *   Both carry `terminals:spawn` at `scope: "container"` because a terminal is born INSIDE one
 *   container and the per-terminal agent token minted for it is container-scoped with that cap.
 *   The broker is their one mechanism; `create` additionally waits for its durable commit.
 * - `rename`, `take`, `restart` and `kill` carry `terminals:write` at `scope: "container"`: the authority the
 *   terminal channel's `terminal_kill` verb has always enforced, and the one the browser's own
 *   `canKill` rule is computed from. The deleted `PATCH/DELETE /api/terminals/:id` routes
 *   asked for `containers:write` instead — two doors onto one concept answering differently, which
 *   docs/CONTRACTS.md §One authoritative implementation gives exactly one reading. This is that reading.
 * - `list` and `terminals` are READS, and reads are doors too (discoverable in
 *   `GET /api/plugins` like any other). `terminals` is `scope: "container"` because the container-terminals
 *   route it replaces answered a container-scoped token with its own container's rows; `list` keeps the
 *   default workspace scope because the terminal index it replaces refused scoped tokens
 *   outright — the ladder's scope rung now says so in the published vocabulary.
 */
export const terminalsActions = [
  defineAction({
    /*
      The session channel's CREATION POLICY door. Its result is the decision, not the terminal:
      `terminal_open` dispatches it before asking the broker, so a socket frame and this policy
      trace carry the same launch facts. Bearer-only callers use `core.terminals.create`, which
      applies the same policy and waits on the same broker mechanism for durable birth.
     */
    /*
      Since issues #192 and #407 that includes the launch directory and WHAT the terminal is
      born running. `cwd`, `program`, and `env` are the FRAME's own fields, handed to this door
      by the gateway before the broker hears of the frame, so what the door judged and what the
      machine receives are one value read once. The trace the ladder writes is the durable
      record of those arguments (`env` is redacted by name, like every env the ledger sees),
      and a denial here means no token was minted and no `create` left the server.
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
      ...optionalGeometry,
      /** The working directory passed unchanged to the terminal owner. */
      cwd: TerminalCwdSchema.optional(),
      /** An explicit machine choice; absent leaves the fleet rule to the broker. */
      machineId: z.string().min(1).optional(),
      /** Who authors the placement — the canvas opener, or the composition itself. */
      placement: z.enum(["element", "tile"]).optional(),
      /**
       * What the PTY execs in place of the machine's shell (issue #192): the same shape the
       * frame carries and the agent receives as `create.program`. Absent ≡ the login shell.
       */
      program: TerminalProgramSchema.optional(),
      runtime: TerminalRuntimeSchema.optional(),
      /** The opener's env allowlist, merged UNDER the minted `MANIFOLD_*` keys; absent ≡ none. */
      env: TerminalEnvSchema.optional(),
    }),
    result: z.strictObject({ traceId: z.number().int().positive().optional() }),
  }),
  defineAction({
    /*
      The BEARER-REACHABLE birth door. Unlike `open`, this action waits for the machine's
      acknowledgement and the broker's durable terminal/home commit, then returns both the
      terminal state and its canonical address. It owns no output channel: callers observe
      lifecycle through the terminal indexes/events and attach later with any SessionClient.
     */
    name: "create",
    title: "Create a terminal and wait for its durable reference",
    caps: ["terminals:spawn"],
    scope: "container",
    input: z.strictObject({
      containerId: z.string().min(1),
      /** Correlation id and, for canvas placement, the id a caller may author a portal under. */
      elementId: z.string().min(1),
      ...optionalGeometry,
      cwd: TerminalCwdSchema.optional(),
      machineId: z.string().min(1).optional(),
      placement: z.literal("tile").optional(),
      program: TerminalProgramSchema.optional(),
      runtime: TerminalRuntimeSchema.optional(),
      env: TerminalEnvSchema.optional(),
    }),
    result: z.strictObject({
      terminal: TerminalInfoSchema,
      uri: z.string().startsWith("manifold://terminal/"),
    }),
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
    name: "restart",
    title: "Restart a terminal in place",
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
