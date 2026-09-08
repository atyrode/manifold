import { closeSync, constants, fstatSync } from "node:fs";
import type { MachineLocation } from "@manifold/protocol";
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
  close(): void;
}

/** Resolves only declared descendants of a held trusted anchor; files never imply parent access. */
export function resolveJobLocation(
  anchor: HeldDirectory,
  locationId: string,
  declaration: MachineLocation,
  access: "read" | "write" | "create",
  exclusions?: DirectoryExclusions,
  beforeCreate?: (parentFd: number) => void,
): JobLocation {
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
  let current = anchor;
  if (declaration.components.length === 0) throw new Error("empty_location_components");
  let fileFd: number | null = null;
  try {
    const directories =
      declaration.kind === "file" ? declaration.components.slice(0, -1) : declaration.components;
    for (let index = 0; index < directories.length; index++) {
      const component = directories[index]!;
      exclusions?.assertSource(current.fd, false);
      if (access === "create") beforeCreate?.(current.fd);
      const next = current.openChild(component, {
        create: access === "create",
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
    const directory = current;
    return {
      fd: directory.fd,
      directory,
      guestPath,
      access,
      writable: access !== "read",
      close() {
        directory.close();
      },
    };
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
