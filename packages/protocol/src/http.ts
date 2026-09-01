import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { HEX_COLOR } from "./elements.ts";
import { ContainerDisciplineSchema, TileLayoutSchema } from "./layout.ts";
import { BindingOverridesSchema, PluginRosterSchema } from "./plugin.ts";
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
});
export type TokenGrant = z.infer<typeof TokenGrantSchema>;

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

/** Exact response envelopes; servers MUST return these shapes, clients parse with them. */
export const HealthResponseSchema = z.strictObject({
  ok: z.literal(true),
  version: z.string(),
  protocolVersion: z.number().int().positive(),
  /** Image/tree provenance (git SHA) baked at build time; absent on ad-hoc dev runs. */
  build: z.string().min(1).optional(),
});

export const OkResponseSchema = z.strictObject({ ok: z.literal(true) });

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
 * claim once no container dissolved under anybody. Only leaf REMOVAL kept its own route
 * (`DELETE /api/containers/:id/tiles/:tileId`), because removal is not a placement: it
 * addresses the leaf rather than moving its occupant anywhere.
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
});
export type MachineSummary = z.infer<typeof MachineSummarySchema>;
export const MachinesResponseSchema = z.strictObject({
  machines: z.array(MachineSummarySchema),
});
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
