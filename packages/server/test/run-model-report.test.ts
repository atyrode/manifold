import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  AGENT_RUN_MAX_LIFETIME_MS,
  AgentPolicyChallengeSchema,
  InspectRunV2ResultSchema,
  ListRunsV2ResultSchema,
  ReportRunActivityV2ResultSchema,
  type ActionOutcome,
  type AgentRunAuthority,
  type RunModel,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import type { ActionCtx, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

const OWNER_KEY = "m".repeat(64);
const REPORT = "core.access.reportRunActivityV2";
const LAUNCH: RunModel = { provider: "fixture", model: "launch" };
const SERVED: RunModel = { provider: "fixture", model: "served" };
const SWITCHED: RunModel = { provider: "fixture", model: "switched" };
const UNSERVED: RunModel = { provider: "fixture", model: "unserved" };

type Resolve = (
  ctx: ActionCtx,
  run: AgentRunAuthority,
  model: RunModel,
) => Promise<RunModel | null>;

/** A harness plugin whose sessions are never launched here; only model resolution is exercised. */
function harnessPlugin(id: string, harnessId: string, resolveModel?: Resolve): ServerPluginDef {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title: "Model harness",
      description: "Run model resolution fixture",
      capabilities: [],
      contributes: {
        panels: [],
        sections: [],
        elements: [],
        tools: [],
        events: [],
        harness: {
          id: harnessId,
          title: "Model harness",
          profileSchema: { type: "object" },
          sessionRef: "typed",
        },
      },
    },
    actions: [],
    handlers: {},
    harness: {
      profileSchema: z.object({}),
      async launch() {
        throw new Error("not exercised");
      },
      async sessions() {
        return [];
      },
      async resolveSession() {
        return null;
      },
      async send() {
        throw new Error("not exercised");
      },
      ...(resolveModel === undefined ? {} : { resolveModel }),
    },
  };
}

async function fixture() {
  const runtime = new FakeRuntime();
  runtime.time = 1_000;
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
  const calls: { runId: string; principalId: string; model: RunModel }[] = [];
  const serves: Resolve = async (_ctx, _run, model) => (model.model === "unserved" ? null : model);
  let answer = serves;
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    settingsPlugins: [
      harnessPlugin("test.model-harness", "model-harness", (ctx, run, model) => {
        calls.push({ runId: run.id, principalId: ctx.principal.id, model });
        return answer(ctx, run, model);
      }),
      harnessPlugin("test.silent-harness", "silent-harness"),
    ],
  });
  const owner = auth.authenticate(OWNER_KEY);
  const register = async (harness: string) => {
    const registered = await auth.registerAgentV2(
      {
        name: `${harness} agent`,
        purpose: "Report the model its harness session serves.",
        harness,
        context: { profile: {} },
        grant: {
          scope: [{ target: "manifold://", reach: "subtree", caps: ["containers:read"] }],
          maxRunLifetimeMs: 120_000,
          delegation: { maxDepth: 0, maxDescendants: 0 },
          expiresAt: runtime.now() + AGENT_RUN_MAX_LIFETIME_MS,
        },
      },
      owner,
    );
    if (registered.credential === undefined) throw new Error("fixture Agent must be new");
    const runner = auth.authenticate(registered.credential.token);
    const admit = () => {
      const created = auth.createRunV2(
        { agentId: registered.agent.agentId, lifetimeMs: 60_000, model: LAUNCH },
        runner,
      );
      if (created.credential === undefined) throw new Error("runner admission returned no bearer");
      return { run: created.run, actor: auth.authenticate(created.credential.token) };
    };
    return { agentId: registered.agent.agentId, runner, admit };
  };
  return {
    runtime,
    store,
    auth,
    host,
    owner,
    calls,
    register,
    answerWith(next: Resolve) {
      answer = next;
    },
    report(actor: AuthContext, input: Record<string, unknown>) {
      return host.dispatch(actor, REPORT, input);
    },
  };
}

function value(outcome: ActionOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected result, got ${outcome.denial.rule}`);
  return outcome.result;
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected denial");
  return outcome.denial;
}

describe("a harness-reported Run model", () => {
  test("the Run's harness resolves it before inspection shows it, while the Run stays pending", async () => {
    const fix = await fixture();
    const { agentId, runner, admit } = await fix.register("model-harness");
    const pending = admit();
    expect(pending.run).toMatchObject({ state: "pending_policy", model: LAUNCH });

    const reported = ReportRunActivityV2ResultSchema.parse(
      value(
        await fix.report(pending.actor, {
          runId: pending.run.id,
          activity: "working",
          model: SERVED,
        }),
      ),
    );
    expect(reported.run).toMatchObject({
      state: "pending_policy",
      activity: "working",
      model: SERVED,
    });
    expect(fix.calls).toEqual([
      { runId: pending.run.id, principalId: pending.actor.principal.id, model: SERVED },
    ]);
    const inspection = InspectRunV2ResultSchema.parse(
      value(
        await fix.host.dispatch(fix.owner, "core.access.inspectRunV2", { runId: pending.run.id }),
      ),
    );
    expect(inspection.run).toMatchObject({ activity: "working", model: SERVED });
    const inventory = ListRunsV2ResultSchema.parse(
      value(await fix.host.dispatch(fix.owner, "core.access.listRunsV2", { agentId })),
    );
    expect(inventory.runs.find((run) => run.id === pending.run.id)?.model).toEqual(SERVED);

    // Its Agent runner reports for it as for activity; the harness answers on the Run's behalf.
    expect(
      value(await fix.report(runner, { runId: pending.run.id, activity: "idle", model: SWITCHED })),
    ).toMatchObject({ run: { activity: "idle", model: SWITCHED } });
    expect(fix.calls.map((call) => [call.runId, call.model])).toEqual([
      [pending.run.id, SERVED],
      [pending.run.id, SWITCHED],
    ]);
    // Activity alone never asks the harness and keeps the reported model.
    expect(
      value(await fix.report(pending.actor, { runId: pending.run.id, activity: "done" })),
    ).toMatchObject({ run: { activity: "done", model: SWITCHED } });
    expect(fix.calls).toHaveLength(2);
    expect(fix.store.getAgentRun(pending.run.id)).toMatchObject({
      state: "pending_policy",
      activity: "done",
      model: SWITCHED,
    });
    fix.store.close();
  });

  test("an unserved, substituted or effectful answer, or one outliving its Run, changes nothing", async () => {
    const fix = await fixture();
    const { admit } = await fix.register("model-harness");
    const pending = admit();
    const unchanged = () =>
      expect(fix.store.getAgentRun(pending.run.id)).toMatchObject({
        activity: "unknown",
        model: LAUNCH,
      });

    expect(
      denial(
        await fix.report(pending.actor, {
          runId: pending.run.id,
          activity: "working",
          model: UNSERVED,
        }),
      ),
    ).toEqual({ rule: "refused", message: "run_model_unavailable" });
    unchanged();

    fix.answerWith(async () => SERVED);
    expect(
      denial(
        await fix.report(pending.actor, {
          runId: pending.run.id,
          activity: "working",
          model: SWITCHED,
        }),
      ),
    ).toEqual({ rule: "refused", message: "harness model reference mismatch" });
    unchanged();

    fix.answerWith(async (ctx, _run, model) => {
      ctx.emit({ kind: "plugin", pluginId: ctx.pluginId }, "model_changed", {});
      return model;
    });
    expect(
      denial(
        await fix.report(pending.actor, {
          runId: pending.run.id,
          activity: "working",
          model: SERVED,
        }),
      ),
    ).toEqual({ rule: "refused", message: "harness model resolution is read-only" });
    unchanged();

    // Expiry while the harness answers: the dispatch's live authority fence refuses the answer
    // before the identity mechanism records anything.
    fix.answerWith(async (_ctx, _run, model) => {
      fix.runtime.time = pending.run.expiresAt;
      return model;
    });
    expect(
      denial(
        await fix.report(pending.actor, {
          runId: pending.run.id,
          activity: "working",
          model: SERVED,
        }),
      ),
    ).toEqual({ rule: "refused", message: "caller authority unavailable" });
    unchanged();
    fix.store.close();
  });

  test("no other caller, unresolving harness or V1 door can set it, and none reaches harness code", async () => {
    const fix = await fixture();
    const { admit } = await fix.register("model-harness");
    const pending = admit();
    const sibling = admit();
    for (const actor of [sibling.actor, fix.owner]) {
      expect(
        denial(
          await fix.report(actor, { runId: pending.run.id, activity: "working", model: SERVED }),
        ),
      ).toEqual({ rule: "refused", message: "harness_credential_required" });
    }
    expect(fix.calls).toEqual([]);

    for (const harness of ["silent-harness", "external"]) {
      const other = (await fix.register(harness)).admit();
      expect(
        denial(
          await fix.report(other.actor, {
            runId: other.run.id,
            activity: "working",
            model: SERVED,
          }),
        ),
      ).toEqual({ rule: "refused", message: "run_model_unverifiable" });
      expect(fix.store.getAgentRun(other.run.id)).toMatchObject({
        activity: "unknown",
        model: LAUNCH,
      });
    }

    // The V1 door predates the field, so its strict input refuses it after acknowledgement.
    const challenge = AgentPolicyChallengeSchema.parse(
      value(await fix.host.dispatch(pending.actor, "core.access.getAgentPolicy", {})),
    );
    value(
      await fix.host.dispatch(pending.actor, "core.access.acknowledgeAgentPolicyV2", {
        revision: challenge.revision,
        acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
      }),
    );
    expect(
      denial(
        await fix.host.dispatch(pending.actor, "core.access.reportRunActivity", {
          runId: pending.run.id,
          activity: "working",
          model: SERVED,
        }),
      ).rule,
    ).toBe("invalid_args");

    fix.runtime.time = pending.run.expiresAt;
    expect(
      denial(
        await fix.report(pending.actor, {
          runId: pending.run.id,
          activity: "working",
          model: SERVED,
        }),
      ),
    ).toEqual({ rule: "forbidden", message: "agent run expired" });
    expect(fix.calls).toEqual([]);
    expect(fix.store.getAgentRun(pending.run.id)).toMatchObject({ model: LAUNCH });
    fix.store.close();
  });
});
