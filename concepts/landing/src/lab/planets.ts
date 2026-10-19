// The Night sky section's planets (nightsky.ts holds them, its night draws them): a chip for each
// of the scene's planets, which picks the one the controls under them shape, a remove button on
// each, and an add button (up to PLANET_CAP); under them the picked planet's knobs (planetDefs),
// laid out from their kinds and widgets as a group's are: its placement on the position pad, its
// switches as chips, the rest as rows, each a gate that shows while what it hangs off is on (dom.ts
// gate, availability-model.ts). A planet is edited through a lab context of its own whose knobs
// are the planet's values, so every control a group uses works on it: each edit writes the whole
// list back under the scene's one planets key, as one change (one undo step). The rules apart from
// the DOM: planets-model.ts.
import type { ParamDef } from "../params.ts";
import {
  encodePlanets,
  PLANET_CAP,
  planetDefaults,
  planetDefs,
  PLANETS_KEY,
  readPlanet,
  type SkyPlanet,
  type SkyPlanets,
} from "../scenes/planets.ts";
import { chipGrid } from "./chips.ts";
import { iconButton, row, textButton } from "./controls.ts";
import { dependent, h, reveal, svg, type Built, type LabContext } from "./dom.ts";
import { Knobs, type SwitchDef } from "./knobs.ts";
import { positionPad } from "./pads.ts";
import {
  addedPlanet,
  kindPatch,
  planetArt,
  planetName,
  planetShows,
  type PlanetArt,
} from "./planets-model.ts";

/** A scene's planets as the section reaches them. */
export interface PlanetsHost {
  spec: SkyPlanets;
  /** The lab's context: the list on screen, and changes to it. */
  ctx: LabContext;
}

/** The planets' part of the section: their controls, their layer of the drawing, picking one. */
export interface Planets {
  controls: Built;
  art: { el: SVGGElement; sync: () => void };
  pick: (index: number) => void;
}

/** A row of a planet's controls: the group's own (inspector.ts #knobRow). */
export type PlanetRow = (knobs: Knobs, def: Exclude<ParamDef, SwitchDef>) => Built;

const HELP = `The planets hanging in this sky, up to ${PLANET_CAP}: add one, pick one to shape it below, remove one with its ×. Each is its own kind and look, standing among the stars or orbiting our world; a bigger one stands in front of a smaller.`;

/**
 * Where the drawing's planets stand: centres from `left` to `right` across the sky and from `low`
 * over the hills to `high`, radii from `small` to `large` with their size (PlanetArt.r); the hills'
 * line at `horizon`, where an orbit's path comes up and goes down.
 */
const FRAME = {
  left: 16,
  right: 224,
  low: 58,
  high: 16,
  small: 2,
  large: 11,
  horizon: 68,
} as const;
/** A planet's moons on its ring's plane, each its turn round it in degrees. */
const MOONS = [160, 20, 300] as const;

/** A planet's chip glyph: its disc in its tint, with its ring when it has one. */
function glyph(art: PlanetArt): SVGSVGElement {
  const disc = svg("circle", { class: "planet-glyph-disc", r: 4.5 });
  disc.style.setProperty("--tint", art.tint);
  return svg(
    "svg",
    { class: "planet-glyph", viewBox: "-8 -8 16 16", "aria-hidden": "true", focusable: "false" },
    disc,
    ...(art.ring > 0
      ? [
          svg("ellipse", {
            class: `planet-glyph-ring${art.ring > 1 ? " wide" : ""}`,
            rx: 7.5,
            ry: 2,
            transform: "rotate(-18)",
          }),
        ]
      : []),
  );
}

/** One planet in the drawing (a group, translated to where it stands), its orbit's path under it. */
function drawn(art: PlanetArt, index: number, picked: boolean, name: string): SVGGElement {
  const x = FRAME.left + art.x * (FRAME.right - FRAME.left);
  const y = FRAME.low - art.y * (FRAME.low - FRAME.high);
  const r = FRAME.small + art.r * (FRAME.large - FRAME.small);
  const parts: SVGElement[] = [];
  if (art.orbit !== undefined) {
    // A dashed arc up from the right horizon through where it tops out (the group's origin) and
    // down on the left, leaned as its path is: a quadratic whose middle is that top.
    const reach = 60;
    const down = FRAME.horizon - y;
    parts.push(
      svg("path", {
        class: "night-planet-path",
        d: `M${reach} ${down.toFixed(2)}Q0 ${(-down).toFixed(2)} ${-reach} ${down.toFixed(2)}`,
        transform: `rotate(${(-art.orbit).toFixed(1)})`,
      }),
    );
  }
  const rx = r * (art.ring > 1 ? 2.2 : 2.05);
  const ry = r * 0.42;
  const ring = (front: boolean) =>
    svg("path", {
      class: `night-planet-ring${art.ring > 1 ? " wide" : ""}`,
      d: `M${-rx} 0A${rx} ${ry} 0 0 ${front ? 0 : 1} ${rx} 0`,
    });
  const disc = svg("circle", { class: "night-planet-disc", r: r.toFixed(2) });
  disc.style.setProperty("--tint", art.tint);
  const tipped = svg(
    "g",
    { transform: "rotate(-18)" },
    ...(art.ring > 0 ? [ring(false)] : []),
    disc,
    ...(art.ring > 0 ? [ring(true)] : []),
    ...MOONS.slice(0, art.moons).map((turn) => {
      const angle = (turn * Math.PI) / 180;
      return svg("circle", {
        class: "night-planet-moon",
        cx: (Math.cos(angle) * r * 1.8).toFixed(2),
        cy: (-Math.sin(angle) * r * 0.5).toFixed(2),
        r: Math.max(1, r * 0.13).toFixed(2),
      });
    }),
  );
  parts.push(tipped);
  const title = svg("title");
  title.textContent = `Planet ${index + 1}: ${name}`;
  return svg(
    "g",
    {
      class: `night-planet${picked ? " picked" : ""}`,
      "data-planet": index,
      transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})`,
    },
    title,
    ...parts,
  );
}

/**
 * A planet's controls from its knobs, in their order: the placement pad where its across knob
 * stands, every switch as one grid of chips where the first stands (a count's segments under it),
 * the rest as `knobRow` makes them, each a gate on what it hangs off.
 */
function planetControls(knobs: Knobs, defs: readonly ParamDef[], knobRow: PlanetRow): Built {
  const items: { at: number; built: Built }[] = [];
  const placed = new Set<ParamDef>();
  const shown = (def: ParamDef, built: Built): Built =>
    def.when === undefined
      ? built
      : {
          el: dependent(built.el, knobs.chain(def.when), () => knobs.live(def.when)),
          sync: built.sync,
        };
  defs.forEach((def, at) => {
    const widget = def.widget;
    if (def.kind !== "range" || widget?.kind !== "position") return;
    const y = defs.find(
      (other): other is Extract<ParamDef, { kind: "range" }> =>
        other.kind === "range" && other.key === widget.y,
    );
    if (!y) return;
    placed.add(def).add(y);
    items.push({ at, built: shown(def, positionPad(knobs, def, y, widget.screen)) });
  });
  const switches = defs.filter(
    (def): def is SwitchDef => def.kind === "toggle" || def.kind === "feature",
  );
  const [first] = switches;
  if (first) {
    const chips = chipGrid(knobs, switches);
    items.push({
      at: defs.indexOf(first),
      built: {
        el: h("div", { class: "planet-chips" }, chips.grid.el, chips.amounts.el),
        sync: () => {
          chips.grid.sync();
          chips.amounts.sync();
        },
      },
    });
  }
  defs.forEach((def, at) => {
    if (placed.has(def) || def.kind === "toggle" || def.kind === "feature") return;
    items.push({ at, built: shown(def, knobRow(knobs, def)) });
  });
  const sorted = items.sort((a, b) => a.at - b.at).map((item) => item.built);
  return {
    el: h("div", { class: "planet-controls" }, ...sorted.map((built) => built.el)),
    sync: () => {
      for (const built of sorted) built.sync();
    },
  };
}

/**
 * The scene's planets for the Night sky section: the chips, the add and remove buttons and the
 * picked planet's controls (`knobRow` makes a range or choice row as the group does), and their
 * layer of the drawing.
 */
export function planetsPart(host: PlanetsHost, knobRow: PlanetRow): Planets {
  const { spec, ctx } = host;
  const defaults: Record<string, number> = { ...planetDefaults(spec) };
  const list = (): readonly SkyPlanet[] => ctx.current().planets;
  const write = (planets: readonly SkyPlanet[], commit: boolean) =>
    ctx.change({ [PLANETS_KEY]: encodePlanets(spec, planets) }, commit);
  let picked = 0;

  // The picked planet's own context: its values are its knobs, and an edit writes the list back.
  const planet = (): SkyPlanet => list()[picked] ?? defaults;
  const planetCtx: LabContext = {
    current: () => ({ ...ctx.current(), params: { ...planet() } }),
    change: (patch, commit) => {
      const numbers = Object.fromEntries(
        Object.entries(patch).flatMap(([key, value]) =>
          typeof value === "number" ? [[key, value]] : [],
        ),
      );
      const now = planet();
      const kind = numbers["kind"];
      const dress = kind !== undefined && kind !== now["kind"] ? kindPatch(kind) : {};
      const next = readPlanet(spec, { ...now, ...numbers, ...dress });
      write(
        list().map((each, index) => (index === picked ? next : each)),
        commit,
      );
    },
    on: (key) => planetShows(planet(), key),
    renderer: () => ctx.renderer(),
    reducedMotion: ctx.reducedMotion,
  };

  const add = textButton("plus", "planet", `Add a planet (up to ${PLANET_CAP})`, () => {
    const next = addedPlanet(spec, list());
    if (next === undefined) return;
    picked = list().length;
    write([...list(), next], true);
  });
  add.classList.add("planet-add");
  const tabs = h("div", { class: "planet-tabs", role: "group", "aria-label": "Planets" });
  const header = row({
    label: "planets",
    help: HELP,
    icon: "planet",
    inline: [add],
    block: tabs,
    readout: () => `${list().length} of ${PLANET_CAP}`,
    modified: () => list().length > 0,
    reset: () => write([], true),
  });
  header.el.classList.add("planet-head");
  const editor = h("div", { class: "planet-editor" });
  const editorShown = reveal(editor, () => list().length > 0);
  const el = h(
    "div",
    { class: "night-planets", "data-keys": PLANETS_KEY },
    header.el,
    editorShown.el,
  );

  let tabsFor = "";
  let controls: Built | undefined;
  let controlsFor = "";
  const syncTabs = () => {
    const planets = list();
    const names = planets.map(planetName);
    const key = `${picked}|${encodePlanets(spec, planets)}`;
    if (key === tabsFor) return;
    tabsFor = key;
    tabs.replaceChildren(
      ...planets.map((each, index) => {
        const name = names[index] ?? "";
        const pick = h(
          "button",
          {
            type: "button",
            class: "planet-pick",
            "aria-pressed": String(index === picked),
            "aria-label": `Planet ${index + 1}: ${name}`,
            title: `Shape planet ${index + 1}, ${name}`,
          },
          glyph(planetArt(spec, each)),
          h("span", { class: "planet-pick-label" }, `${index + 1} ${name.split(" ")[0] ?? ""}`),
        );
        pick.addEventListener("click", () => {
          picked = index;
          sync();
        });
        const remove = iconButton(
          "close",
          `Remove planet ${index + 1} (${name})`,
          () => {
            picked = Math.max(
              0,
              Math.min(picked > index ? picked - 1 : picked, planets.length - 2),
            );
            write(
              list().filter((_, at) => at !== index),
              true,
            );
          },
          "icon-button planet-remove",
        );
        return h("span", { class: `planet-tab${index === picked ? " picked" : ""}` }, pick, remove);
      }),
    );
    add.disabled = planets.length >= PLANET_CAP;
    add.title =
      planets.length >= PLANET_CAP
        ? `This sky holds its most planets, ${PLANET_CAP}`
        : `Add a planet (up to ${PLANET_CAP})`;
  };
  const syncControls = () => {
    const now = list()[picked];
    const key = now === undefined ? "" : `${picked}|${now["kind"] ?? 0}`;
    if (key !== controlsFor) {
      controlsFor = key;
      controls =
        now === undefined
          ? undefined
          : planetControls(
              new Knobs(planetCtx, planetDefs(spec, now["kind"] ?? 0), defaults),
              planetDefs(spec, now["kind"] ?? 0),
              knobRow,
            );
      // The lens counts the list as one change: every control of a planet is the list's.
      for (const each of controls?.el.querySelectorAll<HTMLElement>("[data-keys]") ?? [])
        each.dataset.keys = PLANETS_KEY;
      for (const each of controls?.el.querySelectorAll<HTMLElement>("[data-search]") ?? [])
        each.dataset.search = `${each.dataset.search ?? ""} planet night sky`;
      editor.replaceChildren(...(controls ? [controls.el] : []));
    }
    controls?.sync();
  };

  const layer = svg("g", { class: "night-planets-art" });
  let layerFor = "";
  const syncArt = () => {
    const planets = list();
    const key = `${picked}|${encodePlanets(spec, planets)}`;
    if (key === layerFor) return;
    layerFor = key;
    layer.replaceChildren(
      ...planets.map((each, index) =>
        drawn(planetArt(spec, each), index, index === picked, planetName(each)),
      ),
    );
  };

  const sync = () => {
    picked = Math.max(0, Math.min(picked, list().length - 1));
    header.sync();
    syncTabs();
    syncControls();
    editorShown.sync();
    syncArt();
  };
  return {
    controls: { el, sync },
    art: { el: layer, sync: syncArt },
    pick: (index) => {
      picked = index;
      sync();
    },
  };
}
