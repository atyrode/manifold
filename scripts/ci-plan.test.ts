import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_CHECKS,
  buildDependencyGraph,
  MANDATORY_CHECKS,
  planFromEvidence,
  type Change,
  type DependencyGraph,
} from "./ci-plan.ts";

const emptyGraph: DependencyGraph = { importers: new Map(), holes: [] };
const available = (changes: readonly Change[]): ReadonlySet<string> =>
  new Set(changes.filter((change) => !change.status.startsWith("D")).map((change) => change.path));
const plan = (changes: readonly Change[], graph: DependencyGraph = emptyGraph) =>
  planFromEvidence({
    base: "base",
    head: "head",
    changes,
    graph,
    availableSources: available(changes),
  });

describe("CI impact policy", () => {
  test("the public check universe is exact, ordered, and unique", () => {
    expect(ALL_CHECKS).toEqual([
      "build",
      "types",
      "style",
      "smoke",
      "targeted",
      "trace",
      "unit",
      "e2e-rest",
      "e2e-preview-recovery",
      "convergence",
      "terminal-selection",
      "terminal-mirror",
      "tile-drop",
      "budgets",
      "pwa",
      "axioms",
      "runtime-jobs",
      "runtime-browser",
      "preview-environment",
    ]);
    expect(new Set(ALL_CHECKS).size).toBe(ALL_CHECKS.length);
  });

  test("unknown paths and dependency holes fail closed to every check", () => {
    const unknown = plan([{ status: "A", path: "mystery.binary" }]);
    expect(unknown.risk).toBe("unknown");
    expect(unknown.checks).toEqual(ALL_CHECKS);
    expect(unknown.reasons).toEqual(["unknown path mystery.binary"]);

    const hole = plan([{ status: "M", path: "packages/ui/src/panel.tsx" }], {
      importers: new Map(),
      holes: ["packages/ui/src/panel.tsx -> ./missing"],
    });
    expect(hole.risk).toBe("unknown");
    expect(hole.checks).toEqual(ALL_CHECKS);
    expect(hole.reasons[0]).toContain("dependency graph is incomplete");
  });

  test.each(["infra/new-hook.ts", "docs/executable.py"])(
    "unknown executable/source path %s cannot enter the standard lane",
    (path) => {
      const selected = plan([{ status: "A", path }]);
      expect(selected.risk).toBe("unknown");
      expect(selected.checks).toEqual(ALL_CHECKS);
    },
  );

  test.each(["D", "R100"])("%s source evidence uses the conservative full fallback", (status) => {
    const changed = plan([
      status === "D"
        ? { status, path: "packages/sdk/src/removed.ts" }
        : {
            status,
            oldPath: "packages/sdk/src/old.ts",
            path: "packages/sdk/src/new.ts",
          },
    ]);
    expect(changed.risk).toBe("unknown");
    expect(changed.checks).toEqual(ALL_CHECKS);
    expect(changed.reasons).toEqual([
      "deleted or renamed input makes dependency evidence incomplete",
    ]);
  });

  test("a changed dependency transitively reaching auth cannot evade high-risk checks", () => {
    const graph: DependencyGraph = {
      holes: [],
      importers: new Map([
        ["packages/ui/src/base.ts", new Set(["packages/sdk/src/bridge.ts"])],
        ["packages/sdk/src/bridge.ts", new Set(["packages/server/src/auth.ts"])],
      ]),
    };
    const selected = plan([{ status: "M", path: "packages/ui/src/base.ts" }], graph);
    expect(selected.risk).toBe("high");
    expect(selected.checks).toEqual(
      expect.arrayContaining(["trace", "unit", "e2e-rest", "axioms"]),
    );
    expect(selected.reasons).toContain(
      "authorization boundary: packages/ui/src/base.ts -> packages/sdk/src/bridge.ts -> packages/server/src/auth.ts",
    );
  });

  test("flattened binding provenance reaches the consumer from the original dependency", () => {
    const graph: DependencyGraph = {
      holes: [],
      importers: new Map([
        ["packages/ui/src/change.ts", new Set(["packages/ui/src/intermediate.ts"])],
      ]),
      provenanceImporters: new Map([
        ["packages/ui/src/change.ts", new Set(["packages/server/src/auth.ts"])],
      ]),
    };
    const selected = plan([{ status: "M", path: "packages/ui/src/change.ts" }], graph);
    expect(selected.risk).toBe("high");
    expect(selected.checks).toEqual(
      expect.arrayContaining(["trace", "unit", "e2e-rest", "axioms"]),
    );
  });

  test("transitively affected consumer tests are included in focused regressions", () => {
    const graph: DependencyGraph = {
      holes: [],
      importers: new Map([
        ["packages/ui/src/helper.ts", new Set(["packages/web/src/helper.test.ts"])],
      ]),
    };
    const selected = plan([{ status: "M", path: "packages/ui/src/helper.ts" }], graph);
    expect(selected.unitPaths).toEqual(["packages/ui", "packages/web/src/helper.test.ts"]);
  });

  test.each([
    [
      "packages/server/src/http.ts",
      ["trace", "unit", "e2e-rest", "axioms"],
      "authorization boundary",
    ],
    [
      "packages/server/test/auth.test.ts",
      ["trace", "unit", "e2e-rest", "axioms"],
      "authorization boundary",
    ],
    [
      "packages/server/src/room.ts",
      ["unit", "e2e-rest", "e2e-preview-recovery", "convergence", "axioms"],
      "persistence boundary",
    ],
  ] as const)("semantic boundary root %s selects its existing proof", (path, checks, reason) => {
    const selected = plan([{ status: "M", path }]);
    expect(selected.risk).toBe("high");
    expect(selected.checks).toEqual(expect.arrayContaining(checks));
    expect(selected.reasons.some((entry) => entry.startsWith(reason))).toBe(true);
  });

  test("frontend registration and identity presentation do not impersonate authority", () => {
    const graph: DependencyGraph = {
      holes: [],
      importers: new Map(),
      directImporters: new Map([
        ["packages/plugins/presence/src/web.tsx", new Set(["packages/web/src/assembly.ts"])],
        ["packages/web/src/assembly.ts", new Set(["packages/web/src/api.ts"])],
        ["packages/web/src/api.ts", new Set(["packages/web/src/identity.tsx"])],
      ]),
    };
    const selected = plan([{ status: "M", path: "packages/plugins/presence/src/web.tsx" }], graph);
    expect(selected.risk).toBe("standard");
    expect(selected.checks).toEqual(MANDATORY_CHECKS);
  });

  test.each(["packages/web/src/identity.tsx", "packages/web/src/api.ts"])(
    "browser credential boundary %s is high risk",
    (path) => {
      const selected = plan([{ status: "M", path }]);
      expect(selected.risk).toBe("high");
      expect(selected.checks).toEqual(
        expect.arrayContaining(["trace", "unit", "e2e-rest", "axioms"]),
      );
    },
  );

  test("a real credential helper dependency remains high through semantic traversal", () => {
    const graph: DependencyGraph = {
      holes: [],
      importers: new Map([
        ["packages/web/src/credential-helper.ts", new Set(["packages/web/src/identity.tsx"])],
      ]),
    };
    const selected = plan([{ status: "M", path: "packages/web/src/credential-helper.ts" }], graph);
    expect(selected.risk).toBe("high");
  });

  test("the real access manifest remains high risk through assembly binding provenance", async () => {
    const graph = await buildDependencyGraph();
    const selected = plan([{ status: "M", path: "packages/plugins/access/src/index.ts" }], graph);
    expect(selected.risk).toBe("high");
    expect(selected.checks).toEqual(
      expect.arrayContaining(["trace", "unit", "e2e-rest", "axioms"]),
    );
    expect(selected.reasons.some((reason) => reason.startsWith("authorization boundary"))).toBe(
      true,
    );
  });

  test.each([
    "packages/sdk/src/action-http.ts",
    "packages/sdk/src/action-runner.ts",
    "packages/sdk/src/action-runner-main.ts",
  ])("SDK credential and action execution root %s is high risk", (path) => {
    const selected = plan([{ status: "M", path }]);
    expect(selected.risk).toBe("high");
    expect(selected.checks).toEqual(
      expect.arrayContaining(["trace", "unit", "e2e-rest", "axioms"]),
    );
  });

  test("affected runnable tests are targeted without treating fixtures or tests as production risk", () => {
    const graph: DependencyGraph = {
      holes: [],
      importers: new Map([
        [
          "packages/ui/src/chip.tsx",
          new Set([
            "packages/web/src/room-pipes.test.ts",
            "packages/plugin-kit/test/fixtures/in-realm/web.ts",
          ]),
        ],
      ]),
    };
    const selected = plan([{ status: "M", path: "packages/ui/src/chip.tsx" }], graph);
    expect(selected.risk).toBe("standard");
    expect(selected.checks).toEqual(MANDATORY_CHECKS);
    expect(selected.unitPaths).toEqual(["packages/ui", "packages/web/src/room-pipes.test.ts"]);
  });

  test("a dependency imported by deployment tooling selects the complete plan", () => {
    const graph: DependencyGraph = {
      holes: [],
      importers: new Map([
        ["packages/protocol/src/version.ts", new Set(["scripts/release-core.ts"])],
      ]),
    };
    const selected = plan([{ status: "M", path: "packages/protocol/src/version.ts" }], graph);
    expect(selected.risk).toBe("high");
    expect(selected.checks).toEqual(ALL_CHECKS);
    expect(selected.reasons).toEqual([
      "deployment dependency: packages/protocol/src/version.ts -> scripts/release-core.ts",
    ]);
  });

  test.each([
    ["packages/web/src/styles.css", "packages/web"],
    ["packages/plugins/notes/src/panel.tsx", "packages/plugins/notes"],
  ] as const)("ordinary rendering change %s stays fast and focused", (path, unitPath) => {
    const selected = plan([{ status: "M", path }]);
    expect(selected.risk).toBe("standard");
    expect(selected.checks).toEqual(MANDATORY_CHECKS);
    expect(selected.unitPaths).toEqual([unitPath]);
  });

  test("CI and toolchain inputs always select a complete high-risk plan", () => {
    const selected = plan([{ status: "M", path: ".github/workflows/ci.yml" }]);
    expect(selected.risk).toBe("high");
    expect(selected.checks).toEqual(ALL_CHECKS);
  });
});

describe("ci-plan CLI", () => {
  const executable = join(import.meta.dir, "ci-plan.ts");

  test("--full emits the versioned JSON contract without requiring PR diff evidence", async () => {
    const child = Bun.spawn([process.execPath, executable, "--full", "--json"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output["version"]).toBe(1);
    expect(output["checks"]).toEqual(ALL_CHECKS);
  });

  test("an invalid explicit revision fails closed rather than emitting an empty plan", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        executable,
        "--base",
        "refs/heads/not-a-real-ci-base",
        "--head",
        "HEAD",
        "--json",
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("ci-plan: git rev-parse failed");
  });

  test("explicit historical head cannot borrow the current checkout graph", async () => {
    const child = Bun.spawn(
      [process.execPath, executable, "--base", "HEAD^", "--head", "HEAD^", "--json"],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("is not the analyzed checkout");
  });

  test("precomputed targeted paths execute without recomputing a plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "manifold-ci-targeted-"));
    const bin = join(root, "bin");
    const log = join(root, "args.json");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "bun"),
      `#!${process.execPath}
await Bun.write(Bun.env["TARGET_LOG"], JSON.stringify(Bun.argv.slice(2)));
`,
      { mode: 0o755 },
    );
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          executable,
          "--run-targeted",
          "--unit-paths-json",
          JSON.stringify(["packages/protocol/test"]),
        ],
        {
          cwd: join(import.meta.dir, ".."),
          env: { ...process.env, PATH: bin, TARGET_LOG: log },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(readFileSync(log, "utf8"))).toEqual(["test", "packages/protocol/test"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["[]", "nonempty array"],
    [JSON.stringify(["../outside.test.ts"]), "unsafe targeted test path"],
    [JSON.stringify(["packages/server/src/main.ts"]), "not a package or runnable test"],
    [JSON.stringify(["packages/no-such-package"]), "does not exist"],
  ])("rejects unsafe precomputed targeted input %#", async (json, diagnostic) => {
    const child = Bun.spawn(
      [process.execPath, executable, "--run-targeted", "--unit-paths-json", json],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(diagnostic);
  });

  test("--github-output exports targeted paths from the same plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "manifold-ci-output-"));
    const output = join(root, "output");
    const summary = join(root, "summary");
    try {
      const child = Bun.spawn(
        [process.execPath, executable, "--base", "HEAD", "--head", "HEAD", "--github-output"],
        {
          cwd: join(import.meta.dir, ".."),
          env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(readFileSync(output, "utf8")).toContain('unitPaths=["packages/protocol/test"]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
