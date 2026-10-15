// The pond's border plants, grown with the shared plant component (sims/plants.ts) and drawn into its
// plant sheet on the GPU (sims/plantsheet.ts) from the botany atlas (decor.ts). The layout is the
// one the pond always had: clumps in the corners and along each edge as lush as that edge, monstera
// climbing on stalked leaves, ferns and bananas fanning from crowns, an understory of young leaves,
// grass at the waterline and pothos trailing in, every random draw in its old order, so a seed lays
// out the plants it always did. Now each is a plant: its stems, stalks and vines bend with the
// breeze and its gusts and carry their leaves with them, nearer leaves giving most; leaves unfold,
// age and are replaced with growth on; the year turns and sheds them and brings the flowers out.
//
// Units: frame heights, x right and y down from the frame's top-left corner (a canvas's), as the
// sheet is drawn: the frame is aspect wide and 1 high; plants root just beyond its edges.
import { Material, type MaterialId } from "../../botany.ts";
import { MONSTERA_MATURE, pondRandom } from "../../decor.ts";
import {
  type PlantBuilder,
  PlantHabit,
  PlantRole,
  type PlantSite,
  type PlantSpecies,
  type RootedPlants,
} from "../../sims/plants.ts";

/** Plants that grow in clumps along the edges. */
export const clumpSpecies = ["monstera", "fern", "banana"] as const;
export type ClumpSpecies = (typeof clumpSpecies)[number];

/** The border plants' knobs, as the layout reads them. */
export interface PondPlantConfig {
  /** 0..1: how far the plants reach into the pond. */
  reach: number;
  /** 0..1 lushness of each edge: top, right, bottom, left. */
  sides: readonly [number, number, number, number];
  kinds: readonly ClumpSpecies[];
  /** 0..1: pothos vines trailing in from the edges. */
  vines: number;
  /** 0..1: how many flowers bloom among the leaves. */
  flowers: number;
  /** 0..1: tufts of grass along the waterline. */
  grass: number;
  /** 0..1: a few distinct plants (0) to packed foliage with an understory (1). */
  bushiness: number;
  /** Arrangement variant. */
  seed: number;
}

/** Most organs the border can hold (the lushest, bushiest layout on the widest frame uses ~2500). */
export const POND_ORGANS = 4096;

/** How each kind of plant sways, lives and turns with the year (sims/plants.ts). */
const SWAY = {
  stem: { hz: 0.32, damping: 0.55, give: 0.065, limit: 0.35 },
  leaf: { hz: 0.42, damping: 0.45, give: 0.1, limit: 0.45, flutter: 0.03 },
  grass: { hz: 0.5, damping: 0.4, give: 0.1, limit: 0.4 },
} as const;
const DETAIL = { simple: 5, min: 1.2 } as const;
/** Hibiscus and frangipani bloom among any of the plants, late spring to early autumn. */
const FLOWERING = [0.2, 0.72] as const;

/** One species of the border: how much of it the year sheds and when it turns, and its layout. */
function species(
  id: string,
  shed: number,
  turn: number,
  sway: PlantSpecies["sway"],
  build: (plant: PlantBuilder) => void,
): PlantSpecies {
  return {
    id,
    moisture: [0.4, 1],
    sway,
    year: { shed, turn, bloom: FLOWERING },
    life: { unfold: 14, span: 150 },
    detail: DETAIL,
    build,
  };
}

/** The angle a curl of quadratic Bézier stalk turns through, from node to knee (decor's stalks). */
function stalkTurn(spread: number): number {
  const a = Math.atan2(0.15 * Math.sin(spread), 0.6 + 0.15 * Math.cos(spread));
  const b = Math.atan2(0.15 * Math.sin(spread), 0.4 - 0.15 * Math.cos(spread));
  return a + b;
}

/** A wandering aerial root's turn: ten random kinks of up to ±0.25 rad, drawn as the old path drew them. */
function rootTurn(rand: () => number): number {
  let turn = 0;
  for (let i = 0; i < 10; i++) turn += (rand() - 0.5) * 0.5;
  return turn;
}

/** The arc length of a chord `chord` long turning `turn` radians. */
function arcLength(chord: number, turn: number): number {
  const half = Math.abs(turn) / 2;
  return half < 1e-4 ? chord : (chord * half) / Math.sin(half);
}

/**
 * Lays the border out into `plants` (cleared first) for `config` on a frame `aspect` wide: the old
 * sheet's layout, draw for draw. Returns the organs' drawing order, back layer first.
 */
export function growPondPlants(
  plants: RootedPlants,
  config: PondPlantConfig,
  aspect: number,
): Int32Array {
  plants.clear();
  const rand = pondRandom(17 + config.seed * 101);
  const width = aspect;
  const kinds: readonly ClumpSpecies[] = config.kinds.length > 0 ? config.kinds : clumpSpecies;
  const pick = (prefer: readonly ClumpSpecies[]): ClumpSpecies => {
    const pool = kinds.filter((kind) => prefer.includes(kind));
    const from = pool.length > 0 && rand() < 0.75 ? pool : kinds;
    return from[Math.floor(rand() * from.length)] ?? "fern";
  };
  const reach = 0.55 + 0.9 * config.reach;
  const shadeOf = () => 0.5 + 0.3 * rand();
  // Nearer layers give more to the breeze.
  const give = (layer: number) => 0.6 + 0.4 * layer;

  // A flower on organ `parent` a share `at` along it.
  const bloom = (plant: PlantBuilder, parent: number, at: number) => {
    const size = 0.02 + 0.02 * rand();
    const hibiscus = rand() < 0.55;
    const shade = hibiscus ? 0.65 + 0.25 * rand() : 0.88 + 0.1 * rand();
    const variant = Math.floor(rand() * 8);
    plant.organ({
      parent,
      at,
      angle: 0,
      length: size,
      form: hibiscus ? Material.hibiscus : Material.frangipani,
      variant,
      layer: 2,
      shade,
      role: PlantRole.bloom,
      habit: PlantHabit.rigid,
      give: 0.5,
    });
  };

  // Monstera climbs: a stout stem leaning in from the edge; alternate nodes each carry a long
  // petiole with a knee (geniculum) just below the blade, some an aerial root.
  const monstera = species("monstera", 0.05, 0.6, SWAY.stem, (plant) => {
    const { heading: inward, lush = 1, kind = 0 } = plant.site;
    const layer = kind === 1 ? 2 : 1;
    const length = reach * (0.15 + 0.11 * rand()) * (0.7 + 0.5 * lush);
    const bend = (rand() - 0.5) * 1.1;
    const stem = plant.organ({
      angle: inward + bend * 0.5,
      curl: bend,
      length: arcLength(length, bend),
      width: 0.014,
      a: 0.7,
      form: Material.stem,
      layer,
      shade: 0.4,
      give: give(layer),
    });
    shadeOf();
    const nodes = 2 + Math.floor(rand() * 3) + Math.round(config.bushiness * 2);
    let side = rand() < 0.5 ? -1 : 1;
    for (let n = 0; n < nodes; n++) {
      const t = 0.3 + (0.7 * n) / Math.max(1, nodes - 1);
      const at = Math.round(t * 16) / 16;
      const spread = 0.8 + 0.4 * rand();
      const petiole = length * (0.28 + 0.12 * rand());
      const knee = 0.25 + 0.25 * rand();
      const leafLength = length * (0.5 + 0.2 * rand()) * (0.8 + 0.4 * t);
      const maturity = 0.45 + 0.55 * rand();
      rand();
      const shade = shadeOf();
      const turn = stalkTurn(spread);
      const stalk = plant.organ({
        parent: stem,
        at,
        angle: side * (spread - turn / 2),
        curl: side * turn,
        length: arcLength(petiole, turn),
        width: 0.006,
        a: 0.8,
        form: Material.stem,
        layer,
        shade: 0.55,
        give: give(layer),
      });
      plant.organ({
        parent: stalk,
        angle: -side * (knee + turn / 2),
        length: leafLength,
        form: Material.monstera,
        variant: Math.round(((maturity - 0.45) / 0.55) * (MONSTERA_MATURE - 1)),
        side,
        layer,
        shade,
        role: PlantRole.leaf,
        habit: PlantHabit.rigid,
        give: give(layer),
      });
      if (rand() < 0.5) {
        const rootLength = 0.06 + 0.1 * rand();
        plant.organ({
          parent: stem,
          at,
          angle: -side * 1.2,
          curl: rootTurn(rand),
          length: rootLength,
          width: 0.0035,
          a: 0.5,
          form: Material.root,
          layer: Math.max(0, layer - 1),
          shade: 0.5,
          role: PlantRole.root,
        });
      }
      side = -side;
    }
    if (rand() < config.flowers * 0.7) bloom(plant, stem, 1);
  });

  // Ferns and banana fan from a crown at the edge: fronds straight from the crown, banana leaves
  // on short stout petioles.
  const crown = (fern: boolean) => (plant: PlantBuilder) => {
    const { heading: inward, lush = 1, kind = 0 } = plant.site;
    const big = kind === 1;
    const count =
      (fern ? 5 : 3) +
      Math.floor(rand() * 2) +
      (lush > 0.7 ? 1 : 0) +
      Math.round(config.bushiness * 3);
    const scale = 0.65 + 0.6 * lush;
    for (let i = 0; i < count; i++) {
      const fan =
        (count === 1 ? 0 : i / (count - 1) - 0.5) * (big ? 1.9 : 1.5) + (rand() - 0.5) * 0.3;
      const angle = inward + fan;
      const length = reach * (big ? 0.38 : 0.28) * (0.75 + 0.45 * rand()) * scale;
      const layer = big ? 1 + Math.floor(rand() * 2) : Math.floor(rand() * 2);
      const shade = shadeOf();
      const variant = rand();
      const side = rand() < 0.5 ? -1 : 1;
      let leaf: number;
      let petiole = 0;
      if (fern) {
        leaf = plant.organ({
          angle,
          length,
          form: Material.fern,
          variant: Math.floor(variant * 12),
          side,
          layer,
          shade,
          role: PlantRole.leaf,
          habit: PlantHabit.rigid,
          give: give(layer),
        });
      } else {
        petiole = length * 0.14;
        const wear = rand();
        const stalk = plant.organ({
          angle,
          length: petiole,
          width: 0.012,
          a: 0.8,
          form: Material.banana,
          layer,
          shade: 0.85,
          give: give(layer),
        });
        leaf = plant.organ({
          parent: stalk,
          angle: 0,
          length,
          form: Material.banana,
          variant: Math.min(7, Math.floor(wear * 8)),
          side,
          layer,
          shade,
          role: PlantRole.leaf,
          habit: PlantHabit.rigid,
          give: give(layer),
        });
      }
      if (rand() < config.flowers * 0.4) {
        const along = length * (0.35 + 0.45 * rand());
        bloom(plant, leaf, Math.max(0, along - petiole) / length);
      }
    }
  };
  const fern = species("fern", 0.55, 0.52, SWAY.leaf, crown(true));
  const banana = species("banana", 0.25, 0.56, SWAY.leaf, crown(false));
  const byKind = { monstera, fern, banana } as const;

  const plantAt = (x: number, y: number, inward: number, big: boolean, lush: number) => {
    const kind = pick(big ? ["monstera", "banana"] : ["fern", "monstera"]);
    plants.add(byKind[kind], { x, y, heading: inward, lush, moisture: 1, kind: big ? 1 : 0 }, rand);
  };

  const grass = species("grass", 0, 0.42, SWAY.grass, (plant) => {
    const { heading: inward, lush = 1 } = plant.site;
    const size = (0.12 + 0.1 * rand()) * (0.7 + 0.5 * lush);
    const layer = rand() < 0.6 ? 0 : 1;
    const shade = 0.55 + 0.3 * rand();
    const variant = Math.floor(rand() * 8);
    rand();
    const lean = inward + (rand() - 0.5) * 0.4;
    plant.organ({
      angle: lean,
      length: size,
      form: Material.grass,
      variant,
      layer,
      shade,
      role: PlantRole.leaf,
      habit: PlantHabit.rigid,
      give: give(layer),
    });
  });

  // Pothos trails in: a wandering vine with alternate cordate leaves on short petioles, an aerial
  // root now and then, curling at the tip. The vine is a chain of eight arcs, each bending on its
  // own spring, so a breeze swings the tip furthest.
  const pothos = species("pothos", 0.05, 0.64, { ...SWAY.leaf, give: 0.06 }, (plant) => {
    const { heading: inward, kind: index = 0 } = plant.site;
    const vineLength = (0.3 + 0.45 * rand()) * (0.6 + 0.6 * config.reach);
    const sway = (rand() - 0.5) * 0.8;
    const steps = 40;
    const links = 8;
    const heading = (s: number) => inward + sway * s + Math.sin(s * 9 + index) * 0.35;
    const layer = rand() < 0.6 ? 2 : 1;
    shadeOf();
    const chain: number[] = [];
    let previous = -1;
    for (let j = 0; j < links; j++) {
      const s0 = j / links;
      const s1 = (j + 1) / links;
      const turn = heading(s1) - heading(s0);
      const taper = (k: number) => 1 - 0.5 * (k / links);
      previous = plant.organ({
        parent: previous,
        angle: j === 0 ? heading(0) : 0,
        curl: turn,
        length: vineLength / links,
        width: 0.0045 * taper(j),
        a: taper(j + 1) / taper(j),
        form: Material.stem,
        layer,
        shade: 0.5,
        give: give(layer) * (0.5 + j / links),
      });
      chain.push(previous);
    }
    let side = 1;
    for (let i = 2; i < steps - 1; i += 2 + Math.floor(rand() * 2)) {
      const link = chain[Math.floor((i / steps) * links)] ?? -1;
      const at = ((i / steps) * links) % 1;
      const spread = 0.9 + 0.4 * rand();
      const leafLength = (0.03 + 0.028 * rand()) * (1 - (i / steps) * 0.4);
      const variant = Math.floor(rand() * 12);
      const shade = shadeOf();
      const petiole = plant.organ({
        parent: link,
        at,
        angle: side * spread,
        length: leafLength * 0.45,
        width: 0.0025,
        a: 0.8,
        form: Material.stem,
        layer,
        shade: 0.6,
        give: give(layer),
      });
      plant.organ({
        parent: petiole,
        angle: -side * 0.3,
        length: leafLength,
        form: Material.pothos,
        variant,
        side,
        layer,
        shade,
        role: PlantRole.leaf,
        habit: PlantHabit.rigid,
        give: give(layer),
      });
      if (rand() < 0.12)
        plant.organ({
          parent: link,
          at,
          angle: -side * 1.4,
          curl: rootTurn(rand),
          length: 0.03,
          width: 0.0022,
          a: 0.5,
          form: Material.root,
          layer,
          shade: 0.5,
          role: PlantRole.root,
        });
      side = -side;
    }
  });

  // Understory: young, unsplit leaves packed low along the edge, darker in the plants' shade.
  const youngForms: readonly MaterialId[] = [Material.monstera, Material.pothos, Material.fern];
  const young = species("understory", 0.3, 0.55, { ...SWAY.leaf, give: 0.03 }, (plant) => {
    const { heading: angle } = plant.site;
    const size = 0.06 + 0.07 * rand();
    const shade = 0.3 + 0.2 * rand();
    const variant = rand();
    const form = youngForms[Math.floor(rand() * 3)] ?? Material.fern;
    const side = rand() < 0.5 ? -1 : 1;
    const cell =
      form === Material.monstera
        ? MONSTERA_MATURE + Math.floor(variant * 4)
        : Math.floor(variant * 12);
    plant.organ({
      angle,
      length: size,
      form,
      variant: cell,
      side,
      layer: 0,
      shade,
      role: PlantRole.leaf,
      habit: PlantHabit.rigid,
      give: 0.6,
    });
  });

  const [top, right, bottom, left] = config.sides;
  const margin = 0.03;
  // A corner is only as lush as the barer of its two edges: 0 on a side leaves it clear.
  const corners: [number, number, number][] = [
    [-margin, -margin, Math.min(top, left)],
    [width + margin, -margin, Math.min(top, right)],
    [-margin, 1 + margin, Math.min(bottom, left)],
    [width + margin, 1 + margin, Math.min(bottom, right)],
  ];
  for (const [x, y, lush] of corners) {
    if (lush < 0.05 || rand() < 0.15 * (1 - lush) * (1 - config.bushiness)) continue;
    plantAt(x, y, Math.atan2(0.5 - y, width / 2 - x), true, lush);
  }
  const edges: [number, number, number, number, number, number][] = [
    [0, -margin, width, -margin, Math.PI / 2, top],
    [width + margin, 0, width + margin, 1, Math.PI, right],
    [0, 1 + margin, width, 1 + margin, -Math.PI / 2, bottom],
    [-margin, 0, -margin, 1, 0, left],
  ];
  edges.forEach(([x0, y0, x1, y1, inward, lush], edge) => {
    if (lush < 0.05) return;
    const spacing = (0.85 - 0.62 * lush) * (1.35 - 0.8 * config.bushiness);
    const length = Math.hypot(x1 - x0, y1 - y0);
    const along = (t: number): [number, number] => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    for (
      let d = spacing * (0.5 + rand() * 0.5);
      d < length - spacing * 0.4;
      d += spacing * (0.7 + rand() * 0.6)
    ) {
      if (rand() < 0.25 * (1 - lush) * (1 - config.bushiness)) continue;
      const [x, y] = along(d / length);
      plantAt(x, y, inward + (rand() - 0.5) * 0.5, rand() < 0.15 + 0.15 * lush, lush);
    }
    const youngCount = Math.round(config.bushiness * lush * length * 16);
    for (let n = 0; n < youngCount; n++) {
      const [ex, ey] = along(rand());
      const inset = 0.1 * rand() * (0.5 + config.reach);
      const site: PlantSite = {
        x: ex + Math.cos(inward) * inset,
        y: ey + Math.sin(inward) * inset,
        heading: inward + (rand() - 0.5) * 2.4,
        lush,
        moisture: 1,
      };
      plants.add(young, site, rand);
    }
    const tufts = Math.round(config.grass * lush * length * 7);
    for (let n = 0; n < tufts; n++) {
      const [x, y] = along(rand());
      plants.add(grass, { x, y, heading: inward, lush, moisture: 1 }, rand);
    }
    const strands = Math.round(config.vines * lush * length * 3);
    for (let n = 0; n < strands; n++) {
      const [x, y] = along(rand());
      plants.add(pothos, { x, y, heading: inward, lush, moisture: 1, kind: edge * 10 + n }, rand);
    }
  });
  // Back to front: by layer, and in the order they grew within a layer.
  const order = Int32Array.from({ length: plants.count }, (_, i) => i);
  order.sort((a, b) => (plants.layer[a] ?? 0) - (plants.layer[b] ?? 0) || a - b);
  return order;
}

/** A key that changes whenever the layout would. */
export function pondPlantKey(config: PondPlantConfig, aspect: number): string {
  return [
    config.reach,
    ...config.sides,
    config.vines,
    config.flowers,
    config.grass,
    config.bushiness,
    aspect,
  ]
    .map((value) => value.toFixed(3))
    .concat(config.kinds.join(","), String(config.seed))
    .join("|");
}
