import {
  ActionOutcomeSchema,
  BootstrapPrincipalRequestSchema,
  HttpErrorSchema,
  LayoutResponseSchema,
  AttendanceResponseSchema,
  ContainerSchema,
  TokenGrantSchema,
  type Container,
  type Attendance,
  type Principal,
  type TileLayout,
} from "@manifold/protocol";
import { instanceUrl } from "@manifold/plugin/hooks";

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

/**
 * Every door this layer knocks on is addressed at the INSTANCE, not at the origin that served
 * the page. The two are the same thing for an ordinary self-hosted deployment and deliberately
 * not the same assumption: a lens may be pointed elsewhere (`@manifold/plugin/hooks`
 * `instanceOrigin`, AXIOMS §The portable lens), and a relative path would quietly follow the
 * bundle's birthplace instead.
 */
async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(instanceUrl(path), init);
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

/**
 * Exchanges the fragment-delivered owner key for a durable human token
 * (`core.access.createPrincipal`).
 *
 * The owner key is the ONE credential that lives outside the token system, which is why
 * this boot path holds a raw secret and no terminal: it authenticates as root, asks the
 * access door for an identity, and keeps only the grant. It is also why `core.access` is not
 * `essential` — disabling it costs delegation, never the owner's own way in.
 */
export async function createPrincipal(
  ownerKey: string,
  input: { readonly name: string; readonly color: string },
): Promise<StoredIdentity> {
  const request = BootstrapPrincipalRequestSchema.parse({
    name: input.name,
    color: input.color,
    kind: "human",
  });
  const grant = TokenGrantSchema.parse(
    await dispatchAction(ownerKey, "core.access.createPrincipal", request),
  );
  return { token: grant.token, principal: grant.principal };
}

/**
 * Loads one container so a direct `/p/:id` deep-link still has its name and discipline
 * (`core.index.readContainer`). Declared `scope: "container"`, so a container-scoped viewer resolves its own
 * container exactly as `GET /api/containers/:id` let it.
 */
export async function getContainer(token: string, containerId: string): Promise<Container> {
  const result = await dispatchAction(token, "core.index.readContainer", { containerId });
  return ContainerSchema.parse(fieldFromObject(result, "container"));
}

/*
 * Renaming, deleting, machine listing and leaf removal were wrapped here too, and are not
 * any more: every one of them now belongs to a plugin that holds a `SessionClient`
 * (`renameContainer`, `deleteContainer`, `machines`, `removeContainerTile` on the SDK's own ref). What is
 * left in this layer is exactly what the BOOT path needs — a token, no terminal, one
 * container to name and one workspace tree to fetch — which is the whole reason it exists.
 */

/**
 * The CALLER's workspace tree (`GET /api/layout`) — the tile layout whose leaves name
 * plugin panels. Self-scoped by construction: the door takes no principal id and answers
 * the caller's own tree, falling back server-side to the engine's default workspace.
 */
export async function getWorkspaceLayout(token: string): Promise<TileLayout> {
  const body = await requestJson("/api/layout", {
    headers: authHeaders(token, false),
  });
  return LayoutResponseSchema.parse(body).layout;
}

/** Loads principal-level presence for containers with connected viewers. */
export async function getAttendance(token: string): Promise<readonly Attendance[]> {
  const body = await requestJson("/api/attendance", {
    headers: authHeaders(token, false),
  });
  return AttendanceResponseSchema.parse(body).attendance;
}

/*
 * Terminals had three bespoke routes wrapped here — the index, the rename and the kill. All
 * three are the action door now (`core.terminals.listAll` / `.rename` / `.kill`), reached
 * through `SessionClient` by every caller, so there is nothing left for this layer to wrap:
 * one door, and the shell reaches it exactly the way a plugin does.
 */

/**
 * One action dispatch over this device's token. The action door answers 200 for a REFUSAL
 * too, so the outcome decides and not the status; a denial becomes the thrown message every
 * other call in this layer already throws, because these callers render an error string and
 * have no rung to branch on. Code holding a `SessionClient` uses `client.action` instead —
 * this exists for the boot-time paths that hold a token and nothing else.
 */
export async function dispatchAction(token: string, name: string, args: unknown): Promise<unknown> {
  const body = await requestJson(`/api/actions/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify(args),
  });
  const outcome = ActionOutcomeSchema.parse(body);
  if (!outcome.ok) throw new Error(outcome.denial.message);
  return outcome.result;
}
