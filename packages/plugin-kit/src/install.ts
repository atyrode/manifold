#!/usr/bin/env bun
import { PluginBundleSchema, type PluginManifest } from "@manifold/protocol";
import { resolve } from "node:path";
import { assertOwnerKey, ownerAction, parseHubUrl, roster, type Hub } from "./hub.ts";

/**
 * `install` — one packed bundle onto one hub, at whatever state the hub is in (issue #319).
 *
 *     bun run --cwd packages/plugin-kit install <bundle-file | https://…> --hub <url>
 *         [--sha256 <hex>] [--deliver path | docker:<container>] [--owner-key-file <path>]
 *
 * The command is IDEMPOTENT over the roster it reads first: the same id at the same sha is
 * `unchanged` and nothing is asked of the hub; another sha is a `replaced` through
 * `engine.plugins.install` with `replace: true`. The host replaces the module without
 * changing the target's or its dependents' durable enablement or native approvals. An absent
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
  readonly hardened?: boolean;
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

/** A bundle's identity, required ids, pin over its exact bytes, and source before any hub sees it. */
export interface BundleFacts {
  readonly id: string;
  readonly requiredDependencies: readonly string[];
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

/** Only required ids constrain delivery; optional/incompatible relationships stay hub decisions. */
export function requiredDependencyIds(manifest: Pick<PluginManifest, "dependencies">): string[] {
  const ids: string[] = [];
  for (const [id, dependency] of Object.entries(manifest.dependencies ?? {})) {
    if (dependency.type === "required") ids.push(id);
  }
  return ids;
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
  return {
    id: parsed.data.manifest.id,
    requiredDependencies: requiredDependencyIds(parsed.data.manifest),
    sha256,
    source,
  };
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

/** A whole-batch refusal, before any caller starts installation. */
export class BundleOrderError extends Error {
  constructor(
    readonly reason: "duplicate" | "cycle",
    readonly ids: readonly string[],
  ) {
    super(
      reason === "duplicate"
        ? `duplicate bundle ids: ${ids.join(", ")}`
        : `dependency cycle blocks bundles: ${ids.join(", ")}`,
    );
    this.name = "BundleOrderError";
  }
}

/**
 * Supplied required dependencies and namespace parents before their consumers. Among ready
 * bundles, preserve the original depth-then-id order. Absent dependencies are not invented:
 * only the hub decides whether an external prerequisite is available.
 */
export function familyOrder<
  T extends { readonly id: string; readonly requiredDependencies?: readonly string[] },
>(bundles: readonly T[]): T[] {
  const nodes = bundles.map((bundle) => ({
    bundle,
    depth: bundle.id.split(".").length,
    blockers: 0,
    dependents: [] as number[],
  }));
  nodes.sort((a, b) => {
    const depth = a.depth - b.depth;
    return depth !== 0 ? depth : a.bundle.id < b.bundle.id ? -1 : a.bundle.id > b.bundle.id ? 1 : 0;
  });
  const byId = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    if (byId.has(node.bundle.id)) throw new BundleOrderError("duplicate", [node.bundle.id]);
    byId.set(node.bundle.id, index);
  }
  for (const [index, node] of nodes.entries()) {
    const required = new Set(node.bundle.requiredDependencies);
    for (
      let dot = node.bundle.id.lastIndexOf(".");
      dot > 0;
      dot = node.bundle.id.lastIndexOf(".", dot - 1)
    ) {
      required.add(node.bundle.id.slice(0, dot));
    }
    for (const id of required) {
      const dependency = byId.get(id);
      if (dependency === undefined) continue;
      nodes[dependency]!.dependents.push(index);
      node.blockers++;
    }
  }

  // Kahn's ready set is a min-heap of depth/id ranks: no rescans or quadratic array shifts.
  const ready: number[] = [];
  const enqueue = (index: number): void => {
    let slot = ready.length;
    ready.push(index);
    while (slot > 0) {
      const parent = (slot - 1) >> 1;
      if (ready[parent]! < index) break;
      ready[slot] = ready[parent]!;
      slot = parent;
    }
    ready[slot] = index;
  };
  for (const [index, node] of nodes.entries()) {
    if (node.blockers === 0) enqueue(index);
  }
  const ordered: T[] = [];
  while (ready.length > 0) {
    const index = ready[0]!;
    const last = ready.pop()!;
    if (ready.length > 0) {
      let slot = 0;
      for (;;) {
        let child = slot * 2 + 1;
        if (child >= ready.length) break;
        if (child + 1 < ready.length && ready[child + 1]! < ready[child]!) child++;
        if (last < ready[child]!) break;
        ready[slot] = ready[child]!;
        slot = child;
      }
      ready[slot] = last;
    }
    const node = nodes[index]!;
    ordered.push(node.bundle);
    for (const dependent of node.dependents) {
      if (--nodes[dependent]!.blockers === 0) enqueue(dependent);
    }
  }
  if (ordered.length !== nodes.length) {
    throw new BundleOrderError(
      "cycle",
      nodes.filter((node) => node.blockers > 0).map((node) => node.bundle.id),
    );
  }
  return ordered;
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
  if (
    row?.install?.sha256 === facts.sha256 &&
    (row.install.hardened === true) === (options.hardened === true)
  )
    return report("unchanged");

  const source = await deliver(facts, options.deliver ?? { kind: "path" });
  if (row === undefined) {
    await ownerAction(hub, "engine.plugins.install", {
      source,
      sha256: facts.sha256,
      hardened: options.hardened === true,
    });
    return report("installed");
  }
  await ownerAction(hub, "engine.plugins.install", {
    source,
    sha256: facts.sha256,
    replace: true,
    hardened: options.hardened === true,
  });
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
  readonly hardened?: boolean;
  readonly positionals: readonly string[];
}

export function parseHubFlags(argv: readonly string[], allowSha: boolean): HubFlags {
  let hub: string | undefined;
  let sha256: string | undefined;
  let deliver: Delivery | undefined;
  let ownerKeyFile: string | undefined;
  let hardened = false;
  const positionals: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at];
    if (word === undefined) break;
    if (!word.startsWith("--")) {
      positionals.push(word);
      continue;
    }
    if (word === "--hardened") {
      hardened = true;
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
    ...(hardened ? { hardened } : {}),
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
    "usage: manifold-install <bundle-file | https://…> --hub <url> [--hardened] [--sha256 <hex>] [--deliver path | docker:<container>] [--owner-key-file <path>]",
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
      hardened: flags.hardened === true,
      ...(flags.sha256 === undefined ? {} : { sha256: flags.sha256 }),
      ...(flags.deliver === undefined ? {} : { deliver: flags.deliver }),
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    exitWith("install", error);
  }
}
