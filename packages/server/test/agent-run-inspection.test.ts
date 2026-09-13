import { describe, expect, test } from "bun:test";
import {
  AgentRunInspectionSchema,
  CreateAgentRunRequestSchema,
  AgentRunInventorySchema,
  type ActionOutcome,
  type CreateAgentRunResult,
} from "@manifold/protocol";
import { AuthService, ServiceError, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { RoomManager } from "../src/room.ts";
import { sha256Hex } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

async function fixture() {
  const runtime = new FakeRuntime();
  const store = testStore();
  const auth = new AuthService(store, "i".repeat(64), runtime);
  const clock = new FakeClock(runtime);
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(store, auth, rooms, runtime, clock, silentLogger,
    () => "http://localhost:7777", testTileTrees);
  const host = await testPluginHost(store, auth, rooms, broker, runtime);
  const owner = auth.authenticate("i".repeat(64));
  const sponsor = () => {
    const minted = auth.mintToken({ principal: { name: "sponsor", kind: "human" },
      caps: ["agents:delegate", "containers:read"] }, owner);
    return auth.authenticate(minted.token);
  };
  const run = (actor: AuthContext, name: string): { created: CreateAgentRunResult; actor: AuthContext } => {
    const created = auth.createAgentRun(CreateAgentRunRequestSchema.parse({
      name, purpose: "Read the sponsored workspace", target: "manifold://", reach: "subtree",
      caps: ["agents:delegate", "containers:read"], lifetimeMs: 60_000,
    }), actor);
    const context = auth.authenticate(created.credential.token);
    const challenge = auth.agentPolicyChallenge(context);
    auth.acknowledgeAgentPolicy({ revision: challenge.revision,
      acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })) }, context);
    return { created, actor: context };
  };
  return { runtime, store, auth, host, owner, sponsor, run };
}
function result(outcome: ActionOutcome): unknown {
  if (!outcome.ok) throw new Error(`unexpected refusal: ${outcome.denial.rule}`);
  return outcome.result;
}
function denied(outcome: ActionOutcome) {
  if (outcome.ok) throw new Error("expected inspection refusal");
  return outcome.denial;
}

describe("agent run inspection", () => {
  test("self chain, durable sponsors and root are exact; siblings and missing runs are indistinguishable", async () => {
    const f = await fixture();
    try {
      const sponsor = f.sponsor();
      const otherSponsor = f.sponsor();
      const parent = f.run(sponsor, "password=short-secret");
      const child = f.run(parent.actor, "child");
      const sibling = f.run(parent.actor, "sibling");
      const other = f.run(otherSponsor, "other");
      f.store.db.query("UPDATE agent_runs SET purpose=? WHERE id=?")
        .run("Basic dXNlcjpwYXNzd29yZA==", parent.created.run.id);
      const inspect = (actor: AuthContext, runId: string) =>
        f.host.dispatch(actor, "core.access.inspectAgentRun", { runId });
      for (const actor of [f.owner, sponsor, parent.actor, child.actor]) {
        const projection = AgentRunInspectionSchema.parse(result(await inspect(actor, child.created.run.id)));
        expect(projection.run.id).toBe(child.created.run.id);
      }
      const ancestor = AgentRunInspectionSchema.parse(result(await inspect(child.actor, parent.created.run.id)));
      expect(ancestor.lineage.map((entry) => entry.id)).toEqual([parent.created.run.id, child.created.run.id]);
      const invisible = denied(await inspect(child.actor, sibling.created.run.id));
      expect(denied(await inspect(child.actor, "no-such-run"))).toEqual(invisible);
      expect(denied(await inspect(otherSponsor, child.created.run.id))).toEqual(invisible);
      expect(denied(await inspect(sponsor, other.created.run.id))).toEqual(invisible);
      expect(denied(await f.host.dispatch(child.actor, "core.events.list", {})).rule).toBe("forbidden");
      const listed = AgentRunInventorySchema.parse(result(await f.host.dispatch(child.actor, "core.access.listAgentRuns", {})));
      expect(listed.runs.map((entry) => entry.principalId).sort()).toEqual(
        [parent.actor.principal.id, child.actor.principal.id].sort(),
      );
      const sponsored = AgentRunInventorySchema.parse(result(await f.host.dispatch(sponsor, "core.access.listAgentRuns", {})));
      expect(sponsored.runs.map((entry) => entry.principalId).sort())
        .toEqual([parent.actor.principal.id, child.actor.principal.id, sibling.actor.principal.id].sort());
      for (const inventory of [listed, sponsored]) {
        expect(inventory.runs.find((entry) => entry.id === parent.created.run.id)?.name).toBe("[redacted]");
        expect(inventory.runs.find((entry) => entry.id === parent.created.run.id)?.purpose).toBe("[redacted]");
        expect(JSON.stringify(inventory)).not.toContain("dXNlcjpwYXNzd29yZA==");
        expect(JSON.stringify(inventory)).not.toContain("short-secret");
        expect(JSON.stringify(inventory)).not.toContain(parent.actor.tokenId!);
        expect(JSON.stringify(inventory)).not.toContain(parent.created.credential.token);
      }
      expect(denied(await f.host.dispatch(child.actor, "core.access.listCredentials", {})).rule).toBe("forbidden");
      expect(denied(await f.host.dispatch(sponsor, "core.access.listCredentials", {})).rule).toBe("forbidden");
      expect(f.auth.listCredentials(f.owner).find((entry) => entry.principal.id === parent.actor.principal.id)?.sessions[0]?.id)
        .toBe(parent.actor.tokenId);
      // A coincidentally shared root id is not a sponsorship edge.
      f.store.db.query("UPDATE agent_runs SET authorized_by_principal_id=? WHERE id=?")
        .run(otherSponsor.principal.id, child.created.run.id);
      expect(denied(await inspect(sponsor, child.created.run.id))).toEqual(invisible);
    } finally { f.store.close(); }
  });

  test("credential inventory rechecks expired and revoked request-time authority", async () => {
    const f = await fixture();
    try {
      const sponsor = f.sponsor();
      const run = f.run(sponsor, "sponsored");
      const rootToken = f.auth.mintToken({
        principal: { name: "revocable root", kind: "human" }, caps: ["*"],
      }, f.owner);
      const adminToken = f.auth.mintToken({
        principal: { name: "credential administrator", kind: "human" }, caps: ["tokens:mint"],
      }, f.owner);
      const root = f.auth.authenticate(rootToken.token);
      const admin = f.auth.authenticate(adminToken.token);
      // Keep the contexts issued before withdrawal, as HTTP does while awaiting its body.
      for (const [actor, visible] of [
        [root, run.actor.principal.id],
        [admin, admin.principal.id],
      ] as const) {
        expect(f.auth.listCredentials(actor).map((entry) => entry.principal.id)).toContain(visible);
        f.auth.revokePrincipal(actor.principal.id, f.owner);
        expect(() => f.auth.listCredentials(actor)).toThrow(ServiceError);
        expect(await f.host.dispatch(actor, "core.access.listCredentials", {}))
          .toMatchObject({ ok: false });
      }
      expect(f.auth.listAgentRuns(sponsor).runs.map((entry) => entry.principalId)).toContain(run.actor.principal.id);
      f.auth.revokePrincipal(sponsor.principal.id, f.owner);
      expect(() => f.auth.listAgentRuns(sponsor)).toThrow(ServiceError);
      expect(await f.host.dispatch(sponsor, "core.access.listAgentRuns", {}))
        .toMatchObject({ ok: false, denial: { rule: "refused" } });
      const expiring = f.run(f.owner, "expires during request");
      expect(f.auth.listAgentRuns(expiring.actor).runs.map((entry) => entry.principalId))
        .toEqual([expiring.actor.principal.id]);
      f.runtime.time = expiring.created.run.expiresAt;
      expect(() => f.auth.listAgentRuns(expiring.actor)).toThrow(ServiceError);
      expect(f.auth.listCredentials(f.owner).map((entry) => entry.principal.id))
        .toContain(expiring.actor.principal.id);
    } finally { f.store.close(); }
  });

  test("run discovery bounds authorized summaries rather than truncating to unrelated roots", async () => {
    const f = await fixture();
    try {
      const own = f.run(f.sponsor(), "old authorized run");
      const expected: string[] = [own.created.run.id];
      for (let index = 0; index < 100; index++) {
        f.runtime.time++;
        expected.push(f.run(f.owner, `new root ${String(index)}`).created.run.id);
      }
      const bounded = AgentRunInventorySchema.parse(result(await f.host.dispatch(f.owner, "core.access.listAgentRuns", {})));
      expect(bounded.runs.map((entry) => entry.id)).toEqual(expected.reverse().slice(0, 100));
      expect(bounded.truncated).toBe(true);
      const self = AgentRunInventorySchema.parse(result(await f.host.dispatch(own.actor, "core.access.listAgentRuns", {})));
      expect(self.runs.map((entry) => entry.id)).toEqual([own.created.run.id]);
      expect(self.truncated).toBe(false);
    } finally { f.store.close(); }
  });

  test("projects only retained facts and trusted declarations, with exact trace pagination and native links", async () => {
    const f = await fixture();
    try {
      const run = f.run(f.owner, "run");
      const foreign = f.run(f.owner, "foreign");
      const first = f.store.appendTrace({ ts: f.runtime.now(), actor: run.actor.principal.id,
        authority: "containers:read", door: "core.index.list", containerId: null,
        payload: { args: "SENSITIVE_RAW_ARGS", environment: "SENSITIVE_ENVIRONMENT", data: "SENSITIVE_TERMINAL_BYTES",
          output: "SENSITIVE_RETAINED_OUTPUT", token: run.created.credential.token,
          agentDeclaration: "Read only the approved target" },
        session: "closed-connection", outcome: "ok", targets: ["manifold://"] });
      const second = f.store.appendTrace({ ts: f.runtime.now(), actor: run.actor.principal.id,
        authority: "containers:write", door: "core.index.createContainer", containerId: null,
        payload: {}, session: "live-connection", outcome: "forbidden", targets: [] });
      const pending = f.store.appendTrace({ ts: f.runtime.now(), actor: run.actor.principal.id,
        authority: "open", door: "engine.jobs.execute", containerId: null,
        payload: {}, session: null, outcome: null, targets: [] });
      const foreignTrace = f.store.appendTrace({ ts: f.runtime.now(), actor: foreign.actor.principal.id,
        authority: "open", door: "core.index.list", containerId: null,
        payload: {}, session: null, outcome: "ok", targets: [] });
      f.auth.setRunConnectionReader((principalId) => principalId === run.actor.principal.id ? ["live-connection"] : []);
      f.store.db.query(`INSERT INTO machine_jobs(job_id,machine_id,plugin_id,digest,request,state,created_at,result,owner_closed)
        VALUES(?,?,?,?,?,?,?,?,?)`).run("native-job", "machine", "test.plugin", "SENSITIVE_REQUEST_DIGEST", JSON.stringify({
          operationId: "read", installationRevision: "revision-1", artifactSha256: "a".repeat(64),
          credential: { principalId: run.actor.principal.id, tokenId: "SENSITIVE_TOKEN_ID", hash: sha256Hex(run.created.credential.token) },
          input: { secret: "SENSITIVE_NATIVE_INPUT" }, outputs: [{ path: "SENSITIVE_OUTPUT_PATH" }],
          traceId: String(pending), parent: null, terminal: { terminalId: "native-terminal" },
        }), "started", f.runtime.now(), JSON.stringify({ startedAt: f.runtime.now(), finishedAt: null, exitCode: null,
          outputs: [{ content: "SENSITIVE_RETAINED_OUTPUT" }] }), 0);
      f.store.createContainer({ id: "container", name: "bounded", createdAt: f.runtime.now(), discipline: "canvas" });
      f.store.createTerminal({ id: "native-terminal", machineId: "machine", containerId: "container",
        createdBy: run.actor.principal.id, agentPrincipalId: null, createdAt: f.runtime.now() });
      f.store.db.query("UPDATE agent_runs SET purpose=?,task_ref=?,cleanup_failure=? WHERE id=?")
        .run("token=DO_NOT_REVEAL", "Bearer DO_NOT_REVEAL", "SENSITIVE_CLEANUP_ERROR", run.created.run.id);
      const inspect = async (extra: Record<string, unknown> = {}) => AgentRunInspectionSchema.parse(result(
        await f.host.dispatch(f.owner, "core.access.inspectAgentRun", { runId: run.created.run.id, ...extra }),
      ));
      const page = await inspect({ limit: 2 });
      expect(page.traces.map((entry) => entry.traceId)).toEqual([String(pending), String(second)]);
      expect(page.traces[0]?.settlement).toBe("pending_or_crashed");
      expect(page.traces[1]?.outcome).toBe("forbidden");
      const previous = await inspect({ beforeTraceId: page.nextBeforeTraceId, limit: 2 });
      expect(previous.traces[0]?.traceId).toBe(String(first));
      const exact = await inspect({ traceId: String(first) });
      expect(exact.traces[0]?.agentDeclaration).toBe("Read only the approved target");
      expect(exact.connections).toEqual([
        { connectionId: "live-connection", state: "live", firstObservedAt: f.runtime.now(), lastObservedAt: f.runtime.now() },
        { connectionId: "closed-connection", state: "closed_or_unavailable", firstObservedAt: f.runtime.now(), lastObservedAt: f.runtime.now() },
      ]);
      expect(exact.jobs[0]).toMatchObject({ jobId: "native-job", traceId: String(pending), origin: "retained", ownerState: "unconfirmed" });
      expect(exact.terminals[0]).toMatchObject({ terminalId: "native-terminal", state: "running", retention: "retained" });
      const missing = await inspect({ traceId: "9999999" });
      const notYours = await inspect({ traceId: String(foreignTrace) });
      expect(notYours.traces).toEqual(missing.traces);
      expect(notYours.requestedTrace).toBe(missing.requestedTrace);
      const wire = JSON.stringify(exact);
      for (const sensitive of ["SENSITIVE_", "DO_NOT_REVEAL", run.created.credential.token, sha256Hex(run.created.credential.token)]) {
        expect(wire.includes(sensitive)).toBe(false);
      }
      expect(exact.run.purpose).toBe("[redacted]");
      f.store.db.query("DELETE FROM events WHERE id=?").run(pending);
      expect((await inspect()).jobs[0]?.origin).toBe("unavailable");
      expect((await inspect({ traceId: String(pending) })).requestedTrace).toBe("unavailable");
      // An occurrence may be refused before a machine_jobs row ever exists.
      const scheduledJobId = `schedule-${sha256Hex("schedule-occurrence-fixture")}`;
      f.store.db.query(`INSERT INTO job_schedule_occurrences(
        schedule_id,revision,nominal,job_id,request,deadline,state,reason) VALUES(?,?,?,?,?,?,?,?)`)
        .run("schedule", "revision-1", f.runtime.now(), scheduledJobId, JSON.stringify({
          jobId: scheduledJobId, machineId: "machine", pluginId: "test.plugin", operationId: "read",
          installationRevision: "revision-1", artifactSha256: "a".repeat(64),
          credential: { principalId: run.actor.principal.id }, traceId: String(first),
          input: { secret: "SENSITIVE_SCHEDULE_INPUT" },
        }), f.runtime.now() + 60_000, "skipped", "SENSITIVE_SCHEDULE_REASON");
      f.store.db.query("UPDATE agent_runs SET purpose=? WHERE id=?").run(scheduledJobId, run.created.run.id);
      const scheduled = await inspect();
      expect(scheduled.jobs.find((job) => job.jobId === scheduledJobId))
        .toMatchObject({ state: "skipped", traceId: String(first), origin: "retained", startedAt: null, finishedAt: null });
      expect(JSON.stringify(scheduled)).not.toContain("SENSITIVE_SCHEDULE");
      expect(scheduled.run.purpose).toBe("[redacted]");
      // Human-authored labels remain untrusted even when adjacent mechanical ids are safe.
      f.store.db.query("UPDATE agent_runs SET purpose=?,task_ref=? WHERE id=?")
        .run("Basic dXNlcjpwYXNzd29yZA==", "api_to\u034fken=short-secret", run.created.run.id);
      const redacted = await inspect();
      expect(redacted.run.purpose).toBe("[redacted]");
      expect(redacted.run.taskRef).toBe("[redacted]");
      expect(JSON.stringify(redacted)).not.toContain("dXNlcjpwYXNzd29yZA==");
      expect(JSON.stringify(redacted)).not.toContain("short-secret");
    } finally { f.store.close(); }
  });

  test("pending policy, cleanup failures, revocation, expiry and unavailable legacy origins remain distinct", async () => {
    const f = await fixture();
    try {
      const created = f.auth.createAgentRun(CreateAgentRunRequestSchema.parse({ name: "pending", purpose: "Wait for policy",
        target: "manifold://", reach: "subtree", caps: ["containers:read"], lifetimeMs: 60_000 }), f.owner);
      const pending = f.auth.authenticate(created.credential.token);
      const own = AgentRunInspectionSchema.parse(result(await f.host.dispatch(pending, "core.access.inspectAgentRun", { runId: created.run.id })));
      expect(own.run.state).toBe("pending_policy");
      expect(own.run.cleanup.status).toBe("pending");
      f.store.settleAgentRun(created.run.id, "cleanup_failed", f.runtime.now(), 0, 0, "SENSITIVE_CLEANUP_DETAIL");
      const failed = AgentRunInspectionSchema.parse(result(await f.host.dispatch(f.owner, "core.access.inspectAgentRun", { runId: created.run.id })));
      expect(failed.run.cleanup.status).toBe("failed");
      expect(JSON.stringify(failed)).not.toContain("SENSITIVE_CLEANUP_DETAIL");
      const expired = f.run(f.owner, "expires");
      f.runtime.time += 60_001;
      const expiredProjection = AgentRunInspectionSchema.parse(result(await f.host.dispatch(f.owner, "core.access.inspectAgentRun", { runId: expired.created.run.id })));
      expect(expiredProjection.run.state).toBe("expired");
      expect(expiredProjection.credentials[0]?.state).toBe("expired");
      const live = f.run(f.owner, "revoked");
      f.auth.finishAgentRun({ runId: live.created.run.id, outcome: "completed" }, f.owner);
      const closed = AgentRunInspectionSchema.parse(result(await f.host.dispatch(f.owner, "core.access.inspectAgentRun", { runId: live.created.run.id })));
      expect(closed.run.cleanup.status).toBe("finished");
      expect(closed.credentials[0]?.state).toBe("revoked");
      const legacy = { id: f.runtime.newId(), name: "native lifecycle", kind: "agent" as const, color: "#91a7ff" };
      f.store.createPrincipal(legacy, f.runtime.now());
      expect(result(await f.host.dispatch(f.owner, "core.access.inspectAgentRun", { principalId: legacy.id })))
        .toEqual({ availability: "origin_unavailable", principalId: legacy.id });
    } finally { f.store.close(); }
  });
});
