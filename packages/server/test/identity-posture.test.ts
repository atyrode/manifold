import { describe, expect, test } from "bun:test";
import type { ActionOutcome, Cap, CredentialsResponse, TokenGrant } from "@manifold/protocol";
import {
  AuthService,
  INTERACTIVE_TOKEN_TTL_MS,
  OWNER_AUDIT_WINDOW_MS,
  ServiceError,
  type AuthContext,
} from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import type { PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * THE IDENTITY POSTURE'S NOW ITEMS (ADR 0019 §2-§4), at the boundary that decides them.
 *
 * Every case below is written so that losing the property fails rather than passes quietly,
 * which for this file means driving the CLOCK rather than the code: expiry is the first thing
 * in this server whose behaviour is a function of time, and a test that never advances time
 * would pass against an implementation that never expires anything.
 *
 * Three exemptions are asserted as loudly as the rule, because each one is a lockout if it
 * ever silently stops holding: a machine's credential, an agent's credential, and the owner
 * key itself.
 */

const OWNER_KEY = "a".repeat(64);

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  readonly runtime: FakeRuntime;
  readonly fenced: string[];
}

async function fixture(options: { readonly online?: ReadonlySet<string> } = {}): Promise<Fixture> {
  const runtime = new FakeRuntime();
  runtime.time = 1_700_000_000_000;
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
  );
  rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
  rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
  const fenced: string[] = [];
  auth.onRevoked((principalId) => fenced.push(principalId));
  const online = options.online ?? new Set<string>();
  return {
    store,
    auth,
    owner: auth.authenticate(OWNER_KEY),
    host: await testPluginHost(store, auth, rooms, broker, runtime, {
      machines: {
        isOnline: (machineId) => online.has(machineId),
        drain: () => Promise.resolve({ ok: false, reason: "fixture has no terminal owner" }),
      },
    }),
    runtime,
    fenced,
  };
}

function mint(fix: Fixture, caps: readonly Cap[], kind: "human" | "agent" = "human"): TokenGrant {
  return fix.auth.mintToken({ principal: { name: "guest", kind }, caps: [...caps] }, fix.owner);
}

function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof ServiceError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

function result(outcome: ActionOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected a result, got ${outcome.denial.message}`);
  return outcome.result;
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

describe("session expiry (ADR 0019 §2)", () => {
  test("an interactive credential authenticates up to its bound and is refused `expired` after", async () => {
    const fix = await fixture();
    const granted = mint(fix, ["containers:read"]);

    // Published at the mint, so a lens knows when to come back rather than discovering it.
    expect(granted.expiresAt).toBe(fix.runtime.time + INTERACTIVE_TOKEN_TTL_MS);

    // One millisecond before the bound the credential is ordinary in every respect.
    fix.runtime.time += INTERACTIVE_TOKEN_TTL_MS - 1;
    expect(fix.auth.authenticate(granted.token).principal.id).toBe(granted.principal.id);

    fix.runtime.time += 1;
    /*
      A NAMED CLASS, not a generic `unauthorized`: `expired` says "come back with a fresh
      credential" and `revoked` says "stop asking", and a lens has to be able to tell them
      apart. `forbidden` matches `revoked`'s code because the secret presented is genuine and
      the server recognized it, which is what separates both from an unknown token.
    */
    expect(refusal(() => fix.auth.authenticate(granted.token))).toEqual({
      code: "forbidden",
      message: "expired",
    });
    fix.store.close();
  });

  test("revocation outranks expiry, so a revoked-and-expired credential still reads `revoked`", async () => {
    const fix = await fixture();
    const granted = mint(fix, ["containers:read"]);
    fix.auth.revokePrincipal(granted.principal.id, fix.owner);
    fix.runtime.time += INTERACTIVE_TOKEN_TTL_MS + 1;

    // The rung order is the answer a holder can act on: revoked means stop, and an expiry
    // notice would invite a retry that can never succeed.
    expect(refusal(() => fix.auth.authenticate(granted.token)).message).toBe("revoked");
    fix.store.close();
  });

  test("a machine's credential outlives the interactive bound by a long way", async () => {
    const fix = await fixture();
    const enrolled = fix.auth.enrollMachine("spoke", fix.owner);

    // Ten times the human bound, which is the point: an agent's credential is long-lived by
    // design and shortening it is a fleet outage wearing a security hat.
    fix.runtime.time += INTERACTIVE_TOKEN_TTL_MS * 10;

    expect(fix.auth.authenticateMachine(enrolled.machineToken).id).toBe(enrolled.machine.id);
    // The exemption is in the DATA as well as in the code path: nothing wrote a bound to
    // enforce, so no later change to `authenticateMachine` can start enforcing one.
    expect(fix.store.getToken(enrolled.machine.tokenId)?.expiresAt).toBeNull();
    fix.store.close();
  });

  test("an agent principal's credential does not expire either", async () => {
    const fix = await fixture();
    const granted = mint(fix, ["scenes:write"], "agent");

    expect(granted.expiresAt).toBeUndefined();
    fix.runtime.time += INTERACTIVE_TOKEN_TTL_MS * 10;
    expect(fix.auth.authenticate(granted.token).principal.kind).toBe("agent");
    fix.store.close();
  });

  test("the owner key never expires: break-glass that can lock you out is not break-glass", async () => {
    const fix = await fixture();

    fix.runtime.time += INTERACTIVE_TOKEN_TTL_MS * 100;

    const context = fix.auth.authenticate(OWNER_KEY);
    expect(context.isRoot).toBe(true);
    expect(context.tokenId).toBeNull();
    fix.store.close();
  });
});

describe("bootstrap audit (ADR 0019 §4)", () => {
  test("the owner path leaves one row per window, never one per request", async () => {
    const fix = await fixture();
    // The fixture already authenticated once; ninety-nine more inside the same window.
    for (let index = 0; index < 99; index += 1) fix.auth.authenticate(OWNER_KEY);

    const inWindow = fix.store.listEvents({ type: "owner_authenticated", limit: 500 });
    expect(inWindow).toHaveLength(1);

    fix.runtime.time += OWNER_AUDIT_WINDOW_MS;
    fix.auth.authenticate(OWNER_KEY);
    fix.auth.authenticate(OWNER_KEY);

    // A new window is a new row, and the second call inside it is still the same session.
    expect(fix.store.listEvents({ type: "owner_authenticated", limit: 500 })).toHaveLength(2);
    fix.store.close();
  });

  test("the audit row carries the de-duplication rule and no fragment of the key", async () => {
    const fix = await fixture();

    const row = fix.store.listEvents({ type: "owner_authenticated", limit: 1 })[0];
    // The journal stores a payload as JSON text; the reader parses it, so the test does too.
    expect(JSON.parse(String(row?.payload))).toEqual({ window: OWNER_AUDIT_WINDOW_MS });
    expect(row?.principalId).toBe(fix.auth.ownerPrincipal.id);
    // The whole row, serialized, must not contain the secret or any run of it.
    const serialized = JSON.stringify(row);
    expect(serialized.includes(OWNER_KEY)).toBe(false);
    expect(serialized.includes(OWNER_KEY.slice(0, 8))).toBe(false);
    fix.store.close();
  });

  test("a bootstrap through the owner key records the act, not only the credential", async () => {
    const fix = await fixture();

    const created = result(
      await fix.host.dispatch(fix.owner, "core.access.createPrincipal", { name: "laptop" }),
    ) as TokenGrant;

    const rows = fix.store.listEvents({ type: "principal_bootstrapped", limit: 10 });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.payload))).toEqual({
      subjectPrincipalId: created.principal.id,
      kind: "human",
      // The fact the audit exists for: the owner KEY opened this door, not a delegated token.
      byOwnerKey: true,
    });
    // `token_minted` still records the credential. Two rows, two facts: `mintToken` also
    // mints and is not a bootstrap.
    expect(fix.store.listEvents({ type: "token_minted", limit: 10 })).toHaveLength(1);
    fix.store.close();
  });

  test("the audit is an EVENT row: ADR 0018's trace writer is untouched", async () => {
    const fix = await fixture();

    const traces = fix.store.listEvents({ type: "trace", limit: 100 });
    const audits = fix.store.listEvents({ type: "owner_authenticated", limit: 100 });

    // An authentication has no door, so it cannot be a trace without putting a name in that
    // column the roster does not publish. The two families stay separate.
    expect(audits.length).toBe(1);
    expect(traces.length).toBe(0);
    expect(audits[0]?.door).toBeNull();
    fix.store.close();
  });
});

describe("the machine revocation door (ADR 0019 §3)", () => {
  test("withdrawal kills the credential, fences the socket, and keeps the row", async () => {
    const fix = await fixture();
    const enrolled = fix.auth.enrollMachine("spoke", fix.owner);

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.revoke", {
      machineId: enrolled.machine.id,
    });

    expect(result(outcome)).toEqual({ revoked: 1 });
    // The agent's next dial is refused with the same class every revocation uses.
    expect(refusal(() => fix.auth.authenticateMachine(enrolled.machineToken))).toEqual({
      code: "forbidden",
      message: "revoked",
    });
    // The live socket is severed through the fence a principal's revocation already rode.
    expect(fix.fenced).toContain(enrolled.machine.id);
    // THE ROW SURVIVES ITS CREDENTIAL: withdrawing and forgetting are different verbs.
    expect(fix.store.getMachine(enrolled.machine.id)?.name).toBe("spoke");
    expect(fix.store.revokedMachineIds().has(enrolled.machine.id)).toBe(true);
    fix.store.close();
  });

  test("the roster reports a withdrawn machine, and omits the field for a live one", async () => {
    const fix = await fixture();
    const live = fix.auth.enrollMachine("live", fix.owner);
    const cut = fix.auth.enrollMachine("cut", fix.owner);
    await fix.host.dispatch(fix.owner, "core.machines.revoke", { machineId: cut.machine.id });

    const listed = result(await fix.host.dispatch(fix.owner, "core.machines.list", {})) as {
      machines: readonly { id: string; revoked?: boolean }[];
    };

    // Absent rather than `false`, which is what keeps a pre-v20 reader's parse exact.
    expect(listed.machines.find((row) => row.id === live.machine.id)?.revoked).toBeUndefined();
    expect(listed.machines.find((row) => row.id === cut.machine.id)?.revoked).toBe(true);
    fix.store.close();
  });

  test("withdrawing twice answers zero, which is a success and not a refusal", async () => {
    const fix = await fixture();
    const enrolled = fix.auth.enrollMachine("spoke", fix.owner);
    const machineId = enrolled.machine.id;

    await fix.host.dispatch(fix.owner, "core.machines.revoke", { machineId });
    const again = await fix.host.dispatch(fix.owner, "core.machines.revoke", { machineId });

    expect(result(again)).toEqual({ revoked: 0 });
    fix.store.close();
  });

  test("`machines:mint` is the ladder, and a container-scoped holder of it reaches nothing", async () => {
    const fix = await fixture();
    const enrolled = fix.auth.enrollMachine("spoke", fix.owner);
    const reader = fix.auth.authenticate(mint(fix, ["containers:read"]).token);

    const outcome = await fix.host.dispatch(reader, "core.machines.revoke", {
      machineId: enrolled.machine.id,
    });

    // Refused at the door's cap rung, one rung before the arguments are read — so a caller
    // who may not open this door does not discover its schema by knocking.
    expect(denial(outcome).rule).toBe("forbidden");
    expect(fix.store.revokedMachineIds().has(enrolled.machine.id)).toBe(false);
    fix.store.close();
  });

  test("an unknown machine is not_found rather than a silent zero", async () => {
    const fix = await fixture();

    expect(refusal(() => fix.auth.revokeMachine("no-such-machine", fix.owner))).toEqual({
      code: "not_found",
      message: "machine not found",
    });
    fix.store.close();
  });
});

describe("the credential list (ADR 0019 §3)", () => {
  test("root reads every principal with its live credentials, and no secret", async () => {
    const fix = await fixture();
    const granted = mint(fix, ["containers:read"]);

    const listed = result(
      await fix.host.dispatch(fix.owner, "core.access.listCredentials", {}),
    ) as CredentialsResponse;

    const row = listed.principals.find((entry) => entry.principal.id === granted.principal.id);
    expect(row?.sessions).toHaveLength(1);
    expect(row?.sessions[0]?.caps).toEqual(["containers:read"]);
    expect(row?.sessions[0]?.expiresAt).toBe(granted.expiresAt);
    expect(row?.createdAt).toBe(fix.runtime.time);
    // The owner principal is in the answer too: it is the identity every bootstrap acts as.
    expect(
      listed.principals.some((entry) => entry.principal.id === fix.auth.ownerPrincipal.id),
    ).toBe(true);
    // Neither the raw secret nor its hash may appear anywhere in the published answer.
    const serialized = JSON.stringify(listed);
    expect(serialized.includes(granted.token)).toBe(false);
    expect(serialized.includes("hash")).toBe(false);
    fix.store.close();
  });

  test("a dead credential leaves the list: expired and revoked rows are not sessions", async () => {
    const fix = await fixture();
    const expiring = mint(fix, ["containers:read"]);
    const revoked = mint(fix, ["containers:read"]);
    fix.auth.revokePrincipal(revoked.principal.id, fix.owner);
    fix.runtime.time += INTERACTIVE_TOKEN_TTL_MS + 1;

    const listed = result(
      await fix.host.dispatch(fix.owner, "core.access.listCredentials", {}),
    ) as CredentialsResponse;

    // Both principals still exist — a credential dying does not delete a person — and both
    // now hold nothing, which is the answer that makes the list worth reading.
    for (const id of [expiring.principal.id, revoked.principal.id]) {
      const row = listed.principals.find((entry) => entry.principal.id === id);
      expect(row).toBeDefined();
      expect(row?.sessions).toHaveLength(0);
    }
    fix.store.close();
  });

  test("a non-root reader sees itself and what it minted, and nothing else", async () => {
    const fix = await fixture();
    const minter = mint(fix, ["tokens:mint", "containers:read"]);
    const minterContext = fix.auth.authenticate(minter.token);
    const delegate = fix.auth.mintToken(
      { principal: { name: "sub-agent", kind: "agent" }, caps: ["containers:read"] },
      minterContext,
    );
    const stranger = mint(fix, ["containers:read"]);

    const listed = result(
      await fix.host.dispatch(minterContext, "core.access.listCredentials", {}),
    ) as CredentialsResponse;
    const visible = listed.principals.map((entry) => entry.principal.id);

    /*
      The READ is graded to the WRITE it aims: this caller may revoke itself and what it
      minted (`revokePrincipal`), so that is exactly what it may see. A reader who could see
      more than it can act on learns who to attack; one who can act on more than it can see
      revokes by guesswork.
    */
    expect(visible).toContain(minter.principal.id);
    expect(visible).toContain(delegate.principal.id);
    expect(visible).not.toContain(stranger.principal.id);
    expect(visible).not.toContain(fix.auth.ownerPrincipal.id);
    fix.store.close();
  });

  test("`tokens:mint` is the authority, so a plain reader is refused at the door", async () => {
    const fix = await fixture();
    const reader = fix.auth.authenticate(mint(fix, ["containers:read"]).token);

    expect(denial(await fix.host.dispatch(reader, "core.access.listCredentials", {})).rule).toBe(
      "forbidden",
    );
    fix.store.close();
  });
});
