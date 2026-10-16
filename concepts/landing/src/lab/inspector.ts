// The lab panel's Controls view: the scene's knob groups, the shared world's first on a World shelf
// (with its "keep the world" switch, world.ts), then the global Look, Motion and Page groups, each
// a collapsible section under an icon heading, with a rail of the same icons to jump between them
// (a dot on a group with changes), a search that narrows every group to the controls that match, a
// lens that narrows them to what differs from the defaults (and resets it) and a button that folds
// or opens them all. A group's knobs are laid out by their metadata: the sky dial, mix bars and
// pads where a knob names one (`ParamDef.widget`), its switches as icon chips, everything else as
// rows.
import { formatValue, MAX_SEED, type Option, type ParamDef } from "../params.ts";
import { colorIds, ditherIds, viewIds } from "../renderer.ts";
import { sceneDefs, type SceneId } from "../scenes/index.ts";
import {
  accentOf,
  defaultsFor,
  modeIds,
  paramDefaults,
  type LabState,
  type Params,
} from "../state.ts";
import { almanacParts, gatherAlmanac } from "./almanac-model.ts";
import { chipGrid } from "./chips.ts";
import { climateMarks } from "./climate-hint-model.ts";
import {
  dice,
  iconButton,
  nowButton,
  row,
  segments,
  slider,
  switchControl,
  textButton,
} from "./controls.ts";
import { seasonWheel, skyDial, type SkyParts } from "./dial.ts";
import { h, reveal, type Built, type LabContext, type Patch } from "./dom.ts";
import { flywayCard, flywayOf } from "./flyway.ts";
import { icon, iconFromWords, type IconName } from "./icons.ts";
import {
  knobIcon,
  knobKeys,
  Knobs,
  type FeatureDef,
  type RangeDef,
  type SwitchDef,
} from "./knobs.ts";
import {
  changedCounts,
  changedKnobs,
  changedSettings,
  groupShows,
  itemShows,
  titleHolds,
  type LensGroup,
  type LensQuery,
} from "./lens-model.ts";
import { mixBar } from "./mix.ts";
import type { MixPart } from "./mix-model.ts";
import { compassPad, directionPad, positionPad, type Strength } from "./pads.ts";
import { Rail, type RailEntry } from "./rail.ts";
import { worldDivider } from "./world.ts";
import { shelves } from "./world-model.ts";
import { recipeStrip } from "./recipes.ts";
import { shownRecipes } from "./recipes-model.ts";
import { nightSection } from "./nightsky.ts";
import { nightCompanions, nightParts } from "./nightsky-model.ts";
import { rollPatch } from "./roll-model.ts";

export const MODE_LABEL: Record<(typeof modeIds)[number], string> = {
  landing: "Landing",
  loading: "Loading",
  instance: "Sign-in",
  bare: "None",
};
const VIEW_LABEL: Record<(typeof viewIds)[number], string> = {
  dithered: "Dithered",
  source: "Source",
  split: "Split",
};
const DITHER_LABEL: Record<(typeof ditherIds)[number], string> = {
  bayer8: "Bayer 8",
  bayer4: "Bayer 4",
  ign: "Noise",
  none: "None",
};
const COLOR_LABEL: Record<(typeof colorIds)[number], string> = {
  accent: "Accent",
  mono: "Mono",
  full: "Full",
};
const SWATCHES = ["#4c6ef5", "#ff004e", "#ff7a2f", "#f2c94c", "#2bd9a8", "#e8e6df"] as const;

/**
 * The global groups' settings: what their resets restore, and what the lens compares, against the
 * scene's defaults (`defaultsFor`).
 */
const SETTINGS = {
  look: ["view", "dither", "color", "accent", "levels", "pixel"],
  motion: ["motion", "mouse", "transitions", "overlap", "weave", "blend", "slowmo"],
  page: ["mode", "dim", "blur"],
} as const satisfies Record<string, readonly (keyof LabState)[]>;
const SETTING_KEYS = [...SETTINGS.look, ...SETTINGS.motion, ...SETTINGS.page];
/** The global groups as the lens counts them (by section id): each setting a knob of its own. */
const SETTING_GROUPS: readonly LensGroup[] = Object.entries<readonly string[]>(SETTINGS).map(
  ([id, keys]) => ({ id, knobs: keys.map((key) => [key]) }),
);

/**
 * Tag `built` with the URL keys of the knobs it holds (`data-keys`): the lens shows it while any of
 * them differs from its default, and with it a control inside that has no keys of its own.
 */
function holding(built: Built, defs: readonly (ParamDef | undefined)[]): Built {
  built.el.dataset.keys = defs.flatMap((def) => (def ? knobKeys(def) : [])).join(" ");
  return built;
}

/** Tag a global group's rows, in the order of its settings, each with the setting it shows. */
function tagSettings(rows: readonly Built[], keys: readonly string[]): void {
  for (const [index, key] of keys.entries()) {
    const built = rows[index];
    if (built) built.el.dataset.keys = key;
  }
}

/** The lab preferences the Controls view reads and sets (lab/prefs.ts), and how to store them. */
export interface SectionPrefs {
  /** Open (true) or folded (false) per section id; missing means the section's default. */
  sections: Record<string, boolean>;
  /** Whether a scene picked by hand keeps the world (the World divider's switch). */
  keepWorld: boolean;
  save(): void;
}

const options = (list: readonly Option[]) =>
  list.map((option) => ({ label: option.label, value: String(option.value) }));

interface Section {
  id: string;
  title: string;
  icon: IconName;
  el: HTMLElement;
  toggle: HTMLButtonElement;
  open(): void;
}

export class Inspector {
  readonly el: HTMLElement;
  readonly #ctx: LabContext;
  readonly #prefs: SectionPrefs;
  readonly #search: HTMLInputElement;
  readonly #rail: Rail;
  readonly #body: HTMLElement;
  readonly #worldSlot = h("div", { class: "groups" });
  /** The World shelf's divider and its "keep the world" switch. */
  readonly #worldDivider: Built;
  readonly #sceneDivider = h("p", { class: "shelf-divider" });
  readonly #sceneSlot = h("div", { class: "groups" });
  readonly #globalSlot = h("div", { class: "groups" });
  /** Where nothing shows: what the search or the lens found nothing for (set by filter). */
  readonly #empty = h("p", { class: "lab-empty" });
  readonly #syncers: (() => void)[] = [];
  #sceneSyncers: (() => void)[] = [];
  #sceneSections: Section[] = [];
  readonly #globalSections: Section[] = [];
  #built: SceneId | undefined;
  /** Whether every group is open; the fold button flips it. */
  readonly #fold: HTMLButtonElement;
  /** The "changed" lens: while on, every group narrows to what differs from the defaults. */
  #lens = false;
  readonly #lensToggle: HTMLButtonElement;
  readonly #lensCount = h("span", { class: "lens-count" });
  /** Over the groups while the lens is on and something changed: its "reset what changed". */
  readonly #lensHead: HTMLElement;
  /** The URL keys that differ from their defaults: the scene's knobs and the global settings. */
  #changed: ReadonlySet<string> = new Set();
  /** The scene's knob defaults, and every group as the lens counts it (the global ones last). */
  #defaults: Params = {};
  #lensGroups: LensGroup[] = [];

  constructor(ctx: LabContext, prefs: SectionPrefs) {
    this.#ctx = ctx;
    this.#prefs = prefs;
    this.#search = h("input", {
      type: "search",
      placeholder: "Find a control…",
      "aria-label": "Find a control",
      spellcheck: false,
    });
    this.#search.addEventListener("input", () => this.filter());
    this.#search.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      this.#search.value = "";
      this.filter();
      this.#search.blur();
    });
    this.#worldDivider = worldDivider(prefs);
    this.#syncers.push(this.#worldDivider.sync);
    this.#body = h(
      "div",
      { class: "view-body inspector-body" },
      this.#worldDivider.el,
      this.#worldSlot,
      this.#sceneDivider,
      this.#sceneSlot,
      h("p", { class: "shelf-divider" }, h("span", {}, "Global")),
      this.#globalSlot,
      this.#empty,
    );
    this.#rail = new Rail(this.#body, "Groups", ctx.reducedMotion);
    this.#globalSections.push(this.#lookGroup(), this.#motionGroup(), this.#pageGroup());
    this.#globalSlot.append(...this.#globalSections.map((section) => section.el));
    this.#fold = iconButton("unfold", "Open every group", () => {
      const open = !this.#allOpen();
      for (const section of [...this.#sceneSections, ...this.#globalSections])
        this.#prefs.sections[section.id] = open;
      this.#prefs.save();
      this.sync();
    });
    this.#lensToggle = h(
      "button",
      { type: "button", class: "lens-toggle" },
      icon("changed"),
      this.#lensCount,
    );
    this.#lensToggle.addEventListener("click", () => {
      this.#lens = !this.#lens;
      this.#body.scrollTop = 0;
      this.sync();
    });
    this.#lensHead = h(
      "div",
      { class: "lens-head", hidden: true },
      h("span", { class: "lens-caption" }, "Changed from defaults"),
      textButton(
        "reset",
        "Reset what changed",
        "Every control here back to its default, in one step (undo brings them back)",
        () => {
          this.#resetChanged();
          this.#lensToggle.focus();
        },
      ),
    );
    this.el = h(
      "div",
      { class: "view-controls" },
      h(
        "div",
        { class: "view-tools" },
        h("label", { class: "panel-search" }, icon("search"), this.#search),
        this.#lensToggle,
        this.#fold,
      ),
      this.#lensHead,
      h("div", { class: "view-main" }, this.#rail.el, this.#body),
    );
  }

  focusSearch(): void {
    this.#search.focus();
    this.#search.select();
  }

  /** The view came on screen. */
  shown(): void {
    this.#rail.spy();
  }

  sync(): void {
    const { scene } = this.#ctx.current().state;
    if (this.#built !== scene) this.#build(scene);
    for (const sync of this.#syncers) sync();
    for (const sync of this.#sceneSyncers) sync();
    const all = this.#allOpen();
    this.#fold.replaceChildren(icon(all ? "fold" : "unfold"));
    const label = all ? "Fold every group" : "Open every group";
    this.#fold.title = label;
    this.#fold.setAttribute("aria-label", label);
    this.#syncLens();
    this.filter();
  }

  /** Find what differs from the defaults: the lens's count and head, and the rail's dots. */
  #syncLens(): void {
    const { state, params } = this.#ctx.current();
    this.#changed = new Set([
      ...changedKnobs(sceneDefs[state.scene].params, params, this.#defaults),
      ...changedSettings(SETTING_KEYS, state, this.#base()),
    ]);
    const counts = changedCounts(this.#lensGroups, this.#changed);
    this.#rail.mark(counts);
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    this.#lensCount.textContent = total > 0 ? `${total} changed` : "";
    const label = `Only what changed (${total > 0 ? `${total} changed` : "nothing yet"})`;
    this.#lensToggle.title = `${label}: narrow every group to the controls that differ from this scene's defaults`;
    this.#lensToggle.setAttribute("aria-label", label);
    this.#lensToggle.setAttribute("aria-pressed", String(this.#lens));
    this.#lensHead.hidden = !this.#lens || total === 0;
  }

  /**
   * Every knob of the scene and global setting that differs from its default back to it, in one
   * undoable change: the transport's reset, kept to what changed.
   */
  #resetChanged(): void {
    const base = this.#base();
    const patch: Patch = {};
    for (const [key, value] of Object.entries(this.#defaults))
      if (this.#changed.has(key)) patch[key] = value;
    for (const key of SETTING_KEYS) if (this.#changed.has(key)) patch[key] = base[key];
    this.#ctx.change(patch, true);
  }

  #allOpen(): boolean {
    return [...this.#sceneSections, ...this.#globalSections].every((section) =>
      section.el.classList.contains("is-open"),
    );
  }

  // ---- sections and the rail ------------------------------------------------------------------

  #section(spec: {
    id: string;
    title: string;
    blurb: string;
    icon: IconName;
    open: boolean;
    content: HTMLElement[];
    summary: () => string[];
    master?: Built;
    masterOn?: () => boolean;
    offNote?: string;
    modified?: () => boolean;
    reset?: () => void;
    /** Shuffle the group's knobs: a dice beside the reset. */
    roll?: () => void;
    syncers: (() => void)[];
  }): Section {
    const isOpen = () => this.#prefs.sections[spec.id] ?? spec.open;
    const bodyId = `group-${spec.id.replace(/[^a-z0-9]+/gi, "-")}`;
    const summary = h("span", { class: "group-summary" });
    const toggle = h(
      "button",
      {
        type: "button",
        class: "group-toggle",
        "aria-controls": bodyId,
        title: spec.blurb,
      },
      icon("chevron"),
      h("span", { class: "group-icon" }, icon(spec.icon)),
      h("span", { class: "group-title" }, spec.title),
      summary,
    );
    const reset = iconButton("reset", `Reset ${spec.title.toLowerCase()} to its defaults`, () =>
      spec.reset?.(),
    );
    reset.classList.add("group-reset");
    const roll = spec.roll
      ? iconButton("dice", `Shuffle ${spec.title.toLowerCase()} (this group only)`, (button) => {
          spec.roll?.();
          button.classList.remove("rolling");
          void button.offsetWidth;
          button.classList.add("rolling");
        })
      : null;
    roll?.classList.add("group-roll");
    roll?.addEventListener("animationend", () => roll.classList.remove("rolling"));
    const offNote = spec.offNote ? h("p", { class: "group-off" }, spec.offNote) : null;
    const inner = h(
      "div",
      { class: "group-body" },
      h("p", { class: "group-blurb" }, spec.blurb),
      offNote,
      ...spec.content,
    );
    const body = h(
      "div",
      { class: "reveal", id: bodyId },
      h("div", { class: "reveal-inner" }, inner),
    );
    const el = h(
      "section",
      { class: "group", "data-id": spec.id, "data-title": spec.title.toLowerCase() },
      h(
        "div",
        { class: "group-head" },
        toggle,
        spec.reset ? reset : null,
        roll,
        spec.master?.el ?? null,
      ),
      body,
    );
    toggle.addEventListener("click", () => {
      const opening = !isOpen();
      this.#prefs.sections[spec.id] = opening;
      this.#prefs.save();
      // A group opened from its header is the one in hand: the rail marks it.
      this.#rail.pin(opening ? spec.id : undefined);
      this.sync();
    });
    const sync = () => {
      const open = isOpen() || el.classList.contains("searching");
      body.classList.toggle("open", open);
      el.classList.toggle("is-open", isOpen());
      toggle.setAttribute("aria-expanded", String(open));
      const on = spec.masterOn?.() ?? true;
      el.classList.toggle("off", !on);
      if (offNote) offNote.hidden = on;
      spec.master?.sync();
      reset.hidden = !(spec.modified?.() ?? false);
      summary.textContent = open ? "" : spec.summary().join(" · ");
    };
    spec.syncers.push(sync);
    return {
      id: spec.id,
      title: spec.title,
      icon: spec.icon,
      el,
      toggle,
      open: () => {
        this.#prefs.sections[spec.id] = true;
        this.#prefs.save();
      },
    };
  }

  /** A section on the rail: the jump opens it and hands the keyboard its header. */
  #railEntry(section: Section): RailEntry {
    return {
      id: section.id,
      title: section.title,
      icon: section.icon,
      el: section.el,
      focus: section.toggle,
      open: () => {
        section.open();
        this.sync();
      },
    };
  }

  /** Narrow every group to the controls that match the search and, while it is on, the lens. */
  filter(): void {
    const query: LensQuery = {
      text: this.#search.value.trim().toLowerCase(),
      lens: this.#lens,
      changed: this.#changed,
    };
    const filtering = query.text !== "" || query.lens;
    this.el.classList.toggle("searching", filtering);
    let any = false;
    const sections = [...this.#sceneSections, ...this.#globalSections];
    for (const section of sections) {
      const el = section.el;
      let shown = 0;
      const titleHit = titleHolds(el.dataset.title ?? "", query);
      for (const item of el.querySelectorAll<HTMLElement>("[data-search]")) {
        // A control's knobs are its own, else those of the widget it stands in.
        const keys = item.closest<HTMLElement>("[data-keys]")?.dataset.keys ?? "";
        const hit = itemShows(
          {
            search: item.dataset.search ?? "",
            keys: keys.split(" "),
            held: item.contains(document.activeElement),
          },
          titleHit,
          query,
        );
        item.classList.toggle("no-match", !hit);
        if (hit) shown++;
      }
      const visible = groupShows(shown, titleHit, query);
      el.hidden = !visible;
      el.classList.toggle("searching", filtering && visible);
      if (visible) any = true;
    }
    this.#empty.hidden = any;
    this.#empty.textContent = !query.lens
      ? "Nothing matches. Try another word, or press Esc."
      : query.changed.size === 0
        ? "Nothing has changed: every control is at this scene's default."
        : "Nothing changed matches. Try another word, or press Esc.";
    if (filtering) for (const sync of [...this.#syncers, ...this.#sceneSyncers]) sync();
    this.#rail.spy();
  }

  // ---- the scene's groups ---------------------------------------------------------------------

  #build(scene: SceneId): void {
    this.#built = scene;
    this.#sceneSyncers = [];
    const defs = sceneDefs[scene].params;
    this.#defaults = paramDefaults(scene);
    const knobs = new Knobs(this.#ctx, defs, this.#defaults);
    // The world's groups lead on a shelf of their own; the scene's first group opens by default.
    // The almanac's season and year parts stand with the time of day, wherever they are declared.
    const groups = new Map<string, ParamDef[]>();
    for (const def of defs) groups.set(def.group, [...(groups.get(def.group) ?? []), def]);
    gatherAlmanac(groups);
    this.#lensGroups = [
      ...[...groups].map(([group, list]) => ({
        id: `${scene}:${group}`,
        knobs: list.map(knobKeys),
      })),
      ...SETTING_GROUPS,
    ];
    const { world, own } = shelves(sceneDefs[scene]);
    const section = (group: string) =>
      this.#sceneGroup(scene, knobs, group, groups.get(group) ?? [], group === defs[0]?.group);
    const worldSections = world.filter((group) => groups.has(group)).map(section);
    const ownSections = own.filter((group) => groups.has(group)).map(section);
    this.#sceneSections = [...worldSections, ...ownSections];
    this.#worldDivider.el.hidden = worldSections.length === 0;
    this.#worldSlot.replaceChildren(...worldSections.map((section) => section.el));
    this.#sceneDivider.replaceChildren(h("span", {}, sceneDefs[scene].title));
    this.#sceneSlot.replaceChildren(...ownSections.map((section) => section.el));
    this.#rail.set(
      [worldSections, ownSections, this.#globalSections].map((list) =>
        list.map((section) => this.#railEntry(section)),
      ),
    );
    this.#body.scrollTop = 0;
  }

  /** The knob a group hinges on: its first switch, when every other knob depends on it. */
  #masterOf(defs: readonly ParamDef[]): SwitchDef | undefined {
    const [head, ...rest] = defs;
    if (!head || (head.kind !== "toggle" && head.kind !== "feature") || rest.length === 0)
      return undefined;
    return rest.every((def) => def.when === head.key) ? head : undefined;
  }

  #sceneGroup(
    scene: SceneId,
    knobs: Knobs,
    group: string,
    defs: readonly ParamDef[],
    open: boolean,
  ): Section {
    const info = sceneDefs[scene].groups[group] ?? { title: group, blurb: "" };
    const master = this.#masterOf(defs);
    const syncers = this.#sceneSyncers;
    const used = new Set<ParamDef>(master ? [master] : []);
    const items: { at: number; built: Built; when: string | undefined }[] = [];
    const place = (def: ParamDef, built: Built) => {
      built.el.dataset.keys ??= knobKeys(def).join(" ");
      items.push({ at: defs.indexOf(def), built, when: def.when });
    };

    // The sky dial, where the group holds its time of day, with the season parts round it (from any
    // group, see gatherAlmanac); without one, the season parts make a wheel of their own. The dial
    // draws the scene's night moon and stars wherever they stand.
    const time = defs.find(
      (def): def is RangeDef =>
        def.kind === "range" && def.widget?.kind === "sky" && def.widget.part === "time",
    );
    const almanac = almanacParts(defs);
    let dial: Built | undefined;
    if (time) {
      const cycle = defs.find(
        (def): def is FeatureDef =>
          def.kind === "feature" && def.widget?.kind === "sky" && def.widget.part === "cycle",
      );
      const sky: SkyParts = { time, cycle, moon: undefined, stars: undefined };
      for (const part of nightParts(sceneDefs[scene].params)) {
        if (part.name === "moon") sky.moon = part.def;
        else if (part.name === "stars") sky.stars = part.def;
      }
      dial = holding(skyDial(knobs, sky, almanac), [time, cycle, almanac.season, almanac.year]);
      for (const def of [time, cycle, almanac.season, almanac.year]) if (def) used.add(def);
    } else if (almanac.season) {
      place(
        almanac.season,
        holding(seasonWheel(knobs, almanac.season, almanac.year), [almanac.season, almanac.year]),
      );
      for (const def of [almanac.season, almanac.year]) if (def) used.add(def);
    }

    // The Night sky section, at its first part, with the knobs that hang off its parts (the giant
    // planet's placement pad and dress): ahead of the pads, so it holds its own. "See it at night"
    // sets the scene's own clock.
    const night = nightParts(defs.filter((def) => !used.has(def)));
    const firstNight = defs.find((def) => night.some((part) => part.def === def));
    if (firstNight) {
      const clock = sceneDefs[scene].params.find(
        (def): def is RangeDef =>
          def.kind === "range" && def.widget?.kind === "sky" && def.widget.part === "time",
      );
      const cycle = sceneDefs[scene].params.find(
        (def): def is FeatureDef =>
          def.kind === "feature" && def.widget?.kind === "sky" && def.widget.part === "cycle",
      );
      const free = defs.filter((def) => !used.has(def));
      place(
        firstNight,
        nightSection(knobs, night, clock && { time: clock, cycle }, {
          defs: free,
          row: (def) => this.#knobRow(knobs, def),
        }),
      );
      for (const part of night)
        for (const def of [part.def, ...nightCompanions(part, free)]) used.add(def);
    }

    // Pads: a compass's heading and strength, a position's two coordinates, a signed direction.
    let masterAmountShown = master?.kind === "feature";
    for (const def of defs) {
      if (def.kind !== "range" || used.has(def)) continue;
      const widget = def.widget;
      if (widget?.kind === "compass") {
        const power = knobs.def(widget.strength);
        if (power?.kind !== "range" && power?.kind !== "feature") continue;
        const strength: Strength = {
          def: power,
          key: power.kind === "feature" ? `${power.key}-amount` : power.key,
        };
        place(def, holding(compassPad(knobs, def, strength), [def, power]));
        used.add(def);
        if (power === master) masterAmountShown = false;
        else if (defs.includes(power) && power.kind === "range") used.add(power);
      } else if (widget?.kind === "position") {
        const y = knobs.def(widget.y);
        if (y?.kind !== "range" || !defs.includes(y)) continue;
        place(def, holding(positionPad(knobs, def, y, widget.screen), [def, y]));
        used.add(def).add(y);
      } else if (widget?.kind === "direction" && def.min < 0 && def.max > 0) {
        // The wind card: the group's gusts ride its pad.
        const gusts = defs.find(
          (other): other is FeatureDef =>
            other.kind === "feature" && other.widget?.kind === "gusts" && !used.has(other),
        );
        place(def, directionPad(knobs, def, knobIcon(def), gusts));
        used.add(def);
        if (gusts) used.add(gusts);
      }
    }

    // Mix bars, at their first part; a feature part is the bar's (its chip there), not the grid's.
    const mixes = new Map<string, MixPart[]>();
    for (const def of defs)
      if (
        (def.kind === "range" || def.kind === "feature") &&
        def.widget?.kind === "mix" &&
        !used.has(def)
      ) {
        const parts = mixes.get(def.widget.mix) ?? [];
        parts.push({ def, part: def.widget.part, swatch: def.widget.swatch });
        mixes.set(def.widget.mix, parts);
        used.add(def);
      }
    for (const [name, parts] of mixes) {
      const head = parts[0];
      if (head)
        place(
          head.def,
          holding(
            mixBar(knobs, name, parts),
            parts.map((part) => part.def),
          ),
        );
    }

    // The birds card, at its switch (the header's, when the birds are the group's master).
    const flyway = flywayOf(defs);
    if (flyway) {
      place(
        flyway.birds,
        holding(flywayCard(knobs, flyway, flyway.birds === master), [
          flyway.birds,
          flyway.kind,
          flyway.formation,
        ]),
      );
      for (const def of [flyway.birds, flyway.kind, flyway.formation]) if (def) used.add(def);
      if (flyway.birds === master) masterAmountShown = false;
    }

    // Switches as chips; the rest as rows.
    const switches = defs.filter(
      (def): def is SwitchDef =>
        (def.kind === "toggle" || def.kind === "feature") && !used.has(def),
    );
    // Where the season sets the climate, its marks on the rain's and snow's chips and the recipes.
    const marks = climateMarks(sceneDefs[scene].params);
    const chips = switches.length > 0 ? chipGrid(knobs, switches, marks) : undefined;
    for (const def of defs)
      if (!used.has(def) && def.kind !== "toggle" && def.kind !== "feature")
        place(def, this.#knobRow(knobs, def));

    const content: HTMLElement[] = [];
    const keys = defs.flatMap(knobKeys);
    const recipes = recipeStrip(knobs, info, sceneDefs[scene].params, marks);
    if (recipes) {
      // The strip holds the group's knobs that its recipes set.
      const set = new Set(
        shownRecipes(info.recipes ?? [], sceneDefs[scene].params).flatMap(({ patch }) =>
          Object.keys(patch),
        ),
      );
      recipes.el.dataset.keys = keys.filter((key) => set.has(key)).join(" ");
      content.push(recipes.el);
      syncers.push(recipes.sync);
    }
    if (master?.kind === "feature" && masterAmountShown) {
      const built = holding(this.#masterAmount(knobs, master), [master]);
      content.push(built.el);
      syncers.push(built.sync);
    }
    if (dial) {
      content.push(dial.el);
      syncers.push(dial.sync);
    }
    if (chips) {
      content.push(chips.grid.el, chips.amounts.el);
      syncers.push(chips.grid.sync, chips.amounts.sync);
    }
    for (const item of items.sort((a, b) => a.at - b.at)) {
      syncers.push(item.built.sync);
      if (item.when === undefined) {
        content.push(item.built.el);
        continue;
      }
      const dependent = reveal(item.built.el, () => knobs.on(item.when));
      content.push(dependent.el);
      syncers.push(dependent.sync);
    }

    const masterSwitch = master
      ? switchControl(
          master.label,
          () => knobs.on(master.key),
          (on) => {
            if (on) {
              this.#prefs.sections[`${scene}:${group}`] = true;
              this.#prefs.save();
            }
            knobs.set({ [master.key]: on ? 1 : 0 }, true);
          },
        )
      : undefined;
    if (master && masterSwitch) {
      // The header's switch is one of the group's controls: the search and the lens find it too.
      masterSwitch.el.dataset.search = `${master.label} ${master.help}`.toLowerCase();
      holding(masterSwitch, [master]);
    }
    return this.#section({
      id: `${scene}:${group}`,
      title: info.title,
      blurb: info.blurb,
      icon: info.icon ?? iconFromWords(group, info.title) ?? "sliders",
      open,
      content,
      summary: () => this.#groupSummary(knobs, defs, master),
      ...(masterSwitch ? { master: masterSwitch } : {}),
      ...(master
        ? {
            masterOn: () => knobs.on(master.key),
            offNote: `Switch on to shape the ${info.title.toLowerCase()}.`,
          }
        : {}),
      modified: () => knobs.modified(keys),
      reset: () => knobs.reset(keys),
      ...(defs.some((def) => !def.steady) ? { roll: () => knobs.set(rollPatch(defs), true) } : {}),
      syncers,
    });
  }

  /** A master feature's amount, at the head of its group (the header holds its switch). */
  #masterAmount(knobs: Knobs, def: FeatureDef): Built {
    const amountKey = `${def.key}-amount`;
    const control = def.options
      ? segments(
          def.amountLabel,
          options(def.options),
          () => String(knobs.value(amountKey)),
          (value) => knobs.set({ [amountKey]: Number(value) }, true),
        )
      : slider(
          def.amountLabel,
          def.min,
          def.max,
          def.step,
          () => knobs.value(amountKey),
          (value, commit) => knobs.set({ [amountKey]: value }, commit),
        );
    const slot = def.trigger;
    const built = row({
      label: def.amountLabel,
      help: def.help,
      icon: knobIcon(def),
      block: control.el,
      inline:
        slot === undefined
          ? []
          : [nowButton(def.label, () => knobs.fire(slot), { whileOff: true })],
      ...(def.options ? {} : { readout: () => formatValue(def, knobs.value(amountKey)) }),
      modified: () => knobs.modified(knobKeys(def)),
      reset: () => knobs.reset(knobKeys(def)),
    });
    return {
      el: built.el,
      sync: () => {
        control.sync();
        built.sync();
      },
    };
  }

  /** A range, choice or seed as a row, with its "now" when it has a trigger. */
  #knobRow(knobs: Knobs, def: Exclude<ParamDef, SwitchDef>): Built {
    const slot = def.trigger;
    const now = slot === undefined ? [] : [nowButton(def.label, () => knobs.fire(slot))];
    const common = {
      label: def.label,
      help: def.help,
      modified: () => knobs.modified([def.key]),
      reset: () => knobs.reset([def.key]),
    };
    switch (def.kind) {
      case "range": {
        const control = slider(
          def.label,
          def.min,
          def.max,
          def.step,
          () => knobs.value(def.key),
          (value, commit) => knobs.set({ [def.key]: value }, commit),
        );
        const built = row({
          ...common,
          inline: now,
          block: control.el,
          readout: () => formatValue(def, knobs.value(def.key)),
        });
        return {
          el: built.el,
          sync: () => {
            control.sync();
            built.sync();
          },
        };
      }
      case "choice": {
        const control = segments(
          def.label,
          options(def.options),
          () => String(knobs.value(def.key)),
          (value) => knobs.set({ [def.key]: Number(value) }, true),
        );
        const built = row({ ...common, inline: now, block: control.el });
        return {
          el: built.el,
          sync: () => {
            control.sync();
            built.sync();
          },
        };
      }
      case "seed": {
        const roll = dice(def.label, () => {
          let next = Math.floor(Math.random() * (MAX_SEED + 1));
          if (next === knobs.value(def.key)) next = (next + 1) % (MAX_SEED + 1);
          knobs.set({ [def.key]: next }, true);
        });
        const built = row({
          ...common,
          icon: "dice",
          inline: [...now, roll],
          readout: () => formatValue(def, knobs.value(def.key)),
        });
        return built;
      }
      default: {
        const unreachable: never = def;
        throw new Error(`landing: unknown knob ${String(unreachable)}`);
      }
    }
  }

  #groupSummary(knobs: Knobs, defs: readonly ParamDef[], master: SwitchDef | undefined): string[] {
    if (master && !knobs.on(master.key)) return ["off"];
    const parts: string[] = [];
    for (const def of defs) {
      if (def === master && def.kind !== "feature") continue;
      if (def.when !== undefined && !knobs.on(def.when)) continue;
      const value = knobs.value(def.key);
      switch (def.kind) {
        case "toggle":
          if (value > 0.5) parts.push(def.label);
          break;
        case "feature":
          if (value > 0.5)
            parts.push(
              def.options ? `${knobs.value(`${def.key}-amount`)} ${def.label}` : def.label,
            );
          break;
        case "choice":
          if (master || value !== knobs.default(def.key)) {
            const chosen = def.options.find((option) => option.value === value)?.label ?? "";
            parts.push(/^\d+$/.test(chosen) ? `${chosen} ${def.label}` : chosen);
          }
          break;
        case "range":
        case "seed":
          if (value !== knobs.default(def.key))
            parts.push(`${def.label} ${formatValue(def, value)}`);
          break;
        default: {
          const unreachable: never = def;
          throw new Error(`landing: unknown knob ${String(unreachable)}`);
        }
      }
    }
    if (master && parts.length === 0) parts.push("on");
    return parts.filter(Boolean);
  }

  // ---- global groups --------------------------------------------------------------------------

  /** Defaults for the current scene (its look may differ from the global defaults). */
  #base(): LabState {
    return defaultsFor(this.#ctx.current().state.scene);
  }

  #state(): LabState {
    return this.#ctx.current().state;
  }

  #lookGroup(): Section {
    const change = (patch: Record<string, string | number>, commit = true) =>
      this.#ctx.change(patch, commit);
    const view = segments(
      "View",
      viewIds.map((id) => ({ label: VIEW_LABEL[id], value: id })),
      () => this.#state().view,
      (value) => change({ view: value }),
    );
    const dither = segments(
      "Dither pattern",
      ditherIds.map((id) => ({ label: DITHER_LABEL[id], value: id })),
      () => this.#state().dither,
      (value) => change({ dither: value }),
    );
    const colour = segments(
      "Colour",
      colorIds.map((id) => ({ label: COLOR_LABEL[id], value: id })),
      () => this.#state().color,
      (value) => change({ color: value }),
    );
    const levels = slider(
      "Tones",
      2,
      6,
      1,
      () => this.#state().levels,
      (value, commit) => change({ levels: value }, commit),
    );
    const pixel = slider(
      "Dot size",
      1,
      8,
      1,
      () => this.#state().pixel,
      (value, commit) => change({ pixel: value }, commit),
    );
    const swatches = [
      { value: "", label: "Scene default" },
      ...SWATCHES.map((value) => ({ value, label: value })),
    ].map((swatch) => {
      const button = h("button", {
        type: "button",
        class: "swatch",
        title: swatch.label,
        "aria-label": swatch.label,
        "data-value": swatch.value,
      });
      button.addEventListener("click", () => change({ accent: swatch.value }));
      return button;
    });
    const custom = h("input", {
      type: "color",
      class: "swatch-custom",
      title: "Any colour",
      "aria-label": "Custom accent colour",
    });
    custom.addEventListener("input", () => change({ accent: custom.value }, false));
    const rows = [
      row({
        label: "View",
        help: "Dithered is the finished look. Source shows the picture before dithering; Split puts source on the left and dithered on the right, to see what the shader does.",
        icon: "eye",
        block: view.el,
        modified: () => this.#state().view !== this.#base().view,
        reset: () => change({ view: this.#base().view }),
      }),
      row({
        label: "Dither pattern",
        help: "How tones turn into dots. Bayer 8 and 4: ordered cross-hatch grids (4 is coarser). Noise: finer, film-like grain. None: hard posterised bands.",
        icon: "dither",
        block: dither.el,
        modified: () => this.#state().dither !== this.#base().dither,
        reset: () => change({ dither: this.#base().dither }),
      }),
      row({
        label: "Colour",
        help: "Accent: one accent colour plus off-white ink, the house look. Mono: ink only. Full: the picture's own colours, quantised per channel.",
        icon: "palette",
        block: colour.el,
        modified: () => this.#state().color !== this.#base().color,
        reset: () => change({ color: this.#base().color }),
      }),
      row({
        label: "Accent",
        help: "The single accent colour. The first swatch follows the scene's own default.",
        icon: "drop",
        block: h("div", { class: "swatches" }, ...swatches, custom),
        modified: () => this.#state().accent !== "",
        reset: () => change({ accent: "" }),
      }),
      row({
        label: "Tones",
        help: "Shades per channel. 2 is pure on/off dots; more adds in-between shades and softens the look.",
        icon: "tones",
        block: levels.el,
        readout: () => `${this.#state().levels}`,
        modified: () => this.#state().levels !== this.#base().levels,
        reset: () => change({ levels: this.#base().levels }),
      }),
      row({
        label: "Dot size",
        help: "Size of one dot in screen pixels. Larger is chunkier and cheaper to draw.",
        icon: "grid",
        block: pixel.el,
        readout: () => `${this.#state().pixel}px`,
        modified: () => this.#state().pixel !== this.#base().pixel,
        reset: () => change({ pixel: this.#base().pixel }),
      }),
    ];
    this.#syncers.push(
      view.sync,
      dither.sync,
      colour.sync,
      levels.sync,
      pixel.sync,
      ...rows.map((built) => built.sync),
      () => {
        const state = this.#state();
        for (const swatch of swatches) {
          swatch.setAttribute("aria-pressed", String(swatch.dataset.value === state.accent));
          swatch.style.setProperty(
            "--swatch",
            swatch.dataset.value || sceneDefs[state.scene].accent,
          );
        }
        if (document.activeElement !== custom) custom.value = accentOf(state);
      },
    );
    const keys = SETTINGS.look;
    tagSettings(rows, keys);
    return this.#section({
      id: "look",
      title: "Look",
      blurb: "How the picture becomes dots: pattern, palette and resolution.",
      icon: "dither",
      open: false,
      content: rows.map((built) => built.el),
      summary: () => {
        const state = this.#state();
        return [
          DITHER_LABEL[state.dither],
          COLOR_LABEL[state.color],
          `${state.pixel}px`,
          state.view !== "dithered" ? VIEW_LABEL[state.view] : "",
        ].filter(Boolean);
      },
      modified: () => keys.some((key) => this.#state()[key] !== this.#base()[key]),
      reset: () => change(Object.fromEntries(keys.map((key) => [key, this.#base()[key]]))),
      syncers: this.#syncers,
    });
  }

  #motionGroup(): Section {
    const change = (patch: Record<string, string | number>, commit = true) =>
      this.#ctx.change(patch, commit);
    const motion = slider(
      "Motion",
      0,
      1,
      0.05,
      () => this.#state().motion,
      (value, commit) => change({ motion: value }, commit),
    );
    const follow = switchControl(
      "Follow mouse",
      () => this.#state().mouse === "follow",
      (on) => change({ mouse: on ? "follow" : "still" }),
    );
    const transitions = switchControl(
      "Scene transitions",
      () => this.#state().transitions === "on",
      (on) => change({ transitions: on ? "on" : "off" }),
    );
    const replay = nowButton("this scene's exit, then its entrance", () =>
      this.#ctx.renderer()?.replayPassage(),
    );
    const overlap = slider(
      "Overlap",
      0,
      1,
      0.05,
      () => this.#state().overlap,
      (value, commit) => change({ overlap: value }, commit),
    );
    const weave = slider(
      "Blend length",
      0.3,
      4,
      0.1,
      () => this.#state().weave,
      (value, commit) => change({ weave: value }, commit),
    );
    const blend = segments(
      "Blend pattern",
      [
        { label: "middle first", value: "bloom" },
        { label: "even fade", value: "fade" },
        { label: "sweep", value: "sweep" },
        { label: "grain", value: "grain" },
      ],
      () => this.#state().blend,
      (value) => change({ blend: value }),
    );
    const slowmo = segments(
      "Transition speed",
      [
        { label: "real time", value: "1" },
        { label: "2× slower", value: "2" },
        { label: "4× slower", value: "4" },
        { label: "8× slower", value: "8" },
      ],
      () => String(this.#state().slowmo),
      (value) => change({ slowmo: Number(value) }),
    );
    const play = h("button", { type: "button", class: "text-button wide" });
    play.addEventListener("click", () => {
      const renderer = this.#ctx.renderer();
      renderer?.setPaused(!renderer.paused);
      this.sync();
    });
    const rows = [
      row({
        label: "Amount",
        help: "Overall animation. 0 is a still frame; triggered events still play.",
        icon: "motion",
        block: motion.el,
        readout: () =>
          this.#state().motion === 0 ? "still" : `${Math.round(this.#state().motion * 100)}%`,
        modified: () => this.#state().motion !== this.#base().motion,
        reset: () => change({ motion: this.#base().motion }),
      }),
      row({
        label: "Follow mouse",
        help: "Tilt and parallax the scene gently toward the pointer.",
        icon: "pointer",
        inline: [follow.el],
        modified: () => this.#state().mouse !== this.#base().mouse,
        reset: () => change({ mouse: this.#base().mouse }),
      }),
      row({
        label: "Transitions",
        help: "Scenes come in and leave gracefully: many play their own entrance and exit (a camera settling, a fire catching, lanterns arriving), and the next scene takes over part-way through the leaving one's exit, dot by dot, while both still move. Off: a straight cut. Skipped at motion 0 and under reduced motion; now plays it anyway.",
        icon: "transition",
        inline: [replay, transitions.el],
        modified: () => this.#state().transitions !== this.#base().transitions,
        reset: () => change({ transitions: this.#base().transitions }),
      }),
      row({
        label: "Overlap",
        help: "How much of the leaving scene's exit the next scene's entrance overlaps. While they overlap both scenes move, the next one taking over cell by cell. 0 waits for the whole exit; 1 enters as the exit begins. Try it with now above.",
        icon: "transition",
        block: overlap.el,
        readout: () => `${Math.round(this.#state().overlap * 100)}%`,
        modified: () => this.#state().overlap !== this.#base().overlap,
        reset: () => change({ overlap: this.#base().overlap }),
      }),
      row({
        label: "Blend length",
        help: "Seconds the next scene takes to take over the whole screen from the leaving one.",
        icon: "clock",
        block: weave.el,
        readout: () => `${this.#state().weave.toFixed(1)} s`,
        modified: () => this.#state().weave !== this.#base().weave,
        reset: () => change({ weave: this.#base().weave }),
      }),
      row({
        label: "Blend pattern",
        help: "The order in which dots change over: from the middle outward, evenly everywhere, sweeping in from the left, or in coarse grains.",
        icon: "dither",
        block: blend.el,
        modified: () => this.#state().blend !== this.#base().blend,
        reset: () => change({ blend: this.#base().blend }),
      }),
      row({
        label: "Transition speed",
        help: "Play transitions slower to study them: entrances, exits and the blend between them slow down, the scenes themselves do not.",
        icon: "motion",
        block: slowmo.el,
        modified: () => this.#state().slowmo !== this.#base().slowmo,
        reset: () => change({ slowmo: this.#base().slowmo }),
      }),
      row({
        label: "Clock",
        help: "Freeze time to study a frame (p). Unlike motion 0, a paused frame keeps its current pose.",
        icon: "clock",
        block: play,
      }),
    ];
    // Overlap, blend length, pattern and speed tune transitions: shown only while they are on.
    const tuning = rows.slice(3, 7);
    const keys = SETTINGS.motion;
    tagSettings(rows, keys);
    const playIcon = icon("play");
    const pauseIcon = icon("pause");
    const playLabel = h("span");
    play.append(playIcon, pauseIcon, playLabel);
    this.#syncers.push(
      motion.sync,
      follow.sync,
      transitions.sync,
      overlap.sync,
      weave.sync,
      blend.sync,
      slowmo.sync,
      ...rows.map((built) => built.sync),
      () => {
        const paused = this.#ctx.renderer()?.paused ?? false;
        playIcon.style.display = paused ? "" : "none";
        pauseIcon.style.display = paused ? "none" : "";
        playLabel.textContent = paused ? "Play" : "Pause";
        for (const built of tuning) built.el.hidden = this.#state().transitions !== "on";
      },
    );
    return this.#section({
      id: "motion",
      title: "Motion",
      blurb: "How much things move, whether the scene follows you, and how scenes come and go.",
      icon: "motion",
      open: false,
      content: rows.map((built) => built.el),
      summary: () => {
        const state = this.#state();
        return [
          this.#ctx.renderer()?.paused
            ? "paused"
            : state.motion === 0
              ? "still"
              : `${Math.round(state.motion * 100)}%`,
          state.mouse === "follow" ? "follows mouse" : "fixed camera",
          state.transitions === "on" ? "" : "cuts",
        ].filter(Boolean);
      },
      modified: () => keys.some((key) => this.#state()[key] !== this.#base()[key]),
      reset: () => change(Object.fromEntries(keys.map((key) => [key, this.#base()[key]]))),
      syncers: this.#syncers,
    });
  }

  #pageGroup(): Section {
    const change = (patch: Record<string, string | number>, commit = true) =>
      this.#ctx.change(patch, commit);
    const page = segments(
      "Page on top",
      modeIds.map((id) => ({ label: MODE_LABEL[id], value: id })),
      () => this.#state().mode,
      (mode) => change({ mode }),
    );
    const nameInput = h("input", {
      type: "text",
      maxLength: 40,
      spellcheck: false,
      "aria-label": "Instance name",
    });
    nameInput.addEventListener("input", () => change({ instance: nameInput.value }, false));
    const nameRow = row({
      label: "Instance name",
      help: "Shown on the sign-in card of a private instance.",
      block: nameInput,
    });
    const nameReveal = reveal(nameRow.el, () => this.#state().mode === "instance");
    const dim = slider(
      "Dim background",
      0,
      1,
      0.05,
      () => this.#state().dim,
      (value, commit) => change({ dim: value }, commit),
    );
    const blur = slider(
      "Blur background",
      0,
      1,
      0.05,
      () => this.#state().blur,
      (value, commit) => change({ blur: value }, commit),
    );
    const rows = [
      row({
        label: "Page on top",
        help: "Landing: the public introduction. Loading: what shows while the app boots. Sign-in: the face of a private instance. None: the scene alone (h toggles this).",
        icon: "page",
        block: page.el,
        modified: () => this.#state().mode !== this.#base().mode,
        reset: () => change({ mode: this.#base().mode }),
      }),
      row({
        label: "Dim background",
        help: "Darken the scene behind the page, to judge whether the copy needs help to stand out.",
        icon: "tones",
        block: dim.el,
        readout: () => `${Math.round(this.#state().dim * 100)}%`,
        modified: () => this.#state().dim !== 0,
        reset: () => change({ dim: 0 }),
      }),
      row({
        label: "Blur background",
        help: "Soften the scene behind the page so the copy is the only sharp thing on screen.",
        icon: "fog",
        block: blur.el,
        readout: () => `${Math.round(this.#state().blur * 12)}px`,
        modified: () => this.#state().blur !== 0,
        reset: () => change({ blur: 0 }),
      }),
    ];
    this.#syncers.push(
      page.sync,
      nameRow.sync,
      nameReveal.sync,
      dim.sync,
      blur.sync,
      ...rows.map((built) => built.sync),
      () => {
        if (document.activeElement !== nameInput) nameInput.value = this.#state().instance;
      },
    );
    const keys = SETTINGS.page;
    tagSettings(rows, keys);
    const [pageRow, ...rest] = rows;
    return this.#section({
      id: "page",
      title: "Page",
      blurb: "What sits on top of the picture, and how the picture sits behind it.",
      icon: "page",
      open: false,
      content: [pageRow?.el, nameReveal.el, ...rest.map((built) => built.el)].filter(
        (el): el is HTMLElement => el !== undefined,
      ),
      summary: () => {
        const state = this.#state();
        return [
          MODE_LABEL[state.mode],
          state.dim > 0 ? `dim ${Math.round(state.dim * 100)}%` : "",
          state.blur > 0 ? "blurred" : "",
        ].filter(Boolean);
      },
      modified: () => keys.some((key) => this.#state()[key] !== this.#base()[key]),
      reset: () => change(Object.fromEntries(keys.map((key) => [key, this.#base()[key]]))),
      syncers: this.#syncers,
    });
  }
}
