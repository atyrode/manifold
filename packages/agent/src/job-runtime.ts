import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { JobOwnerConfigSchema, type JobOwnerConfig, type LogEvent } from "@manifold/protocol";
import { fdMountReadOnly, HeldDirectory } from "./job-files.ts";
import { JobJournal } from "./job-journal.ts";
import { MachineJobOwner } from "./job-owner.ts";
import { JobOutputScratchStore, JobOutputStore } from "./job-outputs.ts";
import { JobBoundInputStore } from "./job-bound-inputs.ts";
import { type LinuxJobBind } from "./job-linux.ts";
import { DirectoryExclusions } from "./job-locations.ts";

type OperatorAnchorRefusal = { reason: string; code?: string };

// Protected owner state names the one runtime directory that is the owner's temporary output
// namespace. Nothing in runtime storage, which workloads can reach and which predates #933,
// is trusted to say so: a directory there is the owner's only if this record names it with its
// exact identity, and the record is published only after the owner's journal lock is held.
const OUTPUT_SCRATCH_RECORD = "output-scratch";
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const OutputScratchRecordSchema = z.strictObject({
  name: z
    .string()
    .regex(/^job-output-scratch-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  dev: z.string().regex(DECIMAL),
  ino: z.string().regex(DECIMAL),
});
type OutputScratchRecord = z.infer<typeof OutputScratchRecordSchema>;

function readOutputScratchRecord(state: HeldDirectory): OutputScratchRecord | null {
  let fd: number;
  try {
    fd = state.openFile(OUTPUT_SCRATCH_RECORD);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let text: string;
  try {
    if (fstatSync(fd).size > 4096) throw new Error("output_scratch_record_invalid");
    const bytes = readFileSync(fd);
    if (bytes.length > 4096) throw new Error("output_scratch_record_invalid");
    text = bytes.toString("utf8");
  } finally {
    closeSync(fd);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("output_scratch_record_invalid");
  }
  const record = OutputScratchRecordSchema.safeParse(value);
  if (!record.success) throw new Error("output_scratch_record_invalid");
  return record.data;
}

/**
 * The runtime directory holding temporary output roots: the one the owner's record names, if it
 * still has the recorded identity, or else a fresh one it creates exclusively under a random
 * name and records before any job can be admitted. It never adopts a path it did not record,
 * so a `job-output-scratch` or any other directory already in runtime storage stays ordinary
 * retained data. Only a recorded directory that is gone, as when the runtime tmpfs did not
 * survive a reboot, is replaced; a malformed record, a directory with another identity, or any
 * other lookup failure refuses the start and leaves everything as found. The caller holds the
 * owner lock, so no concurrent start can replace an active owner's record.
 */
function holdOutputScratchNamespace(runtime: HeldDirectory, state: HeldDirectory): HeldDirectory {
  const record = readOutputScratchRecord(state);
  if (record) {
    let held: HeldDirectory | undefined;
    try {
      held = runtime.openChild(record.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (held) {
      const stat = fstatSync(held.fd, { bigint: true });
      if (String(stat.dev) === record.dev && String(stat.ino) === record.ino) return held;
      held.close();
      throw new Error("output_scratch_changed");
    }
  }
  const name = `job-output-scratch-${randomUUID()}`;
  const held = runtime.openChild(name, { create: true, exclusive: true });
  try {
    const stat = fstatSync(held.fd, { bigint: true });
    const created: OutputScratchRecord = { name, dev: String(stat.dev), ino: String(stat.ino) };
    // Durable before the owner opens, so no job receives a root in an unrecorded directory. A
    // first record never replaces one that appeared meanwhile; a lost one is replaced in place.
    state.atomicWrite(OUTPUT_SCRATCH_RECORD, JSON.stringify(created), 0o600, record === null);
  } catch (error) {
    // Left empty and unrecorded: never adopted, never removed by the owner.
    held.close();
    throw error;
  }
  return held;
}

/**
 * Holds one operator anchor, or names why it stays unavailable. Through an idmapped view the
 * owner owns every file it reads, so only a read-only mount keeps it from writing them.
 */
function holdOperatorAnchor(
  path: string,
  exclusions: DirectoryExclusions,
): HeldDirectory | OperatorAnchorRefusal {
  let held: HeldDirectory;
  try {
    held = HeldDirectory.openAbsolute(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    return code === "ENOENT"
      ? { reason: "operator_anchor_absent" }
      : { reason: "operator_anchor_unopenable", code };
  }
  let refusal: OperatorAnchorRefusal | null = null;
  try {
    if (!fdMountReadOnly(held.fd)) refusal = { reason: "operator_anchor_not_read_only" };
    else exclusions.assertSource(held.fd, true);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    refusal =
      code === "private_owner_source_overlap"
        ? { reason: "operator_anchor_overlaps_protected" }
        : { reason: "operator_anchor_unopenable", code };
  }
  if (refusal === null) return held;
  held.close();
  return refusal;
}
/** Opens reviewed local config through held descriptors. No job RPC can modify this authority. */
export async function openConfiguredJobOwner(
  configPath: string,
  socketPath: string,
  terminalSocketPath: string,
  log?: (level: "info" | "warn", event: LogEvent, fields: Record<string, unknown>) => void,
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
  const anchors: Record<string, HeldDirectory> = {};
  for (const [name, path] of Object.entries(config.anchors))
    anchors[name] = HeldDirectory.openAbsolute(path);
  // The owner lock comes before any runtime namespace is created, reopened or recorded: a
  // second start fails here instead of replacing the namespace an active owner is using.
  const journal = new JobJournal(state.openChild("journal", { create: true }), { log });
  // Bound inputs are extracted onto the bounded runtime backing, beside named output storage:
  // derived bytes on the device the operator already sizes and the kernel already bounds. The
  // owner protects that one subdirectory, so no declared location can resolve into it.
  const boundInputRoot = anchors.runtime?.openChild("job-inputs", { create: true });
  // Temporary output locations are backed there too, in a recorded namespace of their own: one
  // owner-private root per job, never a declared path, and equally protected from every location.
  const outputScratchRoot = anchors.runtime
    ? holdOutputScratchNamespace(anchors.runtime, state)
    : undefined;
  const protectedDirectories = [
    state,
    parent,
    HeldDirectory.openAbsolute(dirname(socketPath), { private: true }),
    HeldDirectory.openAbsolute(dirname(terminalSocketPath), { private: true }),
    ...(boundInputRoot ? [boundInputRoot] : []),
    ...(outputScratchRoot ? [outputScratchRoot] : []),
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
  // An anchor the owner cannot hold safely disables only the operations that read it. It never
  // stops the owner and never falls back to another directory.
  const operatorAnchors: Record<string, { path: string; source: string }> = {};
  for (const [name, definition] of Object.entries(config.operatorAnchors ?? {})) {
    const held = holdOperatorAnchor(definition.path, exclusions);
    if (!(held instanceof HeldDirectory)) {
      log?.("warn", "operator_anchor_unavailable", { anchor: name, ...held });
      continue;
    }
    anchors[name] = held;
    operatorAnchors[name] = { path: definition.path, source: definition.source ?? definition.path };
  }
  const cache = state.openChild("artifacts", { create: true });
  const outputs = JobOutputStore.open(state.openChild("outputs", { create: true }));
  const boundInputs = boundInputRoot ? JobBoundInputStore.open(boundInputRoot) : undefined;
  // Held and checked here; cleared only by the owner, after it has recovered its workloads.
  const outputScratch = outputScratchRoot
    ? JobOutputScratchStore.open(outputScratchRoot)
    : undefined;
  const delegatedCgroup = HeldDirectory.openAbsolute(config.delegatedCgroup);
  const bwrapParent = HeldDirectory.openAbsolute(dirname(config.bubblewrap));
  const bubblewrapFd = bwrapParent.openRuntimeFile(basename(config.bubblewrap));
  bwrapParent.close();
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
    ...(boundInputs ? { boundInputs } : {}),
    ...(outputScratch ? { outputScratch } : {}),
    delegatedCgroup,
    bubblewrapFd,
    anchors,
    ...(Object.keys(operatorAnchors).length ? { operatorAnchors } : {}),
    protectedDirectories,
    runtimeTools,
    serviceCredentials,
    artifactAuthority: { origins: config.artifactOrigins, maxRedirects: 5, timeoutMs: 60_000 },
    ...(log ? { log } : {}),
  });
}
