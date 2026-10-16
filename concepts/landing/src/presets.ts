// Saved lab setups. `query` is the setup as the lab writes it (`canonicalSetup`: minimal, in its
// knobs' order), so it loads as saved and the Presets view lights it once loaded. `commit` is the
// build the setup was made on: `/@<commit>/?<query>` replays it exactly even after shader logic
// changes, where that build reads the query's keys as this one does. A knob that changes kind or
// goes away must have the presets that set it rewritten in the knobs that replace it, their commit
// moved to a build that has those (presets.test.ts holds every preset to loading as itself). Add
// entries from the lab's "export" output.

export interface Preset {
  name: string;
  commit: string;
  query: string;
  savedAt: string;
}

export const presets: readonly Preset[] = [
  {
    name: "orbit · red ign (baseline)",
    commit: "db4ca2e8",
    query: "scene=orbit&dither=ign&levels=4&motion=0.45&accent=%23ff004e",
    savedAt: "2026-10-13",
  },
  {
    name: "Orbit · ringed planet",
    commit: "f1ca6557",
    query: "scene=orbit&captures=1&planetX=0&planetY=0&planet=0.35&moons=1&moons-amount=3&ring=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Countryside · crops (baseline)",
    commit: "6e72cac6",
    query: "scene=country",
    savedAt: "2026-10-14",
  },
  {
    name: "Countryside · flower valley",
    commit: "e3e1d4ec",
    query:
      "scene=country&time=0.58&clouds=0.25&landscape=17&crops=0&woodland-amount=50&wildflowers=1&wildflowers-amount=100&date=0.375",
    savedAt: "2026-10-16",
  },
  {
    name: "Countryside · lavender rows",
    commit: "e3e1d4ec",
    query: "scene=country&crops=0&woodland-amount=50&lavender=1&lavender-amount=100&date=0.375",
    savedAt: "2026-10-16",
  },
  {
    name: "Countryside · sunflowers",
    commit: "e3e1d4ec",
    query: "scene=country&crops=0&woodland-amount=50&sunflowers=1&sunflowers-amount=100&date=0.375",
    savedAt: "2026-10-16",
  },
  {
    name: "Countryside · mixed patchwork",
    commit: "e3e1d4ec",
    query:
      "scene=country&crops-amount=30&woodland-amount=50&wildflowers=1&wildflowers-amount=28&lavender=1&lavender-amount=22&sunflowers=1&date=0.375",
    savedAt: "2026-10-16",
  },
  {
    name: "Countryside · woodland valley",
    commit: "e3e1d4ec",
    query:
      "scene=country&time=0.64&crops-amount=40&woodland-amount=100&pasture=1&pasture-amount=60&pines=0.4&birds=1&birds-amount=0.8&birdKind=4&date=0.6",
    savedAt: "2026-10-16",
  },
  {
    name: "Countryside · riverside",
    commit: "e3e1d4ec",
    query:
      "scene=country&time=0.72&crops-amount=65&woodland-amount=50&pasture=1&pasture-amount=35&cows=1&river-amount=1&walkers=1&walkers-amount=0.7&carts=1&birds=1&birds-amount=0.8&murmuration=1&date=0.375",
    savedAt: "2026-10-16",
  },
  {
    name: "Countryside · wildwood",
    commit: "defa703a",
    query: "scene=country&time=0.64&crops=0&woodland-amount=100&pines=0.45&date=0.6",
    savedAt: "2026-10-16",
  },
  {
    name: "Countryside · grazing valley",
    commit: "defa703a",
    query:
      "scene=country&crops-amount=40&woodland-amount=20&pasture=1&pasture-amount=45&cows=0.7&herd=0.8&verges=1&date=0.375",
    savedAt: "2026-10-16",
  },
  {
    name: "Countryside · flower country",
    commit: "defa703a",
    query:
      "scene=country&time=0.6&crops-amount=25&woodland-amount=15&wildflowers=1&lavender=1&sunflowers=1&date=0.375",
    savedAt: "2026-10-16",
  },
  {
    name: "Countryside · market town at dusk",
    commit: "defa703a",
    query:
      "scene=country&time=0.78&village-amount=26&hamlets-amount=3&farms-amount=8&walkers=1&walkers-amount=0.8&carts=1&murmuration=1",
    savedAt: "2026-10-16",
  },
  {
    name: "Countryside · chalk M",
    commit: "defa703a",
    query: "scene=country&time=0.62&chalk=1",
    savedAt: "2026-10-16",
  },
  {
    name: "Swell · heavy swell",
    commit: "f1ca6557",
    query: "scene=swell&height=0.8&chop=0.6&relief=0.6",
    savedAt: "2026-10-15",
  },
  {
    name: "Pond · koi come to you",
    commit: "f1ca6557",
    query: "koi-amount=8&follow=1&eager=0.7",
    savedAt: "2026-10-15",
  },
  {
    name: "Waterfall · slot gorge",
    commit: "f1ca6557",
    query: "scene=falls&mist=0.8&gorge=2",
    savedAt: "2026-10-15",
  },
  {
    name: "Waterfall · slot gorge at dusk",
    commit: "f1ca6557",
    query: "scene=falls&gorge=2&time=0.8",
    savedAt: "2026-10-15",
  },
  {
    name: "Waterfall · sandstone",
    commit: "f1ca6557",
    query: "scene=falls&flow=0.7&gorge=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Marbling · riso rings",
    commit: "f1ca6557",
    query: "scene=marble&pattern=0&palette=2&practice=2",
    savedAt: "2026-10-15",
  },
  {
    name: "Frost · aurora over the cabin",
    commit: "f1ca6557",
    query: "scene=frost&outside=1&time=0.93&moon-amount=0.5&snow=0&aurora=1&aurora-amount=0.8",
    savedAt: "2026-10-15",
  },
  {
    name: "Frost · crescent and shooting stars",
    commit: "f1ca6557",
    query: "scene=frost&time=0.95&stars=0.8&moon-amount=0.25&meteors=1&meteors-amount=0.6&snow=0",
    savedAt: "2026-10-15",
  },
  {
    name: "Sill · quiet shelter",
    commit: "f1ca6557",
    query:
      "scene=sill&restless=0.1&steam-amount=0.8&curtain-amount=0.25&rain=1&rain-amount=0.4&wind=0.05",
    savedAt: "2026-10-15",
  },
  {
    name: "Prism · clean Newton",
    commit: "f1ca6557",
    query: "scene=prism&dispersion=0.25&beam=1&eclipse=0&second=1&second-amount=0.1&reflections=0",
    savedAt: "2026-10-15",
  },
  {
    name: "Chladni plate · grit on brass",
    commit: "f1ca6557",
    query: "scene=chladni&tone=2&grainSize=1&sand=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Shan shui · snow scroll",
    commit: "f1ca6557",
    query: "scene=shanshui&season=4&density=0.65&mist=0.65",
    savedAt: "2026-10-15",
  },
  {
    name: "Shan shui · autumn colours",
    commit: "f1ca6557",
    query: "scene=shanshui&season=3&wetness=0.25&mist=0.45",
    savedAt: "2026-10-15",
  },
  {
    name: "Shan shui · blue-green summer",
    commit: "f1ca6557",
    query: "scene=shanshui&palette=1&season=2",
    savedAt: "2026-10-15",
  },
  {
    name: "Fireflies · riverbank glow",
    commit: "f1ca6557",
    query: "scene=fireflies&density=0.8&habitat=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Pearl · settling tank",
    commit: "f1ca6557",
    query: "scene=pearl&speed=0.4&drift=0.1&vorticity=0",
    savedAt: "2026-10-15",
  },
  {
    name: "Kelp forest · bull kelp",
    commit: "f1ca6557",
    query: "scene=kelp&species=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Petri dish · holes",
    commit: "f1ca6557",
    query: "scene=petri&regime=7",
    savedAt: "2026-10-15",
  },
  {
    name: "Petri dish · spots",
    commit: "f1ca6557",
    query: "scene=petri&regime=5",
    savedAt: "2026-10-15",
  },
  {
    name: "Petri dish · ink mazes",
    commit: "f1ca6557",
    query: "scene=petri&regime=6&palette=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Slime mould · lace",
    commit: "f1ca6557",
    query: "scene=physarum&angle=60&reach=4&decay=0.15",
    savedAt: "2026-10-15",
  },
  {
    name: "Slime mould · ink lace",
    commit: "f1ca6557",
    query: "scene=physarum&angle=60&reach=4&decay=0.15&palette=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Slime mould · routes",
    commit: "f1ca6557",
    query: "scene=physarum&angle=22&reach=18&decay=0.75",
    savedAt: "2026-10-15",
  },
  {
    name: "Slime mould · Tokyo rail routes",
    commit: "f1ca6557",
    query: "scene=physarum&angle=22&reach=18&decay=0.75&layout=2&palette=2",
    savedAt: "2026-10-15",
  },
  {
    name: "Sand table · quick drawings",
    commit: "f1ca6557",
    query: "scene=sandtable&speed=4",
    savedAt: "2026-10-15",
  },
  {
    name: "Lava lamp · chunky wax",
    commit: "f1ca6557",
    query: "scene=lava&heat=0.35&viscosity=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Lava lamp · silky purple in blue",
    commit: "f1ca6557",
    query: "scene=lava&wax=1&heat=0.7&viscosity=0",
    savedAt: "2026-10-15",
  },
  {
    name: "Mystic forest · shy kodama",
    commit: "f1ca6557",
    query: "scene=forest&shy=1&time=0.78",
    savedAt: "2026-10-15",
  },
  {
    name: "Frozen lake · fresh powder under the moon",
    commit: "f1ca6557",
    query: "scene=lake&cover=0.5&fresh=1&moon-amount=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Ripple tank · walled tank",
    commit: "f1ca6557",
    query: "scene=ripple&experiment=1&damping=0.15&edges=0&drips=0",
    savedAt: "2026-10-15",
  },
  {
    name: "City crossing · late delivery",
    commit: "f1ca6557",
    query: "scene=street&crowd=0.2&traffic=0.3&delivery=1&delivery-amount=0.8&time=0.96",
    savedAt: "2026-10-15",
  },
  {
    name: "Campfire · burning down",
    commit: "f1ca6557",
    query: "scene=campfire&fuel=1&fuel-amount=4",
    savedAt: "2026-10-15",
  },
  {
    name: "Campfire · last embers",
    commit: "f1ca6557",
    query: "scene=campfire&fuel=1&fuel-amount=3&tend=0",
    savedAt: "2026-10-15",
  },
  {
    name: "Pendulum wave · real, wide swing",
    commit: "f1ca6557",
    query: "scene=pendula&swing=1&release=0&physics=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Northern lights · breezy fjord",
    commit: "f1ca6557",
    query: "scene=aurora&ripples=0.35&wind=0.45",
    savedAt: "2026-10-15",
  },
  {
    name: "Tide pool · sets",
    commit: "f1ca6557",
    query: "scene=tidepool&swell=0.75&sets-amount=0.8",
    savedAt: "2026-10-15",
  },
  {
    name: "Tide pool · low tide",
    commit: "f1ca6557",
    query: "scene=tidepool&tide=-0.8&swell=0.35",
    savedAt: "2026-10-15",
  },
  {
    name: "Tide pool · night glow",
    commit: "f1ca6557",
    query: "scene=tidepool&time=0.95&glow=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Mobile · solar system at night",
    commit: "d99647f0",
    query: "scene=mobile",
    savedAt: "2026-10-15",
  },
  {
    name: "Mobile · inner planets, glow stars",
    commit: "d99647f0",
    query: "scene=mobile&planets=0&motor-amount=0.7&mark=1",
    savedAt: "2026-10-15",
  },
  {
    name: "Mobile · dwarf planets, daylight",
    commit: "d99647f0",
    query: "scene=mobile&planets=2&room=1&sun=0.7&softness=0.6",
    savedAt: "2026-10-15",
  },
];

const LOCAL_PRESETS = "landing.presets";

function isPreset(entry: unknown): entry is Preset {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.commit === "string" &&
    typeof record.query === "string" &&
    typeof record.savedAt === "string"
  );
}

/** Setups saved in this browser. */
export function loadLocalPresets(): Preset[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_PRESETS) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isPreset) : [];
  } catch (error: unknown) {
    console.error("evt=landing.presets.unreadable", error);
    return [];
  }
}

export function saveLocalPresets(list: readonly Preset[]): void {
  localStorage.setItem(LOCAL_PRESETS, JSON.stringify(list));
}

/** Presets from pasted export JSON; throws on anything that is not a preset list. */
export function parsePresets(text: string): Preset[] {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.every(isPreset)) throw new Error("not a list of presets");
  return list;
}
