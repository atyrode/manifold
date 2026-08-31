import {
  ActionOutcomeSchema,
  BootstrapPrincipalRequestSchema,
  CreatePadFolderRequestSchema,
  CreatePadRequestSchema,
  HttpErrorSchema,
  MachinesResponseSchema,
  MovePadTreeItemRequestSchema,
  PadPresenceResponseSchema,
  PadSchema,
  PadSessionsResponseSchema,
  PadTreeResponseSchema,
  PlaceRequestSchema,
  PlaceResponseSchema,
  PlacementDeniedResponseSchema,
  RenamePadRequestSchema,
  TerminalsResponseSchema,
  TokenGrantSchema,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type PadSessionSummary,
  type PadTreeItem,
  type PlacementDestination,
  type PlacementSurface,
  type Principal,
  type TerminalSummary,
} from "@manifold/protocol";
import type { PlaceOutcome } from "@manifold/sdk";

/** The browser persists only the bearer token and stable identity it needs after bootstrap. */
export interface StoredIdentity {
  readonly token: string;
  readonly principal: Principal;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Server returned a non-JSON response (${response.status})`);
  }
}

function errorFromBody(status: number, body: unknown): Error {
  const parsed = HttpErrorSchema.safeParse(body);
  if (parsed.success) return new Error(parsed.data.error.message);
  return new Error(`Request failed (${status})`);
}

async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const body = await readBody(response);
  if (!response.ok) throw errorFromBody(response.status, body);
  return body;
}

function fieldFromObject(body: unknown, field: string): unknown {
  if (body === null || typeof body !== "object") {
    throw new Error("Server returned an invalid response");
  }
  return Reflect.get(body, field);
}

function authHeaders(token: string, includeJson: boolean): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
  };
}

/** Exchanges the fragment-delivered owner key for a durable human token. */
export async function createPrincipal(
  ownerKey: string,
  input: { readonly name: string; readonly color: string },
): Promise<StoredIdentity> {
  const request = BootstrapPrincipalRequestSchema.parse({
    name: input.name,
    color: input.color,
    kind: "human",
  });
  const body = await requestJson("/api/principals", {
    method: "POST",
    headers: authHeaders(ownerKey, true),
    body: JSON.stringify(request),
  });
  const grant = TokenGrantSchema.parse(body);
  return { token: grant.token, principal: grant.principal };
}

/** Loads one container so a direct `/p/:id` deep-link still has its name and discipline. */
export async function getPad(token: string, padId: string): Promise<Pad> {
  const body = await requestJson(`/api/pads/${encodeURIComponent(padId)}`, {
    headers: authHeaders(token, false),
  });
  return PadSchema.parse(fieldFromObject(body, "pad"));
}

/** Creates a pad through the protocol-owned request schema; `layout` picks the discipline. */
export async function createPad(token: string, name: string, layout?: Pad["layout"]): Promise<Pad> {
  const request = CreatePadRequestSchema.parse({ name, layout });
  const body = await requestJson("/api/pads", {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadSchema.parse(fieldFromObject(body, "pad"));
}

/** Renames a pad through the protocol-owned request schema. */
export async function renamePad(token: string, padId: string, name: string): Promise<Pad> {
  const request = RenamePadRequestSchema.parse({ name });
  const body = await requestJson(`/api/pads/${encodeURIComponent(padId)}`, {
    method: "PATCH",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadSchema.parse(fieldFromObject(body, "pad"));
}
export async function listPadTree(token: string): Promise<readonly PadTreeItem[]> {
  const body = await requestJson("/api/pad-tree", {
    headers: authHeaders(token, false),
  });
  return PadTreeResponseSchema.parse(body).items;
}

export async function createPadFolder(
  token: string,
  name: string,
  parentId: string | null,
): Promise<readonly PadTreeItem[]> {
  const request = CreatePadFolderRequestSchema.parse({ name, parentId });
  const body = await requestJson("/api/pad-folders", {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadTreeResponseSchema.parse(body).items;
}

export async function renamePadFolder(
  token: string,
  folderId: string,
  name: string,
): Promise<readonly PadTreeItem[]> {
  const request = RenamePadRequestSchema.parse({ name });
  const body = await requestJson(`/api/pad-folders/${encodeURIComponent(folderId)}`, {
    method: "PATCH",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadTreeResponseSchema.parse(body).items;
}

export async function deletePadFolder(
  token: string,
  folderId: string,
): Promise<readonly PadTreeItem[]> {
  const body = await requestJson(`/api/pad-folders/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
    headers: authHeaders(token, false),
  });
  return PadTreeResponseSchema.parse(body).items;
}

export async function movePadTreeItem(
  token: string,
  item: { readonly kind: "pad" | "folder"; readonly id: string },
  parentId: string | null,
  index: number,
): Promise<readonly PadTreeItem[]> {
  const request = MovePadTreeItemRequestSchema.parse({ item, parentId, index });
  const body = await requestJson("/api/pad-tree", {
    method: "PUT",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadTreeResponseSchema.parse(body).items;
}

/** Loads principal-level presence for pads with connected viewers. */
export async function getPadPresence(token: string): Promise<readonly PadPresence[]> {
  const body = await requestJson("/api/pad-presence", {
    headers: authHeaders(token, false),
  });
  return PadPresenceResponseSchema.parse(body).pads;
}
/** Loads open terminal sessions across every pad visible to the current principal. */
export async function getPadSessions(token: string): Promise<readonly PadSessionSummary[]> {
  const body = await requestJson("/api/pad-sessions", {
    headers: authHeaders(token, false),
  });
  return PadSessionsResponseSchema.parse(body).sessions;
}

/**
 * Every terminal in the workspace (`GET /api/terminals`). There is no pool and no parked
 * variant: each row carries the composition it lives in (`homeId`) and whether anything
 * references that home (`unplaced`), which is what puts it at the index's top level.
 */
export async function listTerminals(token: string): Promise<readonly TerminalSummary[]> {
  const body = await requestJson("/api/terminals", {
    headers: authHeaders(token, false),
  });
  return TerminalsResponseSchema.parse(body).terminals;
}

/**
 * THE placement call for anything outside a room: put an item in a container
 * (`POST /api/place`). One envelope replaces bind, park, add-tile, compose and extract,
 * and a refusal comes back as DATA — the declared rule that refused it — because a client
 * renders the rule rather than parsing prose.
 *
 * The sidebar has no room socket (it indexes containers, it does not join them), so this
 * token-bound path exists beside `SessionClient.place`, which is the same request made from
 * inside a room. Both hit the one endpoint.
 */
export async function placeItem(
  token: string,
  surface: PlacementSurface,
  destination: PlacementDestination,
): Promise<PlaceOutcome> {
  const request = PlaceRequestSchema.parse({ surface, destination });
  const response = await fetch("/api/place", {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  const body = await readBody(response);
  if (response.ok) return { ok: true, result: PlaceResponseSchema.parse(body) };
  const denied = PlacementDeniedResponseSchema.safeParse(body);
  if (denied.success) return { ok: false, denial: denied.data.error.denial };
  throw errorFromBody(response.status, body);
}

/**
 * Invokes one action (`POST /api/actions/:name`). Denials are DATA — the door answers 200
 * with `ok: false` — so a refusal becomes an Error carrying the reason the door gave rather
 * than a status code the caller would have to interpret.
 */
async function invokeAction(token: string, name: string, args: unknown): Promise<void> {
  const body = await requestJson(`/api/actions/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(args),
  });
  const outcome = ActionOutcomeSchema.parse(body);
  if (!outcome.ok) throw new Error(outcome.denial.message);
}

/** Renames a terminal session (`core.terminals.rename`), placed or not. */
export async function renameTerminal(
  token: string,
  sessionId: string,
  name: string,
): Promise<void> {
  await invokeAction(token, "core.terminals.rename", { sessionId, name });
}

/**
 * Kills a terminal's PTY (`core.terminals.kill`). Nothing survives it: with no pool to fall
 * back into, a terminal's home composition is emptied and deleted with it.
 */
export async function killTerminal(token: string, sessionId: string): Promise<void> {
  await invokeAction(token, "core.terminals.kill", { sessionId });
}

/** Loads the enrolled machines with live online state (`GET /api/machines`). */
export async function getMachines(token: string): Promise<readonly MachineSummary[]> {
  const body = await requestJson("/api/machines", {
    headers: authHeaders(token, false),
  });
  return MachinesResponseSchema.parse(body).machines;
}

/** Deletes a pad (server enforces root authority); resolves when the server confirms. */
export async function deletePad(token: string, padId: string): Promise<void> {
  await requestJson(`/api/pads/${encodeURIComponent(padId)}`, {
    method: "DELETE",
    headers: authHeaders(token, false),
  });
}

/*
 * Two calls retired with the solo-composition cutover and left no successor here.
 * `expandTerminal` had nothing to create — every terminal already lives in a composition,
 * so entering one is `navigate("/p/" + homeId)`. `pinPad` had nothing to claim once no
 * container dissolved under anybody. Reordering an unplaced terminal is `movePadTreeItem`
 * on its home, because the pool's separate ordering folded into the one index.
 */

/**
 * Removes one leaf from a composition (`DELETE /api/pads/:id/tiles/:tileId`). Removal is
 * the one tile gesture that is NOT a placement — nothing accepts "nowhere" — so it keeps
 * its own route while every MOVE of a leaf's occupant goes through `placeItem`.
 */
export async function removePadTile(token: string, padId: string, tileId: string): Promise<void> {
  await requestJson(`/api/pads/${encodeURIComponent(padId)}/tiles/${encodeURIComponent(tileId)}`, {
    method: "DELETE",
    headers: authHeaders(token, false),
  });
}
