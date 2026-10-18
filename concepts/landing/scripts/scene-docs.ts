// bun concepts/landing/scripts/scene-docs.ts [--check]
//
// The docs' generated tables: each a region of src/scenes/README.md between `<!-- gen:<name> -->`
// and `<!-- /gen:<name> -->`, written from the scene registry (and, for the opt-in components, the
// scenes' code), so they cannot drift from what the lab holds:
//   scenes       every scene in the Scenes view's order: its title, family, how it is built (a
//                composer's preset and its layers, or a program of its own), knobs, committed
//                presets and blurb ("The scenes");
//   knobs        the shared sky and weather knobs each scene carries, at their defaults, and whether
//                its night sky hangs planets ("Sky capabilities by scene");
//   composed-by  which scenes compose each opt-in GLSL component ("Composing components").
// Run it after adding a scene or changing what these say, and commit the README; with `--check` it
// writes nothing and exits 1 while a region is stale. scene-docs.test.ts fails while one is.
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import type { Composer } from "../src/composer/compose.ts";
import { interior } from "../src/composer/interior.ts";
import { outdoor } from "../src/composer/outdoor.ts";
import { families, sceneFamily, sceneOrder } from "../src/lab/families.ts";
import type { ParamDef } from "../src/params.ts";
import { presets } from "../src/presets.ts";
import { loadScene, sceneDefs, type SceneId } from "../src/scenes/index.ts";
import type { LoadedScene, SceneDef } from "../src/scenes/types.ts";
import { buildingsGlsl } from "../src/shaders/buildings.ts";
import { sceneFeatures, sceneFeaturesAll } from "../src/shaders/index.ts";
import { birdsGlsl } from "../src/shaders/lib/birds.ts";
import { canopyGroveGlsl } from "../src/shaders/lib/canopy.ts";
import { fieldsGlsl } from "../src/shaders/lib/fields.ts";
import { figuresGlsl } from "../src/shaders/lib/figures.ts";
import { livestockGlsl } from "../src/shaders/lib/livestock.ts";
import { milkyWayGlsl } from "../src/shaders/lib/milkyway.ts";
import { planetGlsl } from "../src/shaders/lib/planet.ts";
import { plantsGlsl } from "../src/shaders/lib/plants.ts";
import { terrainGlsl } from "../src/shaders/lib/terrain.ts";
import { treesGlsl } from "../src/shaders/lib/trees.ts";
import { worldGlsl } from "../src/shaders/lib/world.ts";

/** The README whose regions this writes. */
export const README_PATH = fileURLToPath(new URL("../src/scenes/README.md", import.meta.url));

/** The composers whose presets the scenes table names, found by their home layers. */
const COMPOSERS: readonly Composer[] = [outdoor, interior];

/** The shared knobs the knobs table shows, as its columns: heading and knob key. */
const SHARED_KNOBS: readonly (readonly [heading: string, key: string])[] = [
  ["Time", "time"],
  ["Stars", "stars"],
  ["Milky Way", "milkyWay"],
  ["Moon", "moon"],
  ["Figures", "constellations"],
  ["Meteors", "meteors"],
  ["Aurora", "aurora"],
  ["Clouds", "clouds"],
  ["Rain", "rain"],
  ["Snow", "snow"],
  ["Fog", "fog"],
  ["Wind", "wind"],
  ["Lightning", "lightning"],
  ["Birds", "birds"],
];

/** The opt-in GLSL components, in the README's order: what each is, where it lives and is told. */
const OPT_IN: readonly { name: string; glsl: string; file: string; see: string; also?: string }[] =
  [
    { name: "worldGlsl", glsl: worldGlsl, file: "src/shaders/lib/world.ts", see: '"World layers"' },
    { name: "birdsGlsl", glsl: birdsGlsl, file: "src/shaders/lib/birds.ts", see: '"Birds"' },
    {
      name: "milkyWayGlsl",
      glsl: milkyWayGlsl,
      file: "src/shaders/lib/milkyway.ts",
      see: "the Milky Way row below",
    },
    {
      name: "canopyGroveGlsl",
      glsl: canopyGroveGlsl,
      file: "src/shaders/lib/canopy.ts",
      see: '"Shared libraries" (the canopy)',
    },
    {
      name: "plantsGlsl",
      glsl: plantsGlsl,
      file: "src/shaders/lib/plants.ts",
      see: '"Rooted plants"',
    },
    {
      name: "planetGlsl",
      glsl: planetGlsl,
      file: "src/shaders/lib/planet.ts",
      see: '"The giant planet"',
      also: "every sky's `skyGiant`, in `libs` behind its gate (`SKY_PLANETS`)",
    },
    {
      name: "figuresGlsl",
      glsl: figuresGlsl,
      file: "src/shaders/lib/figures.ts",
      see: '"Figures, livestock and buildings"',
    },
    {
      name: "livestockGlsl",
      glsl: livestockGlsl,
      file: "src/shaders/lib/livestock.ts",
      see: '"Figures, livestock and buildings"',
    },
    {
      name: "buildingsGlsl",
      glsl: buildingsGlsl,
      file: "src/shaders/buildings.ts",
      see: '"Figures, livestock and buildings"',
    },
    {
      name: "terrainGlsl",
      glsl: terrainGlsl,
      file: "src/shaders/lib/terrain.ts",
      see: '`TerrainBuilder` under "Simulations"',
    },
    {
      name: "fieldsGlsl",
      glsl: fieldsGlsl,
      file: "src/shaders/lib/fields.ts",
      see: "the fields row below",
    },
    {
      name: "treesGlsl",
      glsl: treesGlsl,
      file: "src/shaders/lib/trees.ts",
      see: "the trees row below",
    },
  ];

/** A Markdown table of these rows under these headings, its cells' pipes escaped. */
function table(headings: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
  return [line(headings), line(headings.map(() => "---")), ...rows.map(line)].join("\n");
}

const code = (text: string) => `\`${text}\``;

/** A knob's default value as the docs give it: a number to three places at most. */
const number = (value: number) => String(Number(value.toFixed(3)));

/** The composer whose registry holds a composed scene's home layers. */
function composerOf(def: SceneDef): Composer {
  const home = def.layers?.home[0];
  const composer = COMPOSERS.find((each) => each.layers.some((layer) => layer.id === home));
  if (composer === undefined)
    throw new Error(
      `scene-docs: no composer in COMPOSERS (scripts/scene-docs.ts) holds ${def.id}'s layer ${home}`,
    );
  return composer;
}

/** How a scene is built: its composer and layers (the home ones, then those its rig also offers). */
function built(def: SceneDef): string {
  if (def.layers === undefined) return "its own program";
  const home = def.layers.home.length;
  const guests = def.layers.offered.length - home;
  const layers = `${home} layer${home === 1 ? "" : "s"}${guests > 0 ? ` + ${guests} offered` : ""}`;
  return `${code(composerOf(def).id)} preset, ${layers}`;
}

/** Committed presets by scene: the `scene` of each preset's query. */
function presetCounts(): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const preset of presets) {
    const scene = new URLSearchParams(preset.query).get("scene") ?? "";
    counts.set(scene, (counts.get(scene) ?? 0) + 1);
  }
  return counts;
}

/** The scenes table: one row a scene, in the Scenes view's order. */
export function scenesTable(): string {
  const counts = presetCounts();
  const familyTitle: Record<string, string> = Object.fromEntries(
    families.map((family) => [family.id, family.title]),
  );
  return table(
    ["Scene", "Title", "Family", "Built as", "Knobs", "Presets", "Blurb"],
    sceneOrder.map((id) => {
      const def: SceneDef = sceneDefs[id];
      return [
        code(id),
        def.title,
        familyTitle[sceneFamily[id]] ?? sceneFamily[id],
        built(def),
        String(def.params.length),
        String(counts.get(id) ?? 0),
        def.blurb,
      ];
    }),
  );
}

/** A knob's default as the knobs table gives it, and its "now" slot if it has one. */
function knobCell(param: ParamDef): string {
  const value =
    param.kind === "feature"
      ? param.on
        ? number(param.value)
        : "off"
      : param.kind === "toggle"
        ? param.value > 0
          ? "on"
          : "off"
        : param.kind === "choice"
          ? (param.options.find((option) => option.value === param.value)?.label ??
            number(param.value))
          : number(param.value);
  return param.trigger === undefined ? value : `${value}, now ${param.trigger}`;
}

/** The knobs table: every scene with a shared sky or weather knob or a sky of planets. */
export function knobsTable(): string {
  const rows: string[][] = [];
  for (const id of sceneOrder) {
    const def: SceneDef = sceneDefs[id];
    const cells = SHARED_KNOBS.map(([, key]) => {
      const param = def.params.find((each) => each.key === key);
      return param === undefined ? "—" : knobCell(param);
    });
    const planets =
      def.planets === undefined
        ? "—"
        : def.planets.defaults === undefined || def.planets.defaults.length === 0
          ? "yes"
          : `yes, ${def.planets.defaults.length} at first`;
    if (def.planets === undefined && cells.every((cell) => cell === "—")) continue;
    rows.push([code(id), ...cells, planets]);
  }
  return table(["Scene", ...SHARED_KNOBS.map(([heading]) => heading), "Planets"], rows);
}

/** The GLSL a scene adds to the libraries in its all-features program (or its only one). */
function sceneGlsl(scene: LoadedScene): string {
  const features = sceneFeaturesAll(scene) ?? sceneFeatures(scene);
  return scene.glslFor?.(features) ?? scene.glsl;
}

/** The scenes as a list: "every composed scene" for all of them, the rest by id. */
function sceneList(ids: readonly SceneId[]): string {
  const composed = sceneOrder.filter((id) => sceneDefs[id].layers !== undefined);
  const all = composed.length > 0 && composed.every((id) => ids.includes(id));
  const named = (all ? ids.filter((id) => !composed.includes(id)) : ids).join(", ");
  return all ? (named === "" ? "every composed scene" : `every composed scene, ${named}`) : named;
}

/** The composed-by table: each opt-in component and the scenes whose GLSL holds it. */
export async function composedByTable(): Promise<string> {
  const scenes = await Promise.all(
    sceneOrder.map(async (id) => ({ id, glsl: sceneGlsl(await loadScene(id)) })),
  );
  return table(
    ["String", "File", "Composed by", "See"],
    OPT_IN.map((component) => {
      // A component another one carries (the World's birds) is named through that one.
      const carriers = OPT_IN.filter(
        (other) => other !== component && other.glsl.includes(component.glsl),
      );
      const direct = scenes
        .filter(
          ({ glsl }) =>
            glsl.includes(component.glsl) && !carriers.some((other) => glsl.includes(other.glsl)),
        )
        .map(({ id }) => id);
      const through = carriers
        .filter((other) => scenes.some(({ glsl }) => glsl.includes(other.glsl)))
        .map((other) => `through ${code(other.name)}`);
      const parts = [sceneList(direct), ...through, ...(component.also ? [component.also] : [])];
      return [
        code(component.name),
        code(component.file),
        parts.filter((part) => part !== "").join("; "),
        component.see,
      ];
    }),
  );
}

/** Every generated region's Markdown, keyed by its name. */
export async function docRegions(): Promise<Record<string, string>> {
  return { scenes: scenesTable(), knobs: knobsTable(), "composed-by": await composedByTable() };
}

/** A generated region: its opening marker, its name and its closing marker. */
export const REGION = /(<!-- gen:([a-z-]+) -->)[\s\S]*?(<!-- \/gen:\2 -->)/g;

/** `markdown` with every generated region rewritten, each as prettier lays out the README. */
export async function renderDocs(markdown: string): Promise<string> {
  const regions = await docRegions();
  const options = { ...(await resolveConfig(README_PATH)), parser: "markdown" as const };
  const formatted = new Map<string, string>();
  for (const [name, body] of Object.entries(regions))
    formatted.set(name, (await format(body, options)).trimEnd());
  const written = new Set<string>();
  const out = markdown.replace(REGION, (_, open: string, name: string, close: string) => {
    const body = formatted.get(name);
    if (body === undefined) throw new Error(`scene-docs: README region gen:${name} is unknown`);
    written.add(name);
    return `${open}\n\n${body}\n\n${close}`;
  });
  const missing = [...formatted.keys()].filter((name) => !written.has(name));
  if (missing.length > 0)
    throw new Error(`scene-docs: README lacks the regions ${missing.map((n) => `gen:${n}`)}`);
  return out;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const markdown = await Bun.file(README_PATH).text();
  const rendered = await renderDocs(markdown);
  if (rendered === markdown) console.log("scene-docs: the README's generated tables are current");
  else if (check) {
    console.error("scene-docs: stale; run bun concepts/landing/scripts/scene-docs.ts");
    process.exit(1);
  } else {
    await Bun.write(README_PATH, rendered);
    console.log("scene-docs: rewrote the README's generated tables");
  }
}
