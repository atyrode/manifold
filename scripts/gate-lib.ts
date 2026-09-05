/**
 * The verification gates' shared bootstrap.
 *
 * Every gate is a standalone process that spawns a server, asserts against it, and prints
 * what passed and what failed — so every gate needs the same handful of things, and for a
 * while every gate carried its own copy of them: the PASS/FAIL line, a poll that throws, a
 * poll that answers, the owner key a booted server leaves in its data dir, and a teardown.
 * Copies drift: one gate's poll hardcoded 30s where its siblings took a deadline, and two
 * gates unlinked the data dir out from under a server that had not exited yet. This module
 * is the one home, and `cdp.ts` (the browser driver) sits ON it rather than beside it.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const AGENT_ENTRY_MARKER = "packages/agent/src/main.ts";

export const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Polls an async predicate until it returns true, or throws after ms. */
export async function until(
  probe: () => Promise<boolean> | boolean,
  ms: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

/** Polls a rendered condition and ANSWERS instead of throwing, so a miss reads as FAIL. */
export async function settles(
  probe: () => Promise<boolean> | boolean,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

/**
 * Binds the PASS/FAIL line to one gate's own failure list.
 *
 * A gate records rather than throws so a red run reports EVERY failing claim instead of the
 * first, which is why the list belongs to the script (it prints and exits on it) and only the
 * recording belongs here.
 */
export function checkInto(failures: string[]): (name: string, ok: boolean, detail: string) => void {
  return (name, ok, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };
}

/** Ports this process has already handed out, so two reservations in one gate never coincide. */
const reservedPorts = new Set<number>();

/**
 * A loopback port the kernel just confirmed free, for a server or a Chromium debug endpoint
 * the gate is about to bind there.
 *
 * Asked for, not guessed: the gate listens on `127.0.0.1:0`, reads the port the kernel
 * assigned, and closes the listener. That is a RESERVATION with a small race window — another
 * process could bind or `connect()` from the same port between the close and the gate's own
 * bind — but the kernel excludes every port that is bound, connected or in TIME_WAIT at the
 * moment it answers, and picks the next one from a random offset, so the window is as narrow
 * as the platform makes it. A blind `BASE + Math.floor(Math.random() * N)` had no such check:
 * every band sat inside the ephemeral range, where a sibling gate's outbound connection may
 * already hold the number as its source port, and `bun run gate` runs the gates in parallel.
 * #198's `verify:tile-drop` went RED that way on a docs-only PR (#195, run 33943813498):
 * `Failed to start server. Is port 44966 in use?` — Bun's own refusal to bind.
 *
 * Distinct within a process by construction: a repeat of a port already handed out here is
 * asked again, so a gate that reserves for its server and then for its browsers never gets
 * the same number twice.
 */
export function reserveLoopbackPort(): number {
  for (;;) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    if (reservedPorts.has(port)) continue;
    reservedPorts.add(port);
    return port;
  }
}

/** The owner key a freshly booted server wrote into its data dir. */
export async function ownerKeyOf(dataDir: string): Promise<string> {
  return (await Bun.file(join(dataDir, "owner.key")).text()).trim();
}

/**
 * The local agent the gate's own server spawned, or null. Read the way the server decides
 * whether a recorded pid is still its agent (`agent-spawn.ts`, `livePid`): the pid file names
 * it AND `/proc/<pid>/cmdline` must still be the agent entry, so a pid the kernel has since
 * handed to something else is never signalled. Never by name: this box runs many manifolds.
 */
function spawnedAgentPid(dataDir: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, "agent.pid"), "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").includes(AGENT_ENTRY_MARKER)
      ? pid
      : null;
  } catch {
    return null;
  }
}

/** SIGTERM, five seconds, SIGKILL — the server's own discipline, applied to one pid. */
async function reap(pid: number): Promise<void> {
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5_000;
  while (alive() && Date.now() < deadline) await sleep(100);
  if (!alive()) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone between the check and the signal: the outcome this wanted.
  }
}

/**
 * The one teardown: stop the server, WAIT for it to be gone, reap the agent it spawned, and
 * only then take its data dir.
 *
 * SIGTERM, five seconds, SIGKILL — a server that ignores the polite signal must not hold the
 * gate open. The ordering is the point: a store still being flushed into a directory the gate
 * is unlinking turns a green run into a spurious crash, and that race is exactly what two
 * gates shipped by killing and removing in the same tick.
 *
 * THE AGENT IS THE GATE'S TO REAP. A server booted with `MANIFOLD_SPAWN_AGENT=1` detaches its
 * local agent on purpose — in production the agent must survive a server restart (CONTRACTS
 * §Runtime contracts) — so killing the server leaves the agent redialing an origin that will
 * never answer, forever. Every browser gate did exactly that, and the box accumulated 453
 * orphaned agents holding ~21 GiB before anybody looked (2026-09-02). The pid file the server
 * writes is the handle, and it has to be read BEFORE the data dir goes.
 */
export async function teardownServer(server: Bun.Subprocess, dataDir: string): Promise<void> {
  const agent = spawnedAgentPid(dataDir);
  if (server.exitCode === null) server.kill("SIGTERM");
  const stopped = await Promise.race([
    server.exited.then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!stopped && server.exitCode === null) server.kill("SIGKILL");
  await server.exited;
  if (agent !== null) await reap(agent);
  rmSync(dataDir, { recursive: true, force: true });
}
