import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  ActionOutcomeSchema,
  CAPS,
  AttendanceResponseSchema,
  ContainerCensusResponseSchema,
  HealthResponseSchema,
  BindingsResponseSchema,
  HttpErrorSchema,
  LayoutResponseSchema,
  PROTOCOL_VERSION,
  PluginsResponseSchema,
  ResolveResponseSchema,
  SettingsResponseSchema,
  buildProtocolJsonSchema,
  formatManifoldUri,
  parseManifoldUri,
  IssuePreviewIdentityRequestSchema,
  MANIFOLD_ROOT_URI,
  PreviewIdentityAssertionSchema,
  PreviewIdentityClaimsSchema,
  PreviewIdentityConfigSchema,
  PreviewIdentityNonceResponseSchema,
  PreviewIdentityKeySchema,
  defaultRuntime,
  normalizeInstanceOrigin,
  type Cap,
  type HttpError,
  type ManifoldRef,
  type PreviewIdentityClaims,
  type TokenGrant,
  type RuntimeDeps,
} from "@manifold/protocol";
import { composeDefaultLayout } from "@manifold/plugin";
import { ServiceError, type AuthContext, type AuthService } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { MachineGateway } from "./machine-ws.ts";
import type { PluginHost } from "./plugin-host.ts";
import type { RoomManager } from "./room.ts";
import type { ServerStore } from "./stores.ts";
import type { TerminalBroker } from "./terminal-broker.ts";

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

/**
 * The cross-origin permission every door answers with, applied by {@link HttpApp.fetch} rather
 * than by each door: the set is one sentence — anyone may ask, with a bearer token, using the
 * verbs the API has — and a per-route spelling of it is a route that will one day disagree.
 *
 * `*` rather than an allowlist of instances, deliberately. An instance cannot know which lenses
 * will be pointed at it (that is the whole content of the portable-lens rule), and the origin
 * asking is not the authority: the token is. Credentials are never permitted, so `*` cannot be
 * upgraded into ambient access by a browser that decides to send something.
 */
function corsResponse(response: Response): Response {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set("access-control-allow-headers", "authorization, content-type");
  response.headers.set("access-control-max-age", "600");
  return response;
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

const PREVIEW_ASSERTION_TTL_MS = 60_000;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function issuePreviewAssertion(config: ServerConfig, claims: PreviewIdentityClaims): string {
  const header = base64UrlJson({ alg: "EdDSA", typ: "manifold-preview-identity+jwt" });
  const payload = base64UrlJson(claims);
  const signed = `${header}.${payload}`;
  const signature = signBytes(
    null,
    Buffer.from(signed),
    createPrivateKey(config.previewIdentityPrivateKey),
  );
  return `${signed}.${signature.toString("base64url")}`;
}

function previewAudienceAllowed(audience: string, domain: string | null): boolean {
  if (domain === null) return false;
  const url = new URL(audience);
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname.endsWith(".localhost"));
  return (
    ((url.protocol === "https:" && url.port === "") || localHttp) &&
    (url.hostname === `preview.${domain}` ||
      new RegExp(`^[1-9][0-9]*\\.${domain.replace(/\./g, "\\.")}$`).test(url.hostname))
  );
}

const PREVIEW_NONCE_COOKIE = "manifold-preview-nonce";
const PREVIEW_CALLBACK_COOKIE = "manifold-preview-callback";

function previewNonceCookie(
  nonce: string,
  secure: boolean,
  name: string = PREVIEW_NONCE_COOKIE,
): string {
  return `${name}=${nonce}; HttpOnly; SameSite=Lax; Path=/auth/preview; Max-Age=120${secure ? "; Secure" : ""}`;
}

function callbackNonce(request: Request, name: string = PREVIEW_NONCE_COOKIE): string {
  const nonce = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    ?.find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  const parsed = PreviewIdentityNonceResponseSchema.safeParse({ nonce });
  if (!parsed.success)
    throw new RequestError("forbidden", "preview sign-in was not initiated here");
  return parsed.data.nonce;
}

function callbackHtml(grant: TokenGrant, now: number): Response {
  const identity = JSON.stringify({
    token: grant.token,
    principal: grant.principal,
    ...(grant.expiresAt === undefined
      ? {}
      : { expiresAt: grant.expiresAt, expiresInMs: Math.max(0, grant.expiresAt - now) }),
  }).replace(
    /[<\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const response = new Response(
    `<!doctype html><meta charset="utf-8"><title>Opening preview</title><body>Opening preview…</body><script>
const identity=${identity};
identity.receivedAt=Date.now();
sessionStorage.removeItem("manifold.previewNonce");
localStorage.setItem("manifold.identity", JSON.stringify(identity));
location.replace("/");
</script>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "set-cookie": `${PREVIEW_NONCE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/preview; Max-Age=0`,
      },
    },
  );
  response.headers.append(
    "set-cookie",
    `${PREVIEW_CALLBACK_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/preview; Max-Age=0`,
  );
  return response;
}

function callbackPendingHtml(ticket: string, secure: boolean): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Opening preview</title><body>Opening preview…</body><script>location.replace("/auth/preview/finalize")</script>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "set-cookie": previewNonceCookie(ticket, secure, PREVIEW_CALLBACK_COOKIE),
      },
    },
  );
}

function callbackErrorHtml(error: RequestError): Response {
  const message = error.message.replace(/[&<>"]/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return "&quot;";
  });
  const response = new Response(
    `<!doctype html><meta charset="utf-8"><title>Preview sign-in failed</title><h1>Preview sign-in failed</h1><p>${message}</p><p><a href="/">Return to the preview and try again</a>.</p>`,
    {
      status: STATUS_BY_CODE[error.code],
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "set-cookie": `${PREVIEW_NONCE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/preview; Max-Age=0`,
      },
    },
  );
  response.headers.append(
    "set-cookie",
    `${PREVIEW_CALLBACK_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/preview; Max-Age=0`,
  );
  return response;
}

/** Bun fetch handler implementing the complete JSON API and SPA fallback contract. */
export class HttpApp {
  constructor(
    private readonly config: ServerConfig,
    private readonly store: ServerStore,
    private readonly auth: AuthService,
    private readonly rooms: RoomManager,
    private readonly broker: TerminalBroker,
    private readonly machines: MachineGateway,
    private readonly plugins: PluginHost,
    private readonly logger: Logger,
    private readonly runtime: RuntimeDeps = defaultRuntime,
  ) {}
  private readonly consumedPreviewAssertions = new Map<string, number>();
  private readonly pendingPreviewClaims = new Map<string, PreviewIdentityClaims>();
  private readonly previewNonceStates = new Map<
    string,
    { readonly nonce: string; readonly expiresAt: number }
  >();
  private previewIdentityPublicKeyPromise: Promise<string> | null = null;

  /**
   * Handles a request without allowing auth secrets to enter logs or errors.
   *
   * THE CROSS-ORIGIN WRAPPER, and its scope is the whole point: a lens is configurable
   * (`AXIOMS.md` §The portable lens), so an app installed from one instance may be pointed at
   * another, and a browser will not let it knock on a door that does not answer the preflight.
   * The doors therefore answer any origin — and are safe to, because a token is the ONLY
   * authority here: no API door consumes cookies or ambient session. Preview start emits one
   * host-only, callback-path nonce cookie, but it carries no authority and no API request sends
   * credentials. The permission therefore stays "anyone holding a valid bearer token".
   *
   * The SHELL is deliberately excluded. Static files answer same-origin only, because a page
   * that wants manifold's bundle should be served it by an instance rather than hotlink one.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api") && url.pathname !== "/healthz") {
      return await this.route(request, url);
    }
    if (request.method === "OPTIONS") return corsResponse(new Response(null, { status: 204 }));
    return corsResponse(await this.route(request, url));
  }

  private async route(request: Request, url: URL): Promise<Response> {
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        // What runs, by the one derivation the web bundle also carries (`scripts/build-identity.ts`);
        // protocol compatibility is a separate number and is the one the lens negotiates on.
        const { version, build, channel } = this.config.identity;
        return jsonResponse(
          HealthResponseSchema.parse({
            ok: true,
            version,
            build,
            channel,
            protocolVersion: PROTOCOL_VERSION,
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/auth/preview/callback") {
        try {
          const contentType = request.headers.get("content-type") ?? "";
          if (!contentType.startsWith("application/x-www-form-urlencoded")) {
            throw new RequestError("invalid", "preview callback must be form encoded");
          }
          const form = await request.formData();
          const parsed = PreviewIdentityAssertionSchema.safeParse({
            assertion: form.get("assertion"),
          });
          if (!parsed.success) throw new RequestError("invalid", "preview assertion is invalid");
          const claims = await this.verifyPreviewAssertion(parsed.data.assertion);
          const now = this.runtime.now();
          for (const [ticket, pending] of this.pendingPreviewClaims) {
            if (pending.expiresAt <= now) this.pendingPreviewClaims.delete(ticket);
          }
          // This secret reaches only the browser receiving production's POST. The public
          // nonce alone must not let another browser complete that user's sign-in.
          const ticket = randomBytes(32).toString("base64url");
          this.pendingPreviewClaims.set(ticket, claims);
          return callbackPendingHtml(ticket, new URL(this.config.publicUrl).protocol === "https:");
        } catch (error) {
          if (error instanceof RequestError) return callbackErrorHtml(error);
          if (error instanceof ServiceError) {
            return callbackErrorHtml(new RequestError(error.code, error.message));
          }
          throw error;
        }
      }
      if (request.method === "GET" && url.pathname === "/auth/preview/finalize") {
        try {
          const stateId = callbackNonce(request);
          const ticket = callbackNonce(request, PREVIEW_CALLBACK_COOKIE);
          const state = this.previewNonceStates.get(stateId);
          if (state === undefined || state.expiresAt <= this.runtime.now()) {
            throw new RequestError("forbidden", "preview sign-in was not initiated here");
          }
          const claims = this.pendingPreviewClaims.get(ticket);
          if (claims === undefined || claims.nonce !== state.nonce) {
            throw new RequestError("forbidden", "preview sign-in is not pending");
          }
          this.previewNonceStates.delete(stateId);
          this.pendingPreviewClaims.delete(ticket);
          const grant = this.acceptPreviewClaims(claims);
          return callbackHtml(grant, this.runtime.now());
        } catch (error) {
          if (error instanceof RequestError) return callbackErrorHtml(error);
          if (error instanceof ServiceError) {
            return callbackErrorHtml(new RequestError(error.code, error.message));
          }
          throw error;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/protocol") {
        // The description publishes the LIVE vocabulary: every action the assembly holds with
        // its schemas, and the roster that says which plugin owns each one. A stranger's agent
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

  private requireCap(context: AuthContext, cap: Exclude<Cap, "*">, containerId?: string): void {
    if (!this.auth.allows(context, cap, containerId)) {
      throw new RequestError("forbidden", `${cap} capability required`);
    }
  }

  private async api(request: Request, pathname: string): Promise<Response> {
    if (request.method === "GET" && pathname === "/api/identity/preview-key") {
      return jsonResponse(
        PreviewIdentityKeySchema.parse({
          algorithm: "Ed25519",
          publicKey: this.config.previewIdentityPublicKey,
        }),
      );
    }

    if (request.method === "GET" && pathname === "/api/identity/preview-config") {
      return jsonResponse(
        PreviewIdentityConfigSchema.parse({
          authority: this.config.previewIdentityAuthority,
        }),
      );
    }

    if (request.method === "POST" && pathname === "/api/identity/preview-start") {
      if (this.config.previewIdentityAuthority === null) {
        throw new RequestError("not_found", "production preview identity is not configured");
      }
      const now = this.runtime.now();
      for (const [stateId, state] of this.previewNonceStates) {
        if (state.expiresAt <= now) this.previewNonceStates.delete(stateId);
      }
      const nonce = randomBytes(32).toString("base64url");
      const stateId = randomBytes(32).toString("base64url");
      this.previewNonceStates.set(stateId, { nonce, expiresAt: now + 120_000 });
      const response = jsonResponse(PreviewIdentityNonceResponseSchema.parse({ nonce }));
      response.headers.set(
        "set-cookie",
        previewNonceCookie(stateId, new URL(this.config.publicUrl).protocol === "https:"),
      );
      return response;
    }

    if (request.method === "POST" && pathname === "/api/identity/preview-assertion") {
      const context = this.authenticate(request);
      const body = IssuePreviewIdentityRequestSchema.safeParse(await parseJsonBody(request));
      if (!body.success) throw new RequestError("invalid", "preview identity request is invalid");
      const audience = normalizeInstanceOrigin(body.data.audience);
      const issuer = normalizeInstanceOrigin(this.config.publicUrl);
      if (
        audience === null ||
        issuer === null ||
        !previewAudienceAllowed(audience, this.config.previewDomain)
      ) {
        throw new RequestError("forbidden", "preview audience is not authorized");
      }
      if (context.containerScope !== null) {
        throw new RequestError(
          "forbidden",
          "container-scoped credentials cannot open a whole preview workspace",
        );
      }
      if (context.principal.kind !== "human" || context.principal.origin !== undefined) {
        throw new RequestError(
          "forbidden",
          "only local human identities may open browser previews",
        );
      }
      const effectiveCaps = this.auth.effectiveCaps(context, MANIFOLD_ROOT_URI);
      const concreteCaps = CAPS.filter(
        (cap): cap is Exclude<Cap, "*"> => cap !== "*" && effectiveCaps.has(cap),
      );
      const caps =
        context.isRoot && concreteCaps.length === CAPS.length - 1 ? (["*"] as const) : concreteCaps;
      if (caps.length === 0) {
        throw new RequestError("forbidden", "credential has no workspace authority");
      }
      const issuedAt = this.runtime.now();
      const claims = PreviewIdentityClaimsSchema.parse({
        version: 1,
        id: this.runtime.newId(),
        issuer,
        audience,
        issuedAt,
        expiresAt: issuedAt + PREVIEW_ASSERTION_TTL_MS,
        nonce: body.data.nonce,
        principal: context.principal,
        caps,
        containerId: null,
      });
      this.store.addEvent(null, issuedAt, context.principal.id, "preview_identity_issued", {
        assertionId: claims.id,
        audience,
        expiresAt: claims.expiresAt,
      });
      return jsonResponse(
        PreviewIdentityAssertionSchema.parse({
          assertion: issuePreviewAssertion(this.config, claims),
        }),
      );
    }

    if (request.method === "GET" && pathname === "/api/attendance") {
      const context = this.authenticate(request);
      this.requireCap(context, "containers:read");
      const attendance = this.rooms
        .presence()
        .filter(
          (entry) =>
            context.containerScope === null || entry.containerId === context.containerScope,
        );
      return jsonResponse(AttendanceResponseSchema.parse({ attendance }));
    }
    /*
      The index's whole input: what every container holds and what it points at. One route
      rather than a field on each of the container routes, because the INDEX VISIBILITY RULE
      needs the containment GRAPH — a row is top-level exactly when no other container
      references it — and a graph cannot be assembled from rows fetched one at a time.
     */
    if (request.method === "GET" && pathname === "/api/containers") {
      const context = this.authenticate(request);
      this.requireCap(context, "containers:read");
      if (context.containerScope !== null) {
        throw new RequestError("forbidden", "scoped tokens cannot read the container index");
      }
      return jsonResponse(
        ContainerCensusResponseSchema.parse({ containers: this.rooms.censuses() }),
      );
    }

    /*
      THE ACTION DOOR. One route for every mutation any plugin declares, because a door per
      feature is how a workspace ends up with thirty of them and no published vocabulary.

      Authentication only here: the caps an action requires are the ACTION's declaration, so
      the ladder inside `dispatch` is the single place authority is decided (and the single
      place a container-scoped token is refused). A denial answers 200 carrying `ok: false`, the
      shape a refused placement uses too — a refusal is an answer about authority or state,
      never a transport failure.

      The trace's `session` is left absent here, and the absence is the datum: a request over
      this door carries a credential rather than a connection, so "no session" is what the
      ledger should say about it (axiom A6, ADR 0018 §2).
     */
    const actionMatch = /^\/api\/actions\/([^/]+)$/.exec(pathname);
    if (actionMatch !== null && request.method === "POST") {
      const name = decodePathSegment(actionMatch[1], "action name");
      const context = this.authenticate(request);
      const outcome = await this.plugins.dispatch(context, name, await parseJsonBody(request));
      return jsonResponse(ActionOutcomeSchema.parse(outcome));
    }

    if (request.method === "GET" && pathname === "/api/plugins") {
      // Any authenticated token, container-scoped included — the same reasoning that makes
      // `core.machines.list` a `scope: "container"` read: the roster is VOCABULARY, and a scoped
      // viewer still has to render panels and know which plugin owns the placeholder it is
      // looking at.
      const context = this.authenticate(request);
      this.requireCap(context, "containers:read");
      return jsonResponse(PluginsResponseSchema.parse({ plugins: this.plugins.roster() }));
    }

    /*
      THE WORKER MODULE of an installed plugin (ADR 0016 §8 stage 2): the web half a
      dedicated Worker runs, served from the VERIFIED bundle the host holds in memory rather
      than from disk, so what a browser executes is exactly what re-hashed to the pin at boot.
      Same authority as the roster read above, for the same reason: the code is vocabulary
      once it is on the roster, and a scoped viewer still has to draw the panel. `no-store`
      because an upgrade is a new hash under the same URL, and the ETag IS that hash.
    */
    const webModuleMatch = /^\/api\/plugins\/([^/]+)\/web\.js$/.exec(pathname);
    if (webModuleMatch !== null && request.method === "GET") {
      const id = decodePathSegment(webModuleMatch[1], "plugin id");
      const context = this.authenticate(request);
      this.requireCap(context, "containers:read");
      const module = this.plugins.webModule(id);
      if (module === null) throw new RequestError("not_found", "no installed web module");
      return new Response(module.bytes, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          etag: `"${module.sha256}"`,
        },
      });
    }

    if (request.method === "GET" && pathname === "/api/layout") {
      // Self-scoped by construction: a workspace tree belongs to one principal, so the door
      // takes no id and answers the caller's own — the default until they write one.
      const context = this.authenticate(request);
      this.requireCap(context, "containers:read");
      /*
        THE DEFAULT IS COMPOSED, not injected. It used to arrive as a constructor argument,
        because the tree was a floor arrangement filled with two PANEL ids and a panel id names
        a plugin, which this file may not do (REGISTRY.md §Foundation, gate S2). Now it is
        composed from the ROSTER this app already serves at `/api/plugins` — the enabled half's
        declared seats (ADR 0017 S17-B) — so the names come from the manifests and nothing here
        learns which plugin drew what. Composed per request rather than cached because
        enablement is hot: toggling a panel plugin changes what the next unarranged principal is
        shown, and a cached tree would answer for a roster that no longer exists.
      */
      const layout =
        this.store.workspaceLayout(context.principal.id) ??
        composeDefaultLayout(this.plugins.roster()).layout;
      return jsonResponse(LayoutResponseSchema.parse({ layout }));
    }

    if (request.method === "GET" && pathname === "/api/bindings") {
      /*
        The CALLER's key overrides, and self-scoped for the same reason the layout is: a
        rebinding belongs to one principal, so the door takes no id.

        A FLOOR read of state a plugin's door writes, which is the shape `/api/layout` already
        has. The browser engine composes the key table at boot — before a single plugin has
        drawn anything — so it needs the delta from a neutral route rather than by dispatching
        somebody's read door, which is a floor file naming a favourite plugin (REGISTRY.md
        §Foundation, gate S2). `core.keys.setBinding` remains the only way one is WRITTEN.
      */
      const context = this.authenticate(request);
      this.requireCap(context, "containers:read");
      return jsonResponse(
        BindingsResponseSchema.parse({
          overrides: this.store.bindingOverrides(context.principal.id),
        }),
      );
    }

    if (request.method === "GET" && pathname === "/api/settings") {
      /*
        The CALLER's plugin setting values, self-scoped exactly as the two doors above are. A
        FLOOR read of state a door writes, and the engine needs it earliest of the three: a
        sidebar row whose setting reads false is dropped at composition, so the values are input
        to the first paint rather than something a plugin asks for later.

        `engine.plugins.setSetting` remains the only way one is WRITTEN.
      */
      const context = this.authenticate(request);
      this.requireCap(context, "containers:read");
      return jsonResponse(
        SettingsResponseSchema.parse({
          values: this.store.pluginSettings(context.principal.id),
        }),
      );
    }

    if (request.method === "GET" && pathname === "/api/resolve") {
      const context = this.authenticate(request);
      this.requireCap(context, "containers:read");
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

    if (request.method === "GET" && pathname === "/api/introspect") {
      const context = this.authenticate(request);
      requireRoot(context);
      return jsonResponse({
        rooms: this.rooms.introspect(),
        terminals: this.broker.introspect(),
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

  private async verifyPreviewAssertion(assertion: string): Promise<PreviewIdentityClaims> {
    const authority = this.config.previewIdentityAuthority;
    const audience = normalizeInstanceOrigin(this.config.publicUrl);
    if (authority === null || audience === null) {
      throw new RequestError("not_found", "production preview identity is not configured");
    }
    const parts = assertion.split(".");
    if (parts.length !== 3) throw new RequestError("invalid", "preview assertion is invalid");
    const [headerPart, payloadPart, signaturePart] = parts;
    if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
      throw new RequestError("invalid", "preview assertion is invalid");
    }
    let header: unknown;
    let claimsResult: ReturnType<typeof PreviewIdentityClaimsSchema.safeParse>;
    try {
      header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
      claimsResult = PreviewIdentityClaimsSchema.safeParse(
        JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")),
      );
    } catch {
      throw new RequestError("invalid", "preview assertion is invalid");
    }
    if (
      header === null ||
      typeof header !== "object" ||
      Reflect.get(header, "alg") !== "EdDSA" ||
      Reflect.get(header, "typ") !== "manifold-preview-identity+jwt" ||
      !claimsResult.success
    ) {
      throw new RequestError("invalid", "preview assertion is invalid");
    }
    const claims = claimsResult.data;
    const now = this.runtime.now();
    if (
      claims.issuer !== authority ||
      claims.audience !== audience ||
      claims.issuedAt > now + 30_000 ||
      claims.expiresAt <= now ||
      claims.expiresAt <= claims.issuedAt ||
      claims.expiresAt - claims.issuedAt > PREVIEW_ASSERTION_TTL_MS
    ) {
      throw new RequestError("forbidden", "preview assertion is not valid for this instance");
    }

    const key = await this.productionIdentityPublicKey();
    const signed = `${headerPart}.${payloadPart}`;
    let verified = false;
    try {
      verified = verifyBytes(
        null,
        Buffer.from(signed),
        createPublicKey(key),
        Buffer.from(signaturePart, "base64url"),
      );
    } catch {
      verified = false;
    }
    if (!verified) throw new RequestError("forbidden", "preview assertion signature is invalid");
    return claims;
  }

  private acceptPreviewClaims(claims: PreviewIdentityClaims): TokenGrant {
    const now = this.runtime.now();
    if (claims.expiresAt <= now) {
      throw new RequestError("forbidden", "preview assertion is not valid for this instance");
    }
    for (const [id, expiresAt] of this.consumedPreviewAssertions) {
      if (expiresAt <= now) this.consumedPreviewAssertions.delete(id);
    }
    if (this.consumedPreviewAssertions.has(claims.id)) {
      throw new RequestError("forbidden", "preview assertion was already used");
    }
    this.consumedPreviewAssertions.set(claims.id, claims.expiresAt);
    return this.auth.acceptPreviewIdentity(claims);
  }

  private async productionIdentityPublicKey(): Promise<string> {
    const authority = this.config.previewIdentityAuthority;
    if (authority === null) {
      throw new RequestError("not_found", "production preview identity is not configured");
    }
    this.previewIdentityPublicKeyPromise ??= (async () => {
      const response = await fetch(`${authority}/api/identity/preview-key`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`identity authority returned ${response.status}`);
      return PreviewIdentityKeySchema.parse(await response.json()).publicKey;
    })();
    try {
      return await this.previewIdentityPublicKeyPromise;
    } catch {
      this.previewIdentityPublicKeyPromise = null;
      throw new RequestError("conflict", "production identity authority is unavailable");
    }
  }

  /**
   * Existence and display title for one parsed address, asked of whichever side owns that
   * kind of node. Container-addressed forms re-check `containers:read` FOR THAT CONTAINER, so
   * a container-scoped token cannot use the resolver as a window onto the rest of the
   * workspace; workspace-wide forms (principal, plugin, action) are vocabulary every reader
   * already holds.
   */
  private resolveRef(
    ref: ManifoldRef,
    context: AuthContext,
  ): { exists: boolean; title: string | null } {
    switch (ref.kind) {
      case "terminal": {
        const terminal = this.store.getTerminal(ref.terminalId);
        if (terminal === null) return { exists: false, title: null };
        this.requireCap(context, "containers:read", terminal.containerId);
        return { exists: true, title: terminal.name };
      }
      case "container": {
        this.requireCap(context, "containers:read", ref.containerId);
        const container = this.store.getContainer(ref.containerId);
        return { exists: container !== null, title: container?.name ?? null };
      }
      case "element":
        this.requireCap(context, "containers:read", ref.containerId);
        // An element and a tile have no name of their own: they are addressed THROUGH the
        // container that gives them identity, and it is the container that has a title.
        return { exists: this.rooms.holdsElement(ref.containerId, ref.elementId), title: null };
      case "tile":
        this.requireCap(context, "containers:read", ref.containerId);
        return { exists: this.rooms.holdsTile(ref.containerId, ref.tileId), title: null };
      case "machine": {
        const machine = this.store.getMachine(ref.machineId);
        return { exists: machine !== null, title: machine?.name ?? null };
      }
      case "principal": {
        // Deliberately no per-principal authorization: principal identity is workspace
        // vocabulary. Any containers:read holder already reads every principal's id, name,
        // and color from GET /api/attendance, so gating the resolver here would protect
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
        const action = this.plugins.assembly().actions.get(ref.actionName);
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
        if (statSync(candidate).isFile()) {
          const response = new Response(Bun.file(candidate));
          response.headers.set("content-security-policy", "frame-ancestors 'none'");
          response.headers.set("x-frame-options", "DENY");
          return response;
        }
      } catch (error) {
        if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error;
      }
    }
    const index = resolve(this.config.webDist, "index.html");
    try {
      if (statSync(index).isFile()) {
        const response = new Response(Bun.file(index));
        response.headers.set("content-security-policy", "frame-ancestors 'none'");
        response.headers.set("x-frame-options", "DENY");
        return response;
      }
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error;
    }
    throw new RequestError("not_found", "web application is not built");
  }
}
