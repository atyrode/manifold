import { closeSync, constants, fstatSync } from "node:fs";
import { isOperatorAnchor, type MachineLocation } from "@manifold/protocol";
import type { HeldDirectory } from "./job-files.ts";
import { directoryAncestry } from "./job-files.ts";

export interface JobLocation {
  readonly fd: number;
  readonly directory: HeldDirectory | null;
  /** Held parent for file ancestry; borrowed until close(). */
  readonly parentFd?: number;
  readonly guestPath: string;
  readonly access: "read" | "write" | "create";
  readonly writable: boolean;
  /** Backed by one exclusive owner-private root of this job, never by the declared path. */
  readonly temporary?: true;
  close(): void;
}

function guestLocationPath(locationId: string, declaration: MachineLocation): string {
  const guestPath = declaration.guestPath ?? `/locations/${encodeURIComponent(locationId)}`;
  if (
    declaration.guestPath &&
    (!guestPath.startsWith("/home/job/") ||
      guestPath
        .split("/")
        .slice(1)
        .some((component) => !component || component === "." || component === ".."))
  )
    throw new Error("invalid_guest_location");
  return guestPath;
}

function directoryLocation(
  directory: HeldDirectory,
  guestPath: string,
  access: JobLocation["access"],
  temporary = false,
): JobLocation {
  return {
    fd: directory.fd,
    directory,
    guestPath,
    access,
    writable: access !== "read",
    ...(temporary ? { temporary: true as const } : {}),
    close() {
      directory.close();
    },
  };
}

/** Native-owned storage roots are the owner's alone: its uid, and no group or other bits. */
function ownerPrivate(root: HeldDirectory): boolean {
  const stat = root.stat();
  return stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
}

/** This namespace is native-owned, never an ambient anchor or an adoption path. A
 * writable admission can provision its retained directory; create-only external
 * locations keep their exclusive semantics. Concurrent opens share held identity. */
export function resolveManagedJobLocation(
  root: HeldDirectory,
  pluginId: string,
  locationId: string,
  declaration: MachineLocation,
  access: JobLocation["access"],
  beforeCreate: (parentFd: number) => void,
): JobLocation {
  if (
    !declaration.managed ||
    declaration.temporary ||
    declaration.kind !== "directory" ||
    declaration.anchor !== "state" ||
    !declaration.components.length ||
    access === "create" ||
    !ownerPrivate(root)
  )
    throw new Error("invalid_managed_location");
  const guestPath = guestLocationPath(locationId, declaration);
  let current = root;
  try {
    for (const component of [pluginId, ...declaration.components]) {
      if (access === "write") beforeCreate(current.fd);
      const next = current.openChild(component, { create: access === "write" });
      if (current !== root) current.close();
      current = next;
    }
    return directoryLocation(current, guestPath, access);
  } catch (error) {
    if (current !== root) current.close();
    throw error;
  }
}

/** Create-child is not job write/create. Only this resolver may provision its managed root. */
export function resolveManagedTransferRoot(
  root: HeldDirectory,
  pluginId: string,
  declaration: MachineLocation,
  beforeCreate: (parentFd: number) => void,
  create = true,
): HeldDirectory {
  if (
    !declaration.managed || declaration.temporary || declaration.kind !== "directory" ||
    declaration.anchor !== "state" || !declaration.components.length || !ownerPrivate(root)
  ) throw new Error("invalid_transfer_location");
  let current = root.reopen();
  try {
    for (const component of [pluginId, ...declaration.components]) {
      beforeCreate(current.fd);
      const next = current.openChild(component, { create });
      try {
        if (!ownerPrivate(next)) throw new Error("transfer_root_not_private");
        if (create) current.sync();
      } catch (error) {
        next.close();
        throw error;
      }
      current.close();
      current = next;
    }
    return current;
  } catch (error) {
    current.close();
    throw error;
  }
}

/**
 * A temporary location backs output leases only, and never with its declared path: `provision`
 * returns this job's own exclusive root in the owner's private scratch namespace, and is called
 * only once the declaration and its use are known to be exactly that. The location holds its
 * own handle on the root, so closing it never disposes the root; only the scratch store does.
 */
export function resolveTemporaryJobLocation(
  provision: () => HeldDirectory,
  locationId: string,
  declaration: MachineLocation,
  access: JobLocation["access"],
  outputOnly: boolean,
): JobLocation {
  if (
    !declaration.temporary ||
    declaration.managed ||
    declaration.anchor !== "runtime" ||
    declaration.kind !== "directory" ||
    declaration.guestPath !== undefined
  )
    throw new Error("invalid_temporary_location");
  // Never a working directory, context location or ordinary mount: a lease's backing only.
  if (access !== "write" || !outputOnly) throw new Error("temporary_location_requires_output_only");
  const root = provision();
  if (!ownerPrivate(root)) throw new Error("invalid_temporary_location");
  const directory = root.reopen();
  return directoryLocation(directory, guestLocationPath(locationId, declaration), access, true);
}

/** Resolves only declared descendants of a held trusted anchor.
 * Runtime directory writes provision components; files never imply parent access.
 * An operator anchor is only read, and may be named whole through its own handle. */
export function resolveJobLocation(
  anchor: HeldDirectory,
  locationId: string,
  declaration: MachineLocation,
  access: "read" | "write" | "create",
  exclusions?: DirectoryExclusions,
  beforeCreate?: (parentFd: number) => void,
): JobLocation {
  const guestPath = guestLocationPath(locationId, declaration);
  if (declaration.managed) throw new Error("managed_location_requires_native_store");
  if (declaration.temporary) throw new Error("temporary_location_requires_native_store");
  const operator = isOperatorAnchor(declaration.anchor);
  // The declaration schema already refuses this; the owner never relies on that alone.
  if (operator && access !== "read") throw new Error("operator_anchor_read_only");
  if (declaration.components.length === 0) {
    if (!operator || declaration.kind === "file") throw new Error("empty_location_components");
    // A job's close() must never close the owner's held anchor.
    const whole = anchor.reopen();
    try {
      exclusions?.assertSource(whole.fd, true);
      return directoryLocation(whole, guestPath, access);
    } catch (error) {
      whole.close();
      throw error;
    }
  }
  let current = anchor;
  const createDirectories =
    access === "create" ||
    (access === "write" && declaration.anchor === "runtime" && declaration.kind !== "file");
  let fileFd: number | null = null;
  try {
    const directories =
      declaration.kind === "file" ? declaration.components.slice(0, -1) : declaration.components;
    for (let index = 0; index < directories.length; index++) {
      const component = directories[index]!;
      exclusions?.assertSource(current.fd, false);
      if (access === "create") beforeCreate?.(current.fd);
      const next = current.openChild(component, {
        create: createDirectories,
        exclusive:
          access === "create" && declaration.kind !== "file" && index === directories.length - 1,
      });
      if (current !== anchor) current.close();
      current = next;
    }
    exclusions?.assertSource(current.fd, declaration.kind !== "file");
    if (declaration.kind === "file") {
      fileFd = current.openFile(
        declaration.components.at(-1)!,
        access === "read"
          ? constants.O_RDONLY
          : constants.O_RDWR | (access === "create" ? constants.O_CREAT | constants.O_EXCL : 0),
      );
      const parent = current;
      const fd = fileFd;
      let closed = false;
      return {
        fd,
        directory: null,
        parentFd: parent.fd,
        guestPath,
        access,
        writable: access !== "read",
        close() {
          if (!closed) {
            closed = true;
            closeSync(fd);
            if (parent !== anchor) parent.close();
          }
        },
      };
    }
    return directoryLocation(current, guestPath, access);
  } catch (error) {
    if (fileFd !== null) closeSync(fileFd);
    if (current !== anchor) current.close();
    throw error;
  }
}

/** Private owner/control trees remain unavailable even to an explicitly consented location.
 * Identity checks walk held directory descriptions, not checked and reopened pathnames. */
export class DirectoryExclusions {
  private readonly roots = new Set<string>();
  private readonly ancestors = new Set<string>();

  constructor(directories: readonly HeldDirectory[]) {
    for (const directory of directories) {
      const stat = fstatSync(directory.fd, { bigint: true });
      this.roots.add(`${stat.dev}:${stat.ino}`);
      for (const identity of directoryAncestry(directory.fd)) this.ancestors.add(identity);
    }
  }

  assertSource(directoryFd: number, directoryMount: boolean): void {
    const stat = fstatSync(directoryFd, { bigint: true });
    if (directoryMount && this.ancestors.has(`${stat.dev}:${stat.ino}`))
      throw new Error("private_owner_source_overlap");
    for (const identity of directoryAncestry(directoryFd))
      if (this.roots.has(identity)) throw new Error("private_owner_source_overlap");
  }
}
