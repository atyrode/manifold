import { describe, expect, test } from "bun:test";
import { type ActionOutcome } from "@manifold/protocol";
import { AuthService, DECLARED_MACHINE_REFUSAL, ServiceError } from "../src/auth.ts";
import { parseDeclaredMachines } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { RoomManager } from "../src/room.ts";
import { sha256Hex } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * THE DECLARED FLEET (`MANIFOLD_DECLARED_MACHINES`): the repository says which machines exist
 * and what their tokens hash to, and every boot makes the `machines` table agree.
 *
 * Each case is one row of the reconciliation contract — create, no-op, rotate, revoke — plus
 * the two edges around it: a malformed file is a startup error naming the entry, and the
 * enrolment door refuses a name the file owns. The raw token never reaches the hub, so every
 * case that authenticates does it the way a spoke would: with the raw the test minted itself
 * and whose hash it put in the file.
 */

const OWNER_KEY = "c".repeat(64);

/** A raw a spoke would hold, and the hash the repository would publish for it. */
function spokeToken(seed: string): { raw: string; hash: string } {
  const raw = seed.repeat(64).slice(0, 64);
  return { raw, hash: sha256Hex(raw) };
}

function fixture() {
  const runtime = new FakeRuntime();
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  return { runtime, store, auth, owner: auth.authenticate(OWNER_KEY) };
}

function refusal(action: () => unknown): { code: string; message: string } {
  try {
    action();
  } catch (error) {
    if (error instanceof ServiceError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("reconcileDeclaredMachines", () => {
  test("a declared file creates the machines it names, and the raw they hash to dials in", () => {
    const fix = fixture();
    const alpha = spokeToken("a");
    const beta = spokeToken("b");

    const changes = fix.auth.reconcileDeclaredMachines(
      new Map([
        ["alpha", alpha.hash],
        ["beta", beta.hash],
      ]),
    );

    expect(changes.map((change) => [change.name, change.change])).toEqual([
      ["alpha", "created"],
      ["beta", "created"],
    ]);
    const row = fix.store.getMachineByName("alpha");
    expect(row?.origin).toBe("declared");
    expect(fix.auth.authenticateMachine(alpha.raw).id).toBe(row?.id ?? "");
    expect(fix.auth.authenticateMachine(beta.raw).name).toBe("beta");
    // The hub holds the hash and nothing else: no raw was minted, so none can be on disk.
    expect(fix.store.getToken(row?.tokenId ?? "")?.hash).toBe(alpha.hash);
    fix.store.close();
  });

  test("a second boot with the same file is a no-op: same rows, same tokens, no changes", () => {
    const fix = fixture();
    const alpha = spokeToken("a");
    const declared = new Map([["alpha", alpha.hash]]);
    fix.auth.reconcileDeclaredMachines(declared);
    const before = fix.store.getMachineByName("alpha");
    const tokens = fix.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get();

    expect(fix.auth.reconcileDeclaredMachines(declared)).toEqual([]);

    expect(fix.store.getMachineByName("alpha")).toEqual(before);
    expect(fix.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()).toEqual(
      tokens,
    );
    expect(fix.auth.authenticateMachine(alpha.raw).id).toBe(before?.id ?? "");
    fix.store.close();
  });

  test("a changed hash rotates in place: same machine id, old raw refused, new raw accepted", () => {
    const fix = fixture();
    const first = spokeToken("a");
    const second = spokeToken("d");
    fix.auth.reconcileDeclaredMachines(new Map([["alpha", first.hash]]));
    const before = fix.store.getMachineByName("alpha");
    const fenced: string[] = [];
    fix.auth.onRevoked((principalId) => fenced.push(principalId));

    const changes = fix.auth.reconcileDeclaredMachines(new Map([["alpha", second.hash]]));

    expect(changes).toEqual([{ name: "alpha", machineId: before?.id ?? "", change: "rotated" }]);
    expect(fix.store.getMachineByName("alpha")?.id).toBe(before?.id ?? "");
    // The old raw no longer names this machine's credential at all, so it is refused at the
    // lookup, the same way a door rotation leaves it.
    expect(() => fix.auth.authenticateMachine(first.raw)).toThrow(ServiceError);
    expect(fix.auth.authenticateMachine(second.raw).id).toBe(before?.id ?? "");
    // Rotation is a revocation too, and it rides the same fence a door rotation does.
    expect(fenced).toEqual([before?.id ?? ""]);
    fix.store.close();
  });

  test("a name dropped from the file is revoked the way core.machines.revoke revokes", () => {
    const fix = fixture();
    const alpha = spokeToken("a");
    const beta = spokeToken("b");
    fix.auth.reconcileDeclaredMachines(
      new Map([
        ["alpha", alpha.hash],
        ["beta", beta.hash],
      ]),
    );
    const betaRow = fix.store.getMachineByName("beta");

    const changes = fix.auth.reconcileDeclaredMachines(new Map([["alpha", alpha.hash]]));

    expect(changes).toEqual([{ name: "beta", machineId: betaRow?.id ?? "", change: "revoked" }]);
    // The row survives its credential, exactly as withdrawal through the door leaves it.
    expect(fix.store.getMachineByName("beta")?.id).toBe(betaRow?.id ?? "");
    expect(fix.store.revokedMachineIds().has(betaRow?.id ?? "")).toBeTrue();
    expect(refusal(() => fix.auth.authenticateMachine(beta.raw)).code).toBe("forbidden");
    expect(fix.auth.authenticateMachine(alpha.raw).name).toBe("alpha");
    // Revoking is idempotent across boots: the next pass has nothing left to withdraw.
    expect(fix.auth.reconcileDeclaredMachines(new Map([["alpha", alpha.hash]]))).toEqual([]);
    fix.store.close();
  });

  test("a machine the door enrolled is left alone by a file that does not name it", () => {
    const fix = fixture();
    const enrolled = fix.auth.enrollMachine("hand-rolled", fix.owner);

    const changes = fix.auth.reconcileDeclaredMachines(new Map([["alpha", spokeToken("a").hash]]));

    expect(changes.map((change) => change.name)).toEqual(["alpha"]);
    expect(fix.auth.authenticateMachine(enrolled.machineToken).id).toBe(enrolled.machine.id);
    expect(fix.store.getMachine(enrolled.machine.id)?.origin).toBe("enrolled");
    fix.store.close();
  });

  test("a machine the door enrolled is ADOPTED when the file names it: rotated onto the declared hash", () => {
    const fix = fixture();
    const enrolled = fix.auth.enrollMachine("alpha", fix.owner);
    const declared = spokeToken("a");

    const changes = fix.auth.reconcileDeclaredMachines(new Map([["alpha", declared.hash]]));

    expect(changes).toEqual([{ name: "alpha", machineId: enrolled.machine.id, change: "rotated" }]);
    expect(fix.store.getMachine(enrolled.machine.id)?.origin).toBe("declared");
    expect(() => fix.auth.authenticateMachine(enrolled.machineToken)).toThrow(ServiceError);
    expect(fix.auth.authenticateMachine(declared.raw).id).toBe(enrolled.machine.id);
    fix.store.close();
  });

  test("a declaration re-stating a revoked secret is reported unhonoured, never resurrected", () => {
    const fix = fixture();
    const alpha = spokeToken("a");
    fix.auth.reconcileDeclaredMachines(new Map([["alpha", alpha.hash]]));
    const row = fix.store.getMachineByName("alpha");
    fix.auth.revokeMachine(row?.id ?? "", fix.owner);

    const changes = fix.auth.reconcileDeclaredMachines(new Map([["alpha", alpha.hash]]));

    expect(changes).toEqual([{ name: "alpha", machineId: row?.id ?? "", change: "unhonoured" }]);
    expect(refusal(() => fix.auth.authenticateMachine(alpha.raw)).code).toBe("forbidden");
    // A fresh hash is the way back, and it is an ordinary rotation.
    const rekeyed = spokeToken("e");
    expect(
      fix.auth.reconcileDeclaredMachines(new Map([["alpha", rekeyed.hash]])).map((c) => c.change),
    ).toEqual(["rotated"]);
    expect(fix.auth.authenticateMachine(rekeyed.raw).id).toBe(row?.id ?? "");
    fix.store.close();
  });
});

describe("MANIFOLD_DECLARED_MACHINES parsing", () => {
  test("a well-formed file maps names to hashes", () => {
    const hash = "0".repeat(64);
    expect([...parseDeclaredMachines(JSON.stringify({ alpha: hash }), "/etc/fleet.json")]).toEqual([
      ["alpha", hash],
    ]);
  });

  test("a malformed entry fails boot naming the entry", () => {
    const path = "/etc/fleet.json";
    expect(() => parseDeclaredMachines(JSON.stringify({ alpha: "abc" }), path)).toThrow(
      `MANIFOLD_DECLARED_MACHINES (${path}): entry "alpha" must be exactly 64 lowercase hex characters`,
    );
    // Uppercase is refused rather than folded: the handshake compares lowercase strings.
    expect(() => parseDeclaredMachines(JSON.stringify({ alpha: "A".repeat(64) }), path)).toThrow(
      'entry "alpha"',
    );
    expect(() => parseDeclaredMachines(JSON.stringify({ "": "0".repeat(64) }), path)).toThrow(
      "machine name must not be empty",
    );
    expect(() => parseDeclaredMachines("[]", path)).toThrow("expected an object");
    expect(() => parseDeclaredMachines("{", path)).toThrow(`MANIFOLD_DECLARED_MACHINES (${path})`);
  });
});

describe("core.machines.enroll against a declared name", () => {
  function door() {
    const fix = fixture();
    const clock = new FakeClock(fix.runtime);
    const rooms = new RoomManager(fix.store, fix.runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      fix.store,
      fix.auth,
      rooms,
      fix.runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
    rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
    return { ...fix, host: testPluginHost(fix.store, fix.auth, rooms, broker, fix.runtime) };
  }

  function denial(outcome: ActionOutcome): { rule: string; message: string } {
    if (outcome.ok) throw new Error("expected a denial");
    return outcome.denial;
  }

  test("the door refuses a declared name, with and without rotateToken, and mints nothing", async () => {
    const fix = door();
    const alpha = spokeToken("a");
    fix.auth.reconcileDeclaredMachines(new Map([["alpha", alpha.hash]]));
    const before = fix.store.getMachineByName("alpha");

    const plain = await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" });
    const rotate = await fix.host.dispatch(fix.owner, "core.machines.enroll", {
      name: "alpha",
      rotateToken: true,
    });

    expect(denial(plain)).toEqual({ rule: "refused", message: DECLARED_MACHINE_REFUSAL });
    expect(denial(rotate)).toEqual({ rule: "refused", message: DECLARED_MACHINE_REFUSAL });
    expect(fix.store.getMachineByName("alpha")).toEqual(before);
    expect(fix.auth.authenticateMachine(alpha.raw).id).toBe(before?.id ?? "");
    fix.store.close();
  });

  test("the mechanism refuses a declared row on the boot-recovery entrance too", () => {
    const fix = fixture();
    fix.auth.reconcileDeclaredMachines(new Map([["alpha", spokeToken("a").hash]]));
    const row = fix.store.getMachineByName("alpha");
    if (row === null) throw new Error("declared row missing");

    expect(refusal(() => fix.auth.rotateMachineToken(row))).toEqual({
      code: "conflict",
      message: DECLARED_MACHINE_REFUSAL,
    });
    expect(refusal(() => fix.auth.enrollMachine("alpha", fix.owner)).code).toBe("conflict");
    fix.store.close();
  });
});
