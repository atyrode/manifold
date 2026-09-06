#!/usr/bin/env bun
import { PluginBundleSchema, type PluginRoster } from "@manifold/protocol";
import { resolve } from "node:path";
import { assertOwnerKey, ownerAction, parseHubUrl, roster, type Hub } from "./hub.ts";

/**
 * `install` — one packed bundle onto one hub, at whatever state the hub is in (issue #319).
 *
 *     bun run --cwd packages/plugin-kit install <bundle-file | https://…> --hub <url>
 *         [--sha256 <hex>] [--deliver path | docker:<container>] [--owner-key-file <path>]
 *
 * The command is IDEMPOTENT over the roster it reads first: the same id at the same sha is
 * `unchanged` and nothing is asked of the hub; another sha is a `replaced` — the row is
 * switched off, installed over with `replace: true` and switched back on, the three steps
 * `engine.plugins.install` demands (`docs/PLUGINS.md` §7), with any enabled row that requires
 * it taken down first and brought back after (a parent under its parts, ADR 0023); an absent
 * id is `installed`. One JSON line answers, `{ id, sha256, hub, outcome }`, and a refusal exits
 * non-zero naming the class and detail on stderr, never a stack.
 *
 * DELIVERY is how the bundle's bytes reach the hub's file system, because the door reads a
 * path or an https URL and nothing else: `path` hands the hub the file's absolute path (a hub
 * on this machine with `MANIFOLD_PLUGIN_DEV_PATHS=1`, or a path already under its drop box);
 * `docker:<container>` copies the file into `<container>:/data/plugin-uploads/` — the drop box
 * every hub accepts — and installs from there; an https URL is handed through untouched.
 *
 * THE OWNER KEY is read from `--owner-key-file`, else `MANIFOLD_OWNER_KEY_FILE`, else — for a
 * docker delivery — the container's own `/data/owner.key` over `docker exec`. It is never an
 * argument, never printed, never part of the report.
 */

export type Delivery =
  { readonly kind: "path" } | { readonly kind: "docker"; readonly container: string };

export interface InstallOptions {
  /** A bundle file on this machine, or an `https://` URL the hub fetches itself. */
  readonly source: string;
  readonly hub: Hub;
  readonly deliver?: Delivery;
  /** The expected pin; the command refuses before touching the hub when the bytes disagree. */
  readonly sha256?: string;
}

export type InstallOutcome = "installed" | "replaced" | "unchanged";

export interface InstallReport {
  readonly id: string;
  readonly sha256: string;
  readonly hub: string;
  readonly outcome: InstallOutcome;
}

/** What a bundle IS before any hub sees it: its id, the pin over its exact bytes, and where. */
export interface BundleFacts {
  readonly id: string;
  readonly sha256: string;
  /** The absolute path, or the URL as given. */
  readonly source: string;
}

const UPLOADS_DIR = "/data/plugin-uploads";
const OWNER_KEY_IN_CONTAINER = "/data/owner.key";
const FETCH_TIMEOUT_MS = 30_000;

/** A source that is not a bundle this kit can install; `detail` is the sentence without the path. */
export class BundleError extends Error {
  readonly source: string;
  readonly detail: string;

  constructor(source: string, detail: string) {
    super(`${source}: ${detail}`);
    this.name = "BundleError";
    this.source = source;
    this.detail = detail;
  }
}

function factsOf(bytes: Uint8Array, source: string): BundleFacts {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BundleError(source, "not JSON");
  }
  const parsed = PluginBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first === undefined ? "" : ` at ${first.path.join(".")}: ${first.message}`;
    throw new BundleError(source, `not a plugin bundle${at}`);
  }
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { id: parsed.data.manifest.id, sha256, source };
}

/**
 * Reads the bundle where it lives. A URL is fetched once here as well as by the hub — the only
 * way to learn the id (and check the pin) before deciding whether the hub needs asking at all.
 */
export async function inspectBundle(source: string): Promise<BundleFacts> {
  if (/^https:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new BundleError(source, `HTTP ${String(response.status)}`);
    return factsOf(new Uint8Array(await response.arrayBuffer()), source);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw new BundleError(source, "only https:// sources and local files are installed");
  }
  const file = resolve(source);
  if (!(await Bun.file(file).exists())) throw new BundleError(file, "no such bundle file");
  return factsOf(new Uint8Array(await Bun.file(file).arrayBuffer()), file);
}

/**
 * Parents before parts (ADR 0023: `a.b` is a dependency of `a.b.c`), ties by id — the order
 * a set of bundles from one repository installs in, whatever order a shell glob handed them.
 */
export function familyOrder<T extends { readonly id: string }>(bundles: readonly T[]): T[] {
  return [...bundles].sort((a, b) => {
    const depth = a.id.split(".").length - b.id.split(".").length;
    return depth !== 0 ? depth : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

async function docker(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`docker ${args[0] ?? ""} exited ${String(code)}: ${stderr.trim()}`);
  }
  return stdout;
}

/**
 * The owner key, from the first place that names one. Reading the container's key over
 * `docker exec` is what lets a receiver on the hub's own box install without a secret ever
 * leaving that box.
 */
export async function resolveOwnerKey(
  file: string | undefined,
  deliver: Delivery | undefined,
): Promise<string> {
  const path = file ?? process.env.MANIFOLD_OWNER_KEY_FILE;
  if (path !== undefined && path !== "") {
    return assertOwnerKey(await Bun.file(path).text(), path);
  }
  if (deliver?.kind === "docker") {
    return assertOwnerKey(
      await docker(["exec", deliver.container, "cat", OWNER_KEY_IN_CONTAINER]),
      `${deliver.container}:${OWNER_KEY_IN_CONTAINER}`,
    );
  }
  throw new Error(
    "no owner key: pass --owner-key-file, set MANIFOLD_OWNER_KEY_FILE, or deliver with docker:<container>",
  );
}

export function parseDelivery(raw: string): Delivery {
  if (raw === "path") return { kind: "path" };
  const container = raw.startsWith("docker:") ? raw.slice("docker:".length) : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) {
    throw new Error(`--deliver must be path or docker:<container>, got ${raw}`);
  }
  return { kind: "docker", container };
}

/** Where the hub reads the bundle from: the URL, this machine's path, or the drop box copy. */
async function deliver(facts: BundleFacts, delivery: Delivery): Promise<string> {
  if (/^https:\/\//i.test(facts.source) || delivery.kind === "path") return facts.source;
  const target = `${UPLOADS_DIR}/${facts.id}-${facts.sha256}.manifold-plugin.json`;
  // The drop box is created by the first upload, not by the hub's boot.
  await docker(["exec", delivery.container, "mkdir", "-p", UPLOADS_DIR]);
  await docker(["cp", facts.source, `${delivery.container}:${target}`]);
  return target;
}

/**
 * The ENABLED rows that require `id`, transitively, deepest first: the order they must be
 * switched off in before `id` may be, because the engine refuses to disable a plugin an enabled
 * row declares `required` (`missing_dependency`). A part inside its parent (ADR 0023) is the
 * everyday case; the walk is general.
 */
function enabledDependents(rows: PluginRoster, id: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>([id]);
  const visit = (target: string): void => {
    for (const row of rows) {
      const dependent = row.manifest.id;
      if (seen.has(dependent) || !row.enabled) continue;
      if (row.manifest.dependencies?.[target]?.type !== "required") continue;
      seen.add(dependent);
      visit(dependent);
      order.push(dependent);
    }
  };
  visit(id);
  return order;
}

export async function installBundle(options: InstallOptions): Promise<InstallReport> {
  const facts = await inspectBundle(options.source);
  if (options.sha256 !== undefined && options.sha256.toLowerCase() !== facts.sha256) {
    throw new Error(`${facts.source} hashes to ${facts.sha256}, not the pinned ${options.sha256}`);
  }
  const { hub } = options;
  const report = (outcome: InstallOutcome): InstallReport => ({
    id: facts.id,
    sha256: facts.sha256,
    hub: hub.url,
    outcome,
  });

  const rows = await roster(hub);
  const row = rows.find((entry) => entry.manifest.id === facts.id);
  if (row?.install?.sha256 === facts.sha256) return report("unchanged");

  const source = await deliver(facts, options.deliver ?? { kind: "path" });
  if (row === undefined) {
    await ownerAction(hub, "engine.plugins.install", { source, sha256: facts.sha256 });
    return report("installed");
  }
  // A replace needs the row off (`still_enabled`), and the row cannot go off while an enabled
  // dependent requires it — so the family goes dark from the leaves in, and comes back from the
  // root out. A fresh install is on by default while a replace keeps the switch where it was,
  // so the target is flipped back explicitly. A refused replace leaves the OLD bundle in place,
  // and everything goes back on the same way: an upgrade that did not happen must not read as
  // an outage on the hub.
  const off = [...enabledDependents(rows, facts.id), facts.id];
  const on = [...off].reverse();
  const setEnabled = (id: string, enabled: boolean): Promise<unknown> =>
    ownerAction(hub, "engine.plugins.setEnabled", { id, enabled });
  for (const id of off) await setEnabled(id, false);
  try {
    await ownerAction(hub, "engine.plugins.install", {
      source,
      sha256: facts.sha256,
      replace: true,
    });
  } catch (error) {
    for (const id of on) await setEnabled(id, true).catch(() => {});
    throw error;
  }
  for (const id of on) await setEnabled(id, true);
  return report("replaced");
}

/**
 * The flags `install` and `dev` share, from argv, leaving the positionals to the caller.
 * Unknown flags are refused rather than ignored: a misspelled `--deliver` silently handing a
 * hub a path it cannot read is the failure this loop exists to remove.
 */
export interface HubFlags {
  readonly hub: string;
  readonly sha256?: string;
  readonly deliver?: Delivery;
  readonly ownerKeyFile?: string;
  readonly positionals: readonly string[];
}

export function parseHubFlags(argv: readonly string[], allowSha: boolean): HubFlags {
  let hub: string | undefined;
  let sha256: string | undefined;
  let deliver: Delivery | undefined;
  let ownerKeyFile: string | undefined;
  const positionals: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at];
    if (word === undefined) break;
    if (!word.startsWith("--")) {
      positionals.push(word);
      continue;
    }
    const value = argv[at + 1];
    if (value === undefined) throw new Error(`${word} needs a value`);
    at++;
    switch (word) {
      case "--hub":
        hub = parseHubUrl(value);
        break;
      case "--sha256":
        if (!allowSha) throw new Error("--sha256 pins one bundle; dev packs many");
        if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("--sha256 must be hex-64");
        sha256 = value.toLowerCase();
        break;
      case "--deliver":
        deliver = parseDelivery(value);
        break;
      case "--owner-key-file":
        ownerKeyFile = value;
        break;
      default:
        throw new Error(`unknown flag ${word}`);
    }
  }
  if (hub === undefined) throw new Error("--hub <url> is required");
  return {
    hub,
    positionals,
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(deliver === undefined ? {} : { deliver }),
    ...(ownerKeyFile === undefined ? {} : { ownerKeyFile }),
  };
}

/** One sentence on stderr and a non-zero exit; the class and detail are the message. */
export function exitWith(command: string, error: unknown): never {
  console.error(`${command}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function usage(): never {
  console.error(
    "usage: manifold-install <bundle-file | https://…> --hub <url> [--sha256 <hex>] [--deliver path | docker:<container>] [--owner-key-file <path>]",
  );
  process.exit(2);
}

if (import.meta.main) {
  let flags: HubFlags;
  try {
    flags = parseHubFlags(process.argv.slice(2), true);
  } catch (error) {
    console.error(`install: ${error instanceof Error ? error.message : String(error)}`);
    usage();
  }
  const [source] = flags.positionals;
  if (source === undefined || flags.positionals.length !== 1) usage();
  try {
    const ownerKey = await resolveOwnerKey(flags.ownerKeyFile, flags.deliver);
    const report = await installBundle({
      source,
      hub: { url: flags.hub, ownerKey },
      ...(flags.sha256 === undefined ? {} : { sha256: flags.sha256 }),
      ...(flags.deliver === undefined ? {} : { deliver: flags.deliver }),
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    exitWith("install", error);
  }
}
