import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  HARDENED_CONTRACT_VERSION,
  PluginBundleSchema,
  PROTOCOL_VERSION,
  type InstalledPluginsSnapshot,
} from "../packages/protocol/src/index.ts";
import { checkInstalledCandidate, installedBundleFailures } from "./installed-bundles-candidate.ts";
import { fetchInstalledSnapshot } from "./installed-bundles.ts";

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

test("legacy instances without the declared export door cannot produce a false-green empty inventory", async () => {
  let posted = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      posted ||= request.method === "POST";
      return Response.json({ protocolVersion: PROTOCOL_VERSION, actions: [], plugins: [] });
    },
  });
  try {
    await expect(fetchInstalledSnapshot(server.url.origin, "test-only-token")).rejects.toThrow(
      "exportInstalled is unavailable",
    );
    expect(posted).toBe(false);
  } finally {
    await server.stop(true);
  }
});

const WorkflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      name: z.string().optional(),
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      if: z.string().optional(),
      steps: z
        .array(
          z.object({
            name: z.string().optional(),
            uses: z.string().optional(),
            run: z.string().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
    }),
  ),
});

test("both deployment switches require installed-bundles success at the selected checkout", async () => {
  for (const [file, switchJob, revision] of [
    ["deploy-dev.yml", "deploy", "${{ github.event.workflow_run.head_sha }}"],
    ["deploy-hub.yml", "clever", "${{ needs.release.outputs.sha }}"],
  ] as const) {
    const workflow = WorkflowSchema.parse(
      Bun.YAML.parse(
        await Bun.file(new URL(`../.github/workflows/${file}`, import.meta.url)).text(),
      ),
    );
    const gate = workflow.jobs["installed-bundles"]!;
    const deploy = workflow.jobs[switchJob]!;
    expect(gate.name).toBe("installed-bundles");
    expect(deploy.needs).toContain("installed-bundles");
    expect(deploy.if ?? "").not.toMatch(/always\(|failure\(|cancelled\(/);
    const checkout = gate.steps!.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe(revision);
    expect(
      gate.steps!.some((step) =>
        step.run?.includes('bun scripts/installed-bundles.ts "installed-bundles:$SHA"'),
      ),
    ).toBe(true);
  }
});
