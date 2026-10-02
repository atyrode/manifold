import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, type Stats } from "node:fs";
import {
  CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES,
  ServiceCredentialEnrollmentError,
  type ServiceCredentialReference,
} from "@manifold/protocol";
import { fdMountReadOnly, safeComponent, type HeldDirectory } from "./job-files.ts";

interface CredentialSlot {
  readonly fd: number;
  readonly revision: string;
}
interface CredentialPublication {
  current: CredentialSlot | undefined;
  mutating: boolean;
}
interface CredentialSource {
  readonly parent: HeldDirectory;
  readonly leaf: string;
  readonly origins: readonly string[];
  readonly publication: CredentialPublication;
}

function privateCredential(stat: Stats): boolean {
  return (
    stat.isFile() &&
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o077) === 0 &&
    stat.nlink === 1 &&
    stat.size > 0 &&
    stat.size <= CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES
  );
}

/** Sole close-owner of declared source parents and their current read-only descriptors. */
export class HeldServiceCredentialRegistry {
  private readonly sources = new Map<string, CredentialSource>();
  private readonly publications = new Map<string, CredentialPublication>();
  private closed = false;
  private declarationsSealed = false;

  /** Takes ownership of parent even when declaration fails. Only an absent leaf is unavailable. */
  declare(ref: string, parent: HeldDirectory, leaf: string, origins: readonly string[]): void {
    let fd: number | undefined;
    try {
      if (this.closed || this.declarationsSealed || this.sources.has(ref))
        throw new Error("credential_registry_closed_or_duplicate");
      safeComponent(leaf);
      const stat = parent.stat();
      // A root-managed traversable store can supply a private credential, but cannot gain writes.
      if ((stat.uid !== 0 && stat.uid !== process.getuid?.()) || (stat.mode & 0o022) !== 0)
        throw new Error("unsafe_service_credential_reference");
      try {
        fd = parent.openFile(leaf);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (fd !== undefined && !privateCredential(fstatSync(fd)))
        throw new Error("unsafe_service_credential_reference");
      const identity = fstatSync(parent.fd, { bigint: true });
      const sourceKey = `${identity.dev}:${identity.ino}:${leaf}`;
      const allowedOrigins = Object.freeze([...origins]);
      let publication = this.publications.get(sourceKey);
      if (publication) {
        // An alias cannot replace the already-held bootstrap slot by reopening its name.
        if (fd !== undefined) {
          closeSync(fd);
          fd = undefined;
        }
      } else {
        publication = {
          current: fd === undefined ? undefined : { fd, revision: randomUUID() },
          mutating: false,
        };
      }
      this.sources.set(ref, { parent, leaf, origins: allowedOrigins, publication });
      this.publications.set(sourceKey, publication);
    } catch (error) {
      try {
        if (fd !== undefined) closeSync(fd);
      } finally {
        parent.close();
      }
      throw error;
    }
  }

  /** Owner construction ends bootstrap; later control messages can only mutate declared slots. */
  sealDeclarations(): void {
    this.declarationsSealed = true;
  }

  /** Borrowed only while constructing exclusions; callers must not close these capabilities. */
  protectedDirectories(): HeldDirectory[] {
    return [...this.sources.values()].map((source) => source.parent);
  }

  /** Reads have no await: one live slot lookup and synchronous use, with no lease/refcount. */
  currentDescriptor(ref: string): number | undefined {
    return this.closed ? undefined : this.sources.get(ref)?.publication.current?.fd;
  }

  references(): ServiceCredentialReference[] {
    return [...this.sources].map(([ref, source]) => {
      let available = false;
      const current = source.publication.current;
      if (!this.closed && current) {
        try {
          available = privateCredential(fstatSync(current.fd));
        } catch {
          // A lost or unsafe descriptor is unavailable, never a reason to reopen a source path.
        }
      }
      return { ref, origins: [...source.origins], available };
    });
  }

  private target(ref: string, origin: string): CredentialSource {
    if (this.closed) throw new ServiceCredentialEnrollmentError("credential_source_unavailable");
    const source = this.sources.get(ref);
    if (!source) throw new ServiceCredentialEnrollmentError("credential_reference_unknown");
    if (!source.origins.includes(origin))
      throw new ServiceCredentialEnrollmentError("credential_origin_disallowed");
    try {
      const parent = source.parent.stat();
      if (
        parent.uid !== process.getuid?.() ||
        (parent.mode & 0o077) !== 0 ||
        (parent.mode & 0o700) !== 0o700 ||
        fdMountReadOnly(source.parent.fd)
      )
        throw new ServiceCredentialEnrollmentError("credential_source_read_only");
      if (source.publication.current) {
        const current = fstatSync(source.publication.current.fd);
        if (!privateCredential(current))
          throw new ServiceCredentialEnrollmentError("credential_source_invalid");
        if ((current.mode & 0o200) === 0)
          throw new ServiceCredentialEnrollmentError("credential_source_read_only");
      }
    } catch (error) {
      if (error instanceof ServiceCredentialEnrollmentError) throw error;
      throw new ServiceCredentialEnrollmentError("credential_source_invalid");
    }
    return source;
  }

  prepare(ref: string, origin: string, replace: boolean): string | null {
    const publication = this.target(ref, origin).publication;
    if (publication.mutating) throw new ServiceCredentialEnrollmentError("credential_enrollment_busy");
    if (publication.current && !replace)
      throw new ServiceCredentialEnrollmentError("credential_already_held");
    return publication.current?.revision ?? null;
  }

  /**
   * Owner-local revision CAS under the shared source lock. Private native writers are trusted: the
   * held-name identity check is not a kernel expected-inode CAS against hostile same-UID writers.
   * Only initial RENAME_NOREPLACE publication is kernel-exclusive.
   */
  publish(
    ref: string,
    origin: string,
    replace: boolean,
    expectedRevision: string | null,
    bytes: Uint8Array,
  ): { sourceRevision: string; replaced: boolean; durable: boolean } {
    const source = this.target(ref, origin);
    const publication = source.publication;
    if (publication.mutating) throw new ServiceCredentialEnrollmentError("credential_enrollment_busy");
    publication.mutating = true;
    let published = false;
    const revision = randomUUID();
    const previous = publication.current;
    try {
      if ((previous?.revision ?? null) !== expectedRevision)
        throw new ServiceCredentialEnrollmentError("credential_source_changed");
      if (previous && !replace)
        throw new ServiceCredentialEnrollmentError("credential_already_held");
      if (bytes.byteLength === 0 || bytes.byteLength > CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES)
        throw new ServiceCredentialEnrollmentError("credential_value_invalid");
      if (previous) {
        // Never follow a new name or adopt it as a fallback. Detect trusted out-of-band changes
        // before replacing; the live resolver continues to use only the registry's held slot.
        const named = source.parent.openFile(source.leaf);
        try {
          const held = fstatSync(previous.fd, { bigint: true });
          const currentName = fstatSync(named, { bigint: true });
          if (held.dev !== currentName.dev || held.ino !== currentName.ino)
            throw new ServiceCredentialEnrollmentError("credential_source_changed");
        } finally {
          closeSync(named);
        }
      }
      source.parent.atomicWriteHeld(
        source.leaf,
        bytes,
        (fd) => {
          if (!privateCredential(fstatSync(fd)))
            throw new ServiceCredentialEnrollmentError("credential_source_invalid");
        },
        (fd) => {
          publication.current = { fd, revision };
          published = true;
          // Synchronous resolver reads cannot overlap this handoff in this owner event loop.
          if (previous) closeSync(previous.fd);
        },
        0o600,
        previous === undefined,
      );
      return { sourceRevision: revision, replaced: previous !== undefined, durable: true };
    } catch (error) {
      // Rename succeeded: preserve the actual new slot even if the directory fence failed.
      if (published)
        return { sourceRevision: revision, replaced: previous !== undefined, durable: false };
      if (error instanceof ServiceCredentialEnrollmentError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || (previous && (code === "ENOENT" || code === "ELOOP")))
        throw new ServiceCredentialEnrollmentError("credential_source_changed");
      throw new ServiceCredentialEnrollmentError("credential_storage_failed");
    } finally {
      publication.mutating = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const publication of this.publications.values()) {
      try {
        if (publication.current) closeSync(publication.current.fd);
      } catch (error) {
        errors.push(error);
      } finally {
        publication.current = undefined;
      }
    }
    for (const parent of new Set([...this.sources.values()].map((source) => source.parent))) {
      try {
        parent.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.sources.clear();
    this.publications.clear();
    if (errors.length) throw new AggregateError(errors, "credential_registry_close_failed");
  }
}
