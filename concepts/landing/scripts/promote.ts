// bun concepts/landing/scripts/promote.ts [--id <id>] [--title <title>] [--blurb <blurb>]
//                                        [--commit <commit>] [--name <name>] <query>
//
// Promote a saved preset to a curated variant (ADR 0062 D15), as the lab's Promote shows it: fold
// its query into its room's differences from the interior's baseline (src/lab/promote-model.ts),
// write the entry into src/composer/interior-variants.ts, give its programs a compile budget in
// src/shaders/shake.test.ts (10% over their sizes now, as the others were set) and, for a committed
// preset, remove it from src/presets.ts; then regenerate the scene docs (scene-docs.ts). A preset
// is promoted only where it loads as itself on this tree, and only if the variant composed lists
// its query's knobs at its query's values. The names default to those the lab suggests from the
// committed preset's name; a preset saved in a browser gives its `--commit` (default
// "working-tree") and `--name`. Afterwards: render its thumbnail (`thumbs.ts <id>`), check it draws
// as its query did (`ab.ts '<scene=id>~<query>'`, the base the commit before the promotion) and run
// the tests.
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { composedCode } from "../src/composer/code.ts";
import { composeScene, variantPreset } from "../src/composer/compose.ts";
import { INTERIOR_CODE } from "../src/composer/interior-code.ts";
import { interior } from "../src/composer/interior.ts";
import { promote, suggestNames } from "../src/lab/promote-model.ts";
import { presets, type Preset } from "../src/presets.ts";
import type { LoadedScene } from "../src/scenes/types.ts";
import { fragmentSourceFor, sceneFeatures, sceneFeaturesAll } from "../src/shaders/index.ts";

function usage(message: string): never {
  console.error(
    `promote: ${message}\nusage: bun concepts/landing/scripts/promote.ts [--id <id>] ` +
      "[--title <title>] [--blurb <blurb>] [--commit <commit>] [--name <name>] <query>",
  );
  process.exit(2);
}

const options: Record<string, string> = {};
const positional: string[] = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? "";
  if (!arg.startsWith("--")) {
    positional.push(arg);
    continue;
  }
  const key = arg.slice(2);
  if (!["id", "title", "blurb", "commit", "name"].includes(key)) usage(`unknown option ${arg}`);
  const value = args[index + 1];
  if (value === undefined) usage(`${arg} needs a value`);
  options[key] = value;
  index += 1;
}
const [query, ...extra] = positional;
if (query === undefined || extra.length > 0) usage("give one preset query");

const committed = presets.find((preset) => preset.query === query);
const preset: Preset = committed ?? {
  name: options.name ?? query,
  commit: options.commit ?? "working-tree",
  query,
  savedAt: new Date().toISOString().slice(0, 10),
};
const suggested = suggestNames(preset);
const names = {
  id: options.id ?? suggested.id,
  title: options.title ?? suggested.title,
  blurb: options.blurb ?? suggested.blurb,
};
const result = promote(preset, names);
if (!result.ok) {
  console.error(`promote: ${query}: ${result.reason}`);
  process.exit(1);
}

/** Write `text` to `path`, formatted as the repository's prettier formats it. */
async function writeFormatted(path: string, text: string): Promise<void> {
  const config = (await resolveConfig(path)) ?? {};
  await Bun.write(path, await format(text, { ...config, filepath: path }));
}

const variantsPath = fileURLToPath(
  new URL("../src/composer/interior-variants.ts", import.meta.url),
);
const variants = await Bun.file(variantsPath).text();
const registry =
  /(export const promotedInteriorVariants = \{)([\s\S]*?)\n?(\} satisfies Readonly<Record<string, Variant>>;)/;
const found = registry.exec(variants);
if (found === null) {
  console.error(`promote: no promotedInteriorVariants record in ${variantsPath}`);
  process.exit(1);
}
const [whole, open = "", entries = "", close = ""] = found;
await writeFormatted(
  variantsPath,
  variants.replace(whole, `${open}${entries.trimEnd()}\n${result.entry}\n${close}`),
);
console.log(`promote: ${names.id} written into ${variantsPath}`);

if (committed !== undefined) {
  const presetsPath = fileURLToPath(new URL("../src/presets.ts", import.meta.url));
  const text = await Bun.file(presetsPath).text();
  const at = text.indexOf(JSON.stringify(query));
  const start = text.lastIndexOf("\n  {\n", at);
  const end = text.indexOf("\n  },", at);
  if (at < 0 || start < 0 || end < 0) {
    console.error(
      `promote: could not find "${committed.name}" in ${presetsPath}; remove it by hand`,
    );
    process.exit(1);
  }
  await writeFormatted(presetsPath, text.slice(0, start) + text.slice(end + "\n  },".length));
  console.log(`promote: "${committed.name}" removed from ${presetsPath}`);
}

// Its programs' compile budget: the shaken default and all-features programs, as shake.test.ts
// measures them, each ceiling 10% over, in the table's alphabetical place.
const composed = composeScene(interior, variantPreset(interior.baseline, result.variant));
const code = composedCode(composed, INTERIOR_CODE);
const loaded: LoadedScene = { ...composed.def, code: () => Promise.resolve(code), ...code };
const all = sceneFeaturesAll(loaded);
const ceilings = [sceneFeatures(loaded), ...(all === undefined ? [] : [all])].map(
  (features) => Math.ceil((fragmentSourceFor(loaded, features).length * 1.1) / 500) * 500,
);
const shakePath = fileURLToPath(new URL("../src/shaders/shake.test.ts", import.meta.url));
const shake = await Bun.file(shakePath).text();
const budget = /const BUDGET = \{\n([\s\S]*?)\n\} as const satisfies/.exec(shake);
if (budget === null) {
  console.error(
    `promote: no BUDGET table in ${shakePath}; add ${names.id}: [${ceilings.join(", ")}]`,
  );
  process.exit(1);
}
const rows = (budget[1] ?? "").split("\n");
const after = rows.findIndex((row) => (/^ {2}(\w+): \[/.exec(row)?.[1] ?? "") > names.id);
const row = [
  `  // Promoted from ${result.room} (scripts/promote.ts): 10% over its programs when promoted.`,
  `  ${names.id}: [${ceilings.join(", ")}],`,
];
// A row's comment lines stand above it: the new row goes above the comment of the one after it.
let at = after < 0 ? rows.length : after;
while (at > 0 && rows[at - 1]?.trimStart().startsWith("//")) at -= 1;
rows.splice(at, 0, ...row);
await writeFormatted(shakePath, shake.replace(budget[1] ?? "", rows.join("\n")));
console.log(`promote: ${names.id}'s compile budget [${ceilings.join(", ")}] in ${shakePath}`);

const docs = Bun.spawnSync(["bun", fileURLToPath(new URL("./scene-docs.ts", import.meta.url))], {
  stdout: "inherit",
  stderr: "inherit",
});
if (docs.exitCode !== 0) {
  console.error("promote: scene-docs.ts failed; run it again once the tree builds");
  process.exit(1);
}

const scene = `scene=${names.id}`;
console.log(
  [
    "promote: next,",
    `  bun concepts/landing/scripts/thumbs.ts ${names.id}`,
    `  bun concepts/landing/scripts/ab.ts '${scene}~${query}'   # the base: the commit before this`,
    "  bun test concepts/landing/src/composer/interior-variants.test.ts concepts/landing/src/scenes/registry.test.ts concepts/landing/src/shaders/shake.test.ts",
  ].join("\n"),
);
