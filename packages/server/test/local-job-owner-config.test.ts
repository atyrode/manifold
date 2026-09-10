import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeldDirectory } from "@manifold/agent/job-configuration";
import { readPrivateLocalFile, writePrivateLocalFile } from "../src/local-job-owner-config.ts";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "manifold-config-publication-"));
  directories.push(directory);
  return { directory, path: join(directory, "config.json") };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("exclusive configuration appears only after complete private staging", () => {
  const { directory, path } = fixture();
  const contents = JSON.stringify({ value: "x".repeat(32_768) });
  const publish = HeldDirectory.prototype.publish;
  const observed: Array<string | null> = [];
  const intercept = spyOn(HeldDirectory.prototype, "publish").mockImplementation(function (
    this: HeldDirectory,
    temporary,
    destination,
    exclusive,
  ) {
    observed.push(readPrivateLocalFile(path));
    const staged = this.openFile(temporary);
    try {
      expect(readFileSync(staged, "utf8")).toBe(contents);
      expect(fstatSync(staged).mode & 0o777).toBe(0o600);
    } finally {
      closeSync(staged);
    }
    publish.call(this, temporary, destination, exclusive);
    observed.push(readPrivateLocalFile(path));
  });
  try {
    writePrivateLocalFile(path, contents, true);
    expect(observed).toEqual([null, contents]);
    expect(statSync(path).nlink).toBe(1);
    expect(readdirSync(directory)).toEqual(["config.json"]);
  } finally {
    intercept.mockRestore();
  }
});

test("interrupted publication leaves no partial config and cleans only its own staging", () => {
  const { directory, path } = fixture();
  const unrelatedStage = join(directory, ".stage-incumbent");
  writeFileSync(unrelatedStage, "retained staging", { mode: 0o600 });
  const intercept = spyOn(HeldDirectory.prototype, "publish").mockImplementation(() => {
    throw new Error("interrupted before publication");
  });
  try {
    expect(() => writePrivateLocalFile(path, "complete", true)).toThrow(
      "interrupted before publication",
    );
    expect(readPrivateLocalFile(path)).toBeNull();
    expect(readdirSync(directory)).toEqual([".stage-incumbent"]);
    expect(readFileSync(unrelatedStage, "utf8")).toBe("retained staging");
  } finally {
    intercept.mockRestore();
  }
});

test("exclusive publication preserves an incumbent that arrives after staging", () => {
  const { directory, path } = fixture();
  const publish = HeldDirectory.prototype.publish;
  const intercept = spyOn(HeldDirectory.prototype, "publish").mockImplementation(function (
    this: HeldDirectory,
    temporary,
    destination,
    exclusive,
  ) {
    writeFileSync(path, "incumbent", { mode: 0o600, flag: "wx" });
    publish.call(this, temporary, destination, exclusive);
  });
  try {
    let failure: unknown;
    try {
      writePrivateLocalFile(path, "replacement", true);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "EEXIST" });
    expect(readPrivateLocalFile(path)).toBe("incumbent");
    expect(readdirSync(directory)).toEqual(["config.json"]);
  } finally {
    intercept.mockRestore();
  }
});

test("replacement keeps the previous complete inode readable until publication", () => {
  const { path } = fixture();
  writePrivateLocalFile(path, "previous", true);
  const reader = openSync(path, constants.O_RDONLY);
  const publish = HeldDirectory.prototype.publish;
  const observed: Array<string | null> = [];
  const intercept = spyOn(HeldDirectory.prototype, "publish").mockImplementation(function (
    this: HeldDirectory,
    temporary,
    destination,
    exclusive,
  ) {
    observed.push(readPrivateLocalFile(path));
    publish.call(this, temporary, destination, exclusive);
    observed.push(readPrivateLocalFile(path));
  });
  try {
    writePrivateLocalFile(path, "replacement");
    expect(observed).toEqual(["previous", "replacement"]);
    expect(readFileSync(reader, "utf8")).toBe("previous");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    intercept.mockRestore();
    closeSync(reader);
  }
});

test("unsafe incumbents cannot be replaced or modified through configuration writes", () => {
  const { directory } = fixture();
  const target = join(directory, "target");
  const symlink = join(directory, "symlink");
  const hardlink = join(directory, "hardlink");
  const readable = join(directory, "readable");
  writeFileSync(target, "protected", { mode: 0o600 });
  symlinkSync(target, symlink);
  linkSync(target, hardlink);
  writeFileSync(readable, "not private", { mode: 0o644 });
  chmodSync(readable, 0o644);
  for (const path of [symlink, hardlink, readable]) {
    expect(() => writePrivateLocalFile(path, "replacement")).toThrow();
    expect(() => writePrivateLocalFile(path, "replacement", true)).toThrow();
  }
  expect(readFileSync(target, "utf8")).toBe("protected");
  expect(readFileSync(readable, "utf8")).toBe("not private");
  expect(statSync(readable).mode & 0o777).toBe(0o644);
  expect(readdirSync(directory).sort()).toEqual(["hardlink", "readable", "symlink", "target"]);
});
