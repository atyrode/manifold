import {
  BootstrapPrincipalRequestSchema,
  CreatePadFolderRequestSchema,
  CreatePadRequestSchema,
  HttpErrorSchema,
  MachinesResponseSchema,
  MovePadTreeItemRequestSchema,
  PadTreeResponseSchema,
  PadPresenceResponseSchema,
  PadSessionsResponseSchema,
  PadSchema,
  RenamePadRequestSchema,
  TokenGrantSchema,
  BindTerminalRequestSchema,
  BindTerminalResponseSchema,
  ParkTerminalRequestSchema,
  MoveTerminalPoolRequestSchema,
  RenameTerminalRequestSchema,
  AddPadTileRequestSchema,
  AddPadTileResponseSchema,
  ComposePadTileRequestSchema,
  ComposePadTileResponseSchema,
  ExpandTerminalResponseSchema,
  ExtractPadTileRequestSchema,
  ExtractPadTileResponseSchema,
  type TileEdge,
  type TileSurface,
  TerminalPoolResponseSchema,
  type TerminalPoolEntry,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type PadTreeItem,
  type PadSessionSummary,
  type Principal,
} from "@manifold/protocol";

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

/** Loads every pad visible to the current principal. */
export async function listPads(token: string): Promise<Pad[]> {
  const body = await requestJson("/api/pads", {
    headers: authHeaders(token, false),
  });
  const pads = fieldFromObject(body, "pads");
  if (!Array.isArray(pads)) throw new Error("Server returned an invalid pad list");
  return pads.map((pad) => PadSchema.parse(pad));
}

/** Loads a pad so direct `/p/:padId` navigation still has its display name. */
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

/** Lists parked terminals in the workspace pool (`GET /api/terminals`). */
export async function listTerminals(token: string): Promise<readonly TerminalPoolEntry[]> {
  const body = await requestJson("/api/terminals", {
    headers: authHeaders(token, false),
  });
  return TerminalPoolResponseSchema.parse(body).terminals;
}

/** Parks one canvas element; unbinds the session when it was the last reference. */
export async function parkTerminal(
  token: string,
  sessionId: string,
  elementId: string,
): Promise<void> {
  const request = ParkTerminalRequestSchema.parse({ elementId });
  await requestJson(`/api/terminals/${encodeURIComponent(sessionId)}/park`, {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
}

/** Binds a parked session to a pad; the server authors the canvas element. */
export async function bindTerminal(
  token: string,
  sessionId: string,
  padId: string,
  x?: number,
  y?: number,
): Promise<string> {
  const request = BindTerminalRequestSchema.parse({ padId, x, y });
  const body = await requestJson(`/api/terminals/${encodeURIComponent(sessionId)}/bind`, {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return BindTerminalResponseSchema.parse(body).elementId;
}

/** Renames a terminal session (`PATCH /api/terminals/:id`); works bound or parked. */
export async function renameTerminal(
  token: string,
  sessionId: string,
  name: string,
): Promise<void> {
  const request = RenameTerminalRequestSchema.parse({ name });
  await requestJson(`/api/terminals/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
}

/** Reorders a parked terminal within the workspace pool (`PUT /api/terminal-pool`). */
export async function moveTerminalPool(
  token: string,
  sessionId: string,
  index: number,
): Promise<readonly TerminalPoolEntry[]> {
  const request = MoveTerminalPoolRequestSchema.parse({ sessionId, index });
  const body = await requestJson("/api/terminal-pool", {
    method: "PUT",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return TerminalPoolResponseSchema.parse(body).terminals;
}

/** Kills a pooled terminal's PTY (`DELETE /api/terminals/:id`). */
export async function killPooledTerminal(token: string, sessionId: string): Promise<void> {
  await requestJson(`/api/terminals/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: authHeaders(token, false),
  });
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

/**
 * Expands a terminal into a tiled view born around it (`POST /api/terminals/:id/expand`).
 * Returns the new container id; the caller navigates into it.
 */
export async function expandTerminal(token: string, sessionId: string): Promise<string> {
  const body = await requestJson(`/api/terminals/${encodeURIComponent(sessionId)}/expand`, {
    method: "POST",
    headers: authHeaders(token, false),
  });
  return ExpandTerminalResponseSchema.parse(body).viewId;
}

/** Hardens a transient view so it outlives its last occupant (`POST /api/pads/:id/pin`). */
export async function pinPad(token: string, padId: string): Promise<void> {
  await requestJson(`/api/pads/${encodeURIComponent(padId)}/pin`, {
    method: "POST",
    headers: authHeaders(token, false),
  });
}

/**
 * Adds a surface to a tiled container (`POST /api/pads/:id/tiles`). A null target
 * fills the first empty leaf; otherwise `edge` splits the target tile. Returns the
 * new leaf's tile id.
 */
export async function addPadTile(
  token: string,
  padId: string,
  surface: TileSurface,
  targetTileId: string | null,
  edge: TileEdge | null,
): Promise<string> {
  const request = AddPadTileRequestSchema.parse({ surface, targetTileId, edge });
  const body = await requestJson(`/api/pads/${encodeURIComponent(padId)}/tiles`, {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return AddPadTileResponseSchema.parse(body).tileId;
}

/** Removes one leaf from a tiled container (`DELETE /api/pads/:id/tiles/:tileId`). */
export async function removePadTile(token: string, padId: string, tileId: string): Promise<void> {
  await requestJson(`/api/pads/${encodeURIComponent(padId)}/tiles/${encodeURIComponent(tileId)}`, {
    method: "DELETE",
    headers: authHeaders(token, false),
  });
}

/**
 * Composes a dragged surface onto a canvas terminal (`POST /api/pads/:id/compose`),
 * birthing a durable view around the target. Returns the new container id.
 */
export async function composePadTile(
  token: string,
  padId: string,
  targetElementId: string,
  surface: TileSurface,
  edge: TileEdge,
): Promise<string> {
  const request = ComposePadTileRequestSchema.parse({ targetElementId, surface, edge });
  const body = await requestJson(`/api/pads/${encodeURIComponent(padId)}/compose`, {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return ComposePadTileResponseSchema.parse(body).viewId;
}

/**
 * Pulls one tile out of a view back onto the canvas it lives on
 * (`POST /api/pads/:id/tiles/:tileId/extract`). Returns the new element's id.
 */
export async function extractPadTile(
  token: string,
  padId: string,
  tileId: string,
  x: number,
  y: number,
): Promise<string> {
  const request = ExtractPadTileRequestSchema.parse({ x, y });
  const body = await requestJson(
    `/api/pads/${encodeURIComponent(padId)}/tiles/${encodeURIComponent(tileId)}/extract`,
    { method: "POST", headers: authHeaders(token, true), body: JSON.stringify(request) },
  );
  return ExtractPadTileResponseSchema.parse(body).elementId;
}
