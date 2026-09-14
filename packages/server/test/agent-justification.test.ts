import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentPolicyChallengeSchema,
  CreateRunCredentialResultSchema,
  type ActionOutcome,
  type LogEvent,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { normalizeAgentDeclaration, silentLogger } from "../src/log.ts";
import type { PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TRACE_ROW_TYPE, type ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";
import { createExternalRun, type ExternalRunFixtureInput } from "./agent-fixtures.ts";

const stores = new Set<ServerStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

interface Fixture {
  readonly runtime: FakeRuntime;
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  readonly logs: Readonly<Record<string, unknown>>[];
}

async function fixture(): Promise<Fixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  stores.add(store);
  const auth = new AuthService(store, "j".repeat(64), runtime);
  const owner = auth.authenticate("j".repeat(64));
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
  const logs: Readonly<Record<string, unknown>>[] = [];
  const record = (_event: LogEvent, fields?: Readonly<Record<string, unknown>>) => {
    logs.push(fields ?? {});
  };
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    logger: { info: record, warn: record, error: record },
  });
  return { runtime, store, auth, owner, host, logs };
}

function result(outcome: ActionOutcome): unknown {
  if (!outcome.ok) throw new Error(`fixture dispatch refused: ${outcome.denial.rule}`);
  return outcome.result;
}

function latestTrace(fix: Fixture) {
  const row = fix.store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0];
  if (row === undefined) throw new Error("dispatch left no trace");
  return row;
}

const childArgs = {
  target: "manifold://",
  reach: "subtree",
  caps: ["containers:read"],
};

async function newRun(fix: Fixture, options: Partial<ExternalRunFixtureInput> = {}) {
  const created = createExternalRun(fix, {
    name: "reader",
    purpose: "Read a bounded part of the sponsored task.",
    target: "manifold://",
    reach: "subtree",
    caps: ["agents:delegate", "containers:read", "containers:write"],
    ...options,
  });
  return { created, actor: fix.auth.authenticate(created.credential.token) };
}

async function acknowledge(fix: Fixture, actor: AuthContext) {
  const challenge = AgentPolicyChallengeSchema.parse(
    result(await fix.host.dispatch(actor, "core.access.getAgentPolicy", {})),
  );
  result(
    await fix.host.dispatch(actor, "core.access.acknowledgeAgentPolicy", {
      revision: challenge.revision,
      acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
    }),
  );
}

describe("bound agent declarations", () => {
  test("normalization bounds the raw and normalized claim and removes invisible formatting", () => {
    expect(normalizeAgentDeclaration(" \tReview\u202e the\ncontainer\u200b. \r")).toBe(
      "Review the container.",
    );
    const targetClaim = "Inspect manifold://container/550e8400-e29b-41d4-a716-446655440000";
    expect(normalizeAgentDeclaration(targetClaim)).toBe(targetClaim);
    expect(normalizeAgentDeclaration("Bearer 550e8400-e29b-41d4-a716-446655440000")).toBeNull();
    const boundary = "Read " + "a ".repeat(253) + "x";
    expect(normalizeAgentDeclaration(boundary)).toBe(boundary);
    expect(normalizeAgentDeclaration(boundary + " ")).toBeNull();
    expect(normalizeAgentDeclaration("\ufb03 ".repeat(129))).toBeNull();
    expect(normalizeAgentDeclaration(" \u202e\u200b\n")).toBeNull();
  });

  test("invalid optional claims are wholly discarded from denials, traces and operational logs", async () => {
    const fix = await fixture();
    const { actor } = await newRun(fix);
    await acknowledge(fix, actor);
    const invalidClaims = [
      "api_to\u202eken = fixture-only-value",
      "password: fixture-only-value",
      "Authorization: Bearer fixture-only-value",
      "Basic dXNlcjpwYXNzd29yZA==",
      "api_to\u034fken=short-secret",
      "Ba\u0301sic dXNlcjpwYXNzd29yZA==",
      ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmaXh0dXJlIn0", "Zml4dHVyZS1zaWduYXR1cmU"].join("."),
      "x".repeat(64),
    ];
    for (const agentJustification of invalidClaims) {
      const outcome = await fix.host.dispatch(actor, "core.machines.list", {}, null, {
        agentJustification,
      });
      expect(outcome).toMatchObject({ ok: false, denial: { rule: "invalid_justification" } });
      const row = latestTrace(fix);
      expect(row.outcome).toBe("invalid_justification");
      expect(JSON.parse(row.payload)).toEqual({});
      const recorded = JSON.stringify({ outcome, logs: fix.logs });
      expect(recorded).not.toContain(agentJustification);
      expect(recorded).not.toContain("fixture-only-value");
    }
  });

  test("safe claims survive success and handler refusal without changing delegation authority", async () => {
    const fix = await fixture();
    const { created: parent, actor } = await newRun(fix);
    await acknowledge(fix, actor);
    const created = CreateRunCredentialResultSchema.parse(
      result(
        await fix.host.dispatch(actor, "core.access.createChildRun", {
          ...childArgs,
          runId: parent.run.id,
        }, null, {
          agentJustification: " \tDelegate\nread-only work.\u202e ",
        }),
      ),
    );
    expect(JSON.parse(latestTrace(fix).payload).agentDeclaration).toBe("Delegate read-only work.");
    expect(latestTrace(fix).principalId).toBe(actor.principal.id);
    const child = fix.auth.authenticate(created.credential.token);
    await acknowledge(fix, child);
    const renewal = await fix.host.dispatch(
      actor,
      "core.access.renewAgentRun",
      {
        runId: created.run.id,
      },
      null,
      { agentJustification: "Renew the child to finish its read-only task." },
    );
    // The child already expires with its parent; a declaration cannot extend that ceiling.
    expect(renewal).toMatchObject({ ok: false, denial: { rule: "refused" } });
    expect(latestTrace(fix).outcome).toBe("refused");
    expect(JSON.parse(latestTrace(fix).payload).agentDeclaration).toBe(
      "Renew the child to finish its read-only task.",
    );
    expect(
      (
        await fix.host.dispatch(
          fix.auth.authenticate(created.credential.token),
          "core.machines.list",
          {},
        )
      ).ok,
    ).toBe(true);
    const refused = await fix.host.dispatch(
      actor,
      "core.access.createChildRun",
      {
        ...childArgs,
        runId: parent.run.id,
        caps: ["terminals:write"],
      },
      null,
      { agentJustification: "Request broader authority for terminal work." },
    );
    expect(refused).toMatchObject({ ok: false, denial: { rule: "refused" } });
    expect(JSON.parse(latestTrace(fix).payload).agentDeclaration).toBe(
      "Request broader authority for terminal work.",
    );
    expect(fix.auth.allows(actor, "terminals:write")).toBe(false);
    expect((await fix.host.dispatch(actor, "core.machines.list", {})).ok).toBe(true);
    expect(JSON.parse(latestTrace(fix).payload).agentDeclaration).toBeUndefined();
  });

  test("policy, capability and argument rungs precede declaration validation", async () => {
    const fix = await fixture();
    const { actor } = await newRun(fix, { caps: ["containers:read"] });
    const invalid = { agentJustification: "token=fixture-only-value" };
    expect(
      await fix.host.dispatch(actor, "core.access.createChildRun", {}, null, invalid),
    ).toMatchObject({ ok: false, denial: { rule: "policy_required" } });
    await acknowledge(fix, actor);
    expect(
      await fix.host.dispatch(
        actor,
        "core.index.createContainer",
        { name: "forbidden" },
        null,
        invalid,
      ),
    ).toMatchObject({ ok: false, denial: { rule: "forbidden" } });
    expect(
      await fix.host.dispatch(actor, "core.access.createChildRun", {}, null, invalid),
    ).toMatchObject({ ok: false, denial: { rule: "invalid_args" } });
    expect(JSON.parse(latestTrace(fix).payload)).toEqual({});
    expect(JSON.stringify(fix.logs)).not.toContain("fixture-only-value");
  });

  test("raw argument claims cannot impersonate a declaration, even on a refused input", async () => {
    const fix = await fixture();
    const { actor } = await newRun(fix);
    await acknowledge(fix, actor);
    expect(
      await fix.host.dispatch(actor, "core.machines.list", {
        agentDeclaration: "invented caller claim",
      }),
    ).toMatchObject({ ok: false, denial: { rule: "invalid_args" } });
    expect(JSON.parse(latestTrace(fix).payload)).toEqual({});
    expect(
      await fix.host.dispatch(fix.owner, "core.machines.list", {
        agentDeclaration: "invented human claim",
      }),
    ).toMatchObject({ ok: false, denial: { rule: "invalid_args" } });
    expect(JSON.parse(latestTrace(fix).payload)).toEqual({});
  });

  test("opaque job refusals retain the safe declaration but never the job input", async () => {
    const fix = await fixture();
    const { actor } = await newRun(fix);
    await acknowledge(fix, actor);
    const outcome = await fix.host.dispatch(
      actor,
      "engine.jobs.execute",
      {
        jobId: "job-fixture",
        machineId: "machine-fixture",
        operationId: "run",
        pluginId: "test.job",
        input: { text: "private job input" },
        outputs: [],
      },
      null,
      { agentJustification: "Run the declared job for the sponsored task." },
    );
    expect(outcome).toMatchObject({ ok: false, denial: { rule: "refused" } });
    expect(JSON.parse(latestTrace(fix).payload)).toEqual({
      agentDeclaration: "Run the declared job for the sponsored task.",
    });
  });

  test("inspection stays reachable during policy suspension without accepting claims or granting actions", async () => {
    const fix = await fixture();
    const containerId = fix.runtime.newId();
    fix.store.createContainer({
      id: containerId,
      name: "scoped inspection",
      createdAt: fix.runtime.now(),
      discipline: "canvas",
    });
    const { created, actor } = await newRun(fix, {
      target: `manifold://container/${containerId}`,
      caps: ["containers:read"],
    });
    const options = { agentJustification: "Inspect this suspended run." };
    expect(
      await fix.host.dispatch(actor, "core.access.listRuns", {}, null, options),
    ).toMatchObject({
      ok: true,
      result: { runs: [{ id: created.run.id, state: "pending_policy" }] },
    });
    expect(JSON.parse(latestTrace(fix).payload).agentDeclaration).toBeUndefined();
    expect(
      await fix.host.dispatch(actor, "core.index.readContainer", { containerId }),
    ).toMatchObject({ ok: false, denial: { rule: "policy_required" } });
    await acknowledge(fix, actor);
    expect(await fix.host.dispatch(actor, "engine.jobs.execute", {})).toMatchObject({
      ok: false,
      denial: { rule: "forbidden" },
    });
    fix.store.updateAgentRunPolicy(created.run.id, "0".repeat(64), "policy_stale");
    expect(
      await fix.host.dispatch(actor, "core.access.listRuns", {}, null, options),
    ).toMatchObject({
      ok: true,
      result: { runs: [{ id: created.run.id, state: "policy_stale" }] },
    });
    expect(JSON.parse(latestTrace(fix).payload).agentDeclaration).toBeUndefined();
    expect(
      await fix.host.dispatch(actor, "core.index.readContainer", { containerId }),
    ).toMatchObject({ ok: false, denial: { rule: "policy_stale" } });
  });

  test("human and legacy agent credentials never acquire claims from supplied options", async () => {
    const fix = await fixture();
    const options = { agentJustification: "token=fixture-only-value" };
    const registeredRun = createExternalRun(fix, {
      name: "human-created run",
      purpose: "Keep human claims separate from run declarations.",
      target: "manifold://",
      reach: "subtree",
      caps: ["containers:read"],
    });
    const created = await fix.host.dispatch(
      fix.owner,
      "core.access.createRun",
      { agentId: registeredRun.run.agentId },
      null,
      options,
    );
    expect(created.ok).toBe(true);
    expect(JSON.parse(latestTrace(fix).payload).agentDeclaration).toBeUndefined();
    const containerId = fix.runtime.newId();
    fix.store.createContainer({
      id: containerId,
      name: "shared",
      createdAt: fix.runtime.now(),
      discipline: "canvas",
    });
    const share = fix.auth.mintShare(
      {
        node: { kind: "container", containerId },
        caps: ["containers:read"],
        origin: "https://guest.example",
      },
      fix.owner,
    );
    const ticket = fix.auth.mintShareTicket(fix.auth.authenticateShare(share.token), {
      id: "legacy-agent",
      kind: "agent",
      name: "legacy automation",
      color: "#abcdef",
    });
    const legacy = fix.auth.authenticate(ticket.token);
    expect(legacy.agentRunId).toBeUndefined();
    expect(
      await fix.host.dispatch(legacy, "core.index.readContainer", { containerId }, null, options),
    ).toMatchObject({ ok: true });
    expect(JSON.parse(latestTrace(fix).payload).agentDeclaration).toBeUndefined();
  });
});
