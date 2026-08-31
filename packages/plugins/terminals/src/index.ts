import { defineAction } from "@manifold/plugin";
import {
  PadSessionSummarySchema,
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
  capabilities: ["pads:read", "terminal:spawn", "terminal:write"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
};

/** A terminal's geometry, with the wire's own bounds: the door is asked the whole question. */
const geometry = {
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
};

/**
 * Five doors, three authorities, and two scopes — every one of them chosen to reproduce the
 * authority the replaced surface enforced rather than to look tidy:
 *
 * - `open` carries `terminal:spawn`, the cap the broker itself demanded before this door
 *   existed, and is `scope: "pad"` because a terminal is born INSIDE one container and the
 *   per-terminal agent token minted for it is pad-scoped WITH that cap (`auth.ts`
 *   `mintSessionAgentToken`). A workspace-graded creation door would have quietly ended
 *   agents spawning their own terminals, which is A2's whole promise.
 * - `rename` and `kill` carry `terminal:write` at `scope: "pad"`: the authority the session
 *   channel's `terminal_kill` verb has always enforced, and the one the browser's own
 *   `canKill` rule is computed from. The deleted `PATCH/DELETE /api/terminals/:id` routes
 *   asked for `pads:write` instead — two doors onto one concept answering differently, which
 *   invariant 14 gives exactly one reading. This is that reading.
 * - `list` and `sessions` are READS, and reads are doors too (discoverable in
 *   `GET /api/plugins` like any other). `sessions` is `scope: "pad"` because the pad-sessions
 *   route it replaces answered a pad-scoped token with its own pad's rows; `list` keeps the
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
      lands here and nowhere else.
     */
    name: "open",
    title: "Authorize a new terminal in a container",
    caps: ["terminal:spawn"],
    scope: "pad",
    input: z.strictObject({
      /** The container the terminal is born in: the channel's own pad. */
      padId: z.string().min(1),
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
    caps: ["terminal:write"],
    scope: "pad",
    input: z.strictObject({
      sessionId: z.string().min(1),
      name: z.string().min(1).max(120),
    }),
    result: z.strictObject({}),
  }),
  defineAction({
    // D12: kill is CLEANUP — it stays dispatchable while this plugin is disabled, so a
    // disable can refuse new terminals without ever locking anyone out of removing one.
    cleanup: true,
    name: "kill",
    title: "Kill a terminal",
    caps: ["terminal:write"],
    scope: "pad",
    input: z.strictObject({ sessionId: z.string().min(1) }),
    result: z.strictObject({}),
  }),
  defineAction({
    name: "list",
    title: "Every terminal in the workspace",
    caps: ["pads:read"],
    input: z.strictObject({}),
    result: z.strictObject({ terminals: TerminalSummarySchema.array() }),
  }),
  defineAction({
    name: "sessions",
    title: "Terminal sessions by container",
    caps: ["pads:read"],
    scope: "pad",
    input: z.strictObject({}),
    result: z.strictObject({ sessions: PadSessionSummarySchema.array() }),
  }),
];
