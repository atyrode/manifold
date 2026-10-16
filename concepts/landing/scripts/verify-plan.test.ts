import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkScenes,
  DEADLINE_SECONDS,
  deadlineSeconds,
  parseScenes,
  parseShard,
  shardChecks,
  timingsModule,
  VerifyPlanError,
} from "./verify-plan.ts";
import { recordedSeconds } from "./verify-timings.ts";

const names = [...Object.keys(recordedSeconds), "unrecordedOne", "unrecordedTwo"];

describe("shards", () => {
  test("every check runs in exactly one shard, and the shards balance within the longest check", () => {
    const longest = Math.max(...Object.values(recordedSeconds));
    for (let count = 1; count <= 6; count += 1) {
      const shares = Array.from({ length: count }, (_, index) =>
        shardChecks(names, recordedSeconds, { index: index + 1, count }),
      );
      expect(shares.flat().sort()).toEqual([...names].sort());
      const totals = shares.map((share) =>
        share.reduce((sum, name) => sum + (recordedSeconds[name] ?? 0), 0),
      );
      expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(longest);
    }
  });

  test("a shard keeps the registry's order", () => {
    const share = shardChecks(names, recordedSeconds, { index: 2, count: 3 });
    expect(share).toEqual(names.filter((name) => share.includes(name)));
  });

  test("only i/n with 1 <= i <= n names a shard", () => {
    expect(parseShard("3/4")).toEqual({ index: 3, count: 4 });
    for (const value of ["0/4", "5/4", "1/0", "4", "a/b", "-1/4"])
      expect(() => parseShard(value)).toThrow(VerifyPlanError);
  });
});

test("a check may outrun its record, and never gets less than the default deadline", () => {
  for (const [name, seconds] of Object.entries(recordedSeconds)) {
    expect(deadlineSeconds(name, recordedSeconds)).toBeGreaterThanOrEqual(DEADLINE_SECONDS);
    expect(deadlineSeconds(name, recordedSeconds)).toBeGreaterThan(seconds * 2);
  }
  expect(deadlineSeconds("unrecordedOne", recordedSeconds)).toBe(DEADLINE_SECONDS);
});

describe("scene scope", () => {
  test("an unset, empty or * scope runs every scene; an unknown scene fails the run", () => {
    for (const value of [undefined, "", "*"]) expect(parseScenes(value, ["pond"])).toBeUndefined();
    expect(parseScenes("pond,lake", ["lake", "pond"])).toEqual(["pond", "lake"]);
    expect(() => parseScenes("pond,swamp", ["pond"])).toThrow(VerifyPlanError);
  });

  const registry = `import { inlineHelper } from "./src/state.ts";
import { sharedCheck } from "./src/features.verify.ts";
import { ownCheck, borrowedCheck } from "./src/scenes/meadow/own.verify.ts";
import {
  namedCheck,
  type Unused,
} from "./src/scenes/island/water.verify.ts";
import { walkCheck } from "./src/scenes/lake/walk.verify.ts";
function inline(): void {}
export const checks: readonly Check[] = [
  ["inline", inline],
  ["shared", sharedCheck],
  ["own", ownCheck],
  ["borrowed", borrowedCheck],
  ["named", namedCheck(0, 2)],
  ["walk", walkCheck],
];`;
  const files: Readonly<Record<string, string>> = {
    "src/features.verify.ts": `export function sharedCheck() {}`,
    "src/scenes/meadow/own.verify.ts": `import { flowers } from "./flowers.ts";
import { sceneDefs } from "../index.ts";
import { state } from "../../state.ts";
export function ownCheck() {}`,
    "src/scenes/meadow/flowers.ts": `import { boids } from "../flock/boids.ts";`,
    "src/scenes/flock/boids.ts": `export const boids = 1;`,
    "src/scenes/index.ts": `export const sceneDefs = { pond, lake, meadow, island, shore, flock };`,
    "src/state.ts": `const named = "pond";`,
    "src/scenes/island/water.verify.ts": `export const adopters = [sceneDefs.shore, "pond"];`,
    "src/scenes/lake/walk.verify.ts": `for (const scene of Object.values(sceneDefs)) {}`,
  };
  const ids = ["pond", "lake", "meadow", "island", "shore", "flock"];
  const covered = checkScenes(registry, (path) => files[path], ids);
  const scenes = (name: string): string[] | undefined => {
    const covers = covered.get(name);
    return covers === undefined ? undefined : [...covers].sort();
  };

  test("a check outside a scene directory covers every scene", () => {
    expect(scenes("inline")).toBeUndefined();
    expect(scenes("shared")).toBeUndefined();
  });

  test("a scene's check covers its scene and the scene files it reaches, not the roster's", () => {
    expect(scenes("own")).toEqual(["flock", "meadow"]);
    expect(scenes("borrowed")).toEqual(["flock", "meadow"]);
  });

  test("a scene's check covers the scenes it names", () => {
    expect(scenes("named")).toEqual(["island", "pond", "shore"]);
  });

  test("a scene's check that walks every scene covers them all", () => {
    expect(covered.has("walk")).toBe(true);
    expect(scenes("walk")).toBeUndefined();
  });
});

test("--record writes a module that reads back the recorded seconds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "landing-timings-"));
  try {
    const path = join(dir, "verify-timings.ts");
    await Bun.write(path, timingsModule({ slowCheck: 165.84, quick: 0.04, "odd-name": 12 }));
    // The module is written by this test, so only its path at run time can name it.
    const written = (await import(path)) as { recordedSeconds: Record<string, number> };
    expect(written.recordedSeconds).toEqual({ slowCheck: 165.8, quick: 0, "odd-name": 12 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
