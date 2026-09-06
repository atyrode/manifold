import {
  ActionOutcomeSchema,
  HttpErrorSchema,
  PluginsResponseSchema,
  type ActionDenialRule,
  type ActionOutcome,
  type PluginRoster,
} from "@manifold/protocol";

/**
 * THE KIT'S VIEW OF A HUB — the three HTTP calls `install`, `dev` and `verify` share, and
 * nothing else: read the roster, knock on an action door, and turn the door's answer into a
 * value or a named refusal. Every response is parsed against the protocol's own schema at
 * the boundary, exactly as the testkit does, so a command never reads unchecked JSON off a
 * hub it did not spawn.
 *
 * The owner key travels here as a bearer header and nowhere else: it is never interpolated
 * into a message, a log line or a printed report, which is the discipline the commands
 * built on this module inherit (issue #319).
 */

const HTTP_TIMEOUT_MS = 30_000;
const OWNER_KEY_PATTERN = /^[0-9a-f]{64}$/i;

export interface Hub {
  /** The hub's origin, `http://127.0.0.1:7912` — no path, no trailing slash, no `#key`. */
  readonly url: string;
  readonly ownerKey: string;
}

/** A transport-level failure: the hub answered a status outside 2xx, or not JSON at all. */
export class HubHttpError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`HTTP ${String(status)}: ${detail}`);
    this.name = "HubHttpError";
    this.status = status;
  }
}

/**
 * A door answered `ok: false`. `rule` is the ladder rung (`docs/PLUGINS.md` §3), `detail` the
 * message verbatim — for the install doors, `<class>: detail` with a class from
 * `PLUGIN_INSTALL_REFUSALS`, so a caller switches on the prefix without a second parse.
 */
export class HubRefusal extends Error {
  readonly action: string;
  readonly rule: ActionDenialRule;
  readonly detail: string;

  constructor(action: string, rule: ActionDenialRule, detail: string) {
    super(`${action} refused (${rule}): ${detail}`);
    this.name = "HubRefusal";
    this.action = action;
    this.rule = rule;
    this.detail = detail;
  }
}

/** An owner key is hex-64 or it is not an owner key; nothing about its value is ever echoed. */
export function assertOwnerKey(candidate: string, origin: string): string {
  const key = candidate.trim();
  if (!OWNER_KEY_PATTERN.test(key)) {
    throw new Error(`${origin} does not hold a hex-64 owner key`);
  }
  return key;
}

/** An origin the commands accept as `--hub`: http(s), no credential fragment. */
export function parseHubUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--hub must be a URL, got ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--hub must be http:// or https://, got ${url.protocol}`);
  }
  if (url.hash !== "")
    throw new Error("--hub must not carry a #key fragment; use --owner-key-file");
  return url.origin;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new HubHttpError(response.status, text === "" ? "empty body" : "non-JSON body");
  }
}

function failureDetail(body: unknown): string {
  const parsed = HttpErrorSchema.safeParse(body);
  return parsed.success
    ? `${parsed.data.error.code}: ${parsed.data.error.message}`
    : JSON.stringify(body);
}

/** `GET /api/plugins` as the owner: every row, parsed against `PluginsResponseSchema`. */
export async function roster(hub: Hub): Promise<PluginRoster> {
  const response = await fetch(new URL("/api/plugins", hub.url), {
    headers: { authorization: `Bearer ${hub.ownerKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = await readJson(response);
  if (!response.ok) throw new HubHttpError(response.status, failureDetail(body));
  return PluginsResponseSchema.parse(body).plugins;
}

/**
 * `POST /api/actions/<name>` as the holder of `token`, answering the OUTCOME: a denial is a
 * 200 carrying `ok: false` and is returned as data, because a command asserting "this door
 * must not answer `unavailable`" reads the rule rather than catching a status.
 */
export async function dispatch(
  hub: Pick<Hub, "url">,
  token: string,
  name: string,
  args: unknown,
): Promise<ActionOutcome> {
  const response = await fetch(new URL(`/api/actions/${encodeURIComponent(name)}`, hub.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = await readJson(response);
  if (!response.ok) throw new HubHttpError(response.status, failureDetail(body));
  return ActionOutcomeSchema.parse(body);
}

/** Dispatches as the owner and answers the result, raising a denial as a `HubRefusal`. */
export async function ownerAction(hub: Hub, name: string, args: unknown): Promise<unknown> {
  const outcome = await dispatch(hub, hub.ownerKey, name, args);
  if (!outcome.ok) throw new HubRefusal(name, outcome.denial.rule, outcome.denial.message);
  return outcome.result;
}
