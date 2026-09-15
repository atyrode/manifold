import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const target = "a".repeat(40);
const incumbent = "b".repeat(40);
const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../.github/workflows/deploy-dev.yml", import.meta.url)).text(),
) as { jobs: { request: { steps: { id?: string; with?: { script?: string } }[] } } };
const admission = workflow.jobs.request.steps.find((step) => step.id === "request")?.with?.script;
if (typeof admission !== "string") throw new Error("Deployment admission script is missing");

interface CIRun {
  id: number;
  run_number: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  head_repository: { full_name: string };
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
}
interface CIJob {
  id: number;
  run_id: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
}
const currentProof: CIRun = {
  id: 202,
  run_number: 20,
  run_attempt: 2,
  head_sha: target,
  head_branch: "main",
  head_repository: { full_name: "owner/manifold" },
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "push",
  status: "completed",
  conclusion: "success",
};
const oldProof: CIRun = { ...currentProof, id: 101, run_number: 19, run_attempt: 1 };
const gate: CIJob = {
  id: 303,
  run_id: 202,
  head_sha: target,
  name: "gate",
  status: "completed",
  conclusion: "success",
};
interface Request {
  runs?: CIRun[];
  jobs?: CIJob[];
  trigger?: CIRun;
  dispatch?: boolean;
  ref?: string;
  inputs?: Record<string, string>;
  confirmed?: CIRun;
}

async function admit(request: Request = {}): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  const execution: unknown = runInNewContext(`(async () => {\n${admission}\n})()`, {
    context: {
      eventName: request.dispatch ? "workflow_dispatch" : "workflow_run",
      ref: request.ref ?? "refs/heads/main",
      repo: { owner: "owner", repo: "manifold" },
      payload: {
        repository: { default_branch: "main" },
        workflow_run: request.trigger ?? currentProof,
      },
    },
    process: {
      env: {
        DISPATCH_TARGET_SHA: target,
        DISPATCH_EXPECTED_CURRENT_SHA: incumbent,
        DISPATCH_REASON: "Restore the previously verified application",
        DISPATCH_COMPATIBILITY_REVIEWED: "true",
        ...request.inputs,
      },
    },
    github: {
      rest: {
        actions: {
          listWorkflowRuns: "runs",
          listJobsForWorkflowRunAttempt: "jobs",
          getWorkflowRun: async () => ({ data: request.confirmed ?? currentProof }),
        },
      },
      paginate: async (
        method: string,
        parameters: { run_id?: number; attempt_number?: number },
      ) => {
        if (method === "runs") return request.runs ?? [currentProof, oldProof];
        if (method === "jobs" && parameters.run_id === 202 && parameters.attempt_number === 2) {
          return request.jobs ?? [gate];
        }
        return [];
      },
    },
    core: {
      setOutput: (key: string, value: string) => {
        outputs[key] = value;
      },
    },
  });
  await execution;
  return outputs;
}

test("development admits the latest exact main proof, not newer foreign or PR runs", async () => {
  const newer = { ...currentProof, id: 999, run_number: 99 };
  const outputs = await admit({
    runs: [
      { ...newer, event: "pull_request" },
      { ...newer, head_repository: { full_name: "outsider/manifold" } },
      { ...newer, head_sha: incumbent },
      oldProof,
      currentProof,
    ],
  });
  expect(outputs).toMatchObject({ sha: target, ci_run_id: "202", rollback: "false" });
});

test("a newer unsuccessful exact proof cannot fall back to an older success", async () => {
  await expect(
    admit({
      dispatch: true,
      runs: [{ ...currentProof, status: "in_progress", conclusion: null }, oldProof],
    }),
  ).rejects.toThrow();
});

test("an automatic callback cannot borrow a later successful attempt", async () => {
  await expect(admit({ trigger: { ...currentProof, run_attempt: 1 } })).rejects.toThrow();
});

test("a green gate for another commit is not deployment evidence", async () => {
  await expect(admit({ jobs: [{ ...gate, head_sha: incumbent }] })).rejects.toThrow();
});

test("duplicate successful gate jobs leave deployment evidence ambiguous", async () => {
  await expect(admit({ jobs: [gate, { ...gate, id: 304 }] })).rejects.toThrow();
});

test("a rerun beginning during gate inspection invalidates that attempt", async () => {
  await expect(
    admit({
      confirmed: {
        ...currentProof,
        run_attempt: 3,
        status: "queued",
        conclusion: null,
      },
    }),
  ).rejects.toThrow();
});

test("explicit rollback admits a full-main proof with acknowledged compatibility", async () => {
  expect(await admit({ dispatch: true })).toMatchObject({
    sha: target,
    expected_current_sha: incumbent,
    rollback: "true",
    ci_run_id: "202",
  });
});

test("rollback cannot execute from an untrusted branch", async () => {
  await expect(admit({ dispatch: true, ref: "refs/heads/unreviewed" })).rejects.toThrow();
});

test.each([
  ["abbreviated expectation", { DISPATCH_EXPECTED_CURRENT_SHA: incumbent.slice(0, 12) }],
  ["unacknowledged compatibility", { DISPATCH_COMPATIBILITY_REVIEWED: "false" }],
  ["multiline reason", { DISPATCH_REASON: "restore\ninjected log row" }],
] as const)("rollback refuses %s", async (_name, inputs) => {
  await expect(admit({ dispatch: true, inputs })).rejects.toThrow();
});

test("explicit deployment uses forward ordering without borrowing a workflow-run callback", async () => {
  expect(
    await admit({
      dispatch: true,
      trigger: { ...currentProof, run_attempt: 1 },
      inputs: { DISPATCH_OPERATION: "deploy", DISPATCH_EXPECTED_CURRENT_SHA: "" },
    }),
  ).toMatchObject({ sha: target, rollback: "false", expected_current_sha: "" });
});

test("an unrecognized manual operation is not treated as a rollback or deployment", async () => {
  await expect(
    admit({ dispatch: true, inputs: { DISPATCH_OPERATION: "unknown" } }),
  ).rejects.toThrow();
});

test("deployment completion requires successful verification with an explicit maintenance result", async () => {
  for (const [file, job] of [
    ["deploy-dev.yml", "owner-pin"],
    ["deploy-hub.yml", "fleet-pin"],
  ] as const) {
    const source = Bun.YAML.parse(
      await Bun.file(new URL(`../.github/workflows/${file}`, import.meta.url)).text(),
    ) as { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };
    const guard = source.jobs[job]?.steps.find(
      (step) => step.name === "Require successful switch and live verification",
    )?.run;
    if (!guard) throw new Error(`${file} has no deployment completion guard`);
    const complete = (switchResult: string, verifyResult: string, maintenanceRequired: string) =>
      Bun.spawnSync(["bash", "-e", "-c", guard], {
        env: {
          ...process.env,
          SWITCH_RESULT: switchResult,
          VERIFY_RESULT: verifyResult,
          MAINTENANCE_REQUIRED: maintenanceRequired,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    expect(complete("success", "success", "false").exitCode).toBe(0);
    expect(complete("success", "success", "true").exitCode).toBe(0);
    expect(complete("success", "success", "").exitCode).toBe(1);
    expect(complete("success", "skipped", "false").exitCode).toBe(1);
    expect(complete("success", "failure", "false").exitCode).toBe(1);
    expect(complete("failure", "success", "false").exitCode).toBe(1);
  }
});
