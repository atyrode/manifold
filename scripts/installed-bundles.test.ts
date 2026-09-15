import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARDENED_CONTRACT_VERSION,
  PluginBundleSchema,
  type InstalledPluginsSnapshot,
} from "../packages/protocol/src/index.ts";
import { checkInstalledCandidate, installedBundleFailures } from "./installed-bundles-candidate.ts";

function snapshot(source: string, contract = HARDENED_CONTRACT_VERSION): InstalledPluginsSnapshot {
  const pluginId = "example.candidate";
  const bytes = Buffer.from(
    JSON.stringify({
      format: 1,
      hardenedContract: contract,
      manifest: {
        id: pluginId,
        version: "1.0.0",
        title: "Candidate",
        description: "Candidate loader proof",
        capabilities: [],
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
        entry: { server: true },
      },
      files: { "server.js": Buffer.from(source).toString("base64") },
    }),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const bundlePath = `plugins/${pluginId}/${sha256}.manifold-plugin.json`;
  return {
    format: 1,
    developerMode: false,
    plugins: [
      {
        row: {
          pluginId,
          sha256,
          bundlePath,
          source: bundlePath,
          grantedCaps: [],
          installedBy: "source-owner",
          installedAt: 1,
          actions: [],
        },
        bytes: bytes.toString("base64"),
        enabled: false,
      },
    ],
  };
}

test("candidate boots compatible disabled bundles through the actual server loader", async () => {
  await checkInstalledCandidate(
    snapshot("export default { actions: [], handlers: {} };", HARDENED_CONTRACT_VERSION - 1),
  );
}, 30_000);

test("an explicit healthy lifecycle is accepted while an absent installed row fails closed", () => {
  const installed = snapshot("export default { actions: [], handlers: {} };");
  const plugin = installed.plugins[0]!;
  const bundle = PluginBundleSchema.parse(
    JSON.parse(Buffer.from(plugin.bytes, "base64").toString()),
  );
  expect(
    installedBundleFailures(installed, [
      {
        manifest: bundle.manifest,
        enabled: false,
        source: "plugin",
        actions: [],
        install: {
          sha256: plugin.row.sha256,
          source: plugin.row.source,
          grantedCaps: [],
          installedBy: plugin.row.installedBy,
          installedAt: 1,
        },
        lifecycle: "ok",
      },
    ]),
  ).toEqual([]);
  expect(installedBundleFailures(installed, [])).toEqual([
    expect.stringMatching(/example\.candidate: missing.*minimum hardened contract 1/),
  ]);
});

test("candidate refuses a held installed bundle by name and minimum contract", async () => {
  await expect(
    checkInstalledCandidate(snapshot("export default { actions: [], handlers: {} };", 999)),
  ).rejects.toThrow(/example\.candidate.*held: repack_required.*minimum hardened contract 1/s);
}, 30_000);

test("candidate catches load failures hidden by disabled in-realm rows", async () => {
  await expect(
    checkInstalledCandidate(snapshot("throw new Error('broken candidate module');")),
  ).rejects.toThrow(/example\.candidate.*enable_failed/s);
}, 30_000);

test("an in-realm module exiting cleanly during load cannot pass the candidate gate", async () => {
  await expect(checkInstalledCandidate(snapshot("process.exit(0);"))).rejects.toThrow(
    /example\.candidate.*candidate exited 0 before completing startup/s,
  );
}, 30_000);

async function exportGateAttempt(
  bootstrap: boolean,
  reply: unknown,
  status = 200,
  candidateExitCode?: number,
) {
  const root = mkdtempSync(join(tmpdir(), "installed-bootstrap-"));
  const summaryPath = join(root, "summary");
  const outputPath = join(root, "output");
  if (candidateExitCode !== undefined) {
    writeFileSync(
      join(root, "docker"),
      `#!/bin/sh\nif [ "$1" = run ]; then exit ${candidateExitCode}; fi\nexit 0\n`,
      { mode: 0o700 },
    );
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== "Bearer test-only-token")
        return Response.json(
          { error: { code: "forbidden", message: "fixture credential required" } },
          { status: 401 },
        );
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/api/actions/engine.plugins.exportInstalled"
      )
        return new Response(null, { status: 404 });
      return Response.json(reply, { status });
    },
  });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "installed-bundles.ts"),
        candidateExitCode === undefined ? "--invalid-candidate" : "fixture-candidate",
      ],
      {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          INSTALLED_BUNDLES_ORIGIN: server.url.origin,
          INSTALLED_BUNDLES_TOKEN: "test-only-token",
          INSTALLED_BUNDLES_BOOTSTRAP_GATE: String(bootstrap),
          GITHUB_STEP_SUMMARY: summaryPath,
          GITHUB_OUTPUT: outputPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      code,
      output: stdout + stderr,
      summary: existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "",
      jobOutput: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
      target: server.url.origin,
    };
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

const unknownExport = {
  ok: false,
  denial: { rule: "unknown_action", message: 'unknown action "engine.plugins.exportInstalled"' },
};

test("a missing export door fails closed without explicit bootstrap", async () => {
  const attempt = await exportGateAttempt(false, unknownExport);
  expect(attempt.code).toBe(1);
  expect(attempt.output).not.toContain("::warning::");
  expect(attempt.summary).toBe("");
  expect(attempt.jobOutput).toBe("");
});

test("explicit bootstrap passes only an unknown export door and records target and reason", async () => {
  const attempt = await exportGateAttempt(true, unknownExport);
  expect(attempt.code).toBe(0);
  expect(attempt.output).toContain("::warning::");
  expect(attempt.output).toContain(attempt.target);
  expect(attempt.output).toContain("unknown_action");
  expect(attempt.summary).toContain(attempt.target);
  expect(attempt.summary).toContain("unknown_action");
  expect(attempt.summary).toContain("bootstrap_gate=true");
  expect(attempt.jobOutput).toBe("bootstrap_required=true\n");
});

test("bootstrap does not bypass candidate validation when the export door exists", async () => {
  const attempt = await exportGateAttempt(true, {
    ok: true,
    result: { format: 1, developerMode: false, plugins: [] },
  });
  expect(attempt.code).toBe(1);
  expect(attempt.output).toContain("candidate image");
  expect(attempt.output).not.toContain("::warning::");
  expect(attempt.summary).toBe("");
  expect(attempt.jobOutput).toBe("");
});

test("an export-capable hub emits ordinary verification only after its candidate passes", async () => {
  const reply = {
    ok: true,
    result: { format: 1, developerMode: false, plugins: [] },
  };
  const failed = await exportGateAttempt(true, reply, 200, 1);
  expect(failed.code).toBe(1);
  expect(failed.jobOutput).toBe("");

  const passed = await exportGateAttempt(true, reply, 200, 0);
  expect(passed.code).toBe(0);
  expect(passed.jobOutput).toBe("bootstrap_required=false\n");
  expect(passed.summary).toBe("");
});

test("bootstrap never turns authorization or HTTP failures into a missing-door exception", async () => {
  for (const [reply, status] of [
    [{ ok: false, denial: { rule: "forbidden", message: "root authority required" } }, 200],
    [{ error: { code: "not_found", message: "unknown action" } }, 404],
  ] as const) {
    const attempt = await exportGateAttempt(true, reply, status);
    expect(attempt.code).toBe(1);
    expect(attempt.output).not.toContain("::warning::");
    expect(attempt.summary).toBe("");
    expect(attempt.jobOutput).toBe("");
  }
});
