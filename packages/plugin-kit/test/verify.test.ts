import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PluginBundleSchema } from "@manifold/protocol";
import { dispatch, roster } from "../src/hub.ts";
import { familyOrder, inspectBundle, installBundle } from "../src/install.ts";
import { canSpawnServer, startServer, verifyBundles, VerifyFailure } from "../src/verify.ts";

/**
 * `verify` AND `install` AGAINST A REAL SERVER, the way an author repository runs them: the
 * sample is packed by the command (a second process, as in pack.test.ts), then handed to the
 * exported functions, which spawn this checkout's engine themselves. Skipped when this file
 * has been copied out of a manifold checkout and there is no server entry to spawn.
 */

const KIT = `${import.meta.dir}/..`;
const SAMPLE = `${import.meta.dir}/fixtures/sample`;
const ROWS = `${import.meta.dir}/fixtures/rows`;
const PLUGIN_ID = "example.counter";
const ROWS_ID = "example.rows";
const PART_ID = `${PLUGIN_ID}.part`;
const CLIENT_ID = "example.client";
const E2E_TIMEOUT_MS = 90_000;

let dir = "";
let bundle = "";
let rowsBundle = "";
let part = "";
let client = "";

/** Packs one fixture directory the way an author's release would: the command, a second process. */
async function pack(source: string, out: string): Promise<void> {
  const command = Bun.spawn(
    ["bun", `${KIT}/src/pack.ts`, source, "--out", out, "--self-contained"],
    {
      cwd: KIT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, code] = await Promise.all([new Response(command.stderr).text(), command.exited]);
  if (code !== 0) throw new Error(`pack exited ${String(code)}: ${stderr}`);
}

beforeAll(async () => {
  dir = mkdtempSync(`${tmpdir()}/plugin-kit-verify-`);
  bundle = `${dir}/${PLUGIN_ID}.manifold-plugin.json`;
  rowsBundle = `${dir}/${ROWS_ID}.manifold-plugin.json`;
  part = `${dir}/${PART_ID}.manifold-plugin.json`;
  client = `${dir}/${CLIENT_ID}.manifold-plugin.json`;
  for (const [source, output] of [
    [SAMPLE, bundle],
    [ROWS, rowsBundle],
    [`${SAMPLE}/part`, part],
    [`${import.meta.dir}/fixtures/client`, client],
  ] as const) {
    await pack(source, output);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!canSpawnServer())(
  "verify installs the sample, knocks on its door, and uninstalls it",
  async () => {
    const reports = await verifyBundles([bundle], undefined, { hardened: true });
    expect(reports).toEqual([
      {
        bundle,
        id: PLUGIN_ID,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        // `{}` is a legal bump (the step defaults), so the door answered a result.
        doors: { [`${PLUGIN_ID}.bump`]: "ok" },
      },
    ]);
  },
  E2E_TIMEOUT_MS,
);

test("inspection retains only required ids for ordering, not optional, incompatible or after", async () => {
  const parsed = PluginBundleSchema.parse(await Bun.file(client).json());
  const source = `${dir}/relationships.manifold-plugin.json`;
  await Bun.write(
    source,
    JSON.stringify({
      ...parsed,
      manifest: {
        ...parsed.manifest,
        dependencies: {
          ...parsed.manifest.dependencies,
          "example.optional": { type: "optional" },
          "example.incompatible": { type: "incompatible" },
        },
        after: ["example.after"],
      },
    }),
  );
  const facts = await inspectBundle(source);
  expect(facts.requiredDependencies).toEqual([PLUGIN_ID, PART_ID]);
  const supplied = await Promise.all([inspectBundle(part), inspectBundle(bundle)]);
  expect(
    familyOrder([
      facts,
      ...supplied,
      { id: "example.optional" },
      { id: "example.incompatible" },
      { id: "example.after" },
    ]).map((entry) => entry.id),
  ).toEqual([
    "example.after",
    PLUGIN_ID,
    "example.incompatible",
    "example.optional",
    PART_ID,
    CLIENT_ID,
  ]);
});

test.skipIf(!canSpawnServer())(
  "generic verify installs real upstream root and part before a cross-family client and removes in reverse",
  async () => {
    // No prerequisite substitutions: each bundle was packed from its own real source above.
    // Hardened verification exercises the authored guest entry as installed from the bundle.
    // The native disable door refuses a prerequisite while an enabled consumer still needs it,
    // so returning successfully also proves the verifier's reverse uninstall traversal.
    const reports = await verifyBundles([client, part, bundle], undefined, { hardened: true });
    expect(reports.map((report) => ({ id: report.id, doors: report.doors }))).toEqual([
      { id: PLUGIN_ID, doors: { [`${PLUGIN_ID}.bump`]: "ok" } },
      { id: PART_ID, doors: { [`${PART_ID}.snapshot`]: "ok" } },
      { id: CLIENT_ID, doors: { [`${CLIENT_ID}.check`]: "ok" } },
    ]);
  },
  E2E_TIMEOUT_MS,
);

test.skipIf(!canSpawnServer())(
  "duplicate identities refuse before even the first valid bundle installs",
  async () => {
    const reported: string[] = [];
    let refusal: unknown;
    try {
      await verifyBundles([bundle, bundle], (report) => reported.push(report.id), {
        hardened: true,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(VerifyFailure);
    expect(refusal).toMatchObject({
      bundle,
      cause: { reason: "duplicate", ids: [PLUGIN_ID] },
    });
    expect(reported).toEqual([]);
  },
  E2E_TIMEOUT_MS,
);

test.skipIf(!canSpawnServer())(
  "a dependency cycle refuses before an independent valid bundle can install",
  async () => {
    const cycle: string[] = [];
    for (const [id, dependency] of [
      ["example.zcyclea", "example.zcycleb"],
      ["example.zcycleb", "example.zcyclea"],
    ] as const) {
      const source = `${dir}/${id}.manifold-plugin.json`;
      await Bun.write(
        source,
        JSON.stringify({
          format: 1,
          manifest: {
            id,
            version: "1.0.0",
            title: "Cyclic bundle",
            description: "A required dependency cycle must fail before delivery.",
            capabilities: [],
            contributes: {},
            dependencies: { [dependency]: { type: "required" } },
            entry: { web: "web.js" },
          },
          files: { "web.js": Buffer.from("export const cyclic = true;").toString("base64") },
        }),
      );
      cycle.push(source);
    }
    const reported: string[] = [];
    let refusal: unknown;
    try {
      await verifyBundles([bundle, ...cycle], (report) => reported.push(report.id), {
        hardened: true,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(VerifyFailure);
    expect(refusal).toMatchObject({
      bundle: cycle[0],
      cause: { reason: "cycle", ids: ["example.zcyclea", "example.zcycleb"] },
    });
    expect(reported).toEqual([]);
  },
  E2E_TIMEOUT_MS,
);

test.skipIf(!canSpawnServer())(
  "a required bundle omitted from verify remains a native availability refusal",
  async () => {
    await expect(verifyBundles([client], undefined, { hardened: true })).rejects.toThrow(
      "artifact_invalid",
    );
  },
  E2E_TIMEOUT_MS,
);

test.skipIf(!canSpawnServer())(
  "verify names the bundle when its bytes are not a bundle",
  async () => {
    const broken = `${dir}/broken.manifold-plugin.json`;
    await Bun.write(broken, "{}");
    await expect(verifyBundles([broken])).rejects.toBeInstanceOf(VerifyFailure);
  },
  E2E_TIMEOUT_MS,
);

test.skipIf(!canSpawnServer())(
  "install is installed, then unchanged, then replaced as the bytes move",
  async () => {
    const server = await startServer();
    try {
      const first = await installBundle({ source: bundle, hub: server, hardened: true });
      expect(first.outcome).toBe("installed");
      expect(first.hub).toBe(server.url);
      expect((await installBundle({ source: bundle, hub: server, hardened: true })).outcome).toBe(
        "unchanged",
      );

      // The same plugin with one manifest field moved: a different sha under the same id.
      const parsed = PluginBundleSchema.parse(await Bun.file(bundle).json());
      const edited = `${dir}/edited.manifold-plugin.json`;
      await Bun.write(
        edited,
        JSON.stringify({ ...parsed, manifest: { ...parsed.manifest, title: "Edited counter" } }),
      );
      const second = await installBundle({ source: edited, hub: server, hardened: true });
      expect(second.outcome).toBe("replaced");
      expect(second.sha256).not.toBe(first.sha256);

      const row = (await roster(server)).find((entry) => entry.manifest.id === PLUGIN_ID);
      expect(row?.enabled).toBe(true);
      expect(row?.lifecycle).toBeUndefined();
      expect(row?.install?.sha256).toBe(second.sha256);
      expect(row?.manifest.title).toBe("Edited counter");
    } finally {
      await server.stop();
    }
  },
  E2E_TIMEOUT_MS,
);

test.skipIf(!canSpawnServer())(
  "install replaces a parent while an enabled part requires it, and leaves both on",
  async () => {
    const server = await startServer();
    try {
      expect((await installBundle({ source: bundle, hub: server, hardened: true })).outcome).toBe(
        "installed",
      );

      // Install the independently packed part, not a renamed copy of the parent's code.
      const parsed = PluginBundleSchema.parse(await Bun.file(bundle).json());
      expect((await installBundle({ source: part, hub: server, hardened: true })).outcome).toBe(
        "installed",
      );

      // Replacement preserves both enablement choices without invoking the destructive
      // disable path merely to change the parent's bytes.
      const edited = `${dir}/edited-parent.manifold-plugin.json`;
      await Bun.write(
        edited,
        JSON.stringify({ ...parsed, manifest: { ...parsed.manifest, title: "Edited parent" } }),
      );
      const replaced = await installBundle({ source: edited, hub: server, hardened: true });
      expect(replaced.outcome).toBe("replaced");

      const rows = await roster(server);
      const parent = rows.find((entry) => entry.manifest.id === PLUGIN_ID);
      const child = rows.find((entry) => entry.manifest.id === PART_ID);
      expect(parent?.enabled).toBe(true);
      expect(parent?.lifecycle).toBeUndefined();
      expect(parent?.install?.sha256).toBe(replaced.sha256);
      expect(child?.enabled).toBe(true);
      expect(child?.lifecycle).toBeUndefined();
      expect(child?.refusal).toBeUndefined();
    } finally {
      await server.stop();
    }
  },
  E2E_TIMEOUT_MS,
);

test.skipIf(!canSpawnServer())(
  "verify drives a declaring plugin's own tables end to end, and the purge takes the file",
  async () => {
    /*
      THE WHOLE DATABASE PATH, in one spawned engine (ADR 0034): the manifest declares
      `database`, the guest runtime hands the child a `ctx.database`, every call crosses the
      ipc boundary as `database.query`/`run`/`batch`, and the engine answers each against the
      plugin's own file. `kept: 3` is the proof of the batch rule — one row from `run`, two
      from the batch that commits, NONE from the batch whose second statement fails, because
      a batch is the transaction and a failed one rolls back whole.
     */
    const reports = await verifyBundles([rowsBundle], undefined, { hardened: true });
    expect(reports).toEqual([
      {
        bundle: rowsBundle,
        id: ROWS_ID,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        doors: { [`${ROWS_ID}.records`]: "ok" },
        databaseBytes: expect.any(Number),
      },
    ]);
    expect(reports[0]?.databaseBytes ?? 0).toBeGreaterThan(0);

    // The door's own answer, read through a second run's dispatch: `verify` reports the rung,
    // so the count and the rollback are asserted where the result is visible.
    const server = await startServer();
    try {
      await installBundle({ source: rowsBundle, hub: server, hardened: true });
      const outcome = await dispatch(server, server.ownerKey, `${ROWS_ID}.records`, {});
      expect(outcome).toEqual({ ok: true, result: { kept: 3, rolledBack: true } });
    } finally {
      await server.stop();
    }
  },
  E2E_TIMEOUT_MS,
);
