// Which of the lab's browser checks a verify.ts run takes on, and how long each may run: its share
// of the registry under `--shard i/n`, packed by the seconds each check last took
// (verify-timings.ts); the checks a run scoped to some scenes keeps (LANDING_SCENES); and each
// check's deadline.
import { dirname, join, normalize } from "node:path";

/** A plan input that cannot be honoured: a malformed shard or an unknown scene. */
export class VerifyPlanError extends Error {}

/** Run the `index`th (1-based) of `count` disjoint shares of the checks. */
export interface Shard {
  readonly index: number;
  readonly count: number;
}

export function parseShard(value: string): Shard {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || index < 1 || index > count)
    throw new VerifyPlanError(`--shard takes i/n with 1 <= i <= n, not ${JSON.stringify(value)}`);
  return { index, count };
}

/** A check's deadline without a longer record, and the share of a record it may overrun by. */
export const DEADLINE_SECONDS = 180;
const DEADLINE_RECORDS = 3;

/** Seconds `name` may run: three times its record, never under DEADLINE_SECONDS. */
export function deadlineSeconds(name: string, recorded: Readonly<Record<string, number>>): number {
  return Math.max(DEADLINE_SECONDS, Math.ceil(DEADLINE_RECORDS * (recorded[name] ?? 0)));
}

/**
 * The checks of `names` that `shard` runs, in their given order. Longest first, each check joins
 * the share with the fewest recorded seconds so far (ties to the lower share), so every check runs
 * in exactly one share and the shares' totals differ by at most the longest check. A check without
 * a record weighs the median record.
 */
export function shardChecks(
  names: readonly string[],
  recorded: Readonly<Record<string, number>>,
  shard: Shard,
): string[] {
  const records = Object.values(recorded).sort((a, b) => a - b);
  const typical = records[Math.floor(records.length / 2)] ?? 1;
  const weight = (name: string): number => recorded[name] ?? typical;
  const longestFirst = [...new Set(names)].sort(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const totals = Array.from({ length: shard.count }, () => 0);
  const share = new Map<string, number>();
  for (const name of longestFirst) {
    let least = 0;
    for (let index = 1; index < totals.length; index += 1) {
      if ((totals[index] ?? 0) < (totals[least] ?? 0)) least = index;
    }
    totals[least] = (totals[least] ?? 0) + weight(name);
    share.set(name, least);
  }
  return names.filter((name) => share.get(name) === shard.index - 1);
}

/**
 * The scenes LANDING_SCENES scopes a run to: every scene (undefined) when it is unset, empty or
 * `*`, else its comma list, each one of `known`. An unknown scene fails rather than narrowing the
 * run to nothing.
 */
export function parseScenes(
  value: string | undefined,
  known: readonly string[],
): readonly string[] | undefined {
  if (value === undefined || value === "" || value === "*") return undefined;
  const scenes = value.split(",");
  const unknown = scenes.filter((id) => !known.includes(id));
  if (unknown.length > 0)
    throw new VerifyPlanError(`LANDING_SCENES names unknown scenes: ${unknown.join(", ")}`);
  return scenes;
}

const SCENE_FILE = /^src\/scenes\/([a-z][a-z0-9]*)\//;
/** A module that may reach any scene, so its checks cover them all. */
const EVERY_SCENE = /\bsceneIds\b|Object\.(?:keys|values|entries)\(\s*sceneDefs\s*\)/;
/** A registry import of check functions, and a registry entry: `["name", check`. */
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*"(\.\/[^"]+)"/g;
const ENTRY = /\[\s*"([^"]+)"\s*,\s*([A-Za-z_$][\w$]*)/g;

/**
 * The scenes each check registered in `registry` (verify-browser.ts's source) covers, by name;
 * undefined for every scene. A check whose function comes from a module under src/scenes/<id>/
 * covers <id>, the scene directories of the scene files that module imports (directly or through
 * one another), and every scene those files name (`sceneDefs.<id>`, or the id as a whole string
 * literal); one of them that walks every scene covers them all. Any other check (defined in the
 * registry, or imported from a module outside a scene directory) covers every scene. `read` reads a
 * file by its path from the lab's root, undefined when there is none.
 */
export function checkScenes(
  registry: string,
  read: (path: string) => string | undefined,
  scenes: readonly string[],
): ReadonlyMap<string, ReadonlySet<string> | undefined> {
  const from = new Map<string, string>();
  for (const [, names = "", path = ""] of registry.matchAll(IMPORT)) {
    // `name`, `type Name` or `imported as name`: the binding is the entry's last word.
    for (const entry of names.split(",")) {
      const local = /([A-Za-z_$][\w$]*)\s*$/.exec(entry)?.[1];
      if (local !== undefined) from.set(local, normalize(path));
    }
  }
  const start = registry.indexOf("export const checks");
  const list = start === -1 ? "" : registry.slice(start, registry.indexOf("\n];", start));
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const covered = new Map<string, ReadonlySet<string> | undefined>();
  for (const [, name = "", check = ""] of list.matchAll(ENTRY)) {
    const file = from.get(check);
    const home = file === undefined ? undefined : SCENE_FILE.exec(file)?.[1];
    if (file === undefined || home === undefined) {
      covered.set(name, undefined);
      continue;
    }
    const ids = new Set<string>([home]);
    const seen = new Set<string>();
    const queue = [file];
    let everyScene = false;
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      if (seen.has(path)) continue;
      seen.add(path);
      const source = read(path);
      if (source === undefined) continue;
      const dir = SCENE_FILE.exec(path)?.[1];
      if (dir !== undefined) ids.add(dir);
      if (EVERY_SCENE.test(source)) everyScene = true;
      for (const id of scenes) {
        if (new RegExp(`sceneDefs\\.${id}\\b|(["'\`])${id}\\1`).test(source)) ids.add(id);
      }
      for (const { path: spec } of transpiler.scanImports(source)) {
        const target = spec.startsWith(".") ? join(dirname(path), spec) : undefined;
        if (target !== undefined && SCENE_FILE.test(target)) queue.push(target);
      }
    }
    covered.set(name, everyScene ? undefined : ids);
  }
  return covered;
}

const TIMINGS_HEADER = `// Seconds each of the lab's browser checks took when last recorded (software WebGL, dev host).
// verify.ts packs its CI shards by them and gives a check three times its record as its deadline
// (never under 180 s); a check without a record weighs the median one and keeps 180 s.
// Written by \`bun concepts/landing/verify.ts --record\` from the checks that pass.
`;

/** verify-timings.ts holding `recorded`, by name, each to a tenth of a second. */
export function timingsModule(recorded: Readonly<Record<string, number>>): string {
  const lines = Object.keys(recorded)
    .sort()
    .map((name) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
      return `  ${key}: ${String(Math.round((recorded[name] ?? 0) * 10) / 10)},\n`;
    });
  return `${TIMINGS_HEADER}export const recordedSeconds: Readonly<Record<string, number>> = {\n${lines.join("")}};\n`;
}
