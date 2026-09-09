import { createHash, createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DirectoryExclusions, HeldDirectory } from "@manifold/agent/job-configuration";
import {
  canonicalJobJson,
  JobOwnerConfigSchema,
  JobOwnerConfigTemplateSchema,
  type JobOwnerConfigTemplate,
} from "@manifold/protocol";

const MAX_CONFIG_BYTES = 65536;

function readPrivateFile(parent: HeldDirectory, name: string): string | null {
  let fd: number;
  try {
    fd = parent.openFile(name);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > MAX_CONFIG_BYTES)
      throw new Error("unsafe_local_job_owner_file");
    const contents = readFileSync(fd, "utf8");
    if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES) throw new Error("local_job_owner_file_too_large");
    return contents;
  } finally {
    closeSync(fd);
  }
}

/** Only a missing leaf is optional; parents and files retain the runtime's descriptor checks. */
export function readPrivateLocalFile(path: string): string | null {
  const parent = HeldDirectory.openAbsolute(dirname(path), { private: true });
  try {
    return readPrivateFile(parent, basename(path));
  } finally {
    parent.close();
  }
}

/** Existing files must also be private; never chmod or truncate through an unchecked path. */
export function writePrivateLocalFile(path: string, contents: string, exclusive = false): void {
  if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES) throw new Error("local_job_owner_file_too_large");
  const parent = HeldDirectory.openAbsolute(dirname(path), { private: true });
  try {
    if (exclusive) {
      const fd = parent.openFile(basename(path), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      try {
        writeFileSync(fd, contents, "utf8");
        fsyncSync(fd);
        parent.sync();
      } finally {
        closeSync(fd);
      }
    } else {
      readPrivateFile(parent, basename(path));
      parent.atomicWrite(basename(path), contents);
    }
  } finally {
    parent.close();
  }
}

export function loadLocalJobOwnerTemplate(
  dataDir: string,
  path: string,
  admissionPublicKey: string,
): JobOwnerConfigTemplate {
  if (process.platform !== "linux" || !path.startsWith("/") || path.includes("\0") || resolve(path) !== path)
    throw new Error("local_job_owner_requires_normalized_linux_paths");
  if (!admissionPublicKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
      createPublicKey(admissionPublicKey).asymmetricKeyType !== "ed25519")
    throw new Error("local_job_owner_requires_public_admission_key");
  HeldDirectory.openAbsolute(dataDir, { private: true }).close();
  const contents = readPrivateLocalFile(path);
  if (contents === null) throw new Error("local_job_owner_template_missing");
  const parsed = JobOwnerConfigTemplateSchema.parse(JSON.parse(contents));
  const template = JobOwnerConfigTemplateSchema.parse({
    ...parsed,
    protectedDirectories: [...new Set([...parsed.protectedDirectories, dataDir, dirname(path)])],
  });
  const protectedDirectories: HeldDirectory[] = [];
  try {
    for (const directory of template.protectedDirectories)
      protectedDirectories.push(HeldDirectory.openAbsolute(directory));
    const exclusions = new DirectoryExclusions(protectedDirectories);
    for (const path of Object.values(template.anchors)) {
      const anchor = HeldDirectory.openAbsolute(path);
      try {
        // An anchor may contain a protected descendant, but cannot itself be inside control storage.
        exclusions.assertSource(anchor.fd, false);
      } finally {
        anchor.close();
      }
    }
  } finally {
    for (const directory of protectedDirectories) directory.close();
  }
  return template;
}

export interface LocalJobOwnerBootstrap {
  readonly environment: Readonly<Record<string, string>>;
  /** Written only after starting a fresh half; retained process snapshots are never replaced. */
  record(role: "host" | "transport", pid: number): void;
}

/** The boot lock serializes the definition and non-secret snapshots with both process lifetimes. */
export function configureLocalJobOwner(
  dataDir: string,
  template: JobOwnerConfigTemplate,
  machineId: string,
  admissionPublicKey: string,
  retained: { host: number | null; transport: number | null },
): LocalJobOwnerBootstrap {
  const directory = resolve(dataDir, "job-owner");
  const configPath = resolve(directory, "config.json");
  const socketPath = resolve(directory, "owner.sock");
  const terminalSocketPath = resolve(dataDir, "terminal-host", "host.sock");
  if (Buffer.byteLength(socketPath) > 107 || Buffer.byteLength(terminalSocketPath) > 107)
    throw new Error("local_job_owner_socket_path_too_long");
  const hasRetainedProcess = retained.host !== null || retained.transport !== null;
  const root = HeldDirectory.openAbsolute(dataDir, { private: true });
  let control: HeldDirectory;
  try {
    try {
      control = root.openChild("job-owner", { create: !hasRetainedProcess });
    } catch (error) {
      if (hasRetainedProcess && error instanceof Error && Reflect.get(error, "code") === "ENOENT")
        throw new Error("local_job_owner_reuse_conflict: retained processes were not bootstrapped as native owners");
      throw error;
    }
  } finally {
    root.close();
  }
  try {
    const stat = control.stat();
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("local_job_owner_directory_not_private");
    const config = JobOwnerConfigSchema.parse({
      ...template,
      machineId,
      admissionPublicKey,
      stateDirectory: resolve(directory, "state"),
      // The master enrollment and signing stores are never workload sources.
      protectedDirectories: [...new Set([...template.protectedDirectories, dataDir])],
    });
    const encoded = canonicalJobJson(config);
    if (Buffer.byteLength(encoded) > MAX_CONFIG_BYTES) throw new Error("local_job_owner_file_too_large");
    const previous = readPrivateFile(control, "config.json");
    if (previous !== null && canonicalJobJson(JobOwnerConfigSchema.parse(JSON.parse(previous))) !== encoded)
      throw new Error("local_job_owner_definition_conflict: drain the owner before explicitly replacing its configuration");
    if (hasRetainedProcess && previous === null)
      throw new Error("local_job_owner_reuse_conflict: retained processes have no recorded native configuration");
    const digest = createHash("sha256").update(encoded).digest("hex");
    const snapshot = (pid: number): string => canonicalJobJson({ pid, digest, configPath, socketPath, terminalSocketPath });
    for (const role of ["host", "transport"] as const) {
      const pid = retained[role];
      if (pid === null) continue;
      const recorded = readPrivateFile(control, `${role}.json`);
      if (recorded === null || canonicalJobJson(JSON.parse(recorded)) !== snapshot(pid))
        throw new Error(`local_job_owner_reuse_conflict: retained ${role} has no matching bootstrap identity`);
    }
    const state = control.openChild("state", { create: !hasRetainedProcess });
    try {
      const stateStat = state.stat();
      if (stateStat.uid !== process.getuid?.() || (stateStat.mode & 0o077) !== 0)
        throw new Error("local_job_owner_directory_not_private");
    } finally {
      state.close();
    }
    const data = HeldDirectory.openAbsolute(dataDir, { private: true });
    try {
      const terminal = data.openChild("terminal-host", { create: !hasRetainedProcess });
      try {
        const terminalStat = terminal.stat();
        if (terminalStat.uid !== process.getuid?.() || (terminalStat.mode & 0o077) !== 0)
          throw new Error("local_job_owner_directory_not_private");
      } finally {
        terminal.close();
      }
    } finally {
      data.close();
    }
    if (previous === null) writePrivateLocalFile(configPath, `${encoded}\n`, true);
    return {
      environment: { MANIFOLD_JOB_OWNER_CONFIG: configPath, MANIFOLD_JOB_OWNER_SOCKET: socketPath },
      record(role, pid) {
        writePrivateLocalFile(resolve(directory, `${role}.json`), `${snapshot(pid)}\n`);
      },
    };
  } finally {
    control.close();
  }
}
