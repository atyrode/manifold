import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { HEX_COLOR } from "./elements.ts";
import { ContainerDisciplineSchema, TileLayoutSchema } from "./layout.ts";
import { BindingOverridesSchema, PluginRosterSchema, PluginSettingValuesSchema } from "./plugin.ts";
import { PrincipalSchema } from "./principal.ts";
import { ManifoldRefSchema } from "./uri.ts";

/** REST door schemas. Auth: `Authorization: Bearer <token-or-owner-key>`. */

export const ContainerSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  createdAt: z.number().int().nonnegative(),
  /** Which renderer this container asks for: a free canvas, or a composition of tiles. */
  discipline: ContainerDisciplineSchema,
});
export type Container = z.infer<typeof ContainerSchema>;

export const HttpErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(["unauthorized", "forbidden", "not_found", "invalid", "conflict", "internal"]),
    message: z.string(),
  }),
});
export type HttpError = z.infer<typeof HttpErrorSchema>;

export const CreateContainerRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
  /** Omitted means `"canvas"`. */
  discipline: ContainerDisciplineSchema.optional(),
});
export const RenameContainerRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
});
export const TreeParentIdSchema = z.string().min(1).nullable();
export const IndexEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("container"),
    container: ContainerSchema,
    parentId: TreeParentIdSchema,
    sortOrder: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("folder"),
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    createdAt: z.number().int().nonnegative(),
    parentId: TreeParentIdSchema,
    sortOrder: z.number().int().nonnegative(),
  }),
]);
export type IndexEntry = z.infer<typeof IndexEntrySchema>;
export const CreateIndexFolderRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
  parentId: TreeParentIdSchema.default(null),
});
export const MoveIndexEntryRequestSchema = z.strictObject({
  item: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("container"), id: z.string().min(1) }),
    z.strictObject({ kind: z.literal("folder"), id: z.string().min(1) }),
  ]),
  parentId: TreeParentIdSchema,
  index: z.number().int().nonnegative(),
});

export const BootstrapPrincipalRequestSchema = z.strictObject({
  name: z.string().min(1).max(64),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  kind: z.enum(["human", "agent"]).default("human"),
});
export type BootstrapPrincipalRequest = z.infer<typeof BootstrapPrincipalRequestSchema>;

export const MintTokenRequestSchema = z
  .strictObject({
    /** Either reuse an existing principal or create one inline. */
    principalId: z.string().min(1).optional(),
    principal: BootstrapPrincipalRequestSchema.optional(),
    caps: z.array(CapSchema).min(1),
    containerId: z.string().min(1).optional(),
  })
  .refine((v) => (v.principalId === undefined) !== (v.principal === undefined), {
    message: "exactly one of principalId | principal is required",
  });
export type MintTokenRequest = z.infer<typeof MintTokenRequestSchema>;

export const TokenGrantSchema = z.strictObject({
  token: z.string().min(1),
  principal: PrincipalSchema,
  caps: z.array(CapSchema).min(1),
  containerId: z.string().nullable(),
  /**
   * When this credential stops authenticating (ADR 0019 §2). ABSENT means never, which is
   * both the v19 semantics of every minted token and the standing answer for a
   * non-interactive credential — so a v19 client that ignores this field sees exactly the
   * server it saw before, and one that reads it learns when to come back.
   */
  expiresAt: z.number().int().positive().optional(),
});
export type TokenGrant = z.infer<typeof TokenGrantSchema>;

/**
 * WHY A CREDENTIAL WAS REFUSED, as a closed set of CLASSES rather than prose.
 *
 * `authenticate` has two refusals a holder can act on, and both were sentences before
 * ADR 0019 §2: a socket read `error.message === "revoked"` to decide whether to re-dial,
 * and nothing distinguished "this credential is finished" from "this credential is wrong".
 * A lens meeting `expired` re-bootstraps; a lens meeting `revoked` stops. Prose cannot
 * carry that difference, so the words are vocabulary — the same ruling `TICKET_REFUSALS`
 * makes for the ticket exchange, applied to the credential itself.
 *
 * They travel as the WebSocket close reason (4403) and as the `forbidden` message on the
 * HTTP door, both verbatim. A client that never switches on them observes exactly the v19
 * behaviour: `revoked` is the word it already read, and `expired` could not previously
 * happen.
 */
export const AUTH_REFUSALS = ["revoked", "expired"] as const;
export const AuthRefusalSchema = z.enum(AUTH_REFUSALS);
export type AuthRefusal = (typeof AUTH_REFUSALS)[number];

/**
 * ONE LIVE CREDENTIAL of one principal — a session, in the sense "which browsers hold my
 * key" asks about (ADR 0019 §3).
 *
 * A session here is a token ROW, not a socket, and that is a decision rather than a
 * convenience: whether somebody is CONNECTED right now is presence's question, answered by
 * `core.presence` and `GET /api/attendance` with a per-principal connection count, and a
 * second answer to it here would be invariant 14 with the seams showing. What this row
 * carries is the credential's own life — when it was issued, who issued it, what it is
 * confined to, and when it stops working — which is exactly what a revoke decision needs
 * and exactly what presence cannot say.
 *
 * No hash, no prefix, no fragment of the secret: the raw token existed once, in the mint
 * response, and nothing here may hand a reader a way to recognize it.
 */
export const CredentialSchema = z.strictObject({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  /** The principal that minted it; absent when the mint had no actor (boot recovery). */
  mintedBy: z.string().min(1).optional(),
  /** The container this credential is confined to; absent for a workspace-grade one. */
  containerId: z.string().min(1).optional(),
  caps: z.array(CapSchema),
  /** When it stops authenticating; absent means never, exactly as on {@link TokenGrantSchema}. */
  expiresAt: z.number().int().positive().optional(),
});
export type Credential = z.infer<typeof CredentialSchema>;

/**
 * One principal and the credentials it holds — what `core.access.listCredentials`
 * publishes, one row per principal.
 *
 * `createdAt` rides HERE rather than on {@link PrincipalSchema}, because a principal is an
 * identity the whole product passes around (attendance, presence, the session hello) and
 * when it was created is a fact only administration asks for. Putting it on the principal
 * would mean every frame carrying one grew a field nobody reads.
 */
export const PrincipalCredentialsSchema = z.strictObject({
  principal: PrincipalSchema,
  createdAt: z.number().int().nonnegative(),
  /** Live credentials only: neither revoked nor past its expiry. Empty is a real answer. */
  sessions: z.array(CredentialSchema),
});
export type PrincipalCredentials = z.infer<typeof PrincipalCredentialsSchema>;

export const CredentialsResponseSchema = z.strictObject({
  principals: z.array(PrincipalCredentialsSchema),
});
export type CredentialsResponse = z.infer<typeof CredentialsResponseSchema>;

export const RevokeRequestSchema = z.strictObject({
  principalId: z.string().min(1),
});

/**
 * What a revocation ANSWERS: how many tokens actually died. Zero is a success — asking
 * twice about a principal whose tokens are already dead is what a nervous administrator
 * does — and it must not read as the same event as three. Published here rather than
 * inside `core.access` so the door's declared result and every client's parse are one
 * schema (`core.access.revoke`).
 */
export const RevokeResultSchema = z.strictObject({
  revoked: z.number().int().nonnegative(),
});
export type RevokeResult = z.infer<typeof RevokeResultSchema>;

// ---------------------------------------------------------------------------- responses

/**
 * Which kind of build answers: `release` when it is exactly a released tag, `development` for
 * anything past one (`scripts/build-identity.ts`).
 */
export const BuildChannelSchema = z.enum(["release", "development"]);
export type BuildChannel = z.infer<typeof BuildChannelSchema>;

/** Exact response envelopes; servers MUST return these shapes, clients parse with them. */
export const HealthResponseSchema = z.strictObject({
  ok: z.literal(true),
  /** The last reachable release tag without its `v`. */
  version: z.string(),
  protocolVersion: z.number().int().positive(),
  /**
   * `version` at a release; `<version>+<distance>.g<sha7>` past one. Optional on the wire so a
   * lens can read an instance that predates the field; a current server always sends it.
   */
  build: z.string().min(1).optional(),
  /** Same additive terms as `build`. */
  channel: BuildChannelSchema.optional(),
});

export const ContainerResponseSchema = z.strictObject({ container: ContainerSchema });
export const ContainersResponseSchema = z.strictObject({ containers: z.array(ContainerSchema) });
/** Who is in one container's room right now — the attendance of that room. */
export const AttendanceSchema = z.strictObject({
  containerId: z.string().min(1),
  principals: z.array(PrincipalSchema),
});
export type Attendance = z.infer<typeof AttendanceSchema>;
export const AttendanceResponseSchema = z.strictObject({
  attendance: z.array(AttendanceSchema),
});
export const IndexResponseSchema = z.strictObject({ items: z.array(IndexEntrySchema) });

export const ContainerTerminalSummarySchema = z.strictObject({
  id: z.string().min(1),
  containerId: z.string().min(1),
  machineId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
});
export type ContainerTerminalSummary = z.infer<typeof ContainerTerminalSummarySchema>;
export const ContainerTerminalsResponseSchema = z.strictObject({
  terminals: z.array(ContainerTerminalSummarySchema),
});

/**
 * A terminal, indexed. Every terminal lives in a composition — `homeId` — so there is no
 * "pooled" variant of this row and no pool position to carry: what used to be a workspace
 * pool with its own durable ordering is now the top level of the one index, and `unplaced`
 * says whether this terminal belongs there. `unplaced` is DERIVED (no container references
 * its home), never stored, which is why parking and unparking leave no state behind.
 */
export const TerminalSummarySchema = z.strictObject({
  id: z.string().min(1),
  machineId: z.string().min(1),
  name: z.string().min(1).max(120).nullable(),
  createdAt: z.number().int().nonnegative(),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
  /** The composition this terminal lives in: solo from birth, shared once merged. */
  homeId: z.string().min(1),
  /** True while nothing references `homeId`: the terminal sits at the index's top level. */
  unplaced: z.boolean(),
});
export type TerminalSummary = z.infer<typeof TerminalSummarySchema>;
export const TerminalsResponseSchema = z.strictObject({
  terminals: z.array(TerminalSummarySchema),
});
export type TerminalsResponse = z.infer<typeof TerminalsResponseSchema>;

/**
 * One item a container holds, classified with the placement algebra's own vocabulary so a
 * census answer and a placement resolution can never disagree about what something is.
 * `containerId` is set when the item IS a container; `terminalId` when it is a terminal.
 *
 * `kind` is an open string for the same reason `PlacementItem.kind` is: a canvas holds
 * whatever element kinds the composition contributes, and the census must be able to say so
 * without the engine enumerating them (ADR 0013 §12).
 */
export const CensusItemSchema = z.strictObject({
  kind: z.string().min(1).max(32),
  containerId: z.string().min(1).nullable(),
  terminalId: z.string().min(1).nullable(),
});
export type CensusItem = z.infer<typeof CensusItemSchema>;

/**
 * What one container holds and what it points at — the index's whole input.
 *
 * `items` are the items it holds DIRECTLY: occupied tile leaves for a composition, elements
 * for a canvas, in the container's own order. `references` is the forward edge of
 * containment; inverting it across every container yields the INDEX VISIBILITY RULE
 * directly — a container no other container references is top-level, and one with parents
 * renders as a collapsed child under each of them.
 */
export const ContainerCensusSchema = z.strictObject({
  containerId: z.string().min(1),
  discipline: ContainerDisciplineSchema,
  items: z.array(CensusItemSchema),
  references: z.array(z.string().min(1)),
});
export type ContainerCensus = z.infer<typeof ContainerCensusSchema>;
export const ContainerCensusResponseSchema = z.strictObject({
  containers: z.array(ContainerCensusSchema),
});
export type ContainerCensusResponse = z.infer<typeof ContainerCensusResponseSchema>;

/**
 * The item a container of ONE holds, else null. Exported rather than inlined because this
 * one line IS the paradigm — a composition holding a single item is that item, for chrome,
 * for merging and for the index — and three subsystems deciding it separately is exactly
 * how they would come to disagree.
 */
export function censusSolo(census: ContainerCensus): CensusItem | null {
  return census.items.length === 1 ? (census.items[0] ?? null) : null;
}

/*
 * Everything that used to be a verb here — bind, park, add-tile, compose, extract, and
 * (with the solo-composition cutover) expand and pin — is now the action
 * `core.space.place` carrying `PlaceRequest`, whose legality comes from the placement
 * declarations rather than from a schema per gesture. Expand had nothing left to do once
 * every terminal already lived in a
 * composition: entering one is navigation to something that exists. Pin had nothing left to
 * claim once no container dissolved under anybody. Leaf REMOVAL is not a placement — nothing
 * accepts "nowhere" for a LEAF, so it addresses the leaf rather than moving its occupant
 * anywhere — and it kept its own route (`DELETE /api/containers/:id/tiles/:tileId`) for
 * exactly that long. Being a different verb never made it a different KIND of thing: it is a
 * discrete authority-bearing mutation, so it is now `core.space.removeTile`, the second door
 * on the plugin that owns the tree, dispatched through the same ladder and traced by it
 * (issue #114). No route here mutates a container any more, and none carried a `{ ok: true }`
 * envelope out of this file, so `OkResponseSchema` went with the last one that did.
 */
/**
 * A machine as `core.machines.list` publishes it. `color` is DERIVED, not stored: the
 * server hashes the machine id into the shared identity palette (`identityColorFor`) so
 * every viewer — browser, agent, a second client nobody wrote yet — paints the same dot
 * without re-implementing the hash. Optional because a machine row is identity first and
 * presentation second; a consumer that only wants liveness ignores it.
 */
export const MachineSummarySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  online: z.boolean(),
  color: z.string().regex(HEX_COLOR).optional(),
  /**
   * Whether this machine's credential has been WITHDRAWN (`core.machines.revoke`,
   * ADR 0019 §3). ABSENT means it has not, which is every v19 row and every live machine,
   * so a v19 reader sees the roster it always saw.
   *
   * The row survives its credential deliberately: revoking a machine revokes that machine's
   * credential, and a fleet inventory that forgot the box it just cut off would be an
   * inventory an operator cannot audit. A revoked machine is `online: false` within one
   * liveness interval, because its socket is severed by the same fence a principal's is.
   */
  revoked: z.boolean().optional(),
  /**
   * Whether this machine's terminal ADMISSION is closed (`core.machines.drain`, issue #278):
   * the hub refuses every new terminal on it until `core.machines.drain { draining: false }`.
   * ABSENT means open, which is every pre-v24 row, so a v23 reader sees the roster it always
   * saw. Persisted, so a hub restart cannot reopen a drained machine by forgetting.
   */
  draining: z.boolean().optional(),
});
export type MachineSummary = z.infer<typeof MachineSummarySchema>;
export const MachinesResponseSchema = z.strictObject({
  machines: z.array(MachineSummarySchema),
});

/**
 * `core.machines.revoke` — withdrawal as an ACT, which is the door ADR 0019 §3 names as
 * missing. The mechanism existed one level down (`rotateMachineToken` revokes and re-mints);
 * what nothing could ask for was revocation WITHOUT a re-mint. One door, one concept: there
 * is no second spelling of "revoke this machine's credential" (invariant 14).
 */
export const RevokeMachineRequestSchema = z.strictObject({
  machineId: z.string().min(1),
});
export type RevokeMachineRequest = z.infer<typeof RevokeMachineRequestSchema>;

/**
 * `core.machines.drain` — the ATOMIC admission contract a host activation needs before it
 * replaces a machine's agent (issue #278). `draining: true` closes new-terminal admission on
 * the hub FIRST (persisted, so a hub restart cannot forget it), then asks the machine's
 * terminal owner to latch the same and report every PTY it still holds. `draining: false` is
 * the explicit cancellation, and the only thing that reopens admission.
 */
export const DrainMachineRequestSchema = z.strictObject({
  machineId: z.string().min(1),
  draining: z.boolean(),
});
export type DrainMachineRequest = z.infer<typeof DrainMachineRequestSchema>;

/**
 * What the OWNER answered, and nothing the hub inferred: `terminalHostId` is the identity of
 * the process holding the PTYs and `terminalIds` is every live PTY it holds after applying
 * `draining`, ordered behind every create the hub had already sent. An owner that could not
 * answer — offline, a pre-v24 agent with no owner identity, a timeout, a mismatched
 * identity — is a REFUSAL of the action rather than an empty list: an unknown machine is not
 * a safe one, and the admission the hub closed stays closed until cancelled.
 */
export const MachineDrainStatusSchema = z.strictObject({
  terminalHostId: z.string().min(1),
  draining: z.boolean(),
  terminalIds: z.array(z.string().min(1)),
});
export type MachineDrainStatus = z.infer<typeof MachineDrainStatusSchema>;

export const EnrollMachineRequestSchema = z.strictObject({
  name: z.string().min(1).max(120),
  /** Revoke and re-mint the token when the name is already enrolled (recovers a lost token file). */
  rotateToken: z.boolean().optional(),
});
export const MachineEnrollResponseSchema = z.strictObject({
  machine: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    color: z.string().regex(HEX_COLOR).optional(),
  }),
  /**
   * Raw token — returned exactly once, only when a token was minted (new machine or explicit
   * rotation); the DB keeps only its hash. Absent on an idempotent re-enroll of an existing
   * name, which never invalidates the token the running agent already holds.
   */
  machineToken: z.string().min(1).optional(),
});
export type MachineEnrollResponse = z.infer<typeof MachineEnrollResponseSchema>;

/**
 * `GET /api/resolve?uri=` — what a `manifold://` address points at, answered by the one
 * side that can see every node: the URI echoed back in canonical form, its structured
 * reference, whether the node exists RIGHT NOW, and its display title when it has one.
 *
 * Existence is a separate field rather than a 404 because a dead reference is a legitimate
 * answer about a live address — a link to a terminal that has since been killed resolves
 * fine and reports `exists: false`, which is what a renderer needs to say so.
 */
export const ResolveResponseSchema = z.strictObject({
  uri: z.string().min(1),
  ref: ManifoldRefSchema,
  exists: z.boolean(),
  title: z.string().nullable(),
});
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;

/**
 * `GET /api/plugins` — the workspace's assembly as every principal sees it. The same
 * roster arrives unsolicited on the connection-level `plugins` session frame whenever it
 * changes; this door is how a client that has not opened a socket yet (or holds no room to
 * join) learns the vocabulary.
 */
export const PluginsResponseSchema = z.strictObject({ plugins: PluginRosterSchema });
export type PluginsResponse = z.infer<typeof PluginsResponseSchema>;

/**
 * `GET /api/layout` — the CALLER's workspace tree. Self-scoped by construction: a layout is
 * per principal, so the door takes no id and `core.space.setLayout` writes only the caller's own.
 */
export const LayoutResponseSchema = z.strictObject({ layout: TileLayoutSchema });
export type LayoutResponse = z.infer<typeof LayoutResponseSchema>;

/**
 * `GET /api/bindings` — the CALLER's key overrides. Self-scoped exactly as the layout door is:
 * a rebinding is per principal, so the door takes no id, and `core.keys.setBinding` writes only
 * the caller's own.
 *
 * It is a FLOOR read of PLUGIN-written state, which is the same shape `/api/layout` has and for
 * the same reason: the engine composes the key table, so the engine needs the delta at boot
 * before any plugin has drawn anything, and a floor route that fetched it by dispatching a
 * plugin's read door would make the browser engine name a favourite plugin (AXIOMS.md
 * §Foundation law, neutrality). The WRITE stays a declared door somebody owns; only the read is
 * the engine's.
 */
export const BindingsResponseSchema = z.strictObject({ overrides: BindingOverridesSchema });
export type BindingsResponse = z.infer<typeof BindingsResponseSchema>;

/**
 * `GET /api/settings` — the CALLER's plugin setting values. Self-scoped exactly as the layout
 * and binding doors are: a preference is per principal, so the door takes no id, and
 * `engine.plugins.setSetting` writes only the caller's own.
 *
 * It is a FLOOR read for the same reason `/api/bindings` is one: the engine composes the
 * sidebar — a row whose setting reads false is dropped before any plugin has drawn anything —
 * so it needs the delta at boot, and a floor route that fetched it by dispatching some
 * plugin's read door would make the browser engine name a favourite plugin (AXIOMS.md
 * §Foundation law, neutrality). A failed read composes the DECLARED defaults, which is the
 * honest degradation: every row answers what its plugin shipped.
 */
export const SettingsResponseSchema = z.strictObject({ values: PluginSettingValuesSchema });
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
