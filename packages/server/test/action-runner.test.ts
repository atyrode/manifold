import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { EventsListResponseSchema } from "@manifold-plugin/events";
import { ActionRunner, invokeAction } from "@manifold/sdk";
import {
  ActionRunnerResponseSchema,
  CreateRunCredentialResultSchema,
  InspectRunResultSchema,
  RegisterAgentResultSchema,
  type ActionRunnerResponse,
  type RuntimeDeps,
} from "@manifold/protocol";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { startServer, type RunningServer } from "../src/main.ts";

const SPONSOR = "d".repeat(64);
const directories: string[] = [];
const servers: RunningServer[] = [];

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "manifold-action-runner-"));
  directories.push(directory);
  const policyFile = join(directory, "policy.txt");
  writeFileSync(policyFile, "Approved read-only run.\n", "utf8");
  let sequence = 0;
  const runtime: RuntimeDeps = { newId: () => `runner-${++sequence}`, now: () => 10_000 };
  const config = loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: SPONSOR,
      MANIFOLD_SPAWN_AGENT: "0",
      MANIFOLD_AGENT_POLICY_FILE: policyFile,
    },
    directory,
  );
  const server = await startServer({ config, runtime, logger: silentLogger, announce: false });
  servers.push(server);
  const registered = await invokeAction(
    { origin: server.publicUrl, token: SPONSOR },
    "core.access.registerAgent",
    {
      name: "runner probe",
      purpose: "Read the approved workspace and delegate one reader.",
      harness: "external",
      grant: {
        caps: ["agents:delegate", "containers:read"],
        targets: ["manifold://"],
        reach: "subtree",
        maxRunLifetimeMs: 240_000,
        delegation: { maxDepth: 4, maxDescendants: 32 },
        expiresAt: 3_600_000,
      },
      context: { profile: {} },
    },
  );
  if (!registered.outcome.ok) throw new Error("agent registration refused");
  const registration = RegisterAgentResultSchema.parse(registered.outcome.result);
  if (registration.credential === undefined) throw new Error("runner credential missing");
  return {
    server,
    policyFile,
    agentId: registration.agent.agentId,
    token: registration.credential.token,
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function policyFrame(frames: ActionRunnerResponse[]) {
  const frame = frames.findLast((frame) => frame.type === "policy");
  if (frame?.type !== "policy") throw new Error("runner did not deliver policy");
  return frame;
}

function ack(id: string, policy: Extract<ActionRunnerResponse, { type: "policy" }>) {
  return {
    type: "ack",
    id,
    runId: policy.runId,
    policy: {
      revision: policy.policy.revision,
      acknowledgements: policy.policy.required.map(({ id, digest }) => ({ id, digest })),
    },
  };
}

async function ledger(origin: string) {
  const result = await invokeAction({ origin, token: SPONSOR }, "core.events.list", {
    kind: "trace",
    limit: 100,
  });
  if (!result.outcome.ok) throw new Error("ledger refused");
  return EventsListResponseSchema.parse(result.outcome.result).events;
}

describe("external action runner over real doors", () => {
  test("discovery, exact acknowledgement, refusal correlation, renewal, child attenuation and live re-ack share the ledger", async () => {
    const { server, policyFile, agentId, token } = await fixture();
    const frames: ActionRunnerResponse[] = [];
    const runner = new ActionRunner({
      origin: server.publicUrl,
      token,
      bind: { agentId },
      emit: (frame) => frames.push(frame),
    });
    try {
      await runner.bind();
      const rootPolicy = policyFrame(frames);
      const rootId = rootPolicy.runId;
      expect(rootPolicy.policy.required.find((bundle) => bundle.source === "operator")?.body).toBe(
        "Approved read-only run.\n",
      );
      await expect(
        runner.accept({
          type: "ack",
          id: "wrong",
          runId: rootId,
          policy: {
            revision: "0".repeat(64),
            acknowledgements: rootPolicy.policy.required.map(({ id, digest }) => ({ id, digest })),
          },
        }),
      ).rejects.toMatchObject({ code: "policy_mismatch" });
      await expect(
        runner.accept({
          type: "invoke",
          id: "before",
          runId: rootId,
          door: "core.machines.list",
          target: "manifold://",
          args: {},
        }),
      ).rejects.toMatchObject({ code: "invalid_state" });
      await runner.accept(ack("ack-root", rootPolicy));
      const discovery = frames.find((frame) => frame.type === "discovery");
      if (discovery?.type !== "discovery") throw new Error("no discovery");
      const door = discovery.actions.find((action) => action.name === "core.machines.list");
      expect(door?.input).toMatchObject({ type: "object" });
      await runner.accept({
        type: "invoke",
        id: "read",
        runId: rootId,
        door: door?.name,
        target: "manifold://",
        args: {},
      });
      await runner.accept({
        type: "invoke",
        id: "refuse",
        runId: rootId,
        door: "core.index.createContainer",
        target: "manifold://",
        args: { name: "private argument not emitted" },
      });
      expect(
        frames.find((frame) => frame.type === "result" && frame.id === "refuse"),
      ).toMatchObject({ outcome: { ok: false, denial: { rule: "forbidden" } } });
      await runner.accept({
        type: "renew",
        id: "renew-root",
        runId: rootId,
        lifetimeMs: 180_000,
        justification: "Continue the sponsor-approved read-only task.",
      });
      await runner.accept({
        type: "child",
        id: "child",
        runId: rootId,
        declaration: {
          caps: ["containers:read"],
          lifetimeMs: 60_000,
        },
        justification: "Delegate a read-only subset of the approved task.",
      });
      const childPolicy = policyFrame(frames);
      expect(childPolicy.runId).not.toBe(rootId);
      const inspected = await invokeAction(
        { origin: server.publicUrl, token: SPONSOR },
        "core.access.inspectRun",
        { runId: childPolicy.runId },
      );
      if (!inspected.outcome.ok) throw new Error("child inspection refused");
      const childRun = InspectRunResultSchema.parse(inspected.outcome.result);
      if (childRun.availability !== "available") throw new Error("child unavailable");
      expect(childRun.run).toMatchObject({ agentId, parentRunId: rootId });
      await runner.accept(ack("ack-child", childPolicy));
      await runner.accept({
        type: "renew",
        id: "renew-child",
        runId: childPolicy.runId,
        lifetimeMs: 90_000,
        justification: "Allow the delegated reader to complete its bounded read.",
      });
      writeFileSync(policyFile, "Changed exact policy bytes.\n", "utf8");
      expect(
        (
          await invokeAction(
            { origin: server.publicUrl, token: SPONSOR },
            "core.access.reloadAgentPolicy",
            {},
          )
        ).outcome.ok,
      ).toBe(true);
      await runner.accept({
        type: "invoke",
        id: "stale",
        runId: rootId,
        door: door?.name,
        target: "manifold://",
        args: {},
      });
      expect(frames.find((frame) => frame.type === "result" && frame.id === "stale")).toMatchObject(
        { outcome: { ok: false, denial: { rule: "policy_stale" } } },
      );
      const changed = policyFrame(frames);
      expect(changed.policy.revision).not.toBe(rootPolicy.policy.revision);
      await runner.accept(ack("reack", changed));
      await runner.accept({
        type: "invoke",
        id: "read-again",
        runId: rootId,
        door: door?.name,
        target: "manifold://",
        args: {},
      });
      await runner.accept({ type: "finish", id: "done", runId: rootId, outcome: "completed" });
      expect(runner.successful).toBe(true);
      expect(frames.at(-1)).toEqual({ type: "closed", outcome: "completed", cleanup: "confirmed" });
      const traces = await ledger(server.publicUrl);
      for (const frame of frames) {
        if (frame.type !== "result") continue;
        const trace = traces.find((row) => row.id === frame.traceId);
        expect(trace).toMatchObject({
          door: frame.door,
          outcome: frame.outcome.ok ? "ok" : frame.outcome.denial.rule,
        });
      }
      const output = JSON.stringify(frames);
      expect(output).not.toContain(SPONSOR);
      expect(output).not.toContain("private argument not emitted");
      expect(
        frames
          .filter((frame) => frame.type === "result")
          .every((frame) => !Object.hasOwn(frame.outcome, "result")),
      ).toBe(true);
    } finally {
      await runner.close("failed");
    }
  });

  test("an undiscovered door or nested credential cannot reach the dispatcher", async () => {
    const { server, agentId, token } = await fixture();
    const frames: ActionRunnerResponse[] = [];
    const runner = new ActionRunner({
      origin: server.publicUrl,
      token,
      bind: { agentId },
      emit: (frame) => frames.push(frame),
    });
    try {
      await runner.bind();
      const policy = policyFrame(frames);
      await runner.accept(ack("ack", policy));
      await expect(
        runner.accept({
          type: "invoke",
          id: "unknown",
          runId: policy.runId,
          door: "absent.effect",
          target: "manifold://",
          args: {},
        }),
      ).rejects.toMatchObject({ code: "unknown_action" });
      await expect(
        runner.accept({
          type: "invoke",
          id: "secret",
          runId: policy.runId,
          door: "core.machines.list",
          target: "manifold://",
          args: { nested: { authorization: "must never reach the door" } },
        }),
      ).rejects.toMatchObject({ code: "credential_input" });
      expect(
        (await ledger(server.publicUrl)).filter(
          (row) => row.door === "core.machines.list" || row.door === "absent.effect",
        ),
      ).toEqual([]);
    } finally {
      expect(await runner.close("failed")).toBe(true);
    }
  });

  for (const terminal of ["completed", "failed"] as const) {
    test(`a scoped runner can renew and ${terminal} its run without retiring its Agent`, async () => {
      const { server, agentId, token } = await fixture();
      const frames: ActionRunnerResponse[] = [];
      const runner = new ActionRunner({
        origin: server.publicUrl,
        token,
        bind: { agentId },
        emit: (frame) => frames.push(frame),
      });
      try {
        await runner.bind();
        const ownedPolicy = policyFrame(frames);
        await runner.accept(ack("ack", ownedPolicy));
        await runner.accept({
          type: "renew",
          id: "renew",
          runId: ownedPolicy.runId,
          lifetimeMs: 90_000,
          justification: "Extend the approved reader's bounded task.",
        });
        expect(
          frames.find((frame) => frame.type === "result" && frame.id === "renew"),
        ).toMatchObject({ outcome: { ok: true }, expiresAt: 100_000 });
        if (terminal === "completed")
          await runner.accept({
            type: "finish",
            id: "finish",
            runId: ownedPolicy.runId,
            outcome: terminal,
          });
        else expect(await runner.close(terminal)).toBe(true);
        expect(frames.at(-1)).toEqual({ type: "closed", outcome: terminal, cleanup: "confirmed" });
        const next = new ActionRunner({
          origin: server.publicUrl,
          token,
          bind: { agentId },
          emit: (frame) => frames.push(frame),
        });
        try {
          await next.bind();
          expect(policyFrame(frames).runId).not.toBe(ownedPolicy.runId);
        } finally {
          expect(await next.close("completed")).toBe(true);
        }
        expect(JSON.stringify(frames)).not.toContain(token);
      } finally {
        await runner.close("failed");
      }
    });
  }

  test("adopting a prepared run renews its private bearer and records harness activity without another admission", async () => {
    const { server, agentId, token } = await fixture();
    const created = await invokeAction(
      { origin: server.publicUrl, token },
      "core.access.createRun",
      { agentId },
    );
    if (!created.outcome.ok) throw new Error("run admission refused");
    const admission = CreateRunCredentialResultSchema.parse(created.outcome.result);
    const frames: ActionRunnerResponse[] = [];
    const runner = new ActionRunner({
      origin: server.publicUrl,
      token: admission.credential.token,
      bind: { runId: admission.run.id },
      emit: (frame) => frames.push(frame),
    });
    try {
      await runner.bind();
      expect(policyFrame(frames).runId).toBe(admission.run.id);
      await expect(
        runner.accept({
          type: "start",
          id: "forged",
          version: 1,
          declaration: {},
        }),
      ).rejects.toMatchObject({ code: "invalid_frame" });
      await runner.accept(ack("ack", policyFrame(frames)));
      await runner.accept({
        type: "renew",
        id: "renew",
        runId: admission.run.id,
        lifetimeMs: 90_000,
      });
      await runner.reportActivity({ runId: admission.run.id, activity: "blocked" });
      const inspection = await invokeAction(
        { origin: server.publicUrl, token: SPONSOR },
        "core.access.inspectRun",
        { runId: admission.run.id },
      );
      if (!inspection.outcome.ok) throw new Error("run inspection refused");
      expect(InspectRunResultSchema.parse(inspection.outcome.result).run.activity).toBe("blocked");
      await runner.accept({
        type: "finish",
        id: "finish",
        runId: admission.run.id,
        outcome: "completed",
      });
      expect(runner.successful).toBe(true);
      expect(JSON.stringify(frames)).not.toContain(admission.credential.token);
    } finally {
      await runner.close("failed");
    }
  });

  for (const terminal of [
    "completed",
    "failed",
    "eof",
    "malformed",
    "transport_failure",
    "SIGINT",
    "SIGTERM",
  ] as const) {
    test(`the executable settles its run on ${terminal} without secret-bearing output`, async () => {
      const { server, agentId, token } = await fixture();
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../../sdk/src/action-runner-main.ts")],
        {
          env: {
            PATH: process.env["PATH"],
            MANIFOLD_ORIGIN: server.publicUrl,
            MANIFOLD_RUNNER_TOKEN: token,
            MANIFOLD_AGENT_ID: agentId,
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const lines = createInterface({ input: Readable.from(child.stdout), crlfDelay: Infinity });
      const frames: ActionRunnerResponse[] = [];
      let acted = false;
      try {
        for await (const line of lines) {
          const frame = ActionRunnerResponseSchema.parse(JSON.parse(line));
          frames.push(frame);
          if (frame.type !== "policy" || acted) continue;
          acted = true;
          if (terminal === "SIGINT" || terminal === "SIGTERM") child.kill(terminal);
          else if (terminal === "eof") child.stdin.end();
          else if (terminal === "transport_failure") {
            await server.stop();
            child.stdin.write(`${JSON.stringify(ack("ack", frame))}\n`);
            await child.stdin.flush();
          } else if (terminal === "malformed") {
            child.stdin.write("{malformed\n");
            await child.stdin.flush();
          } else {
            child.stdin.write(`${JSON.stringify(ack("ack", frame))}\n`);
            child.stdin.write(
              `${JSON.stringify({
                type: "invoke",
                id: "read",
                runId: frame.runId,
                door: "core.machines.list",
                target: "manifold://",
                args: {},
              })}\n`,
            );
            child.stdin.write(
              `${JSON.stringify({ type: "finish", id: "finish", runId: frame.runId, outcome: terminal })}\n`,
            );
            await child.stdin.flush();
          }
        }
        expect(acted).toBe(true);
        const code = await child.exited;
        expect(code === 0).toBe(terminal === "completed");
        expect(frames.at(-1)).toEqual({
          type: "closed",
          outcome:
            terminal === "eof"
              ? "abandoned"
              : terminal === "malformed" || terminal === "transport_failure"
                ? "failed"
                : terminal === "SIGINT" || terminal === "SIGTERM"
                  ? "cancelled"
                  : terminal,
          cleanup: terminal === "transport_failure" ? "failed" : "confirmed",
        });
        if (terminal === "transport_failure") {
          expect(frames).toContainEqual(
            expect.objectContaining({
              type: "error",
              code: "cleanup_failed",
              door: "core.access.finishAgentRun",
              runId: policyFrame(frames).runId,
            }),
          );
        } else {
          const cleanup = frames.findLast(
            (frame) => frame.type === "result" && frame.door === "core.access.finishAgentRun",
          );
          expect(cleanup).toMatchObject({
            outcome: { ok: true },
            cleanup: { finishedRuns: 1, revokedCredentials: 1 },
          });
          expect(
            (await ledger(server.publicUrl)).find(
              (trace) => trace.id === (cleanup?.type === "result" ? cleanup.traceId : null),
            ),
          ).toMatchObject({ door: "core.access.finishAgentRun", outcome: "ok" });
        }
        expect(JSON.stringify(frames)).not.toContain(SPONSOR);
        expect(await new Response(child.stderr).text()).toBe("");
      } finally {
        lines.close();
        child.kill();
        await child.exited;
      }
    }, 15_000);
  }
});
