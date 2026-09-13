import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  MAX_MACHINE_REMOTE_CHARS,
  defaultRuntime,
  type MachineRepositoryFact,
  type MachineRepositoryReason,
  type RuntimeDeps,
} from "@manifold/protocol";

/**
 * WHAT A FOLDER IS, answered on the host (issue #529).
 *
 * A job runs in a sandbox that sees only its declared locations, so a plugin inside one
 * cannot ask git about a folder the operator merely mentioned — and opening the whole home
 * read-only to make it possible would hand every job every secret file in `~`. The enrolled
 * agent is already on the host and already reports facts about the machine, so this is one
 * more fact: given an absolute path, what repository is it.
 *
 * The IDENTITY is the resolved git common directory rather than the path, because every
 * worktree of one repository shares exactly one common directory: a checkout and the linked
 * worktree beside it answer with the same identity, which is what makes "the same project"
 * sayable across two locators. The REMOTE is `origin` normalized to `host/owner/repo`, which
 * is what makes the same repository on two machines recognisable as one.
 *
 * Every probe is READ-ONLY, and in git's own terms rather than by intention: `rev-parse` and
 * `remote get-url` read metadata, `GIT_OPTIONAL_LOCKS=0` keeps them from touching the index,
 * and `GIT_TERMINAL_PROMPT=0` keeps a credential prompt from turning a background question
 * into a hang. Observing where somebody's work happened must never modify it.
 */

/**
 * Bounds ONE git invocation. Both probes read local metadata and answer in milliseconds; the
 * bound exists so a path on an unresponsive network mount costs the asker one second rather
 * than stalling it, and a timeout is a stated reason like any other failed observation.
 */
export const REPOSITORY_PROBE_TIMEOUT_MS = 1000;

/**
 * How long an observation stands before the disk is asked again. A hub cataloguing a fleet's
 * folders asks about the same handful of checkouts repeatedly, and a repository's identity
 * changes when somebody clones or moves it — minutes apart, not milliseconds — so a short
 * window turns a burst of questions into one pair of subprocesses without ever serving an
 * answer whose subject could plausibly have changed.
 */
export const REPOSITORY_CACHE_TTL_MS = 60_000;

/**
 * The cache's ceiling in distinct paths. A bound rather than a tuning knob: the path is
 * CALLER-CHOSEN, so an unbounded map would let one asker grow the agent's heap by naming a
 * fresh path per question. The oldest entry goes when the ceiling is reached.
 */
export const REPOSITORY_CACHE_MAX_ENTRIES = 4096;

/** What one bounded git invocation produced. Every non-answer says WHY, never just "no". */
export type ProbeOutcome =
  | { readonly kind: "line"; readonly line: string }
  /** git exited non-zero, or printed nothing: it ran, and it declined to answer. */
  | { readonly kind: "refused" }
  | { readonly kind: "timed_out" }
  | { readonly kind: "no_git" };

/** Injected so a test can drive the observer without a git on PATH; production spawns. */
export interface RepositoryProbe {
  /** The first line of `git -C <path> <args>`, or the reason there is none. */
  run(path: string, args: readonly string[]): Promise<ProbeOutcome>;
}

export interface RepositoryObserverOptions {
  readonly runtime?: RuntimeDeps;
  readonly probe?: RepositoryProbe;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

interface CacheEntry {
  readonly fact: MachineRepositoryFact;
  readonly expiresAt: number;
}

/**
 * One agent's repository observer, for the life of the process. The cache is why this is an
 * object rather than a function.
 */
export class RepositoryObserver {
  private readonly runtime: RuntimeDeps;
  private readonly probe: RepositoryProbe;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  /** Insertion-ordered, which is what makes "evict the oldest" a `keys().next()`. */
  private readonly cached = new Map<string, CacheEntry>();
  /** One in-flight probe per path, so a burst of questions costs one pair of subprocesses. */
  private readonly inflight = new Map<string, Promise<MachineRepositoryFact>>();

  constructor(options: RepositoryObserverOptions = {}) {
    this.runtime = options.runtime ?? defaultRuntime;
    this.probe = options.probe ?? spawnProbe();
    this.ttlMs = options.ttlMs ?? REPOSITORY_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? REPOSITORY_CACHE_MAX_ENTRIES;
  }

  /** The fact for one absolute path, fresh or from the window the last one still stands in. */
  observe(path: string): Promise<MachineRepositoryFact> {
    const hit = this.cached.get(path);
    if (hit !== undefined) {
      if (hit.expiresAt > this.runtime.now()) return Promise.resolve(hit.fact);
      this.cached.delete(path);
    }
    const pending = this.inflight.get(path);
    if (pending !== undefined) return pending;
    const started = this.look(path).then((fact) => {
      this.inflight.delete(path);
      this.remember(path, fact);
      return fact;
    });
    this.inflight.set(path, started);
    return started;
  }

  private remember(path: string, fact: MachineRepositoryFact): void {
    this.cached.delete(path);
    while (this.cached.size >= this.maxEntries) {
      const oldest = this.cached.keys().next();
      if (oldest.done === true) break;
      this.cached.delete(oldest.value);
    }
    this.cached.set(path, { fact, expiresAt: this.runtime.now() + this.ttlMs });
  }

  private async look(path: string): Promise<MachineRepositoryFact> {
    const answer = (
      reason: MachineRepositoryReason,
      identity: string | null = null,
      remote: string | null = null,
    ): MachineRepositoryFact => ({
      path,
      identity,
      remote,
      reason,
      observedAt: this.runtime.now(),
    });
    /*
      What the path IS, before git is asked anything. A path this host cannot traverse is
      `unreadable` rather than absent — "I may not look" and "there is nothing there" are
      different states of the machine and the caller acts on them differently — and a path
      that names a file is `not_a_repository`, because it exists and is not a checkout.
    */
    const reached = await stat(path).then(
      (info): MachineRepositoryReason | null => (info.isDirectory() ? null : "not_a_repository"),
      (error: unknown): MachineRepositoryReason => (denied(error) ? "unreadable" : "absent"),
    );
    if (reached !== null) return answer(reached);
    const common = await this.probe.run(path, ["rev-parse", "--git-common-dir"]);
    switch (common.kind) {
      case "no_git":
        return answer("git_unavailable");
      // A bounded probe that never answered says nothing about the folder, so it must not be
      // reported as "not a repository": the reason is the timeout itself.
      case "timed_out":
        return answer("timed_out");
      case "refused":
        return answer("not_a_repository");
      case "line":
        break;
      default: {
        const exhaustive: never = common;
        void exhaustive;
        return answer("not_a_repository");
      }
    }
    /*
      git answers relative to the directory it ran in, so a plain checkout reports ".git" and
      only a linked worktree reports an absolute path. Resolving against the asked path is
      what collapses both to the one identity they share. Symlinks are resolved for the same
      reason: two folders reached through different symlinked prefixes are one repository,
      and comparing unresolved paths would file them as two. A path that cannot be resolved
      is used as it stands — what git printed is still the repository's.
    */
    const joined = isAbsolute(common.line) ? resolve(common.line) : resolve(path, common.line);
    const identity = await realpath(joined).catch(() => joined);
    const origin = await this.probe.run(path, ["remote", "get-url", "origin"]);
    return answer(
      "repository",
      identity,
      origin.kind === "line" ? normalizeRemote(origin.line) : null,
    );
  }
}

/** EACCES/EPERM is a folder this host refuses to read; anything else is a folder it lacks. */
function denied(error: unknown): boolean {
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return code === "EACCES" || code === "EPERM";
}

/**
 * The production probe: one bounded, prompt-free, lock-free `git` per question, with the
 * PATH walk paid once for the life of the agent.
 *
 * The operator's own git configuration is left in place deliberately — `safe.directory` and
 * `url.insteadOf` are how this machine's git reads this machine's checkouts, and observing
 * through a different configuration would report a repository the operator does not have.
 */
export function spawnProbe(): RepositoryProbe {
  let git: string | null | undefined;
  return {
    run: async (path, args) => {
      if (git === undefined) git = Bun.which("git");
      if (git === null) return { kind: "no_git" };
      const child = Bun.spawn([git, "-C", path, ...args], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        stdin: "ignore",
        stderr: "ignore",
        stdout: "pipe",
        timeout: REPOSITORY_PROBE_TIMEOUT_MS,
      });
      const out = await new Response(child.stdout).text().catch(() => "");
      const code = await child.exited;
      if (code !== 0) {
        // Bun enforces its bound by signalling the child, so a killed probe is the one that
        // ran out of its second rather than the one that heard git decline.
        const killed = child.signalCode === "SIGKILL" || child.signalCode === "SIGTERM";
        return killed ? { kind: "timed_out" } : { kind: "refused" };
      }
      const trimmed = out.trim();
      const end = trimmed.search(/[\r\n]/u);
      const line = end < 0 ? trimmed : trimmed.slice(0, end).trim();
      return line === "" ? { kind: "refused" } : { kind: "line", line };
    },
  };
}

/** `"/"` as a code unit, so the slash trim below compares without allocating a substring. */
const SLASH = "/".charCodeAt(0);

/**
 * States a git remote URL as `host/owner/repo`, and answers null for one it cannot read that
 * way.
 *
 * The normalization is what makes one repository one subject. git's own URL grammar writes
 * the same GitHub repository as `git@github.com:atyrode/manifold.git`,
 * `https://github.com/atyrode/manifold`, `https://token@github.com/atyrode/manifold.git/`
 * and `ssh://git@github.com/atyrode/manifold` — four strings, one project — so the scheme,
 * the credentials, the `.git` suffix and the trailing slash are removed, and the scp-like
 * short form's colon becomes the separator it means.
 *
 * A local path remote (`/srv/git/thing`, `../other`) normalizes to null: it names a
 * directory on one machine, which is a locator and not an identity, and the common directory
 * is already the better answer for it.
 */
export function normalizeRemote(url: string): string | null {
  let remote = url.trim();
  if (remote === "") return null;
  const scheme = remote.indexOf("://");
  if (scheme >= 0) {
    remote = remote.slice(scheme + 3);
  } else {
    const colon = remote.indexOf(":");
    // The scp-like short form, [user@]host:owner/repo. Its colon is a separator rather than
    // a port, which is why it is rewritten here and not for a URL that carried a scheme.
    if (colon >= 0 && !remote.slice(0, colon).includes("/")) {
      remote = `${remote.slice(0, colon)}/${remote.slice(colon + 1)}`;
    }
  }
  // Credentials in a URL that had a scheme: user[:password]@host.
  const at = remote.indexOf("@");
  if (at >= 0) remote = remote.slice(at + 1);
  // Surrounding slashes, trimmed by index rather than by `/^\/+|\/+$/`. That pattern's second
  // alternative is unanchored at its start, so a remote of many slashes makes the engine
  // retry `\/+$` from every position — quadratic work on a string this host was HANDED
  // (CodeQL js/polynomial-redos). Two scans of a string are linear and allocate nothing.
  let from = 0;
  let until = remote.length;
  while (from < until && remote.charCodeAt(from) === SLASH) from += 1;
  while (until > from && remote.charCodeAt(until - 1) === SLASH) until -= 1;
  remote = remote.slice(from, until);
  if (remote === "" || remote.startsWith(".")) return null;
  const parts: string[] = [];
  for (const part of remote.split("/")) {
    if (part === "" || part === ".") continue;
    parts.push(part);
  }
  if (parts.length < 2) return null;
  const last = parts.length - 1;
  const tail = parts[last];
  if (tail === undefined) return null;
  parts[last] = tail.endsWith(".git") ? tail.slice(0, -".git".length) : tail;
  if (parts[last] === "") return null;
  // A host element carries a dot or is localhost; anything else is a path, and a path remote
  // is a locator rather than a repository identity.
  const first = parts[0] ?? "";
  const host = first.includes(":") ? first.slice(0, first.indexOf(":")) : first;
  if (!host.includes(".") && host !== "localhost") return null;
  parts[0] = host;
  const normalized = parts.join("/");
  return normalized.length > MAX_MACHINE_REMOTE_CHARS ? null : normalized;
}
