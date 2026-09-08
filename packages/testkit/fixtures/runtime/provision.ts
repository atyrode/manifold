import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  JobDescriptionSchema,
  MachineHalfSchema,
  formatManifoldUri,
  type Cap,
  type ManifoldRef,
} from "@manifold/protocol";
import { z } from "zod";
import {
  enrollMachine,
  ownerAction,
  startAgent,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../../src/index.ts";
import { PLUGIN, OPERATION, LOCATION, limits } from "./shared.ts";

const REPO = resolve(import.meta.dir, "../../../..");
export interface RuntimeFixture {
  readonly machineId: string;
  readonly artifactSha256: string;
  starts(): string[];
  release(id: string): void;
  consent(cap: Cap, enabled: boolean, resource?: boolean): Promise<void>;
  startAgent(): Promise<TestAgent>;
  startOwner(): Promise<Bun.Subprocess<"ignore", "ignore", "ignore">>;
}
export async function provisionRuntime(
  server: TestServer,
  root: string,
  delegatedCgroup: string,
): Promise<RuntimeFixture> {
  const control = join(root, "control");
  const state = join(control, "state");
  const workspace = join(root, "workspace");
  const witness = join(workspace, "witness");
  for (const path of [control, state, join(state, "artifacts"), workspace, witness])
    mkdirSync(path, { mode: 0o700 });
  const enrollment = await enrollMachine(server, "jobs-browser-proof");
  const machineId = enrollment.machineId;
  const executable = Buffer.from(
    [
      "#!/bin/busybox sh",
      'printf "%s\\n" "$1" >> /home/job/witness/starts',
      'while test ! -f "/home/job/witness/release-$1"; do /bin/busybox sleep 0.02; done',
      "if test -t 0 || test -t 1 || test -t 2; then exit 99; fi",
      'printf \'{"kind":"runtime.result/1","value":42,"pty":false}\\n\'',
      "printf diagnostic >&2",
      "exit 7",
      "",
    ].join("\n"),
  );
  const sha256 = createHash("sha256").update(executable).digest("hex");
  writeFileSync(join(state, "artifacts", `${sha256}-${sha256}`), executable, { mode: 0o500 });
  const machine = MachineHalfSchema.parse({
    artifacts: {
      [`linux-${process.arch}`]: {
        url: "https://example.invalid/runtime-fixture",
        sha256,
        format: "raw",
        entry: ["fixture"],
        entrySha256: sha256,
        maxBytes: executable.length,
        maxExpandedBytes: executable.length,
        maxMembers: 1,
      },
    },
    locations: {
      [LOCATION]: {
        anchor: "data",
        components: ["witness"],
        revision: "r1",
        kind: "directory",
        guestPath: "/home/job/witness",
      },
    },
    operations: {
      [OPERATION]: {
        argv: [{ input: "label" }],
        input: { label: { type: "string", required: true, maxLength: 64 } },
        runtimeTools: ["busybox"],
        locations: [{ locationId: LOCATION, access: "write" }],
        outputs: [],
        network: "none",
        limits,
        stdin: false,
      },
    },
  });
  const pluginDir = join(root, "plugin");
  cpSync(import.meta.dir, pluginDir, { recursive: true });
  const modules = join(root, "node_modules");
  mkdirSync(join(modules, "@manifold"), { recursive: true });
  symlinkSync(join(REPO, "packages/plugin-kit"), join(modules, "@manifold/plugin-kit"), "dir");
  symlinkSync(join(REPO, "packages/protocol"), join(modules, "@manifold/protocol"), "dir");
  symlinkSync(join(REPO, "node_modules/zod"), join(modules, "zod"), "dir");
  const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({ ...manifest, machine }), {
    mode: 0o600,
  });
  const pack = Bun.spawn(
    [
      process.execPath,
      join(REPO, "packages/plugin-kit/src/pack.ts"),
      pluginDir,
      "--out",
      join(control, "fixture.json"),
      "--self-contained",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(pack.stdout).text(),
    new Response(pack.stderr).text(),
    pack.exited,
  ]);
  if (exit !== 0) throw new Error(`runtime fixture packing failed: ${stderr}`);
  const packed = z.object({ file: z.string(), sha256: z.string() }).parse(JSON.parse(stdout));
  await ownerAction(server, "engine.plugins.install", {
    source: packed.file,
    sha256: packed.sha256,
    hardened: true,
  });
  const installation = {
    machineId,
    pluginId: PLUGIN,
    installationRevision: "r1",
    artifactSha256: sha256,
  };
  await ownerAction(server, "engine.jobs.install", { ...installation, machine });
  const socket = join(control, "owner.sock");
  const config = join(control, "owner.json");
  // Bootstrap the remote owner's verifier through ordinary authenticated inspection.
  const { admissionPublicKey } = JobDescriptionSchema.parse(
    await ownerAction(server, "engine.jobs.describe", { machineId, pluginId: PLUGIN }),
  );
  writeFileSync(
    config,
    JSON.stringify({
      machineId,
      admissionPublicKey,
      stateDirectory: state,
      delegatedCgroup,
      bubblewrap: realpathSync(process.env.MANIFOLD_TEST_BWRAP!),
      protectedDirectories: [control],
      anchors: { data: workspace },
      runtimeTools: {
        busybox: [
          {
            source: realpathSync(process.env.MANIFOLD_TEST_STATIC_BUSYBOX!),
            target: "/bin/busybox",
            kind: "file",
          },
        ],
      },
      artifactOrigins: ["https://example.invalid"],
    }),
    { mode: 0o600 },
  );
  return {
    machineId,
    artifactSha256: sha256,
    starts: () =>
      existsSync(join(witness, "starts"))
        ? readFileSync(join(witness, "starts"), "utf8").trimEnd().split("\n")
        : [],
    release: (id: string) =>
      writeFileSync(join(witness, `release-${id}`), "release", { mode: 0o600 }),
    consent: async (cap: Cap, enabled: boolean, resource = false) => {
      // Native installation binds the canonical manifest revision, replacing the bootstrap
      // revision. Consent must follow the observed installation, never a stale fixture seed.
      const description = JobDescriptionSchema.parse(
        await ownerAction(server, "engine.jobs.describe", { machineId, pluginId: PLUGIN }),
      );
      if (description.installation === null)
        throw new Error("runtime fixture has no observed installation for consent");
      const node: ManifoldRef = resource
        ? { kind: "location", machineId, locationId: LOCATION }
        : { kind: "operation", machineId, operationId: OPERATION };
      await ownerAction(server, "engine.jobs.consent", {
        machineId,
        pluginId: PLUGIN,
        installationRevision: description.installation.revision,
        artifactSha256: description.installation.artifactSha256,
        cap,
        enabled,
        node: formatManifoldUri(node),
      });
    },
    startAgent: () =>
      startAgent({
        serverUrl: server.url,
        machineToken: enrollment.machineToken,
        name: "jobs-browser-proof",
        env: { MANIFOLD_JOB_OWNER_SOCKET: socket },
      }),
    async startOwner() {
      const owner = Bun.spawn([process.execPath, "packages/agent/src/main.ts", "--job-owner"], {
        cwd: REPO,
        env: {
          ...process.env,
          MANIFOLD_JOB_OWNER_SOCKET: socket,
          MANIFOLD_JOB_OWNER_CONFIG: config,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await waitFor(
          () => {
            if (owner.exitCode !== null)
              throw new Error(`UNVERIFIED: Linux job owner exited ${owner.exitCode}`);
            return existsSync(socket);
          },
          20_000,
          20,
        );
      } catch (error) {
        owner.kill("SIGKILL");
        await owner.exited;
        throw error;
      }
      return owner;
    },
  };
}
