import { basename, dirname } from "node:path";
import { closeSync, fstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { HeldDirectory } from "./job-files.ts";
import { JobJournal } from "./job-journal.ts";
import { MachineJobOwner } from "./job-owner.ts";
import { JobOutputStore } from "./job-outputs.ts";
import { type LinuxJobBind } from "./job-linux.ts";
import { DirectoryExclusions } from "./job-locations.ts";

const absolute = z
  .string()
  .startsWith("/")
  .max(4096)
  .refine((value) => !value.includes("\0"));
const ConfigSchema = z.strictObject({
  machineId: z.string().min(1).max(128),
  admissionPublicKey: z.string().min(1).max(4096),
  stateDirectory: absolute,
  delegatedCgroup: absolute,
  bubblewrap: absolute,
  protectedDirectories: z.array(absolute).max(32),
  anchors: z.partialRecord(
    z.enum(["home", "data", "state", "cache", "config", "runtime"]),
    absolute,
  ),
  runtimeTools: z
    .record(
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      z
        .array(
          z.strictObject({
            source: absolute,
            target: absolute,
            kind: z.enum(["file", "directory"]),
          }),
        )
        .min(1)
        .max(128),
    )
    .refine((tools) => Object.keys(tools).length <= 128),
  artifactOrigins: z
    .array(
      z
        .url()
        .refine((value) => new URL(value).protocol === "https:" && new URL(value).origin === value),
    )
    .min(1)
    .max(128),
});

/** Opens reviewed local config through held descriptors. No job RPC can modify this authority. */
export async function openConfiguredJobOwner(
  configPath: string,
  socketPath: string,
  terminalSocketPath: string,
): Promise<MachineJobOwner> {
  const parent = HeldDirectory.openAbsolute(dirname(configPath), { private: true });
  const configFd = parent.openFile(basename(configPath));
  let config: z.infer<typeof ConfigSchema>;
  try {
    const stat = fstatSync(configFd);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.size > 65536)
      throw new Error("unsafe_job_owner_configuration");
    config = ConfigSchema.parse(JSON.parse(readFileSync(configFd, "utf8")));
  } finally {
    closeSync(configFd);
  }
  const state = HeldDirectory.openAbsolute(config.stateDirectory, { private: true });
  const protectedDirectories = [
    state,
    parent,
    HeldDirectory.openAbsolute(dirname(socketPath), { private: true }),
    HeldDirectory.openAbsolute(dirname(terminalSocketPath), { private: true }),
    ...config.protectedDirectories.map((path) => HeldDirectory.openAbsolute(path)),
  ];
  const exclusions = new DirectoryExclusions(protectedDirectories);
  const journal = new JobJournal(state.openChild("journal", { create: true }));
  const cache = state.openChild("artifacts", { create: true });
  const outputs = JobOutputStore.open(state.openChild("outputs", { create: true }));
  const delegatedCgroup = HeldDirectory.openAbsolute(config.delegatedCgroup);
  const bwrapParent = HeldDirectory.openAbsolute(dirname(config.bubblewrap));
  const bubblewrapFd = bwrapParent.openFile(basename(config.bubblewrap));
  bwrapParent.close();
  const anchors: Record<string, HeldDirectory> = {};
  for (const [name, path] of Object.entries(config.anchors))
    anchors[name] = HeldDirectory.openAbsolute(path);
  const runtimeTools: Record<string, LinuxJobBind[]> = {};
  for (const [tool, definitions] of Object.entries(config.runtimeTools)) {
    runtimeTools[tool] = definitions.map((definition) => {
      if (definition.kind === "directory") {
        const source = HeldDirectory.openAbsolute(definition.source);
        try {
          exclusions.assertSource(source.fd, true);
        } catch (error) {
          source.close();
          throw error;
        }
        return { fd: source.fd, target: definition.target, writable: false };
      }
      const sourceParent = HeldDirectory.openAbsolute(dirname(definition.source));
      try {
        exclusions.assertSource(sourceParent.fd, false);
        return {
          fd: sourceParent.openFile(basename(definition.source)),
          target: definition.target,
          writable: false,
        };
      } finally {
        sourceParent.close();
      }
    });
  }
  return MachineJobOwner.open({
    machineId: config.machineId,
    admissionPublicKey: config.admissionPublicKey,
    journal,
    cache,
    outputs,
    delegatedCgroup,
    bubblewrapFd,
    anchors,
    protectedDirectories,
    runtimeTools,
    artifactAuthority: { origins: config.artifactOrigins, maxRedirects: 5, timeoutMs: 60_000 },
  });
}
