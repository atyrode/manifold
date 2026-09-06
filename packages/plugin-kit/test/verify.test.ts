import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PluginBundleSchema } from "@manifold/protocol";
import { roster } from "../src/hub.ts";
import { installBundle } from "../src/install.ts";
import { canSpawnServer, startServer, verifyBundles, VerifyFailure } from "../src/verify.ts";

/**
 * `verify` AND `install` AGAINST A REAL SERVER, the way an author repository runs them: the
 * sample is packed by the command (a second process, as in pack.test.ts), then handed to the
 * exported functions, which spawn this checkout's engine themselves. Skipped when this file
 * has been copied out of a manifold checkout and there is no server entry to spawn.
 */

const KIT = `${import.meta.dir}/..`;
const SAMPLE = `${import.meta.dir}/fixtures/sample`;
const PLUGIN_ID = "example.counter";
const PART_ID = `${PLUGIN_ID}.part`;
const E2E_TIMEOUT_MS = 90_000;

let dir = "";
let bundle = "";

beforeAll(async () => {
  dir = mkdtempSync(`${tmpdir()}/plugin-kit-verify-`);
  bundle = `${dir}/${PLUGIN_ID}.manifold-plugin.json`;
  const command = Bun.spawn(
    ["bun", `${KIT}/src/pack.ts`, SAMPLE, "--out", bundle, "--self-contained"],
    {
      cwd: KIT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, code] = await Promise.all([new Response(command.stderr).text(), command.exited]);
  if (code !== 0) throw new Error(`pack exited ${String(code)}: ${stderr}`);
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

      // A part (ADR 0023): the sample's web half under `example.counter.part`, declaring the
      // parent `required`. Web-only, so the engine has no process to spawn for it.
      const parsed = PluginBundleSchema.parse(await Bun.file(bundle).json());
      const webFile = parsed.manifest.entry?.web ?? "web.js";
      const part = `${dir}/${PART_ID}.manifold-plugin.json`;
      await Bun.write(
        part,
        JSON.stringify({
          ...parsed,
          manifest: {
            id: PART_ID,
            version: "1.0.0",
            title: "Example counter part",
            description: "A part of the reference plugin, here to require its parent.",
            capabilities: [],
            contributes: { panels: [{ id: "part", title: "Part" }] },
            dependencies: { [PLUGIN_ID]: { type: "required" } },
            entry: { web: webFile },
          },
          files: { [webFile]: parsed.files[webFile] },
        }),
      );
      expect((await installBundle({ source: part, hub: server, hardened: true })).outcome).toBe(
        "installed",
      );

      // Switching the parent off alone is refused by the engine while the part is on; the
      // replace path takes the part down first and brings both back.
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
