// The birds card: the birds component's knobs (`birdKnobs`, widget `flyway`) as one instrument. A sky
// strip is the switch and how often a flight passes: the further along, the more often and the more
// birds aloft in it (bobbing on beating wings unless motion is reduced); a drag or the arrow keys
// set it and let the birds fly, Delete grounds them. Under it, while the birds are on, the species
// as tiles of their silhouettes seen from below, and the formation as dot diagrams drawn for the
// chosen species' own party, its usual formation on the "usual" tile. Each row of tiles is a radio
// group: the arrow keys move along it and choose. flyway-model.ts holds the rules.
import { formatValue, type Option, type ParamDef } from "../params.ts";
import type { BirdKind } from "../shaders/lib/birds.ts";
import { row, switchControl } from "./controls.ts";
import { drag, h, keyStep, reveal, snap, svg, type Built } from "./dom.ts";
import { icon } from "./icons.ts";
import { knobIcon, knobKeys, type FeatureDef, type Knobs } from "./knobs.ts";
import {
  aloft,
  flightOf,
  formationOf,
  speciesOf,
  STRIP_BIRDS,
  tileStep,
  type Flight,
  type Formation,
  type Party,
} from "./flyway-model.ts";

type ChoiceDef = Extract<ParamDef, { kind: "choice" }>;

/** The birds card's knobs: the switch and how often, the species and the formation. */
export interface Flyway {
  birds: FeatureDef;
  kind: ChoiceDef | undefined;
  formation: ChoiceDef | undefined;
}

/** The card a group holds: its `birds` part (a feature) and its `kind` and `formation` parts. */
export function flywayOf(defs: readonly ParamDef[]): Flyway | undefined {
  const part = (name: "birds" | "kind" | "formation") =>
    defs.find((def) => def.widget?.kind === "flyway" && def.widget.part === name);
  const birds = part("birds");
  if (birds?.kind !== "feature") return undefined;
  const kind = part("kind");
  const formation = part("formation");
  return {
    birds,
    kind: kind?.kind === "choice" ? kind : undefined,
    formation: formation?.kind === "choice" ? formation : undefined,
  };
}

// ---- drawings: 48 x 24, a species seen from below with its head up, a formation flying right ------

type Point = readonly [number, number];
/** A curve's two handles and its end, or a straight line's end. */
type Segment = Point | readonly [number, number, number, number, number, number];

/**
 * A silhouette from its right half: the outline from the bill at `from` (on the spine, x 24) round
 * the right wing to the middle of the tail, closed back through its mirror image.
 */
function silhouette(from: Point, half: readonly Segment[]): string {
  const ends: Point[] = [
    from,
    ...half.map((seg): Point => (seg.length === 2 ? seg : [seg[4], seg[5]])),
  ];
  const flip = (x: number) => Number((48 - x).toFixed(2));
  let path = `M${from.join(" ")}`;
  for (const seg of half) path += `${seg.length === 2 ? "L" : "C"}${seg.join(" ")}`;
  for (let index = half.length - 1; index >= 0; index--) {
    const seg = half[index];
    const back = ends[index];
    if (!seg || !back) continue;
    path +=
      seg.length === 2
        ? `L${flip(back[0])} ${back[1]}`
        : `C${flip(seg[2])} ${seg[3]} ${flip(seg[0])} ${seg[1]} ${flip(back[0])} ${back[1]}`;
  }
  return `${path}Z`;
}

/** Each species' silhouette, as a field guide draws it from below. */
const SILHOUETTES: Readonly<Record<BirdKind, string>> = {
  // Wings fingered at the tips, narrower at the body, a jutting head and a wedge of a tail.
  rooks: silhouette(
    [24, 1.5],
    [
      [25.2, 1.5, 26, 3, 26, 4.5],
      [26.6, 7.5],
      [31, 7, 37, 6.5, 42, 7.2],
      [46, 8.2],
      [43.6, 9.3],
      [46.2, 10.4],
      [43.4, 11.2],
      [45.4, 12.6],
      [42.6, 12.8],
      [43.8, 14.6],
      [41, 14],
      [36, 13.8, 31, 13.4, 27.4, 13.2],
      [26.8, 16.2],
      [28.4, 20.8],
      [26.8, 22.6, 25.4, 23.6, 24, 23.8],
    ],
  ),
  // Slim wings swept back to points, a deeply forked tail with streamers.
  swallows: silhouette(
    [24, 3],
    [
      [25, 3, 25.6, 4, 25.6, 5.2],
      [26, 7.5],
      [31, 6.8, 37, 6.5, 46, 12.5],
      [38, 10.5, 31, 10.8, 26.4, 11.5],
      [25.8, 14.5],
      [30, 23],
      [26.5, 17],
      [24, 17.5],
    ],
  ),
  // Long narrow wings crooked at the wrist, a short square tail.
  gulls: silhouette(
    [24, 3.5],
    [
      [25, 3.5, 25.6, 4.6, 25.6, 5.8],
      [25.9, 8],
      [29, 7, 32.5, 5.2, 35.5, 4.8],
      [39.5, 5.6, 43.5, 9.5, 47.2, 14],
      [43, 11.6, 39.5, 9.6, 36.5, 9.4],
      [32.5, 9.6, 29, 11, 26.4, 11.6],
      [26, 15],
      [26, 16.6, 25.5, 17.4, 24, 17.4],
    ],
  ),
  // A long outstretched neck, long wings, a heavy body and a short tail.
  geese: silhouette(
    [24, 0.6],
    [
      [24.5, 0.6, 24.7, 1.2, 24.7, 1.8],
      [25.3, 2.1, 25.4, 3, 25.2, 3.6],
      [24.9, 4.2, 24.9, 5.5, 25.1, 6.6],
      [25.6, 7.6, 26.4, 8.4, 26.8, 9.4],
      [32, 8.8, 38, 9, 46, 11.2],
      [39, 12.8, 32, 13.8, 27.2, 14.4],
      [27.2, 17, 26.4, 19, 25.6, 20],
      [26, 21.6],
      [25.3, 22.3, 24.6, 22.4, 24, 22.4],
    ],
  ),
  // Broad rounded wings fingered at the tips, a short head and a fanned tail.
  buzzard: silhouette(
    [24, 4.5],
    [
      [25.1, 4.5, 25.8, 5.5, 25.8, 6.8],
      [26.4, 8],
      [31, 6.6, 38, 6.4, 42.6, 7.2],
      [46.2, 8.4],
      [43.8, 9.4],
      [46.6, 10.6],
      [44, 11.4],
      [46, 12.8],
      [43.2, 13.2],
      [44.2, 14.8],
      [41.4, 14.6],
      [37, 15.6, 31, 16, 27.2, 15.6],
      [26.2, 16.4],
      [28.6, 21.6],
      [27.4, 22.6, 25.6, 22.9, 24, 22.9],
    ],
  ),
  // A small head on a full chest, pointed wings and a broad square tail.
  pigeons: silhouette(
    [24, 4.5],
    [
      [25, 4.5, 25.6, 5.4, 25.6, 6.4],
      [26.4, 7.4, 27, 8, 27.4, 9],
      [33, 8.6, 38, 9, 44, 11.8],
      [38, 13, 32, 13.6, 27.6, 13.8],
      [26.6, 15.6],
      [28, 22.4],
      [24, 22.8],
    ],
  ),
  // Long stiff scythe wings swept far back, a slim body and a short forked tail.
  swifts: silhouette(
    [24, 5],
    [
      [25, 5, 25.5, 6, 25.5, 7],
      [25.8, 8.4],
      [31, 7.2, 38, 7.8, 46, 15.5],
      [39, 11.5, 32, 10.6, 26, 11.2],
      [25.6, 15],
      [27, 18.4],
      [24, 16.6],
    ],
  ),
};

/** How each species flies, for its tile's title (birdsGlsl's own notes). */
const SPECIES_NOTES: Readonly<Record<BirdKind, string>> = {
  rooks: "rooks, crows and jackdaws rowing steadily with short glides, in loose parties",
  swallows: "small and dark, flickering low and near in bursts and glides",
  gulls: "pale, long wings crooked at the wrist, slow beats and long glides",
  geese: "long necks and deep steady beats, in a V far and high",
  buzzard: "broad wings held in a shallow V, circling on a thermal",
  pigeons: "a flock wheeling round, gliding, beating slowly in bouts",
  swifts: "long stiff scythe wings, sailing in long loops",
};

const path = (d: string, transform?: string) =>
  svg("path", { class: "flyway-body", d, ...(transform === undefined ? {} : { transform }) });

/** A species' tile drawing; "mixed" (no species) a small party of three kinds. */
function speciesArt(species: BirdKind | undefined): SVGElement[] {
  if (species) return [path(SILHOUETTES[species])];
  return [
    path(SILHOUETTES.rooks, "scale(0.55)"),
    path(SILHOUETTES.gulls, "translate(23 1.5) scale(0.5)"),
    path(SILHOUETTES.swallows, "translate(12 11) scale(0.5)"),
  ];
}

const dot = ([x, y]: Point, r: number) =>
  svg("circle", { class: "flyway-dot", cx: x.toFixed(2), cy: y.toFixed(2), r });

/** Vertical offsets of a loose party's birds, so it straggles. */
const STRAGGLE = [0, -3.5, 2.8, -1.2, 4, -3, 1.6, -4.2, 3.2] as const;

/** Where a formation's `count` birds fly, the leader on the right: birdFlightHit's layout, side-on. */
function formationPoints(formation: Formation, count: number): Point[] {
  const birds = Array.from({ length: count }, (_, index) => index);
  switch (formation) {
    case "solo":
      return [[24, 12]];
    case "party": {
      const gap = 28 / Math.max(1, count - 1);
      return birds.map((index) => [
        38 - index * gap,
        12 + (STRAGGLE[index % STRAGGLE.length] ?? 0),
      ]);
    }
    case "V": {
      // Birds alternate between the arms behind the leader, the upper arm a little shorter.
      const ranks = Math.max(1, Math.floor(count / 2));
      const across = Math.min(7, 28 / ranks);
      const up = Math.min(0.6 * across, 9 / ranks);
      return birds.map((index) => {
        const rank = Math.floor((index + 1) / 2);
        const arm = index % 2 === 0 ? 1 : -1;
        return [40 - rank * across * (arm > 0 ? 0.8 : 1), 12 - arm * rank * up];
      });
    }
    case "circling":
      return birds.map((index) => {
        const angle = -Math.PI / 3 + (index / count) * Math.PI * 2;
        return [24 + 15 * Math.cos(angle), 12 + 6 * Math.sin(angle)];
      });
    default: {
      const unreachable: never = formation;
      throw new Error(`landing: unknown formation ${String(unreachable)}`);
    }
  }
}

/**
 * A mixed sky's party drawn for a formation, where each species makes up its own: one alone, the
 * middle of the least party and V birdParty makes up (2–4, 5–9), a few on a circle.
 */
const MIXED_PARTY: Readonly<Record<Formation, number>> = { solo: 1, party: 3, V: 7, circling: 4 };

/** A formation tile's drawing; a mixed sky's usual (each species its own way) a V over a party. */
function formationArt(flight: Flight): SVGElement[] {
  const { formation, party } = flight;
  if (formation === undefined)
    return [
      ...formationPoints("V", 3).map(([x, y]) => dot([x, y - 4], 1.7)),
      ...formationPoints("party", 3).map(([x, y]) => dot([x * 0.55, y + 4], 1.7)),
    ];
  const count = party ? Math.round((party[0] + party[1]) / 2) : MIXED_PARTY[formation];
  const r = count > 5 ? 1.5 : count > 1 ? 1.8 : 2.4;
  const art: SVGElement[] = formationPoints(formation, count).map((point) => dot(point, r));
  if (formation === "circling")
    art.unshift(svg("ellipse", { class: "flyway-orbit", cx: 24, cy: 12, rx: 15, ry: 6 }));
  return art;
}

/** "5–9" birds, or "one". */
function partyText(party: Party): string {
  if (party[0] === party[1]) return party[0] === 1 ? "one" : String(party[0]);
  return `${party[0]}–${party[1]}`;
}

/** What a flight in a formation looks like, for a formation tile's title. */
function flightNote(flight: Flight): string {
  const { formation, party } = flight;
  const strong = party ? `, ${partyText(party)} strong` : "";
  switch (formation) {
    case undefined:
      return "each flight as its own species flies";
    case "solo":
      return "one bird alone";
    case "party":
      return `a loose straggling party${party ? ` of ${partyText(party)}` : ""}`;
    case "V":
      return `a skein, one arm longer, a chevron seen from the side${strong}`;
    case "circling":
      if (!party) return "turning circles on a thermal, each species' own party";
      return party[1] === 1
        ? "one bird turning circles on a thermal"
        : `a flock wheeling round one circle on a thermal${strong}`;
    default: {
      const unreachable: never = formation;
      throw new Error(`landing: unknown formation ${String(unreachable)}`);
    }
  }
}

// ---- the card ---------------------------------------------------------------------------------

/**
 * A choice as a row of tiles, a radio group: a click or the arrow keys choose (Home and End the
 * ends). `art` draws each option's tile and names it; the tiles are redrawn when `basis` changes.
 */
function tileRow(
  knobs: Knobs,
  def: ChoiceDef,
  spec: {
    help: string;
    /** The readout, from the option chosen (undefined for a value no tile holds) and the value. */
    readout: (chosen: Option | undefined, value: number) => string;
    basis: () => number;
    art: (option: Option) => { drawing: SVGElement[]; title: string };
  },
): Built {
  const tiles = def.options.map((option) => {
    const glyph = svg("svg", {
      class: "flyway-glyph",
      viewBox: "0 0 48 24",
      "aria-hidden": "true",
      focusable: "false",
    });
    const button = h(
      "button",
      { type: "button", role: "radio", class: "flyway-tile", "aria-label": option.label },
      glyph,
      h("span", { class: "flyway-tile-label" }, option.label),
    );
    button.addEventListener("click", () => knobs.set({ [def.key]: option.value }, true));
    return { option, button, glyph };
  });
  const group = h(
    "div",
    { class: "flyway-tiles", role: "radiogroup", "aria-label": def.label },
    ...tiles.map((tile) => tile.button),
  );
  // Up to five in one row, more in two.
  const columns = tiles.length <= 5 ? tiles.length : Math.ceil(tiles.length / 2);
  group.style.setProperty("--columns", String(columns));
  group.addEventListener("keydown", (event) => {
    const focused = tiles.findIndex((tile) => tile.button === document.activeElement);
    const at =
      focused >= 0
        ? focused
        : tiles.findIndex((tile) => tile.option.value === knobs.value(def.key));
    const next = tileStep(event.key, at, tiles.length);
    const target = next === undefined ? undefined : tiles[next];
    if (!target) return;
    event.preventDefault();
    knobs.set({ [def.key]: target.option.value }, true);
    target.button.focus();
  });
  const built = row({
    label: def.label,
    help: spec.help,
    block: group,
    readout: () => {
      const value = knobs.value(def.key);
      return spec.readout(
        def.options.find((option) => option.value === value),
        value,
      );
    },
    modified: () => knobs.modified([def.key]),
    reset: () => knobs.reset([def.key]),
  });
  let drawn: number | undefined;
  return {
    el: built.el,
    sync: () => {
      built.sync();
      const basis = spec.basis();
      if (basis !== drawn) {
        drawn = basis;
        for (const { option, button, glyph } of tiles) {
          const { drawing, title } = spec.art(option);
          glyph.replaceChildren(...drawing);
          button.title = title;
        }
      }
      const value = knobs.value(def.key);
      const chosen = tiles.some((tile) => tile.option.value === value);
      for (const [index, { option, button }] of tiles.entries()) {
        const on = option.value === value;
        button.setAttribute("aria-checked", String(on));
        button.tabIndex = on || (!chosen && index === 0) ? 0 : -1;
      }
    },
  };
}

/**
 * The birds card. `headed`: the group's header holds the birds' switch (they are its master), so the
 * card leaves it out.
 */
export function flywayCard(knobs: Knobs, parts: Flyway, headed: boolean): Built {
  const { birds, kind, formation } = parts;
  const amountKey = `${birds.key}-amount`;
  const span = birds.max - birds.min;
  const flying = () => knobs.value(birds.key) > 0.5;
  const kindValue = () => (kind ? knobs.value(kind.key) : -1);

  // The sky strip: how often, as birds aloft up to the fill.
  const fill = h("span", { class: "flyway-fill" });
  const flock = STRIP_BIRDS.map((bird, index) => {
    const el = h("span", { class: "flyway-bird" }, icon("bird"));
    el.style.left = `${(bird.x * 100).toFixed(2)}%`;
    el.style.top = `${(bird.y * 100).toFixed(2)}%`;
    el.style.setProperty("--size", bird.size.toFixed(2));
    el.style.setProperty("--delay", `${(-index * 0.41).toFixed(2)}s`);
    return el;
  });
  const quiet = h("span", { class: "flyway-quiet" }, "no birds");
  const strip = h(
    "div",
    {
      class: "flyway-strip",
      role: "slider",
      tabIndex: 0,
      "aria-label": `${birds.label}: ${birds.amountLabel}`,
      "aria-valuemin": String(birds.min),
      "aria-valuemax": String(birds.max),
      title:
        "Drag along, or use the arrow keys: further right, flights pass more often. Delete grounds them.",
    },
    fill,
    ...flock,
    quiet,
  );
  const fly = (amount: number, commit: boolean) =>
    knobs.set(
      { [birds.key]: 1, [amountKey]: snap(amount, birds.min, birds.max, birds.step) },
      commit,
    );
  strip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    strip.focus();
    const rect = strip.getBoundingClientRect();
    let amount = knobs.value(amountKey);
    drag(
      event,
      strip,
      (pointer) => {
        amount = birds.min + ((pointer.clientX - rect.left) / Math.max(1, rect.width)) * span;
        fly(amount, false);
      },
      () => fly(amount, true),
    );
  });
  strip.addEventListener("keydown", (event) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      knobs.set({ [birds.key]: 0 }, true);
      return;
    }
    const delta = keyStep(event, birds.step, span);
    const amount = knobs.value(amountKey);
    const next =
      delta !== undefined
        ? amount + delta
        : event.key === "Home"
          ? birds.min
          : event.key === "End"
            ? birds.max
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    // Grounded, a key lets them fly at the amount they had.
    fly(flying() ? next : amount, true);
  });
  const toggle = headed
    ? undefined
    : switchControl(birds.label, flying, (on) => knobs.set({ [birds.key]: on ? 1 : 0 }, true));
  const often = row({
    label: birds.label,
    help: `${birds.help} Drag along the strip or use the arrow keys: further right, more often, and more birds aloft; Delete grounds them.`,
    icon: knobIcon(birds),
    inline: toggle ? [toggle.el] : [],
    block: strip,
    readout: () =>
      flying() ? `${birds.amountLabel} ${formatValue(birds, knobs.value(amountKey))}` : "off",
    modified: () => knobs.modified(knobKeys(birds)),
    reset: () => knobs.reset(knobKeys(birds)),
  });

  const species = kind
    ? tileRow(knobs, kind, {
        help: `${kind.help} Arrow keys move along the birds and choose.`,
        readout: (chosen, value) => chosen?.label ?? String(value),
        basis: () => 0,
        art: (option) => {
          const which = speciesOf(option.value);
          return {
            drawing: speciesArt(which),
            title: `${option.label}: ${which ? SPECIES_NOTES[which] : "the scene picks each flight's species"}`,
          };
        },
      })
    : undefined;
  const flights = formation
    ? tileRow(knobs, formation, {
        help: `${formation.help} Each diagram is drawn for the birds chosen above; arrow keys move along and choose.`,
        readout: (chosen, value) => {
          const name = chosen?.label ?? String(value);
          const own = flightOf(kindValue(), value).formation;
          return formationOf(value) === undefined && own ? `${name}: ${own}` : name;
        },
        basis: kindValue,
        art: (option) => {
          const flight = flightOf(kindValue(), option.value);
          const which = speciesOf(kindValue());
          const note = flightNote(flight);
          return {
            drawing: formationArt(flight),
            title:
              formationOf(option.value) === undefined && which
                ? `${option.label} for ${which}: ${note}`
                : `${option.label}: ${note}`,
          };
        },
      })
    : undefined;

  const pickers = [
    { def: kind, built: species },
    { def: formation, built: flights },
  ].flatMap(({ def, built }) => {
    if (!def || !built) return [];
    const shown = reveal(built.el, () => knobs.on(def.when));
    return [{ built, shown }];
  });
  const el = h(
    "div",
    {
      class: "flyway",
      "data-search": [birds, kind, formation]
        .flatMap((def) => (def ? [`${def.label} ${def.help}`] : []))
        .join(" ")
        .toLowerCase(),
    },
    often.el,
    ...pickers.map(({ shown }) => shown.el),
  );

  return {
    el,
    sync: () => {
      often.sync();
      toggle?.sync();
      const on = flying();
      const share = Math.min(1, Math.max(0, (knobs.value(amountKey) - birds.min) / span));
      const count = aloft(on, share);
      for (const [index, bird] of flock.entries()) bird.classList.toggle("aloft", index < count);
      fill.style.setProperty("--fill", `${(share * 100).toFixed(2)}%`);
      strip.classList.toggle("grounded", !on);
      quiet.hidden = on;
      const amount = knobs.value(amountKey);
      strip.setAttribute("aria-valuenow", String(amount));
      strip.setAttribute(
        "aria-valuetext",
        on ? `${formatValue(birds, amount)}, ${count} birds aloft` : "off, no birds",
      );
      for (const { built, shown } of pickers) {
        built.sync();
        shown.sync();
      }
    },
  };
}
