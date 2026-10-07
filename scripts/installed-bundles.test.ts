import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARDENED_CONTRACT_VERSION,
  ISOLATE_MAX_ARTIFACT_BYTES,
  PluginBundleSchema,
  PROTOCOL_VERSION,
  type InstalledPluginsSnapshot,
} from "../packages/protocol/src/index.ts";
import {
  checkInstalledCandidate,
  crossingReview,
  installedBundleFailures,
} from "./installed-bundles-candidate.ts";
import { restorePlanDigest } from "../packages/server/src/index.ts";
import { containedIn, fetchReplacement, rollbackProjection } from "./installed-bundles.ts";

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
  expect(attempt.jobOutput).toBe("bootstrap_required=true\nreplacement_set=\nrestore_plan=\n");
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
  expect(passed.jobOutput).toBe("bootstrap_required=false\nreplacement_set=\nrestore_plan=\n");
  expect(passed.summary).toBe("");
});

/** A bundle as one SDK stamped it, so the candidate's admission judges the protocol alone. */
function stampedBundle(protocol: string, version: string): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(
    JSON.stringify({
      format: 1,
      hardenedContract: HARDENED_CONTRACT_VERSION,
      builtAgainst: { "manifold:protocol": protocol },
      manifest: {
        id: "example.candidate",
        version,
        title: "Candidate",
        description: "Crossing proof",
        capabilities: [],
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
        entry: { server: true },
      },
      files: {
        "server.js": Buffer.from("export default { actions: [], handlers: {} };").toString(
          "base64",
        ),
      },
    }),
  );
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function previousClosure(): InstalledPluginsSnapshot {
  const installed = snapshot("export default { actions: [], handlers: {} };");
  const { bytes, sha256 } = stampedBundle("56", "1.0.0");
  const bundlePath = `plugins/example.candidate/${sha256}.manifold-plugin.json`;
  const plugin = installed.plugins[0]!;
  return {
    ...installed,
    plugins: [
      {
        ...plugin,
        enabled: true,
        row: { ...plugin.row, sha256, bundlePath, source: bundlePath },
        bytes: bytes.toString("base64"),
      },
    ],
  };
}

test("a protocol-56 closure crosses with a staged replacement set on the disposable candidate (#1068)", async () => {
  const installed = previousClosure();
  await expect(checkInstalledCandidate(installed)).rejects.toThrow(
    /example\.candidate: held: repack_required/,
  );
  const next = stampedBundle(String(PROTOCOL_VERSION), "2.0.0");
  await checkInstalledCandidate(installed, {
    set: {
      format: 1,
      members: [
        {
          pluginId: "example.candidate",
          sha256: next.sha256,
          url: "https://plugins.example.invalid/example.candidate.manifold-plugin.json",
        },
      ],
    },
    revision: "c".repeat(40),
    bundles: { [next.sha256]: next.bytes.toString("base64") },
  });
}, 60_000);

test("a missing or mismatched staged replacement refuses the crossing (#1068)", async () => {
  const installed = previousClosure();
  const next = stampedBundle(String(PROTOCOL_VERSION), "2.0.0");
  const url = "https://plugins.example.invalid/example.candidate.manifold-plugin.json";
  await expect(
    checkInstalledCandidate(installed, {
      set: { format: 1, members: [{ pluginId: "example.absent", sha256: next.sha256, url }] },
      revision: "c".repeat(40),
      bundles: { [next.sha256]: next.bytes.toString("base64") },
    }),
  ).rejects.toThrow(/example\.absent: not installed/);
  const future = stampedBundle("999", "2.0.0");
  await expect(
    checkInstalledCandidate(installed, {
      set: { format: 1, members: [{ pluginId: "example.candidate", sha256: future.sha256, url }] },
      revision: "c".repeat(40),
      bundles: { [future.sha256]: future.bytes.toString("base64") },
    }),
  ).rejects.toThrow(/example\.candidate: repack_required; manifold:protocol built against 999/);
  await expect(
    checkInstalledCandidate(installed, {
      set: { format: 1, members: [{ pluginId: "example.candidate", sha256: "e".repeat(64), url }] },
      revision: "c".repeat(40),
      bundles: { ["e".repeat(64)]: next.bytes.toString("base64") },
    }),
  ).rejects.toThrow(/staged bytes do not hash/);
}, 60_000);

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

const url = "https://1.1.1.1/example.candidate.manifold-plugin.json";

function installedEntry(bundle: { bytes: Buffer; sha256: string }) {
  const bundlePath = `plugins/example.candidate/${bundle.sha256}.manifold-plugin.json`;
  return {
    row: {
      pluginId: "example.candidate",
      sha256: bundle.sha256,
      bundlePath,
      source: bundlePath,
      grantedCaps: [],
      installedBy: "source-owner",
      installedAt: 1,
      actions: [],
    },
    bytes: bundle.bytes.toString("base64"),
  };
}

test("a staged set already installed is a completed crossing, refused before the switch (#1068)", () => {
  const installed = previousClosure();
  const next = stampedBundle(String(PROTOCOL_VERSION), "2.0.0");
  const replacement = {
    set: {
      format: 1 as const,
      members: [{ pluginId: "example.candidate", sha256: next.sha256, url }],
    },
    revision: "c".repeat(40),
    bundles: { [next.sha256]: next.bytes.toString("base64") },
  };
  expect(crossingReview(installed, replacement).refusals).toEqual([]);
  const crossed = { ...installed, plugins: [{ ...installedEntry(next), enabled: true }] };
  expect(crossingReview(crossed, replacement)).toEqual({
    lines: [],
    refusals: [
      expect.stringMatching(
        /^staged set [0-9a-f]{64} is already installed; deploy without replacement_set$/,
      ),
    ],
  });
});

test("a manual rollback gate boots the target on the closure its restore yields (#1068)", async () => {
  // From the target's view, the crossed bundles are protocols it would hold.
  const current = stampedBundle("999", "3.0.0");
  const middle = stampedBundle("998", "2.0.0");
  const previous = stampedBundle(String(PROTOCOL_VERSION), "1.0.0");
  const [first, second] = ["1".repeat(40), "2".repeat(40)];
  const exported: InstalledPluginsSnapshot = {
    format: 1,
    developerMode: false,
    plugins: [{ ...installedEntry(current), enabled: false }],
    crossings: [
      {
        revision: first,
        setSha256: "a".repeat(64),
        members: [
          {
            pluginId: "example.candidate",
            sha256: middle.sha256,
            previous: installedEntry(previous),
          },
        ],
      },
      {
        revision: second,
        setSha256: "b".repeat(64),
        members: [
          {
            pluginId: "example.candidate",
            sha256: current.sha256,
            previous: installedEntry(middle),
          },
        ],
      },
    ],
  };
  // Neither crossing is in the target: both restore, newest first, to the oldest bundle, with
  // its enablement kept, and the switch binds exactly that plan.
  const both = rollbackProjection(exported, () => false);
  expect(both.restored).toEqual([second, first]);
  expect(both.snapshot).toEqual({
    format: 1,
    developerMode: false,
    plugins: [{ ...installedEntry(previous), enabled: false }],
  });
  expect(both.plan).toBe(
    restorePlanDigest([
      {
        revision: second,
        setSha256: "b".repeat(64),
        members: [
          { pluginId: "example.candidate", sha256: current.sha256, previousSha256: middle.sha256 },
        ],
      },
      {
        revision: first,
        setSha256: "a".repeat(64),
        members: [
          { pluginId: "example.candidate", sha256: middle.sha256, previousSha256: previous.sha256 },
        ],
      },
    ]),
  );
  const one = rollbackProjection(exported, (revision) => revision === first);
  expect(one.restored).toEqual([second]);
  expect(one.snapshot.plugins[0]!.row.sha256).toBe(middle.sha256);
  expect(one.plan).not.toBe(both.plan);
  expect(rollbackProjection(exported, () => true)).toMatchObject({
    restored: [],
    plan: "none",
    snapshot: { plugins: [{ row: { sha256: current.sha256 } }] },
  });
  // The target candidate holds the installed closure, and loads the one its rollback restores.
  await expect(
    checkInstalledCandidate({ format: 1, developerMode: false, plugins: exported.plugins }),
  ).rejects.toThrow(/example\.candidate: held/);
  await checkInstalledCandidate(both.snapshot);
}, 60_000);

test("rollback ancestry follows git as the host receiver does, and an unknown crossing refuses", () => {
  const repository = mkdtempSync(join(tmpdir(), "installed-bundles-ancestry-"));
  try {
    const git = (...args: string[]) => {
      const run = Bun.spawnSync(["git", "-C", repository, "-c", "commit.gpgsign=false", ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      return run.stdout.toString().trim();
    };
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "one");
    const one = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "two");
    const two = git("rev-parse", "HEAD");
    expect(containedIn(repository, two)(one)).toBe(true);
    expect(containedIn(repository, two)(two)).toBe(true);
    expect(containedIn(repository, one)(two)).toBe(false);
    expect(() => containedIn(repository, two)("f".repeat(40))).toThrow(/cannot order/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("the gate fetches staged members only under the install door's artifact policy (#1068)", async () => {
  const next = stampedBundle(String(PROTOCOL_VERSION), "2.0.0");
  const set = (source: string) => ({
    format: 1,
    members: [{ pluginId: "example.candidate", sha256: next.sha256, url: source }],
  });
  const revision = "c".repeat(40);
  const contacted: string[] = [];
  const serve = ((input: string | URL | Request): Promise<Response> => {
    contacted.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response(new Uint8Array(next.bytes)));
  }) as typeof fetch;
  // A private destination is refused before any request.
  await expect(
    fetchReplacement(
      set("https://127.0.0.1/example.candidate.manifold-plugin.json"),
      revision,
      serve,
    ),
  ).rejects.toThrow(/not ordinary public unicast/);
  expect(contacted).toEqual([]);
  // Every redirect hop meets the same policy: no downgrade to plain HTTP.
  const downgrade = ((input: string | URL | Request): Promise<Response> => {
    contacted.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(
      new Response(null, { status: 302, headers: { location: "http://1.1.1.1/bundle" } }),
    );
  }) as typeof fetch;
  await expect(fetchReplacement(set(url), revision, downgrade)).rejects.toThrow(/HTTPS/);
  expect(contacted).toEqual([url]);
  // The cap ends the read while the body streams, not after it was held whole.
  let streamed = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const oversized = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (streamed >= ISOLATE_MAX_ARTIFACT_BYTES * 2) return controller.close();
            streamed += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      ),
    )) as unknown as typeof fetch;
  await expect(fetchReplacement(set(url), revision, oversized)).rejects.toThrow(/cap/);
  expect(streamed).toBeLessThanOrEqual(ISOLATE_MAX_ARTIFACT_BYTES + 2 * chunk.byteLength);
  // A public HTTPS member serving its pinned bytes is carried exactly.
  const fetched = await fetchReplacement(set(url), revision, serve);
  expect(fetched.bundles).toEqual({ [next.sha256]: next.bytes.toString("base64") });
});
