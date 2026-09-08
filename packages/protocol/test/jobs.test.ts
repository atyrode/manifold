import { expect, test } from "bun:test";
import {
  MachineArtifactSchema,
  MachineLocationSchema,
  MachineOperationSchema,
  JobOutputBindingSchema,
} from "../src/jobs.ts";

const location = { anchor: "config", components: ["vault"], revision: "r1", kind: "file" };
test("guest paths permit exact hidden files but never home-root or noncanonical paths", () => {
  expect(
    MachineLocationSchema.parse({ ...location, guestPath: "/home/job/.config/auth/vault.json" })
      .guestPath,
  ).toBe("/home/job/.config/auth/vault.json");
  for (const guestPath of [
    "/home/job",
    "/home/job/",
    "/home/job/../vault",
    "/home/job/a/../../vault",
    "/home/job/./vault",
    "/home/job//vault",
    "/home/job/a/",
    "/etc/vault",
    "/home/job/a\\b",
  ]) {
    expect(MachineLocationSchema.safeParse({ ...location, guestPath }).success).toBe(false);
  }
});

test("named resources admit hidden account directories without admitting traversal", () => {
  expect(
    MachineLocationSchema.safeParse({
      anchor: "home",
      components: [".omp", "agent", "sessions"],
      revision: "r1",
    }).success,
  ).toBe(true);
  for (const component of [".", "..", "../.omp", "/.omp", ".omp/agent", ".omp\\agent"]) {
    expect(
      MachineLocationSchema.safeParse({
        anchor: "home",
        components: [component],
        revision: "r1",
      }).success,
    ).toBe(false);
  }
});

const artifact = {
  url: "https://example.invalid/tool",
  sha256: "a".repeat(64),
  entrySha256: "b".repeat(64),
  format: "tar.gz",
  entry: ["main"],
  maxBytes: 4096,
  maxExpandedBytes: 8192,
  maxMembers: 8,
};
test("artifact executable bundles pin selected members and never admit URL credentials or raw companion files", () => {
  const files = { helper: { entry: ["bin", "helper"], sha256: "c".repeat(64) } };
  expect(MachineArtifactSchema.parse({ ...artifact, files }).files).toEqual(files);
  expect(MachineArtifactSchema.safeParse({ ...artifact, files, format: "raw" }).success).toBe(
    false,
  );
  expect(
    MachineArtifactSchema.safeParse({
      ...artifact,
      url: "https://user:secret@example.invalid/tool",
    }).success,
  ).toBe(false);
  expect(
    MachineArtifactSchema.safeParse({
      ...artifact,
      files: { helper: { entry: ["..", "tool"], sha256: "c".repeat(64) } },
    }).success,
  ).toBe(false);
});

test("owner-retained stdout and stderr cannot be caller-declared or rebound as filesystem outputs", () => {
  const operation = {
    argv: [],
    input: {},
    runtimeTools: ["custom-runner"],
    locations: [],
    network: "none",
    limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
    stdin: false,
  };
  expect(MachineOperationSchema.parse({ ...operation, outputs: ["report"] }).outputs).toEqual([
    "report",
  ]);
  for (const name of ["stdout", "stderr"]) {
    expect(MachineOperationSchema.safeParse({ ...operation, outputs: [name] }).success).toBe(false);
    expect(
      JobOutputBindingSchema.safeParse({
        name,
        locationId: "sample.worker.data",
        components: ["output"],
      }).success,
    ).toBe(false);
  }
});
