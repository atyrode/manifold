import {
  BootstrapPrincipalRequestSchema,
  CreatePadFolderRequestSchema,
  CreatePadRequestSchema,
  HttpErrorSchema,
  MachinesResponseSchema,
  MovePadRequestSchema,
  OkResponseSchema,
  PadFolderResponseSchema,
  PadFoldersResponseSchema,
  PadPresenceResponseSchema,
  PadSessionsResponseSchema,
  PadSchema,
  RenamePadRequestSchema,
  ReorderPadsRequestSchema,
  TokenGrantSchema,
  type MachineSummary,
  type Pad,
  type PadFolder,
  type PadPresence,
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

/** Creates a pad through the protocol-owned request schema. */
export async function createPad(token: string, name: string): Promise<Pad> {
  const request = CreatePadRequestSchema.parse({ name });
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
/** Persists the complete owner-visible pad order atomically. */
export async function reorderPads(token: string, padIds: readonly string[]): Promise<void> {
  const request = ReorderPadsRequestSchema.parse({ padIds });
  const body = await requestJson("/api/pads/order", {
    method: "PUT",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  OkResponseSchema.parse(body);
}
export async function listPadFolders(token: string): Promise<readonly PadFolder[]> {
  const body = await requestJson("/api/pad-folders", {
    headers: authHeaders(token, false),
  });
  return PadFoldersResponseSchema.parse(body).folders;
}

export async function createPadFolder(
  token: string,
  name: string,
  padIds: readonly string[] = [],
): Promise<PadFolder> {
  const request = CreatePadFolderRequestSchema.parse({ name, padIds });
  const body = await requestJson("/api/pad-folders", {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadFolderResponseSchema.parse(body).folder;
}

export async function renamePadFolder(
  token: string,
  folderId: string,
  name: string,
): Promise<PadFolder> {
  const request = RenamePadRequestSchema.parse({ name });
  const body = await requestJson(`/api/pad-folders/${encodeURIComponent(folderId)}`, {
    method: "PATCH",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  return PadFolderResponseSchema.parse(body).folder;
}

export async function deletePadFolder(token: string, folderId: string): Promise<void> {
  const body = await requestJson(`/api/pad-folders/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
    headers: authHeaders(token, false),
  });
  OkResponseSchema.parse(body);
}

export async function movePadToFolder(
  token: string,
  padId: string,
  folderId: string | null,
): Promise<void> {
  const request = MovePadRequestSchema.parse({ folderId });
  const body = await requestJson(`/api/pads/${encodeURIComponent(padId)}/folder`, {
    method: "PUT",
    headers: authHeaders(token, true),
    body: JSON.stringify(request),
  });
  OkResponseSchema.parse(body);
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
