// Browser regressions for the lab's Controls view (inspector.ts) laid out under lab.css, run by
// concepts/landing/verify-browser.ts on a real page (the view draws no WebGL):
// - `focus`: folded groups and closed controls leave the tab order (inert): none of their controls
//   takes the focus, those on screen do, and a group that folds while holding the focus hands it
//   to its header;
// - `dormant`: under the lens a change behind a switch that is off shows, dimmed, beside the
//   switches it waits on, its "changed" dot whole and under the pointer; a `when` two levels up
//   closes its grandchildren;
// - `writes`: a sync that changes nothing writes nothing (a MutationObserver over the view), plain,
//   under the lens and under a search, in three scenes; a sync that changes something does write;
// - `night`: in a night with an aurora (three drawings over one another), a click on a planet picks
//   it, and one on the aurora, or on the Milky Way under the drawings over it, switches that part.
import labCss from "../lab.css" with { type: "text" };
import { sceneDefs } from "../scenes/index.ts";
import { encodePlanets, PLANETS_KEY, type SkyPlanet } from "../scenes/planets.ts";
import { readParams, readPlanets, readState, serialise } from "../state.ts";
import type { LabContext, Patch } from "./dom.ts";
import { Inspector } from "./inspector.ts";
import { nightParts } from "./nightsky-model.ts";
import { addedPlanet } from "./planets-model.ts";

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`lab controls: ${message}`);
}

/** The next frame: the rail marks the group in view in one. */
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** A Controls view over a setup of its own, filling the page; a change re-syncs it. */
interface View {
  inspector: Inspector;
  /** Its groups' preferences, open (true) or folded, by section id. */
  sections: Record<string, boolean>;
  /** Every patch it applied, in order. */
  changes: Patch[];
  remove(): void;
}

function view(query: URLSearchParams, sections: Record<string, boolean> = {}): View {
  let state = readState(query);
  let params = readParams(state.scene, query);
  let planets: SkyPlanet[] = readPlanets(state.scene, query);
  const changes: Patch[] = [];
  const ctx: LabContext = {
    current: () => ({ state, params, planets }),
    change: (patch) => {
      changes.push(patch);
      const next = serialise(state, params, planets);
      for (const [key, value] of Object.entries(patch)) next.set(key, String(value));
      state = readState(next);
      params = readParams(state.scene, next);
      planets = readPlanets(state.scene, next);
      inspector.sync();
    },
    on: (key) => key === undefined || (params[key] ?? 0) > 0.5,
    renderer: () => undefined,
    reducedMotion: true,
  };
  const inspector = new Inspector(ctx, { sections, keepWorld: false, save: () => {} });
  const box = document.createElement("div");
  box.style.cssText =
    "position: fixed; inset: 0 auto 0 0; width: 380px; display: flex; flex-direction: column; overflow: auto; background: #0b0c10";
  box.append(inspector.el);
  document.body.append(box);
  inspector.sync();
  return { inspector, sections, changes, remove: () => box.remove() };
}

const setup = (text: string) => new URLSearchParams(text);

function element<E extends Element>(root: ParentNode, selector: string): E {
  const found = root.querySelector<E>(selector);
  if (!found) throw new Error(`lab controls: no ${selector}`);
  return found;
}

/** Whether `el` stands in a folded group or a closed control (a reveal not open). */
const folded = (el: Element) => el.closest(".reveal:not(.open)") !== null;

/** Whether `el` takes the focus; the focus goes back to the page either way. */
function takesFocus(el: HTMLElement): boolean {
  el.focus();
  const took = document.activeElement === el;
  el.blur();
  return took;
}

/** Folded groups and closed controls hold no tab stop; a group folding with the focus hands it on. */
function focus(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, sections] of [
    ["country", {}],
    ["pond", { "pond:koi": true }],
  ] as const) {
    const { inspector, remove } = view(setup(`scene=${name}`), { ...sections });
    try {
      const controls = [
        ...inspector.el.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((el) => el.closest("[hidden]") === null);
      const inFolds = controls.filter(folded);
      const shown = controls.filter((el) => !folded(el) && el.getClientRects().length > 0);
      check(inFolds.length > 0, `${name}: no control stands in a folded group or closed control`);
      const leaks = inFolds.filter(takesFocus);
      check(
        leaks.length === 0,
        `${name}: ${leaks.length} controls in folded groups or closed controls take the focus (${leaks
          .slice(0, 3)
          .map((el) => el.getAttribute("aria-label") ?? el.className)
          .join("; ")})`,
      );
      const reached = shown.filter(takesFocus).length;
      check(reached > 0, `${name}: no control on screen takes the focus`);
      counts[`${name}Folded`] = inFolds.length;
      counts[`${name}Shown`] = reached;
    } finally {
      remove();
    }
  }
  // A group folding while it holds the focus hands it to its header.
  const pond = view(setup("scene=pond"), { "pond:koi": true });
  try {
    const group = element<HTMLElement>(pond.inspector.el, 'section.group[data-id="pond:koi"]');
    const chip = element<HTMLElement>(group, '.chip-cell[data-keys="koi koi-amount"] .chip');
    chip.focus();
    check(document.activeElement === chip, "the koi's chip takes no focus in its open group");
    pond.sections["pond:koi"] = false;
    pond.inspector.sync();
    check(
      document.activeElement === element(group, ".group-toggle"),
      "a group folding with the focus in it does not hand it to its header",
    );
  } finally {
    pond.remove();
  }
  return counts;
}

/** Under the lens a dormant change shows beside its switches, its dot whole; a chain closes all. */
async function dormant(): Promise<Record<string, unknown>> {
  // Personal space changed while "drawn to mouse" is off, its group folded.
  const lens = view(setup("scene=pond&spacing=0.9"), { "pond:koi": false });
  try {
    const { el } = lens.inspector;
    element<HTMLButtonElement>(el, ".lens-toggle").click();
    check(element(el, ".lens-count").textContent === "1 changed", "the lens does not count 1");
    const row = element<HTMLElement>(el, '.row[data-keys="spacing"]');
    const gate = row.closest<HTMLElement>("[data-when]");
    if (!gate) throw new Error("lab controls: personal space stands in no gate");
    check(gate.dataset.when === "follow koi", "personal space hangs on no chain to the koi");
    check(
      gate.classList.contains("open") && gate.classList.contains("dormant"),
      "the lens leaves the changed personal space folded, or not dormant",
    );
    check(!row.classList.contains("no-match"), "the lens leaves out personal space");
    const reason = element<HTMLElement>(el, '.chip-cell[data-keys="follow"]');
    check(
      !reason.classList.contains("no-match") && !reason.hidden,
      "the switch personal space waits on stays out of sight",
    );
    check(
      folded(row) === false && !row.closest<HTMLElement>("section.group")?.hidden,
      "the group holding personal space stays folded under the lens",
    );
    // Its dot hangs off the row's left edge, whole, the one thing under the pointer there.
    row.scrollIntoView({ block: "center" });
    await frame();
    const dot = element<HTMLElement>(row, ".modified");
    const rect = dot.getBoundingClientRect();
    check(!dot.hidden && rect.width > 0, "the changed dot of personal space is hidden");
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    check(hit === dot, `the changed dot of personal space is clipped (${hit?.tagName ?? "none"})`);
    dot.click();
    check(lens.changes.at(-1)?.["spacing"] === 0.5, "the dot does not reset personal space");
  } finally {
    lens.remove();
  }
  // The koi off and "drawn to mouse" on: personal space, two levels down, stays closed.
  const chain = view(setup("scene=pond&koi=0&follow=1"), { "pond:koi": true });
  try {
    const row = element<HTMLElement>(chain.inspector.el, '.row[data-keys="spacing"]');
    check(folded(row), "personal space shows under a switched-off koi");
    check(
      row.closest<HTMLElement>(".reveal-inner")?.inert === true,
      "the closed personal space stays in the tab order",
    );
    check(
      element<HTMLElement>(chain.inspector.el, '.chip-cell[data-keys="follow"]').hidden,
      '"drawn to mouse" shows under a switched-off koi',
    );
  } finally {
    chain.remove();
  }
  return { dormant: "shown", chain: "closed" };
}

/** Records of `records` in words, for a failure. */
function described(records: readonly MutationRecord[]): string {
  return records
    .slice(0, 6)
    .map((record) => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const where = `${target?.tagName.toLowerCase() ?? "?"}.${target?.getAttribute("class") ?? ""}`;
      return `${record.type}${record.attributeName ? ` ${record.attributeName}` : ""} on ${where}`;
    })
    .join("; ");
}

/** A dunes night with two planets, by the add button's rule. */
function twoPlanets(): URLSearchParams {
  const spec = sceneDefs.dunes.planets;
  if (!spec) throw new Error("lab controls: dunes has no planets");
  const first = addedPlanet(spec, []);
  const second = first && addedPlanet(spec, [first]);
  if (!first || !second) throw new Error("lab controls: no room for two planets");
  const query = setup("scene=dunes");
  query.set(PLANETS_KEY, encodePlanets(spec, [first, second]));
  return query;
}

/** A sync that changes nothing writes nothing, whatever narrows the view. */
async function writes(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const scenes: readonly (readonly [string, URLSearchParams, string])[] = [
    ["country", setup("scene=country"), "wind"],
    ["pond", setup("scene=pond&spacing=0.9&koi=0"), "eager"],
    ["dunes", twoPlanets(), "planet"],
  ];
  for (const [name, query, words] of scenes) {
    const { inspector, remove } = view(query);
    try {
      const search = element<HTMLInputElement>(inspector.el, 'input[type="search"]');
      const lens = element<HTMLButtonElement>(inspector.el, ".lens-toggle");
      for (const mode of ["plain", "lens", "search"] as const) {
        if (mode === "lens") lens.click();
        if (mode === "search") {
          lens.click();
          search.value = words;
          search.dispatchEvent(new Event("input"));
        }
        // Let the rail mark the group in view, then sync with nothing changed.
        await frame();
        await frame();
        const observer = new MutationObserver(() => {});
        observer.observe(inspector.el, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });
        inspector.sync();
        const records = observer.takeRecords();
        observer.disconnect();
        check(
          records.length === 0,
          `${name} (${mode}): a sync that changes nothing writes ${records.length} times: ${described(records)}`,
        );
        counts[`${name}-${mode}`] = records.length;
      }
    } finally {
      remove();
    }
  }
  // The observer sees a sync that does change something.
  const { inspector, remove } = view(setup("scene=pond"), { motion: true });
  try {
    const observer = new MutationObserver(() => {});
    observer.observe(inspector.el, { attributes: true, childList: true, subtree: true });
    element<HTMLButtonElement>(
      inspector.el,
      'section.group[data-id="motion"] .group-toggle',
    ).click();
    const records = observer.takeRecords();
    observer.disconnect();
    check(records.length > 0, "folding a group writes nothing");
    counts["foldWrites"] = records.length;
  } finally {
    remove();
  }
  return counts;
}

/** Screen points along `path`, `count` of them from end to end. */
function along(path: SVGGeometryElement, count: number): DOMPoint[] {
  const matrix = path.getScreenCTM();
  if (!matrix) return [];
  const length = path.getTotalLength();
  return Array.from({ length: count }, (_, index) =>
    path.getPointAtLength((length * (index + 0.5)) / count).matrixTransform(matrix),
  );
}

/** The night part (`data-part`) or planet (`planet:<n>`) a click at a point lands on, if any. */
function landsOn(point: DOMPoint): { target: Element | null; name: string | undefined } {
  const target = document.elementFromPoint(point.x, point.y);
  const planet = target?.closest("[data-planet]")?.getAttribute("data-planet");
  const part = target?.closest("[data-part]")?.getAttribute("data-part");
  return { target, name: planet ? `planet:${planet}` : (part ?? undefined) };
}

/** In a night with an aurora, clicks reach planets and parts through the drawings over them. */
async function night(): Promise<Record<string, unknown>> {
  // The aurora and the Milky Way out, so their light (not a dashed outline) takes the click.
  const query = twoPlanets();
  const keys: Record<string, string> = {};
  for (const part of nightParts(sceneDefs.dunes.params))
    if (part.name === "aurora" || part.name === "milkyWay") {
      keys[part.name] = part.def.key;
      query.set(part.def.key, "1");
    }
  const { inspector, changes, remove } = view(query, { "dunes:sky": true });
  try {
    const scene = element<HTMLElement>(inspector.el, ".night-scene");
    const drawings = scene.querySelectorAll(":scope > .night-art").length;
    check(drawings === 3, `a night with an aurora draws in ${drawings} drawings, not 3`);
    scene.scrollIntoView({ block: "center" });
    await frame();
    // The second planet: a click on its disc picks it.
    const disc = element<SVGGeometryElement>(scene, '[data-planet="1"] .night-planet-disc');
    const box = disc.getBoundingClientRect();
    const planet = landsOn(new DOMPoint(box.left + box.width / 2, box.top + box.height / 2));
    check(
      planet.name === "planet:1",
      `a click on the second planet lands on ${planet.name ?? "nothing"}`,
    );
    planet.target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    check(
      scene.querySelector(".night-planet.picked")?.getAttribute("data-planet") === "1",
      "a click on the second planet does not pick it",
    );
    check(
      element(inspector.el, '.planet-pick[aria-pressed="true"]')
        .getAttribute("aria-label")
        ?.startsWith("Planet 2") === true,
      "the planets' chips do not follow the planet picked on the drawing",
    );
    // The aurora, in a drawing of its own, and the Milky Way, under two drawings: a click on
    // either switches it off.
    const switched: Record<string, number> = {};
    for (const [part, selector] of [
      ["aurora", '[data-part="aurora"] .night-glow'],
      ["milkyWay", '[data-part="milkyWay"] .night-band-core'],
    ] as const) {
      const hit = along(element<SVGGeometryElement>(scene, selector), 9)
        .map(landsOn)
        .find((each) => each.name === part);
      check(hit !== undefined, `no click on the ${part} lands on it`);
      const before = changes.length;
      hit.target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const key = keys[part] ?? part;
      const value = changes[before]?.[key];
      check(value === 0, `a click on the ${part} does not switch it off`);
      switched[part] = value;
    }
    return { drawings, picked: 1, switched };
  } finally {
    remove();
  }
}

/** Every Controls view regression above, under the lab's own stylesheet. */
export async function verifyInspector(
  _gl: WebGL2RenderingContext,
): Promise<Record<string, unknown>> {
  const style = document.createElement("style");
  // Transitions and animations off, so each layout settles at once.
  style.textContent = `${labCss}\n*, *::before, *::after { transition: none !important; animation: none !important; }`;
  document.head.append(style);
  try {
    return {
      focus: focus(),
      dormant: await dormant(),
      writes: await writes(),
      night: await night(),
    };
  } finally {
    style.remove();
  }
}
