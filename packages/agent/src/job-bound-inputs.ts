import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { HeldDirectory } from "./job-files.ts";

/** One extracted archive, held open until the job that reads it settles. */
export interface JobBoundInput {
  readonly name: string;
  readonly directory: HeldDirectory;
  /** The sealed archive's length, which is what the job's `inputBytes` budget was charged. */
  readonly bytes: number;
  readonly files: number;
}

/**
 * Where a bound input lands on its way into a sandbox.
 *
 * An extraction is DERIVED state: the sealed archive it came from is the record, and this tree
 * exists only for as long as one job needs a real filesystem to read. So the store owns three
 * things and nothing else — a private root under the runtime anchor, one fresh 0700 directory
 * per binding, and the removal of that directory when the job settles or refuses to start.
 *
 * Because it is derived, `open` does not recover: it deletes whatever an earlier owner
 * generation left behind. A directory here after a crash belongs to a job that will never run
 * again, and keeping it would be keeping a job's inputs alive past the job.
 */
export class JobBoundInputStore {
  private readonly staged = new Map<HeldDirectory, string>();
  private constructor(private readonly directory: HeldDirectory) {}
  static open(directory: HeldDirectory): JobBoundInputStore {
    const stat = directory.stat();
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("input_store_not_private");
    for (const name of directory.names())
      rmSync(`${directory.procPath}/${name}`, { recursive: true, force: true });
    directory.sync();
    return new JobBoundInputStore(directory);
  }
  /**
   * A fresh directory, the caller's extraction into it, and the mount it becomes — or nothing at
   * all. A binding that fails halfway leaves no tree and no descriptor, which is what makes
   * "never a half-mounted job" true one binding at a time rather than only in aggregate.
   *
   * The directory is named by a fresh UUID rather than by the job: a job id is an arbitrary
   * 128-character string off the wire and has no business being a filename.
   */
  stage(
    name: string,
    extract: (into: HeldDirectory) => { bytes: number; files: number },
  ): JobBoundInput {
    const child = randomUUID();
    const directory = this.directory.openChild(child, { create: true, exclusive: true });
    this.staged.set(directory, child);
    try {
      const { bytes, files } = extract(directory);
      return { name, directory, bytes, files };
    } catch (error) {
      this.release({ name, directory, bytes: 0, files: 0 });
      throw error;
    }
  }
  /** Idempotent: the settle path and the refused-start path both run, in either order. */
  release(input: JobBoundInput): void {
    const child = this.staged.get(input.directory);
    input.directory.close();
    if (child === undefined) return;
    this.staged.delete(input.directory);
    rmSync(`${this.directory.procPath}/${child}`, { recursive: true, force: true });
    this.directory.sync();
  }
}
