import { basename, dirname } from "node:path";
import { closeSync, fstatSync, readFileSync } from "node:fs";
import { JobOwnerConfigSchema, type JobOwnerConfig } from "@manifold/protocol";
import { HeldDirectory } from "./job-files.ts";
import { JobJournal } from "./job-journal.ts";
import { MachineJobOwner } from "./job-owner.ts";
import { JobOutputStore } from "./job-outputs.ts";
import { type LinuxJobBind } from "./job-linux.ts";
import { DirectoryExclusions } from "./job-locations.ts";

/** Opens reviewed local config through held descriptors. No job RPC can modify this authority. */
export async function openConfiguredJobOwner(
  configPath: string,
  socketPath: string,
  terminalSocketPath: string,
): Promise<MachineJobOwner> {
  const parent = HeldDirectory.openAbsolute(dirname(configPath), { private: true });
  const configFd = parent.openFile(basename(configPath));
  let config: JobOwnerConfig;
  try {
    const stat = fstatSync(configFd);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.size > 65536)
      throw new Error("unsafe_job_owner_configuration");
    config = JobOwnerConfigSchema.parse(JSON.parse(readFileSync(configFd, "utf8")));
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
  const serviceCredentials = new Map<string, { fd: number; origins: readonly string[] }>();
  for (const [ref, credential] of Object.entries(config.serviceCredentials ?? {})) {
    const directory = HeldDirectory.openAbsolute(dirname(credential.source));
    // Existing secret stores may be root-managed and traversable. Only trusted
    // writers may control the source name; the credential itself must stay private.
    const directoryStat = directory.stat();
    if (
      (directoryStat.uid !== 0 && directoryStat.uid !== process.getuid?.()) ||
      (directoryStat.mode & 0o022) !== 0
    ) {
      directory.close();
      throw new Error("unsafe_service_credential_reference");
    }
    protectedDirectories.push(directory);
    const fd = directory.openFile(basename(credential.source));
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > 16384
    ) {
      closeSync(fd);
      throw new Error("unsafe_service_credential_reference");
    }
    serviceCredentials.set(ref, { fd, origins: credential.origins });
  }
  const exclusions = new DirectoryExclusions(protectedDirectories);
  const journal = new JobJournal(state.openChild("journal", { create: true }));
  const cache = state.openChild("artifacts", { create: true });
  const outputs = JobOutputStore.open(state.openChild("outputs", { create: true }));
  const delegatedCgroup = HeldDirectory.openAbsolute(config.delegatedCgroup);
  const bwrapParent = HeldDirectory.openAbsolute(dirname(config.bubblewrap));
  const bubblewrapFd = bwrapParent.openRuntimeFile(basename(config.bubblewrap));
  bwrapParent.close();
  const anchors: Record<string, HeldDirectory> = {};
  for (const [name, path] of Object.entries(config.anchors))
    anchors[name] = HeldDirectory.openAbsolute(path);
  const runtimeTools: Record<string, LinuxJobBind[]> = {};
  // These sources live with the retained owner. Sharing their descriptors lets
  // independent tool groups compose without relaxing target-conflict checks.
  const runtimeSources = { directory: new Map<string, number>(), file: new Map<string, number>() };
  for (const [tool, definitions] of Object.entries(config.runtimeTools)) {
    runtimeTools[tool] = definitions.map((definition) => {
      const sources = runtimeSources[definition.kind];
      let fd = sources.get(definition.source);
      if (fd === undefined) {
        if (definition.kind === "directory") {
          const source = HeldDirectory.openAbsolute(definition.source);
          try {
            exclusions.assertSource(source.fd, true);
          } catch (error) {
            source.close();
            throw error;
          }
          fd = source.fd;
        } else {
          const sourceParent = HeldDirectory.openAbsolute(dirname(definition.source));
          try {
            exclusions.assertSource(sourceParent.fd, false);
            fd = sourceParent.openRuntimeFile(basename(definition.source));
          } finally {
            sourceParent.close();
          }
        }
        sources.set(definition.source, fd);
      }
      return { fd, target: definition.target, writable: false };
    });
  }
  return MachineJobOwner.open({
    machineId: config.machineId,
    admissionPublicKey: config.admissionPublicKey,
    journal,
    cache,
    managedState: state.openChild("locations", { create: true }),
    outputs,
    delegatedCgroup,
    bubblewrapFd,
    anchors,
    protectedDirectories,
    runtimeTools,
    serviceCredentials,
    artifactAuthority: { origins: config.artifactOrigins, maxRedirects: 5, timeoutMs: 60_000 },
  });
}
