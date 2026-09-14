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
  AgentPolicyChallengeSchema,
  CreateAgentRunResultSchema,
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
  return { server, policyFile };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const declaration = {
  name: "runner probe",
  purpose: "Read the approved workspace and delegate one reader.",
  target: "manifold://",
  reach: "subtree",
  caps: ["agents:delegate", "containers:read"],
  lifetimeMs: 120_000,
};

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
    const { server, policyFile } = await fixture();
    const frames: ActionRunnerResponse[] = [];
    const runner = new ActionRunner({
      origin: server.publicUrl,
      sponsorToken: SPONSOR,
      emit: (frame) => frames.push(frame),
    });
    try {
      await runner.accept({ type: "start", id: "start", version: 1, declaration });
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
          ...declaration,
          name: "child reader",
          caps: ["containers:read"],
          lifetimeMs: 60_000,
        },
        justification: "Delegate a read-only subset of the approved task.",
      });
      const childPolicy = policyFrame(frames);
      expect(childPolicy.runId).not.toBe(rootId);
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
    const { server } = await fixture();
    const frames: ActionRunnerResponse[] = [];
    const runner = new ActionRunner({
      origin: server.publicUrl,
      sponsorToken: SPONSOR,
      emit: (frame) => frames.push(frame),
    });
    try {
      await runner.accept({ type: "start", id: "start", version: 1, declaration });
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
    test(`an accountable launcher can renew and ${terminal === "completed" ? "finish" : "clean up"} its owned root without revoking itself`, async () => {
      const { server } = await fixture();
      const owner = { origin: server.publicUrl, token: SPONSOR };
      const admission = await invokeAction(owner, "core.access.createAgentRun", {
        ...declaration,
        lifetimeMs: 180_000,
      });
      if (!admission.outcome.ok) throw new Error("sponsor admission refused");
      const sponsor = CreateAgentRunResultSchema.parse(admission.outcome.result);
      const sponsorOptions = { origin: server.publicUrl, token: sponsor.credential.token };
      const challenge = await invokeAction(sponsorOptions, "core.access.getAgentPolicy", {});
      if (!challenge.outcome.ok) throw new Error("sponsor policy refused");
      const policy = AgentPolicyChallengeSchema.parse(challenge.outcome.result);
      const activated = await invokeAction(sponsorOptions, "core.access.acknowledgeAgentPolicy", {
        revision: policy.revision,
        acknowledgements: policy.required.map(({ id, digest }) => ({ id, digest })),
      });
      expect(activated.outcome.ok).toBe(true);
      const frames: ActionRunnerResponse[] = [];
      const runner = new ActionRunner({
        origin: server.publicUrl,
        sponsorToken: sponsor.credential.token,
        emit: (frame) => frames.push(frame),
      });
      try {
        await runner.accept({
          type: "start",
          id: "start",
          version: 1,
          declaration: {
            ...declaration,
            caps: ["containers:read"],
            lifetimeMs: 60_000,
          },
          justification: "Delegate the approved read-only task —\nwith a shorter lifetime.",
        });
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
        if (terminal === "completed") {
          await runner.accept({
            type: "finish",
            id: "finish",
            runId: ownedPolicy.runId,
            outcome: terminal,
          });
        } else expect(await runner.close(terminal)).toBe(true);
        expect(frames.at(-1)).toEqual({ type: "closed", outcome: terminal, cleanup: "confirmed" });
        expect((await invokeAction(sponsorOptions, "core.machines.list", {})).outcome.ok).toBe(
          true,
        );
        expect(JSON.stringify(frames)).not.toContain(sponsor.credential.token);
      } finally {
        await runner.close("failed");
        await invokeAction(owner, "core.access.finishAgentRun", {
          runId: sponsor.run.id,
          outcome: "completed",
        });
      }
    });
  }

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
      const { server } = await fixture();
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../../sdk/src/action-runner-main.ts")],
        {
          env: {
            PATH: process.env["PATH"],
            MANIFOLD_ORIGIN: server.publicUrl,
            MANIFOLD_SPONSOR_TOKEN: SPONSOR,
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
        child.stdin.write(
          `${JSON.stringify({ type: "start", id: "start", version: 1, declaration })}\n`,
        );
        await child.stdin.flush();
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
