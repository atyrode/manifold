import { describe, expect, test } from "bun:test";
import {
  ACTION_TRACE_ID_HEADER,
  ActionRunnerRequestSchema,
  ActionRunnerResponseSchema,
  CreateChildRunRequestSchema,
  CreateRunRequestSchema,
  FinishAgentRunRequestSchema,
  ReportRunActivityRequestSchema,
  PROTOCOL_VERSION,
  type AgentRun,
  type ActionRunnerResponse,
} from "@manifold/protocol";
import { ActionRunner } from "../src/action-runner.ts";
import { readActionRunnerEnvironment, runActionStdio } from "../src/action-runner-main.ts";

const credential = "a".repeat(64);

describe("launcher-only runner binding", () => {
  test("Agent bind consumes the scoped credential and typed context before untrusted input", async () => {
    const environment: Record<string, string | undefined> = {
      MANIFOLD_ORIGIN: "https://hub.example",
      MANIFOLD_RUNNER_TOKEN: credential,
      MANIFOLD_AGENT_ID: "agent-babel",
      MANIFOLD_AGENT_SESSION: JSON.stringify({
        harness: "external",
        sessionId: "analysis",
        machineId: "worker",
      }),
      MANIFOLD_AGENT_MODEL: JSON.stringify({ provider: "provider", model: "model" }),
      PATH: "/bin",
    };
    const configuration = readActionRunnerEnvironment(environment);
    expect(configuration.bind).toEqual({
      agentId: "agent-babel",
      session: { harness: "external", sessionId: "analysis", machineId: "worker" },
      model: { provider: "provider", model: "model" },
    });
    expect(environment).toEqual({ PATH: "/bin" });
    const runner = new ActionRunner({ ...configuration, emit: () => {} });
    await expect(
      runner.accept({ type: "start", id: "model", version: 1, declaration: {} }),
    ).rejects.toMatchObject({ code: "invalid_frame" });
  });

  test("Run bind adopts only the launcher-selected run and withdraws both run carriers", () => {
    const environment: Record<string, string | undefined> = {
      MANIFOLD_ORIGIN: "https://hub.example",
      MANIFOLD_RUN_TOKEN: credential,
      MANIFOLD_RUN_ID: "run-omp",
      MANIFOLD_ACTIVITY_FD: "3",
    };
    const configuration = readActionRunnerEnvironment(environment);
    expect(configuration.bind).toEqual({ runId: "run-omp" });
    expect(configuration.activityFd).toBe(3);
    expect(environment).toEqual({});
  });

  test("ambiguous or obsolete credentials fail closed but are still withdrawn", () => {
    for (const extra of [
      { MANIFOLD_RUN_TOKEN: credential, MANIFOLD_RUN_ID: "other-run" },
      { MANIFOLD_SPONSOR_TOKEN: credential },
    ]) {
      const environment: Record<string, string | undefined> = {
        MANIFOLD_ORIGIN: "https://hub.example",
        MANIFOLD_RUNNER_TOKEN: credential,
        MANIFOLD_AGENT_ID: "agent-babel",
        ...extra,
      };
      expect(() => readActionRunnerEnvironment(environment)).toThrow();
      expect(environment).toEqual({});
    }
  });

  test("models cannot manufacture bind, start, activity, or child session authority", () => {
    for (const frame of [
      { type: "start", id: "start", version: 1, declaration: {} },
      { type: "bind", id: "bind", agentId: "other" },
      { type: "activity", id: "activity", runId: "run", activity: "done" },
      {
        type: "child",
        id: "child",
        runId: "run",
        declaration: {
          session: { harness: "atyrode.omp", sessionId: "forged", machineId: "worker" },
        },
      },
    ])
      expect(ActionRunnerRequestSchema.safeParse(frame).success).toBe(false);
  });

  test("the activity carrier cannot alias model input or an output pipe", () => {
    for (const descriptor of ["0", "1", "2", "3junk", "-1"]) {
      const environment: Record<string, string | undefined> = {
        MANIFOLD_ORIGIN: "https://hub.example",
        MANIFOLD_RUN_TOKEN: credential,
        MANIFOLD_RUN_ID: "run",
        MANIFOLD_ACTIVITY_FD: descriptor,
      };
      expect(() => readActionRunnerEnvironment(environment)).toThrow();
      expect(environment).toEqual({});
    }
  });
});

test("trusted pipes admit before input, keep children on the Agent, and report activity without model authority", async () => {
  const runs: AgentRun[] = [];
  const bearers = new Map<string, AgentRun>();
  const policyBody = "Read-only smoke policy.";
  const digest = new Bun.CryptoHasher("sha256").update(policyBody).digest("hex");
  let traceId = 0;
  const activities: string[] = [];
  const doors = [
    "createRun",
    "createChildRun",
    "inspectRun",
    "reportRunActivity",
    "getAgentPolicy",
    "acknowledgeAgentPolicy",
    "renewAgentRun",
    "finishAgentRun",
  ];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/api/protocol")
        return Response.json({
          protocolVersion: PROTOCOL_VERSION,
          actions: doors.map((name) => ({
            name: `core.access.${name}`,
            title: name,
            caps: [],
            scope: "workspace",
            input: { type: "object" },
            result: { type: "object" },
          })),
        });
      const door = new URL(request.url).pathname.split(".").at(-1);
      const input: unknown = await request.json();
      const caller = bearers.get(request.headers.get("authorization") ?? "");
      let result: unknown;
      if (door === "createRun" || door === "createChildRun") {
        const declaration =
          door === "createRun"
            ? CreateRunRequestSchema.parse(input)
            : CreateChildRunRequestSchema.parse(input);
        const parent =
          "runId" in declaration ? runs.find((run) => run.id === declaration.runId) : undefined;
        const id = `run-${runs.length + 1}`;
        const run: AgentRun = {
          id,
          agentId: parent?.agentId ?? declaration.agentId!,
          session: null,
          activity: "unknown",
          principal: { id: "principal", name: "reader", kind: "agent", color: "#123456" },
          rootRunId: parent?.rootRunId ?? id,
          parentRunId: parent?.id ?? null,
          authorizedByPrincipalId: "sponsor",
          authorizationPath: "principal",
          authorizationCredential: { tokenId: null, grantId: null, caps: [], containerScope: null },
          purpose: "Read approved data",
          target: "manifold://",
          reach: "subtree",
          caps: ["containers:read"],
          createdAt: 1,
          expiresAt: 120_001,
          renewals: 0,
          maxDepth: 4,
          maxDescendants: 32,
          depth: parent === undefined ? 0 : 1,
          cleanupOwnerPrincipalId: "sponsor",
          state: "pending_policy",
          policyRevision: digest,
          cleanup: { revokedCredentials: 0, revokedGrants: 0 },
        };
        runs.push(run);
        const token = String(runs.length).repeat(64);
        bearers.set(`Bearer ${token}`, run);
        result = { run, credential: { token, expiresAt: run.expiresAt } };
      } else if (door === "getAgentPolicy" && caller !== undefined)
        result = {
          runId: caller.id,
          revision: digest,
          issuedAt: 1,
          required: [{ id: "policy", source: "builtin", body: policyBody, digest }],
        };
      else if (door === "acknowledgeAgentPolicy" && caller !== undefined) {
        caller.state = "active";
        result = { run: caller };
      } else if (door === "reportRunActivity" && caller !== undefined) {
        const report = ReportRunActivityRequestSchema.parse(input);
        if (report.runId !== caller.id) throw new Error("cross-run activity");
        caller.activity = report.activity;
        activities.push(report.activity);
        result = { run: caller };
      } else if (door === "finishAgentRun") {
        const finish = FinishAgentRunRequestSchema.parse(input);
        const root = runs.find((run) => run.id === finish.runId)!;
        for (const run of runs) {
          run.state = finish.outcome;
          run.cleanup = { finishedAt: 2, revokedCredentials: 1, revokedGrants: 1 };
        }
        result = {
          run: root,
          finishedRuns: runs.length,
          revokedCredentials: runs.length,
          revokedGrants: runs.length,
        };
      } else throw new Error("unexpected runner door");
      return Response.json(
        { ok: true, result },
        { headers: { [ACTION_TRACE_ID_HEADER]: String(++traceId) } },
      );
    },
  });
  const output: ActionRunnerResponse[] = [];
  const rootPolicy = Promise.withResolvers<Extract<ActionRunnerResponse, { type: "policy" }>>();
  const childPolicy = Promise.withResolvers<Extract<ActionRunnerResponse, { type: "policy" }>>();
  const activityDone = Promise.withResolvers<void>();
  let activityResults = 0;
  const environment: Record<string, string | undefined> = {
    MANIFOLD_ORIGIN: server.url.origin,
    MANIFOLD_AGENT_ID: "durable",
    MANIFOLD_RUNNER_TOKEN: credential,
  };
  const config = readActionRunnerEnvironment(environment);
  const line = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  async function* model() {
    expect(environment).toEqual({});
    const root = await rootPolicy.promise;
    yield line({
      type: "ack",
      id: "ack",
      runId: root.runId,
      policy: { revision: digest, acknowledgements: [{ id: "policy", digest }] },
    });
    yield line({
      type: "child",
      id: "child",
      runId: root.runId,
      declaration: { caps: ["containers:read"] },
    });
    await activityDone.promise;
    yield line({ type: "finish", id: "finish", runId: root.runId, outcome: "completed" });
  }
  async function* harness() {
    const child = await childPolicy.promise;
    for (const activity of ["working", "blocked", "done", "idle"])
      yield line({ runId: child.runId, activity });
  }
  try {
    const code = await runActionStdio({
      ...config,
      input: model(),
      activityInput: harness(),
      output(line) {
        const frame = ActionRunnerResponseSchema.parse(JSON.parse(line));
        output.push(frame);
        if (frame.type === "policy") (frame.id === null ? rootPolicy : childPolicy).resolve(frame);
        if (
          frame.type === "result" &&
          frame.door === "core.access.reportRunActivity" &&
          ++activityResults === 4
        )
          activityDone.resolve();
      },
    });
    expect(code).toBe(0);
    expect(runs.map((run) => [run.agentId, run.parentRunId])).toEqual([
      ["durable", null],
      ["durable", "run-1"],
    ]);
    expect(activities).toEqual(["working", "blocked", "done", "idle"]);
    expect(output.at(-1)).toEqual({ type: "closed", outcome: "completed", cleanup: "confirmed" });
    expect(JSON.stringify(output)).not.toContain(credential);
  } finally {
    await server.stop(true);
  }
});
