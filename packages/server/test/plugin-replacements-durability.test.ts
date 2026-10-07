import { afterAll, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/*
  A staged crossing's journal must be durable before the effects it describes (#1068): a host
  crash may keep SQLite's committed bundle rows and native disables, so it must keep their undo
  record too. Atomic rename is visibility, not persistence. This traces the filesystem calls the
  journal makes, as the plugin database journal's recovery discipline requires: the file is
  fsynced before it is renamed into place, and its directory after every rename or unlink.
*/
const actual = { ...fs };
const trace: string[] = [];
const opened = new Map<number, string>();
let root = "";
const name = (path: fs.PathLike) => relative(root, String(path)) || ".";
const traced = {
  ...actual,
  openSync: (path: fs.PathLike, ...rest: unknown[]) => {
    const fd = (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
    opened.set(fd, String(path));
    return fd;
  },
  fsyncSync: (fd: number) => {
    const path = opened.get(fd);
    if (path?.startsWith(root)) trace.push(`fsync ${name(path)}`);
    actual.fsyncSync(fd);
  },
  renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from).startsWith(root)) trace.push(`rename ${name(from)} ${name(to)}`);
    actual.renameSync(from, to);
  },
  rmSync: (path: fs.PathLike, options?: fs.RmOptions) => {
    if (String(path).startsWith(root)) trace.push(`rm ${name(path)}`);
    actual.rmSync(path, options);
  },
};
mock.module("node:fs", () => ({ ...traced, default: traced }));
afterAll(() => {
  mock.module("node:fs", () => ({ ...actual, default: actual }));
});
// Loaded after the trace is installed: a static import would bind the real filesystem first.
const {
  clearStagedReplacement,
  readReplacementJournal,
  stagedReplacementDir,
  writeReplacementJournal,
} = await import("../src/plugin-replacements.ts");

const row = {
  pluginId: "vendor.sample",
  sha256: "a".repeat(64),
  source: "/data/plugins/vendor.sample/a.manifold-plugin.json",
  grantedCaps: [],
  installedBy: "owner",
  installedAt: 1,
  bundlePath: "/data/plugins/vendor.sample/a.manifold-plugin.json",
  actions: [],
  hardened: true,
};
const record = {
  format: 1 as const,
  setSha256: "b".repeat(64),
  revision: "c".repeat(40),
  appliedAt: 2,
  members: [{ sha256: "d".repeat(64), previous: row, nativeReview: false }],
  disabledInstallations: [],
};

test("the replacement journal and its staging are durable before anything relies on them (#1068)", () => {
  root = actual.mkdtempSync(join(tmpdir(), "manifold-replacement-durability-"));
  try {
    trace.length = 0;
    writeReplacementJournal(root, [record]);
    expect(trace).toEqual([
      "fsync .",
      "fsync plugin-replacement/journal.json.next",
      "rename plugin-replacement/journal.json.next plugin-replacement/journal.json",
      "fsync plugin-replacement",
    ]);
    expect(readReplacementJournal(root)).toEqual([record]);

    trace.length = 0;
    writeReplacementJournal(root, [{ ...record, appliedAt: 3 }]);
    expect(trace).toEqual([
      "fsync plugin-replacement/journal.json.next",
      "rename plugin-replacement/journal.json.next plugin-replacement/journal.json",
      "fsync plugin-replacement",
    ]);

    // Truncation, as a committed restore ends: the unlink is durable before anything else.
    trace.length = 0;
    writeReplacementJournal(root, []);
    expect(trace).toEqual(["rm plugin-replacement/journal.json", "fsync plugin-replacement"]);
    expect(readReplacementJournal(root)).toEqual([]);

    // A completed crossing's staged set is removed durably, never left to reappear.
    actual.mkdirSync(stagedReplacementDir(root));
    trace.length = 0;
    clearStagedReplacement(root);
    expect(trace).toEqual(["rm plugin-replacement/staged", "fsync plugin-replacement"]);
  } finally {
    actual.rmSync(root, { recursive: true, force: true });
  }
});
