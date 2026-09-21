import { describe, expect, test } from "bun:test";
import {
  ACTION_RESULT_PROJECTION_HEADER,
  ACTION_TRACE_ID_HEADER,
  ActionRunnerRequestSchema,
  ActionRunnerResponseSchema,
  CreateChildRunRequestSchema,
  CreateRunRequestSchema,
  FinishAgentRunRequestSchema,
  ReportRunActivityRequestSchema,
  PROTOCOL_VERSION,
  actionResultProjectionDigest,
  type ActionResultProjection,
  type ActionRunnerReadResults,
  type ActionSummary,
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

  test("cancellation before Agent admission neither creates work nor reads the model", async () => {
    const output: ActionRunnerResponse[] = [];
    const code = await runActionStdio({
      origin: "http://127.0.0.1:1",
      token: credential,
      bind: { agentId: "durable" },
      signal: AbortSignal.abort(),
      input: {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          throw new Error("cancelled runner read model input");
        },
      },
      output: (line) => output.push(ActionRunnerResponseSchema.parse(JSON.parse(line))),
    });
    expect(code).toBe(130);
    expect(output).toEqual([{ type: "closed", outcome: "cancelled", cleanup: "not_started" }]);
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

const readDoor = "example.catalog.query";
const readPolicy: ActionResultProjection = {
  kind: "projected-json",
  fields: [["items", "*", "title"]],
  maxArrayItems: 2,
  maxResultBytes: 1_024,
};
const textReadPolicy: ActionResultProjection = {
  ...readPolicy,
  fields: [
    ["items", "*", "title"],
    ["items", "*", "sourceId"],
  ],
  textFields: [["items", "*", "title"]],
  maxArrayItems: 3,
};

/** An intentionally adversarial HTTP peer: it may ignore the requested projection. */
async function readResultScenario(options: {
  readResults?: ActionRunnerReadResults;
  declaration?: ActionResultProjection | null;
  refreshDeclaration?: ActionResultProjection;
  projection?: unknown;
  missingTrace?: boolean;
  denied?: boolean;
  retainAdditionalCredentials?: boolean;
  invoke?: Record<string, unknown>;
  runAccess?: ActionSummary["runAccess"];
  discoveryBodyBytes?: number;
}) {
  const policyBody = "Synthetic policy — acknowledge these exact bytes.";
  const policyDigest = new Bun.CryptoHasher("sha256").update(policyBody).digest("hex");
  const contractDigest = await actionResultProjectionDigest(readPolicy);
  const runToken = "b".repeat(64);
  const run: AgentRun = {
    id: "read-run",
    agentId: "reader",
    session: null,
    activity: "unknown",
    principal: { id: "principal", name: "reader", kind: "agent", color: "#123456" },
    rootRunId: "read-run",
    parentRunId: null,
    authorizedByPrincipalId: "sponsor",
    authorizationPath: "principal",
    authorizationCredential: { tokenId: null, grantId: null, caps: [], containerScope: null },
    purpose: "Synthetic projection check",
    target: "manifold://",
    reach: "subtree",
    caps: ["containers:read"],
    createdAt: 1,
    expiresAt: 120_001,
    renewals: 0,
    maxDepth: 4,
    maxDescendants: 32,
    depth: 0,
    cleanupOwnerPrincipalId: "sponsor",
    state: "pending_policy",
    policyRevision: policyDigest,
    cleanup: { revokedCredentials: 0, revokedGrants: 0 },
  };
  const childRun: AgentRun = { ...run, id: "read-child", parentRunId: run.id, depth: 1 };
  const calls: { door: string; projection: string | null; trace: number }[] = [];
  const output: ActionRunnerResponse[] = [];
  const lines: string[] = [];
  let discoveries = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/protocol") {
        const declaration =
          ++discoveries > 1 && options.refreshDeclaration !== undefined
            ? options.refreshDeclaration
            : options.declaration === undefined
              ? readPolicy
              : options.declaration;
        const summary = (name: string): ActionSummary => ({
          name,
          title: name,
          caps: [],
          scope: "workspace",
          input: { type: "object" },
          result: { type: "object" },
        });
        const padding = { padding: "" };
        const payload = {
          protocolVersion: PROTOCOL_VERSION,
          actions: [
            ...[
              "createRun",
              "createChildRun",
              "inspectRun",
              "reportRunActivity",
              "getAgentPolicy",
              "acknowledgeAgentPolicy",
              "renewAgentRun",
              "finishAgentRun",
            ].map((name) => summary(`core.access.${name}`)),
            {
              ...summary(readDoor),
              ...(declaration === null ? {} : { resultProjection: declaration }),
              ...(options.runAccess === undefined ? {} : { runAccess: options.runAccess }),
              ...(options.discoveryBodyBytes === undefined ? {} : { input: padding }),
            },
          ],
        };
        if (options.discoveryBodyBytes !== undefined)
          padding.padding = "x".repeat(
            options.discoveryBodyBytes - Buffer.byteLength(JSON.stringify(payload)),
          );
        return Response.json(payload);
      }
      const door = decodeURIComponent(path.slice("/api/actions/".length));
      const trace = calls.length + 1;
      calls.push({ door, projection: request.headers.get(ACTION_RESULT_PROJECTION_HEADER), trace });
      const headers =
        options.missingTrace && door === readDoor
          ? {}
          : { [ACTION_TRACE_ID_HEADER]: String(trace) };
      if (door === readDoor) {
        if (options.denied)
          return Response.json(
            { ok: false, denial: { rule: "forbidden", message: "PRIVATE_DENIAL" } },
            { headers },
          );
        return Response.json(
          {
            ok: true,
            result: { raw: "RAW_RESULT_MUST_STAY_PRIVATE", token: runToken },
            ...(options.projection === null
              ? {}
              : {
                  projection: options.projection ?? {
                    ok: true,
                    contractDigest,
                    data: { items: [{ title: "Selected evidence" }] },
                  },
                }),
          },
          { headers },
        );
      }
      let result: unknown;
      if (door === "core.access.createRun") {
        result = { run, credential: { token: runToken, expiresAt: run.expiresAt } };
      } else if (door === "core.access.createChildRun") {
        result = {
          run: childRun,
          credential: { token: "c".repeat(64), expiresAt: childRun.expiresAt },
        };
      } else if (door === "core.access.renewAgentRun") {
        result = {
          run,
          credential: { token: "d".repeat(64), expiresAt: run.expiresAt },
          revokedCredentials: 1,
        };
      } else if (door === "core.access.getAgentPolicy") {
        result = {
          runId:
            request.headers.get("authorization") === `Bearer ${"c".repeat(64)}`
              ? childRun.id
              : run.id,
          revision: policyDigest,
          issuedAt: 1,
          required: [{ id: "policy", source: "builtin", body: policyBody, digest: policyDigest }],
        };
      } else if (door === "core.access.acknowledgeAgentPolicy") {
        expect(await request.json()).toEqual({
          revision: policyDigest,
          acknowledgements: [{ id: "policy", digest: policyDigest }],
        });
        run.state = "active";
        result = { run };
      } else if (door === "core.access.finishAgentRun") {
        const finish = FinishAgentRunRequestSchema.parse(await request.json());
        run.state = finish.outcome;
        run.cleanup = { finishedAt: 2, revokedCredentials: 1, revokedGrants: 1 };
        result = { run, finishedRuns: 1, revokedCredentials: 1, revokedGrants: 1 };
      } else throw new Error("unexpected synthetic action");
      // Unsolicited sidebands on lifecycle responses must never escape.
      return Response.json(
        {
          ok: true,
          result,
          projection: {
            ok: true,
            contractDigest,
            data: { items: [{ title: "LIFECYCLE_PRIVATE" }] },
          },
        },
        { headers },
      );
    },
  });
  const environment: Record<string, string | undefined> = {
    MANIFOLD_ORIGIN: server.url.origin,
    MANIFOLD_RUNNER_TOKEN: credential,
    MANIFOLD_AGENT_ID: "reader",
    ...(options.readResults === undefined
      ? {}
      : {
          MANIFOLD_READ_RESULTS: JSON.stringify(options.readResults),
        }),
  };
  const configuration = readActionRunnerEnvironment(environment);
  const line = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  async function* model() {
    expect(environment).toEqual({});
    const policy = output.find((frame) => frame.type === "policy");
    expect(policy?.type === "policy" ? policy.policy.required[0]?.body : null).toBe(policyBody);
    yield line({
      type: "ack",
      id: "ack",
      runId: run.id,
      policy: {
        revision: policyDigest,
        acknowledgements: [{ id: "policy", digest: policyDigest }],
      },
    });
    if (options.retainAdditionalCredentials) {
      yield line({
        type: "child",
        id: "child",
        runId: run.id,
        declaration: { caps: ["containers:read"] },
      });
      yield line({ type: "renew", id: "renew", runId: run.id, lifetimeMs: 120_000 });
    }
    if (options.refreshDeclaration !== undefined)
      yield line({ type: "discover", id: "refresh", runId: run.id });
    yield line({
      type: "invoke",
      id: "read",
      runId: run.id,
      door: readDoor,
      target: "manifold://",
      args: {},
      ...options.invoke,
    });
    yield line({ type: "finish", id: "finish", runId: run.id, outcome: "completed" });
  }
  try {
    const code = await runActionStdio({
      ...configuration,
      input: model(),
      output(line) {
        lines.push(line);
        output.push(ActionRunnerResponseSchema.parse(JSON.parse(line)));
      },
    });
    const result = output.find((frame) => frame.type === "result" && frame.id === "read");
    return { code, calls, output, lines, result, run };
  } finally {
    await server.stop(true);
  }
}

describe("trusted bounded read results", () => {
  const allow = async (
    maxResultBytes?: number,
    policy = readPolicy,
  ): Promise<ActionRunnerReadResults> => [
    {
      door: readDoor,
      contractDigest: await actionResultProjectionDigest(policy),
      ...(maxResultBytes === undefined ? {} : { maxResultBytes }),
    },
  ];

  test("default-off drops unsolicited results; exact launcher opt-in emits only traced untrusted leaves", async () => {
    for (const enabled of [false, true]) {
      const scenario = await readResultScenario(enabled ? { readResults: await allow() } : {});
      expect(scenario.code).toBe(0);
      const call = scenario.calls.find((call) => call.door === readDoor);
      expect(scenario.result).toMatchObject({
        type: "result",
        outcome: { ok: true },
        traceId: call?.trace,
        door: readDoor,
      });
      if (scenario.result?.type !== "result") throw new Error("missing read outcome");
      expect(scenario.result.projection).toEqual(
        enabled
          ? {
              ok: true,
              contractDigest: await actionResultProjectionDigest(readPolicy),
              data: { items: [{ title: "Selected evidence" }] },
              trust: "untrusted",
            }
          : undefined,
      );
      expect(call?.projection).toBe(
        enabled ? await actionResultProjectionDigest(readPolicy) : null,
      );
      expect(
        scenario.calls
          .filter((call) => call.door !== readDoor)
          .every((call) => call.projection === null),
      ).toBe(true);
      expect(scenario.lines.join("")).not.toMatch(/RAW_RESULT_MUST_STAY_PRIVATE|LIFECYCLE_PRIVATE/);
      expect(scenario.lines.join("")).not.toContain("b".repeat(64));
      expect(scenario.output.at(-1)).toEqual({
        type: "closed",
        outcome: "completed",
        cleanup: "confirmed",
      });
    }
  });

  test("model output-policy forgery cannot opt in or reach an action effect", async () => {
    for (const forged of [
      { readResults: await allow() },
      { resultProjectionDigest: await actionResultProjectionDigest(readPolicy) },
      { textFields: [["items", "*", "title"]] },
      { resultProjection: textReadPolicy },
    ]) {
      const scenario = await readResultScenario({ invoke: forged });
      expect(scenario.calls.some((call) => call.door === readDoor)).toBe(false);
      expect(scenario.output).toContainEqual(
        expect.objectContaining({ type: "error", code: "invalid_frame" }),
      );
      expect(scenario.run.cleanup.finishedAt).toBe(2);
    }
  });

  test("missing declarations and refreshed contract changes refuse before effects", async () => {
    const cases: [Parameters<typeof readResultScenario>[0], string][] = [
      [{ declaration: null }, "projection_unavailable"],
      [{ declaration: { ...readPolicy, maxArrayItems: 3 } }, "projection_changed"],
      [{ refreshDeclaration: { ...readPolicy, fields: [["other"]] } }, "projection_changed"],
      [{ declaration: textReadPolicy }, "projection_changed"],
      [{ refreshDeclaration: textReadPolicy }, "projection_changed"],
      [{ declaration: { ...readPolicy, textFields: readPolicy.fields } }, "projection_changed"],
    ];
    for (const [override, code] of cases) {
      const scenario = await readResultScenario({ ...override, readResults: await allow() });
      expect(scenario.calls.some((call) => call.door === readDoor)).toBe(false);
      expect(scenario.output).toContainEqual(
        expect.objectContaining({ type: "error", code, door: readDoor }),
      );
      expect(scenario.run.cleanup.finishedAt).toBe(2);
    }
  });

  test("an allowlist entry never authorizes a neighboring door or lifecycle invocation", async () => {
    const neighboring = await readResultScenario({
      readResults: [{ ...(await allow())[0]!, door: `${readDoor}.other` }],
    });
    expect(
      neighboring.result?.type === "result" ? neighboring.result.projection : null,
    ).toBeUndefined();
    for (const invoke of [{ door: "core.access.getAgentPolicy" }, {}]) {
      const scenario = await readResultScenario({
        readResults: [
          ...(await allow()),
          {
            door: "core.access.getAgentPolicy",
            contractDigest: await actionResultProjectionDigest(readPolicy),
          },
        ],
        ...(Object.keys(invoke).length === 0
          ? { declaration: null, runAccess: "policy" as const }
          : {}),
        invoke,
      });
      expect(scenario.output).toContainEqual(
        expect.objectContaining({ type: "error", code: "invalid_state" }),
      );
      expect(scenario.calls.some((call) => call.door === readDoor)).toBe(false);
      expect(scenario.run.cleanup.finishedAt).toBe(2);
    }
  });

  test("missing or mismatched sidebands never fall back to a raw result or retry the effect", async () => {
    for (const projection of [
      null,
      {
        ok: true,
        contractDigest: "c".repeat(64),
        data: { items: [{ title: "WRONG_CONTRACT" }] },
      },
    ]) {
      const scenario = await readResultScenario({ readResults: await allow(), projection });
      expect(scenario.result).toMatchObject({
        outcome: { ok: true },
        projection: { ok: false, code: "projection_invalid", trust: "untrusted" },
      });
      expect(scenario.calls.filter((call) => call.door === readDoor)).toHaveLength(1);
      expect(scenario.lines.join("")).not.toMatch(/RAW_RESULT_MUST_STAY_PRIVATE|WRONG_CONTRACT/);
      expect(scenario.run.state).toBe("completed");
    }
  });

  test("structural, credential and UTF-8 guards refuse data without denying successful effects", async () => {
    const contractDigest = await actionResultProjectionDigest(readPolicy);
    let deep: unknown = "deep";
    for (let index = 0; index < 17; index++) deep = { child: deep };
    for (const [data, code, limit] of [
      [{ items: [{ title: { nested: "not a leaf" } }] }, "projection_invalid", undefined],
      [
        { items: [{ title: "one" }, { title: "two" }, { title: "three" }] },
        "projection_limit",
        undefined,
      ],
      [{ items: [{ title: "ok" }], extra: deep }, "projection_limit", undefined],
      [{ items: [{ title: "b".repeat(64) }] }, "projection_invalid", undefined],
      [{ items: [{ title: "Bearer synthetic-value" }] }, "projection_invalid", undefined],
      [
        { items: [{ title: "https://reader@example.invalid/archive" }] },
        "projection_invalid",
        undefined,
      ],
      [
        { items: [{ title: "https://example.invalid/?token=[REDACTED]" }] },
        "projection_invalid",
        undefined,
      ],
      [
        { items: [{ title: "https://example.invalid/#key=synthetic" }] },
        "projection_invalid",
        undefined,
      ],
      [{ items: [{ title: "ok", access_token: "synthetic" }] }, "projection_invalid", undefined],
      [{ items: [{ title: "x".repeat(1_024) }] }, "projection_limit", undefined],
      [
        { items: [{ title: "界" }] },
        "projection_limit",
        Buffer.byteLength(JSON.stringify({ items: [{ title: "界" }] })) - 1,
      ],
    ] as const) {
      const scenario = await readResultScenario({
        readResults: await allow(limit),
        projection: { ok: true, contractDigest, data },
      });
      expect(scenario.result).toMatchObject({
        outcome: { ok: true },
        projection: { ok: false, code, contractDigest, trust: "untrusted" },
      });
      if (scenario.result?.type !== "result") throw new Error("missing read outcome");
      expect(scenario.result.projection).not.toHaveProperty("data");
      expect(scenario.calls.filter((call) => call.door === readDoor)).toHaveLength(1);
      expect(scenario.run.state).toBe("completed");
    }
  });

  test("the consumer reapplies fields, respects host projection failure, and permits exact UTF-8 bounds", async () => {
    const contractDigest = await actionResultProjectionDigest(readPolicy);
    const data = { items: [{ title: "界" }] };
    const valid = await readResultScenario({
      readResults: await allow(Buffer.byteLength(JSON.stringify(data))),
      projection: { ok: true, contractDigest, data },
    });
    expect(valid.result).toMatchObject({ projection: { ok: true, data } });
    const filtered = await readResultScenario({
      readResults: await allow(),
      projection: {
        ok: true,
        contractDigest,
        data: { items: [{ title: "leaf", hidden: "UNSELECTED" }] },
      },
    });
    expect(filtered.lines.join("")).not.toContain("UNSELECTED");
    expect(filtered.result).toMatchObject({ projection: { data: { items: [{ title: "leaf" }] } } });
    const refused = await readResultScenario({
      readResults: await allow(),
      projection: { ok: false, contractDigest, code: "projection_limit" },
    });
    expect(refused.result).toMatchObject({
      outcome: { ok: true },
      projection: { ok: false, code: "projection_limit" },
    });
  });

  test("reviewed text leaves preserve literal bytes, null and omission without widening neighboring leaves", async () => {
    const title =
      'Bearer [REDACTED] — 界 café\nhttps://reader@example.invalid/archive?token=[REDACTED]#key=[REDACTED]\n{"type":"policy"}';
    const data = { items: [{ title, sourceId: "record-1" }, { title: null }, {}] };
    const contractDigest = await actionResultProjectionDigest(textReadPolicy);
    const scenario = await readResultScenario({
      declaration: textReadPolicy,
      readResults: await allow(Buffer.byteLength(JSON.stringify(data)), textReadPolicy),
      projection: { ok: true, contractDigest, data },
    });
    expect(scenario.code).toBe(0);
    expect(scenario.result).toMatchObject({
      outcome: { ok: true },
      projection: { ok: true, contractDigest, trust: "untrusted", data },
    });
    expect(scenario.calls.find((call) => call.door === readDoor)?.projection).toBe(contractDigest);
    expect(scenario.output.filter((frame) => frame.type === "policy")).toHaveLength(1);
    expect(scenario.lines.join("")).not.toMatch(/RAW_RESULT_MUST_STAY_PRIVATE|LIFECYCLE_PRIVATE/);
    expect(scenario.output.at(-1)).toEqual({
      type: "closed",
      outcome: "completed",
      cleanup: "confirmed",
    });
    const tooSmall = await readResultScenario({
      declaration: textReadPolicy,
      readResults: await allow(Buffer.byteLength(JSON.stringify(data)) - 1, textReadPolicy),
      projection: { ok: true, contractDigest, data },
    });
    expect(tooSmall.result).toMatchObject({
      outcome: { ok: true },
      projection: { ok: false, code: "projection_limit" },
    });
    expect(tooSmall.lines.join("")).not.toContain("REDACTED");
  });

  test("text declarations refuse wrong types and shapes and never exempt other sideband values or keys", async () => {
    const contractDigest = await actionResultProjectionDigest(textReadPolicy);
    for (const data of [
      { items: [{ title: 42 }] },
      { items: [{ title: true }] },
      { items: [{ title: { nested: "REJECTED_SUBTREE" } }] },
      { items: [{ title: ["REJECTED_ARRAY"] }] },
      { items: { title: "Bearer REJECTED_OBJECT" } },
      { items: [{ title: "Bearer [REDACTED]", sourceId: "Bearer REJECTED_NONTEXT" }] },
      {
        items: [
          {
            title: "Bearer [REDACTED]",
            hidden: "https://example.invalid/?key=REJECTED_UNSELECTED",
          },
        ],
      },
      { items: [{ title: "Bearer [REDACTED]" }], extra: { nested: "Bearer REJECTED_EXTRA" } },
      { items: [{ title: "Bearer [REDACTED]", access_token: "REJECTED_KEY" }] },
      { items: [{ title: "Bearer [REDACTED]", ["Bearer " + "REJECTED_KEY"]: "ordinary" }] },
      { items: [{ title: { access_token: "REJECTED_NESTED_KEY" } }] },
    ]) {
      const scenario = await readResultScenario({
        declaration: textReadPolicy,
        readResults: await allow(undefined, textReadPolicy),
        projection: { ok: true, contractDigest, data },
      });
      expect(scenario.result).toMatchObject({
        outcome: { ok: true },
        projection: { ok: false, code: "projection_invalid", contractDigest, trust: "untrusted" },
      });
      expect(
        scenario.result?.type === "result" ? scenario.result.projection : null,
      ).not.toHaveProperty("data");
      expect(scenario.lines.join("")).not.toMatch(/REJECTED|REDACTED/);
      expect(scenario.calls.filter((call) => call.door === readDoor)).toHaveLength(1);
      expect(scenario.run.cleanup.finishedAt).toBe(2);
    }
  });

  test("even an explicitly selected text leaf cannot permit a forbidden credential key", async () => {
    const declaration: ActionResultProjection = {
      ...readPolicy,
      fields: [["authorization"]],
      textFields: [["authorization"]],
    };
    const scenario = await readResultScenario({
      declaration,
      readResults: await allow(undefined, declaration),
      projection: {
        ok: true,
        contractDigest: await actionResultProjectionDigest(declaration),
        data: { authorization: "Bearer [REDACTED]" },
      },
    });
    expect(scenario.result).toMatchObject({
      outcome: { ok: true },
      projection: { ok: false, code: "projection_invalid" },
    });
    expect(scenario.lines.join("")).not.toContain("REDACTED");
    expect(scenario.run.cleanup.finishedAt).toBe(2);
  });

  test("reviewed text still rejects every held launcher, run, child and replacement credential", async () => {
    const contractDigest = await actionResultProjectionDigest(textReadPolicy);
    for (const secret of [credential, "b".repeat(64), "c".repeat(64), "d".repeat(64)]) {
      for (const data of [
        { items: [{ title: `Held ${secret}` }] },
        { items: [{ title: "safe" }], unselected: { nested: secret } },
        { items: [{ title: "safe", [secret]: "ordinary" }] },
      ]) {
        const scenario = await readResultScenario({
          declaration: textReadPolicy,
          readResults: await allow(undefined, textReadPolicy),
          retainAdditionalCredentials: true,
          projection: { ok: true, contractDigest, data },
        });
        expect(scenario.result).toMatchObject({
          outcome: { ok: true },
          projection: { ok: false, code: "projection_invalid" },
        });
        expect(scenario.lines.join("")).not.toContain(secret);
        expect(scenario.run.cleanup.finishedAt).toBe(2);
      }
    }
  });

  test("invalid text paths cannot widen the reviewed declaration or reach invocation", async () => {
    for (const textFields of [
      [["unselected"]],
      [["items", "*"]],
      [["items", "*", "title", "nested"]],
      [["items", "**", "title"]],
    ]) {
      const scenario = await readResultScenario({
        declaration: { ...readPolicy, textFields },
        readResults: await allow(),
      });
      expect(scenario.calls).toEqual([]);
      expect(scenario.output).toContainEqual(
        expect.objectContaining({ type: "error", code: "invalid_response" }),
      );
    }
  });

  test("reviewed result text never exempts model input, even with nested attempted opt-in", async () => {
    for (const args of [
      { items: [{ title: "Bearer [REDACTED]" }] },
      { textFields: [["items", "*", "title"]], items: [{ title: "Bearer [REDACTED]" }] },
      { title: "https://reader@example.invalid/archive" },
      { title: "https://example.invalid/?token=[REDACTED]" },
      { title: credential },
      { nested: { authorization: "synthetic" } },
    ]) {
      const scenario = await readResultScenario({
        declaration: textReadPolicy,
        readResults: await allow(undefined, textReadPolicy),
        invoke: { args },
      });
      expect(scenario.calls.some((call) => call.door === readDoor)).toBe(false);
      expect(scenario.output).toContainEqual(
        expect.objectContaining({ type: "error", code: "credential_input" }),
      );
      expect(scenario.lines.join("")).not.toMatch(/REDACTED|reader@example/);
      expect(scenario.run.cleanup.finishedAt).toBe(2);
    }
  });

  test("denials retain mechanical refusal; absent invocation traces cannot publish data", async () => {
    const denied = await readResultScenario({ readResults: await allow(), denied: true });
    expect(denied.result).toMatchObject({ outcome: { ok: false, denial: { rule: "forbidden" } } });
    expect(denied.result).not.toHaveProperty("projection");
    expect(denied.lines.join("")).not.toContain("PRIVATE_DENIAL");
    const untraced = await readResultScenario({ readResults: await allow(), missingTrace: true });
    expect(untraced.output).toContainEqual(
      expect.objectContaining({ type: "error", code: "missing_trace" }),
    );
    expect(untraced.result).toBeUndefined();
    expect(untraced.lines.join("")).not.toContain("Selected evidence");
    expect(untraced.run.cleanup.finishedAt).toBe(2);
  });

  test("invalid launcher output policies are withdrawn even when admission refuses", async () => {
    const entry = (await allow())[0]!;
    for (const value of [
      [entry, entry],
      [{ ...entry, contractDigest: "not-a-digest" }],
      [{ ...entry, door: "*" }],
      [{ ...entry, maxResultBytes: 0 }],
      [{ ...entry, maxResultBytes: 1_048_577 }],
      Array.from({ length: 65 }, (_, index) => ({ ...entry, door: `door-${index}` })),
    ]) {
      const environment: Record<string, string | undefined> = {
        MANIFOLD_ORIGIN: "https://example.invalid",
        MANIFOLD_AGENT_ID: "reader",
        MANIFOLD_RUNNER_TOKEN: credential,
        MANIFOLD_READ_RESULTS: JSON.stringify(value),
      };
      expect(() => readActionRunnerEnvironment(environment)).toThrow();
      expect(environment).toEqual({});
      expect(
        () =>
          new ActionRunner({
            origin: "https://example.invalid",
            token: credential,
            bind: { agentId: "reader" },
            readResults: value,
            emit: () => {},
          }),
      ).toThrow();
    }
  });

  test("malformed launcher JSON is rejected before either input pipe can be read", () => {
    const environment: Record<string, string | undefined> = {
      MANIFOLD_ORIGIN: "https://example.invalid",
      MANIFOLD_AGENT_ID: "reader",
      MANIFOLD_RUNNER_TOKEN: credential,
      MANIFOLD_READ_RESULTS: "[",
      MANIFOLD_ACTIVITY_FD: "3",
    };
    expect(() => readActionRunnerEnvironment(environment)).toThrow();
    expect(environment).toEqual({});
  });

  test("the outgoing discovery frame includes JSONL framing in its response limit", async () => {
    // Tune the otherwise valid HTTP body to fit while the discovery envelope cannot.
    const limit = 16 * 1_048_576;
    const scenario = await readResultScenario({ discoveryBodyBytes: limit - 1 });
    expect(scenario.lines.every((line) => Buffer.byteLength(line) <= limit)).toBe(true);
    expect(scenario.output).toContainEqual(
      expect.objectContaining({ type: "error", code: "limit_exceeded" }),
    );
    expect(scenario.calls).toEqual([]);
  });
});
