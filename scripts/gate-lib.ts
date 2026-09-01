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
import { rmSync } from "node:fs";
import { join } from "node:path";

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

/** The owner key a freshly booted server wrote into its data dir. */
export async function ownerKeyOf(dataDir: string): Promise<string> {
  return (await Bun.file(join(dataDir, "owner.key")).text()).trim();
}

/**
 * The one teardown: stop the server, WAIT for it to be gone, and only then take its data dir.
 *
 * SIGTERM, five seconds, SIGKILL — a server that ignores the polite signal must not hold the
 * gate open. The ordering is the point: a store still being flushed into a directory the gate
 * is unlinking turns a green run into a spurious crash, and that race is exactly what two
 * gates shipped by killing and removing in the same tick.
 */
export async function teardownServer(server: Bun.Subprocess, dataDir: string): Promise<void> {
  if (server.exitCode === null) server.kill("SIGTERM");
  const stopped = await Promise.race([
    server.exited.then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!stopped && server.exitCode === null) server.kill("SIGKILL");
  await server.exited;
  rmSync(dataDir, { recursive: true, force: true });
}
