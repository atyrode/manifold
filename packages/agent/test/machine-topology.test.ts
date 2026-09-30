import { describe, expect, test } from "bun:test";
import { readPhysicalCoreCount } from "../src/machine-topology.ts";

const ROOT = "/sys/devices/system/cpu";

function topology(online: string, pairs: Readonly<Record<number, readonly [number, number]>>) {
  const files: Record<string, string> = { [`${ROOT}/online`]: online };
  for (const [cpu, [packageId, coreId]] of Object.entries(pairs)) {
    files[`${ROOT}/cpu${cpu}/topology/physical_package_id`] = `${packageId}\n`;
    files[`${ROOT}/cpu${cpu}/topology/core_id`] = `${coreId}\n`;
  }
  return files;
}

function count(files: Readonly<Record<string, string>>) {
  return readPhysicalCoreCount({ platform: "linux", read: (path) => files[path] });
}

describe("OS-visible physical core topology", () => {
  test("collapses SMT siblings but separates packages, ignoring offline CPU topology", () => {
    const files = topology("0-3,6-7\n", {
      0: [0, 0],
      1: [0, 0],
      2: [0, 1],
      3: [0, 1],
      4: [9, 0],
      5: [9, 1],
      6: [1, 0],
      7: [1, 0],
    });
    // Offline entries need not even be readable: only online package/core pairs count.
    files[`${ROOT}/cpu4/topology/core_id`] = "broken";
    expect(count(files)).toBe(3);
    expect(count(topology("3\n", { 3: [7, 12] }))).toBe(1);
  });

  test("malformed, empty, overlapping, unordered or over-bound online lists are unknown", () => {
    for (const online of [
      "",
      "\n",
      "0,",
      "0,,1",
      "0-",
      "0-2,2",
      "2,1",
      "2-1",
      "-1",
      "1.5",
      "0 1",
      "0-9007199254740992",
      "65536",
      "0-8192",
      "0".repeat(65_537),
    ]) {
      expect(count(topology(online, { 0: [0, 0], 1: [0, 1], 2: [0, 2] }))).toBeUndefined();
    }
    expect(count({})).toBeUndefined();
  });

  test("one missing or malformed identity invalidates the whole observation", () => {
    for (const field of ["physical_package_id", "core_id"]) {
      for (const invalid of [
        "",
        "-1\n",
        "1.5",
        "NaN",
        "0garbage",
        "9007199254740992",
        "1".repeat(33),
      ]) {
        const files = topology("0-1", { 0: [0, 0], 1: [0, 1] });
        files[`${ROOT}/cpu1/topology/${field}`] = invalid;
        expect(count(files)).toBeUndefined();
      }
      const files = topology("0-1", { 0: [0, 0], 1: [0, 1] });
      delete files[`${ROOT}/cpu1/topology/${field}`];
      expect(count(files)).toBeUndefined();
    }
    expect(
      readPhysicalCoreCount({
        platform: "linux",
        read: (path) => {
          if (path.endsWith("core_id")) throw new Error("EACCES");
          return path.endsWith("/online") ? "0" : "0\n";
        },
      }),
    ).toBeUndefined();
  });

  test("a CPU hotplug during either pass is unknown, not a partial core count", () => {
    for (const changedAt of [2, 3]) {
      let reads = 0;
      const files = topology("0-1", { 0: [0, 0], 1: [0, 1] });
      expect(
        readPhysicalCoreCount({
          platform: "linux",
          read: (path) => (path === `${ROOT}/online` && ++reads >= changedAt ? "0" : files[path]),
        }),
      ).toBeUndefined();
    }
  });

  test("identity changes between passes are unknown even when the count would stay the same", () => {
    const files = topology("0-1", { 0: [0, 0], 1: [0, 1] });
    let reads = 0;
    expect(
      readPhysicalCoreCount({
        platform: "linux",
        read: (path) => {
          if (path === `${ROOT}/cpu1/topology/core_id` && ++reads === 2) return "2\n";
          return files[path];
        },
      }),
    ).toBeUndefined();
  });

  test("unsupported platforms never consult Linux observations", () => {
    let observed = false;
    const result = readPhysicalCoreCount({
      platform: "darwin",
      read: () => {
        observed = true;
        return "0\n";
      },
    });
    expect(result).toBeUndefined();
    expect(observed).toBe(false);
  });

  test("the largest supported online set is finite and complete", () => {
    let observations = 0;
    const result = readPhysicalCoreCount({
      platform: "linux",
      read: (path) => {
        if (++observations > 32_771) throw new Error("observation budget exceeded");
        if (path.endsWith("/online")) return "0-8191";
        if (path.endsWith("physical_package_id")) return "0";
        return path.match(/\/cpu(\d+)\/topology\/core_id$/)?.[1];
      },
    });
    expect(result).toBe(8192);
    expect(observations).toBe(32_771);
  });
});
