import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { DEFAULT_WORKSPACE_LAYOUT } from "@manifold/plugin";
import {
  ActionOutcomeSchema,
  ContainersResponseSchema,
  HealthResponseSchema,
  HttpErrorSchema,
  LayoutResponseSchema,
  OkResponseSchema,
  PROTOCOL_VERSION,
  PadPresenceResponseSchema,
  PluginsResponseSchema,
  ResolveResponseSchema,
  buildProtocolJsonSchema,
  formatManifoldUri,
  parseManifoldUri,
  type Cap,
  type HttpError,
  type ManifoldRef,
} from "@manifold/protocol";
import { ServiceError, type AuthContext, type AuthService } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { MachineGateway } from "./machine-ws.ts";
import type { PlaceExecutor } from "./placement.ts";
import type { PluginHost } from "./plugin-host.ts";
import type { RoomManager } from "./room.ts";
import type { ServerStore } from "./stores.ts";
import type { TerminalBroker } from "./terminal-broker.ts";

/** Build identifier exposed by `/healthz`; protocol compatibility has its own version. */
export const SERVER_VERSION = "0.1.0";

/** HTTP JSON ceiling, mirrored by Bun.serve so chunked bodies cannot reach its 128 MiB default. */
export const MAX_HTTP_BODY_BYTES = 1_048_576;

type HttpErrorCode = HttpError["error"]["code"];

class RequestError extends Error {
  constructor(
    readonly code: HttpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

const STATUS_BY_CODE: Readonly<Record<RequestError["code"], number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  internal: 500,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: RequestError): Response {
  const body = HttpErrorSchema.parse({ error: { code: error.code, message: error.message } });
  return jsonResponse(body, STATUS_BY_CODE[error.code]);
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > MAX_HTTP_BODY_BYTES) {
    throw new RequestError("invalid", "request body is too large");
  }

  const reader = request.body?.getReader();
  if (reader === undefined) throw new RequestError("invalid", "request body must be valid JSON");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_HTTP_BODY_BYTES) {
      throw new RequestError("invalid", "request body is too large");
    }
    chunks.push(chunk.value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks, bytes));
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError("invalid", "request body must be valid JSON");
  }
}

function requireRoot(context: AuthContext): void {
  if (!context.isRoot) throw new RequestError("forbidden", "root capability required");
}

/** Decodes one path segment, mapping a missing or malformed escape to a 400. */
function decodePathSegment(encoded: string | undefined, label: string): string {
  if (encoded === undefined) throw new RequestError("invalid", `${label} is missing`);
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new RequestError("invalid", `${label} is invalid`);
  }
}

/** Bun fetch handler implementing the complete JSON API and SPA fallback contract. */
export class HttpApp {
  constructor(
    private readonly config: ServerConfig,
    private readonly store: ServerStore,
    private readonly auth: AuthService,
    private readonly rooms: RoomManager,
    private readonly broker: TerminalBroker,
    private readonly placement: PlaceExecutor,
    private readonly machines: MachineGateway,
    private readonly plugins: PluginHost,
    private readonly logger: Logger,
  ) {}

  /** Handles a request without allowing auth secrets to enter logs or errors. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return jsonResponse(
          HealthResponseSchema.parse({
            ok: true,
            version: SERVER_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            ...(this.config.build !== undefined ? { build: this.config.build } : {}),
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/protocol") {
        // The description publishes the LIVE vocabulary: every composed action with its
        // schemas, and the roster that says which plugin owns each one. A stranger's agent
        // reads this document and knows every door it may knock on.
        return jsonResponse(
          buildProtocolJsonSchema({
            actions: this.plugins.roster().flatMap((entry) => entry.actions),
            plugins: this.plugins.roster(),
          }),
        );
      }
      if (url.pathname.startsWith("/api")) return await this.api(request, url.pathname);
      if (
        request.method === "GET" &&
        !url.pathname.startsWith("/ws") &&
        !url.pathname.startsWith("/healthz")
      ) {
        return this.staticFile(url.pathname);
      }
      throw new RequestError("not_found", "route not found");
    } catch (error) {
      if (error instanceof RequestError) return errorResponse(error);
      if (error instanceof ServiceError) {
        return errorResponse(new RequestError(error.code, error.message));
      }
      this.logger.error("http_request_failed", {
        method: request.method,
        error: error instanceof Error ? error.message : "unknown failure",
      });
      return errorResponse(new RequestError("internal", "internal server error"));
    }
  }

  private authenticate(request: Request): AuthContext {
    const header = request.headers.get("authorization");
    if (header === null || !header.startsWith("Bearer ")) {
      throw new RequestError("unauthorized", "bearer token required");
    }
    const raw = header.slice("Bearer ".length).trim();
    if (raw.length === 0) throw new RequestError("unauthorized", "bearer token required");
    return this.auth.authenticate(raw);
  }

  private requireCap(context: AuthContext, cap: Exclude<Cap, "*">, padId?: string): void {
    if (!this.auth.allows(context, cap, padId)) {
      throw new RequestError("forbidden", `${cap} capability required`);
    }
  }

  private async api(request: Request, pathname: string): Promise<Response> {
    if (request.method === "GET" && pathname === "/api/pad-presence") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      const pads = this.rooms
        .presence()
        .filter((pad) => context.padScope === null || pad.padId === context.padScope);
      return jsonResponse(PadPresenceResponseSchema.parse({ pads }));
    }
    /*
      The index's whole input: what every container holds and what it points at. One route
      rather than a field on each of the pad routes, because the INDEX VISIBILITY RULE needs
      the containment GRAPH — a row is top-level exactly when no other container references
      it — and a graph cannot be assembled from rows fetched one at a time.
     */
    if (request.method === "GET" && pathname === "/api/containers") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot read the container index");
      }
      return jsonResponse(ContainersResponseSchema.parse({ containers: this.rooms.censuses() }));
    }

    /*
      THE ACTION DOOR. One route for every mutation any plugin declares, because a door per
      feature is how a workspace ends up with thirty of them and no published vocabulary.

      Authentication only here: the caps an action requires are the ACTION's declaration, so
      the ladder inside `dispatch` is the single place authority is decided (and the single
      place a pad-scoped token is refused). A denial answers 200 carrying `ok: false`, the
      shape a refused placement uses too — a refusal is an answer about authority or state,
      never a transport failure.
     */
    const actionMatch = /^\/api\/actions\/([^/]+)$/.exec(pathname);
    if (actionMatch !== null && request.method === "POST") {
      const name = decodePathSegment(actionMatch[1], "action name");
      const context = this.authenticate(request);
      const outcome = await this.plugins.dispatch(context, name, await parseJsonBody(request));
      return jsonResponse(ActionOutcomeSchema.parse(outcome));
    }

    if (request.method === "GET" && pathname === "/api/plugins") {
      // Any authenticated token, pad-scoped included — the same reasoning that makes
      // `core.machines.list` a `scope: "pad"` read: the roster is VOCABULARY, and a scoped
      // viewer still has to render panels and know which plugin owns the placeholder it is
      // looking at.
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      return jsonResponse(PluginsResponseSchema.parse({ plugins: this.plugins.roster() }));
    }

    if (request.method === "GET" && pathname === "/api/layout") {
      // Self-scoped by construction: a workspace tree belongs to one principal, so the door
      // takes no id and answers the caller's own — the default until they write one.
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      const layout = this.store.workspaceLayout(context.principal.id) ?? DEFAULT_WORKSPACE_LAYOUT;
      return jsonResponse(LayoutResponseSchema.parse({ layout }));
    }

    if (request.method === "GET" && pathname === "/api/resolve") {
      const context = this.authenticate(request);
      this.requireCap(context, "pads:read");
      const raw = new URL(request.url).searchParams.get("uri");
      if (raw === null) throw new RequestError("invalid", "uri query parameter is required");
      const ref = parseManifoldUri(raw);
      // An address this server cannot parse is a bad REQUEST; an address that parses and
      // points at nothing is a legitimate answer carrying `exists: false`.
      if (ref === null) throw new RequestError("invalid", "uri is not a manifold:// address");
      return jsonResponse(
        ResolveResponseSchema.parse({
          uri: formatManifoldUri(ref),
          ref,
          ...this.resolveRef(ref, context),
        }),
      );
    }

    const tileMatch = /^\/api\/pads\/([^/]+)\/tiles\/([^/]+)$/.exec(pathname);
    if (tileMatch !== null && request.method === "DELETE") {
      const padId = decodePathSegment(tileMatch[1], "pad id");
      const context = this.authenticate(request);
      this.requireCap(context, "pads:write");
      if (context.padScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot remove tiles");
      }
      // Leaf removal is NOT a placement: nothing accepts "nowhere" as a destination for a
      // LEAF, so a leaf is addressed directly here while every MOVE of its occupant goes
      // through `core.layout.place`. Removing a terminal's last leaf closes the terminal.
      const tileId = decodePathSegment(tileMatch[2], "tile id");
      const removed = this.placement.removeTile(padId, tileId);
      if (removed === "not_found") throw new RequestError("not_found", "tile not found");
      if (removed === "conflict") throw new RequestError("conflict", "tile is not removable");
      return jsonResponse(OkResponseSchema.parse({ ok: true }));
    }

    if (request.method === "GET" && pathname === "/api/introspect") {
      const context = this.authenticate(request);
      requireRoot(context);
      return jsonResponse({
        rooms: this.rooms.introspect(),
        sessions: this.broker.introspect(),
        machines: this.store.listMachines().map((machine) => ({
          id: machine.id,
          name: machine.name,
          online: this.machines.isOnline(machine.id),
          lastSeen: machine.lastSeen,
        })),
        principals: this.store.listPrincipals(),
      });
    }

    throw new RequestError("not_found", "route not found");
  }

  /**
   * Existence and display title for one parsed address, asked of whichever side owns that
   * kind of node. Container-addressed forms re-check `pads:read` FOR THAT PAD, so a
   * pad-scoped token cannot use the resolver as a window onto the rest of the workspace;
   * workspace-wide forms (principal, plugin, action) are vocabulary every reader already
   * holds.
   */
  private resolveRef(
    ref: ManifoldRef,
    context: AuthContext,
  ): { exists: boolean; title: string | null } {
    switch (ref.kind) {
      case "terminal": {
        const session = this.store.getSession(ref.sessionId);
        if (session === null) return { exists: false, title: null };
        this.requireCap(context, "pads:read", session.padId);
        return { exists: true, title: session.name };
      }
      case "pad": {
        this.requireCap(context, "pads:read", ref.padId);
        const pad = this.store.getPad(ref.padId);
        return { exists: pad !== null, title: pad?.name ?? null };
      }
      case "element":
        this.requireCap(context, "pads:read", ref.padId);
        // An element and a tile have no name of their own: they are addressed THROUGH the
        // container that gives them identity, and it is the container that has a title.
        return { exists: this.rooms.holdsElement(ref.padId, ref.elementId), title: null };
      case "tile":
        this.requireCap(context, "pads:read", ref.padId);
        return { exists: this.rooms.holdsTile(ref.padId, ref.tileId), title: null };
      case "principal": {
        // Deliberately no per-principal authorization: principal identity is workspace
        // vocabulary. Any pads:read holder already reads every principal's id, name, and
        // color from GET /api/pad-presence, so gating the resolver here would protect
        // nothing while making one door behave unlike the doors beside it.
        const principal = this.store.getPrincipal(ref.principalId);
        return { exists: principal !== null, title: principal?.name ?? null };
      }
      case "plugin": {
        const entry = this.plugins
          .roster()
          .find((candidate) => candidate.manifest.id === ref.pluginId);
        return { exists: entry !== undefined, title: entry?.manifest.title ?? null };
      }
      case "action": {
        const action = this.plugins.composition().actions.get(ref.actionName);
        return { exists: action !== undefined, title: action?.def.title ?? null };
      }
      default: {
        const exhaustive: never = ref;
        void exhaustive;
        return { exists: false, title: null };
      }
    }
  }

  private staticFile(pathname: string): Response {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new RequestError("invalid", "path is invalid");
    }
    const candidate = resolve(this.config.webDist, `.${decoded}`);
    const distPrefix = `${resolve(this.config.webDist)}${sep}`;
    if (candidate.startsWith(distPrefix)) {
      try {
        if (statSync(candidate).isFile()) return new Response(Bun.file(candidate));
      } catch (error) {
        if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error;
      }
    }
    const index = resolve(this.config.webDist, "index.html");
    try {
      if (statSync(index).isFile()) return new Response(Bun.file(index));
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error;
    }
    throw new RequestError("not_found", "web application is not built");
  }
}
