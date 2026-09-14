import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeldDirectory } from "../src/job-files.ts";
import { JobBoundInputStore } from "../src/job-bound-inputs.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;

function fixture(run: (context: { root: string; store: JobBoundInputStore }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "job-bound-inputs-"));
  mkdirSync(join(root, "inputs"), { mode: 0o700 });
  const directory = HeldDirectory.openAbsolute(join(root, "inputs"), { private: true });
  try {
    run({ root, store: JobBoundInputStore.open(directory) });
  } finally {
    directory.close();
    rmSync(root, { recursive: true, force: true });
  }
}

linuxTest(
  "an extraction root a group could read is refused, and residue never survives open",
  () => {
    const root = mkdtempSync(join(tmpdir(), "job-bound-inputs-"));
    try {
      mkdirSync(join(root, "shared"), { mode: 0o750 });
      const shared = HeldDirectory.openAbsolute(join(root, "shared"));
      try {
        expect(() => JobBoundInputStore.open(shared)).toThrow("input_store_not_private");
      } finally {
        shared.close();
      }
      // A crash leaves a tree belonging to a job that will never run again.
      mkdirSync(join(root, "inputs", "stale", "nested"), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, "inputs/stale/nested/left-behind"), "orphan");
      const directory = HeldDirectory.openAbsolute(join(root, "inputs"), { private: true });
      try {
        JobBoundInputStore.open(directory);
        expect(directory.names()).toEqual([]);
      } finally {
        directory.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

linuxTest("a staged input is owner-only, and release takes its whole tree with it", () => {
  fixture(({ root, store }) => {
    const input = store.stage("material", (into) => {
      mkdirSync(`${into.procPath}/nested`);
      writeFileSync(`${into.procPath}/nested/file`, "extracted");
      return { bytes: 2048, files: 1 };
    });
    expect(input).toMatchObject({ name: "material", bytes: 2048, files: 1 });
    const held = HeldDirectory.openAbsolute(join(root, "inputs"));
    const staged = join(root, "inputs", held.names()[0]!);
    held.close();
    expect(lstatSync(staged).mode & 0o777).toBe(0o700);
    store.release(input);
    expect(existsSync(staged)).toBe(false);
    // Idempotent: the settle path and the refused-start path both run.
    store.release(input);
  });
});

linuxTest("an extraction that throws leaves no directory and no descriptor behind", () => {
  fixture(({ root, store }) => {
    expect(() =>
      store.stage("material", (into) => {
        writeFileSync(`${into.procPath}/partial`, "half");
        throw new Error("input_source_corrupt");
      }),
    ).toThrow("input_source_corrupt");
    const directory = HeldDirectory.openAbsolute(join(root, "inputs"));
    try {
      expect(directory.names()).toEqual([]);
    } finally {
      directory.close();
    }
  });
});
