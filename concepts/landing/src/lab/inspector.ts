// The lab panel's Controls view: the scene's knob groups, the shared world's first on a World shelf
// (with its "keep the world" switch, world.ts), then the global Look, Motion and Page groups, each
// a collapsible section under an icon heading, with a rail of the same icons to jump between them
// (a dot on a group with changes), a search that narrows every group to the controls that match, a
// lens that narrows them to what differs from the defaults (and resets it) and a button that folds
// or opens them all. A group's knobs are laid out by their metadata: the sky dial, mix bars and
// pads where a knob names one (`ParamDef.widget`), its switches as icon chips, everything else as
// rows; a scene's planets (SceneDef.planets) stand in their group's Night sky section, and the lens,
// a group's reset and its dice take the list as one more of that group's knobs. A composed scene's
// layer switches make its Layers section (layers.ts), and each layer's groups (Blurb.layer) stand
// after it in role order, shown while the layer is switched on. A control that hangs on a switch
// (`when`, to any depth; a global setting's on another setting) is a gate (dom.ts): after every
// sync this view alone decides which controls and groups show, from one availability model
// (availability-model.ts) that the lens, the search, the folds and the summaries share. A change the
// lens counts behind a switch that is off shows dormant, dimmed beside that switch, never folded
// away; folded groups and closed controls leave the tab order (inert). The compact bar (menu.ts)
// shows the same view and sections: its Find chip borrows the whole view (search, lens and rail,
// narrowing as in the panel), and a section's chip its section (a layer's chip all of its layer's
// sections: `lend`), which shows open and whole, nothing narrowing it, until given back; so both
// presentations share these controls and their syncs. Under a search, "Reset what changed"
// restores only the changes the search shows.
import { formatValue, MAX_SEED, type Option, type ParamDef } from "../params.ts";
import { colorIds, ditherIds, viewIds } from "../renderer.ts";
import { sceneDefs, type SceneId } from "../scenes/index.ts";
import { encodePlanets, PLANETS_KEY, type SkyPlanets } from "../scenes/planets.ts";
import {
  accentOf,
  defaultsFor,
  modeIds,
  paramDefaults,
  type LabState,
  type Params,
} from "../state.ts";
import { skyAnchor } from "../world-clock.ts";
import { almanacParts, gatherAlmanac } from "./almanac-model.ts";
import {
  groupShows,
  narrow,
  narrowing,
  shownChanges,
  titleHolds,
  type LensGate,
  type LensQuery,
  type NarrowItem,
} from "./availability-model.ts";
import { chipGrid } from "./chips.ts";
import { climateMarks } from "./climate-hint-model.ts";
import { dice, iconButton, nowButton, row, segments, slider, switchControl } from "./controls.ts";
import { seasonWheel, skyDial, type SkyParts } from "./dial.ts";
import {
  borrow,
  dependent,
  h,
  isLive,
  setAttr,
  setHidden,
  setOpen,
  setStyle,
  setText,
  showGate,
  type Built,
  type LabContext,
  type Patch,
} from "./dom.ts";
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
import { changedCounts, changedKnobs, changedSettings, type LensGroup } from "./lens-model.ts";
import { layersSection } from "./layers.ts";
import { layerGroupOrder } from "./layers-model.ts";
import { mixBar } from "./mix.ts";
import type { MixPart } from "./mix-model.ts";
import { compassPad, directionPad, positionPad, type Strength } from "./pads.ts";
import { Rail, type RailEntry } from "./rail.ts";
import { worldDivider } from "./world.ts";
import { shelves } from "./world-model.ts";
import { recipeStrip } from "./recipes.ts";
import { shownRecipes } from "./recipes-model.ts";
import { nightSection } from "./nightsky.ts";
import { nightParts } from "./nightsky-model.ts";
import { rollPlanets } from "./planets-model.ts";
import { rollPatch } from "./roll-model.ts";

export const MODE_LABEL: Record<(typeof modeIds)[number], string> = {
  landing: "Landing",
  loading: "Loading",
  instance: "Sign-in",
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
  look: ["view", "dither", "color", "accent", "levels", "pixel", "dim", "blur"],
  motion: [
    "motion",
    "mouse",
    "agents",
    "rest",
    "transitions",
    "overlap",
    "weave",
    "blend",
    "slowmo",
  ],
  page: ["mode", "instance"],
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

/** Where a section stands in the Controls order: on the World shelf, the scene's own, or Global. */
export type Shelf = "world" | "scene" | "global";

/**
 * The layer of a composed scene a section belongs to (Blurb.layer): the panel shows its sections
 * while it is switched on, and the compact bar gives them one chip, its own.
 */
export interface MenuLayer {
  id: string;
  /** Its chip's id: unique among the sections'. */
  key: string;
  title: string;
  icon: IconName;
  on(): boolean;
}

/** A section as the compact bar shows it: a chip, which opens the section itself (`lend`). */
export interface MenuSection {
  id: string;
  title: string;
  icon: IconName;
  shelf: Shelf;
  /** Its master switch, on or off; undefined without one. */
  on(): boolean | undefined;
  layer?: MenuLayer;
}

interface Section extends MenuSection {
  el: HTMLElement;
  toggle: HTMLButtonElement;
  open(): void;
  /** Reflect the setup into the heading and open or fold the body (open while `searching`). */
  sync(searching: boolean): void;
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
  /** Where nothing shows: what the search or the lens found nothing for (set by #narrow). */
  readonly #empty = h("p", { class: "lab-empty" });
  readonly #syncers: (() => void)[] = [];
  #sceneSyncers: (() => void)[] = [];
  #sceneSections: Section[] = [];
  readonly #globalSections: Section[] = [];
  #built: SceneId | undefined;
  /** The fold button: folds every group while every one is open, else opens them all. */
  readonly #fold: HTMLButtonElement;
  /** Whether every group was open as the fold button last showed it. */
  #allShown: boolean | undefined;
  /** Which groups showed and were open, as the rail last marked them. */
  #layout = "";
  /** The "changed" lens: while on, every group narrows to what differs from the defaults. */
  #lens = false;
  readonly #lensToggle: HTMLButtonElement;
  readonly #lensCount = h("span", { class: "lens-count" });
  /** Over the groups while the lens is on and something changed: its "reset what changed". */
  readonly #lensHead: HTMLElement;
  readonly #lensCaption = h("span", { class: "lens-caption" });
  readonly #lensReset: HTMLButtonElement;
  readonly #lensResetLabel = h("span");
  /** The URL keys that differ from their defaults: the scene's knobs and the global settings. */
  #changed: ReadonlySet<string> = new Set();
  /** Of those, the ones the controls on show hold (set by #narrow): a search's reset takes these. */
  #shownChanged: ReadonlySet<string> = new Set();
  /** The scene's knob defaults, and every group as the lens counts it (the global ones last). */
  #defaults: Params = {};
  #lensGroups: LensGroup[] = [];
  /** How many knobs of each group differ from their defaults, by section id (the lens's count). */
  #counts: ReadonlyMap<string, number> = new Map();
  /** Every section in the Controls order; a new list each time the scene's are built. */
  #menu: readonly Section[] = [];
  /** The sections the compact bar has borrowed, and how to put each back where it stood. */
  #lent: { sections: readonly Section[]; back: readonly (() => void)[] } | undefined;
  /** A sync left the controls as they were (off screen): they catch up as they come back. */
  #stale = false;

  /** `leaveSearch`: Escape left the search, cleared (the lab may hand the keyboard elsewhere). */
  constructor(ctx: LabContext, prefs: SectionPrefs, leaveSearch: () => void) {
    this.#ctx = ctx;
    this.#prefs = prefs;
    this.#search = h("input", {
      type: "search",
      placeholder: "Find a control…",
      "aria-label": "Find a control",
      spellcheck: false,
    });
    this.#search.addEventListener("input", () => this.#narrow());
    this.#search.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      this.#search.value = "";
      this.#narrow();
      this.#search.blur();
      leaveSearch();
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
    this.#menu = [...this.#globalSections];
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
    this.#lensReset = h(
      "button",
      { type: "button", class: "text-button" },
      icon("reset"),
      this.#lensResetLabel,
    );
    this.#lensReset.addEventListener("click", () => {
      this.#resetChanged();
      this.#lensToggle.focus();
    });
    this.#lensHead = h(
      "div",
      { class: "lens-head", hidden: true },
      this.#lensCaption,
      this.#lensReset,
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

  /** The view came on screen: it catches up on the syncs it missed while away. */
  shown(): void {
    if (this.#stale) this.sync();
    this.#rail.spy();
  }

  /** The sections in the Controls order (World shelf, the scene's, Global), for the compact bar. */
  get menu(): readonly MenuSection[] {
    return this.#menu;
  }

  /** How many knobs of section `id` differ from their defaults, as the lens counts them. */
  changes(id: string): number {
    return this.#counts.get(id) ?? 0;
  }

  /**
   * Lend sections `ids` to the compact bar's popover (menu.ts), giving back any others first: their
   * own elements, in order, taken from where they stand, open whatever their fold, their toggles
   * plain headings, until `giveBack`; they catch up on the syncs the controls missed off screen.
   * Empty for no such sections.
   */
  lend(ids: readonly string[]): HTMLElement[] {
    this.giveBack();
    const sections = ids.flatMap((id) => this.#menu.filter((candidate) => candidate.id === id));
    if (sections.length === 0) return [];
    this.#lent = { sections, back: sections.map((section) => borrow(section.el)) };
    if (this.#stale) this.sync();
    else this.#narrow();
    return sections.map((section) => section.el);
  }

  /** Put the lent sections back where they stood, folded or open as before. */
  giveBack(): void {
    const lent = this.#lent;
    if (!lent) return;
    this.#lent = undefined;
    for (const back of lent.back) back();
    this.#narrow();
  }

  /**
   * Reflect the setup into every control, then decide once what shows (#narrow): a sync that
   * changes nothing writes nothing. Off screen (`onScreen` false, the Controls view not showing,
   * and no section lent to the bar) only the lens counts, which the bar's chips read; the controls
   * wait to catch up as they come back (`shown`, `lend`).
   */
  sync(onScreen = true): void {
    const { scene } = this.#ctx.current().state;
    if (this.#built !== scene) this.#build(scene);
    this.#stale = !onScreen && this.#lent === undefined;
    if (this.#stale) {
      this.#syncLens();
      return;
    }
    for (const sync of this.#syncers) sync();
    for (const sync of this.#sceneSyncers) sync();
    this.#syncLens();
    this.#narrow();
  }

  /**
   * Find what differs from the defaults: the lens's count and head, and the rail's dots. A scene's
   * planets differ while it has any (PLANETS_KEY, one knob of their group). A knob counts whether
   * or not its switch is on: the lens shows it dormant beside that switch.
   */
  #syncLens(): void {
    const { state, params, planets } = this.#ctx.current();
    this.#changed = new Set([
      ...changedKnobs(sceneDefs[state.scene].params, params, this.#defaults),
      ...changedSettings(SETTING_KEYS, state, this.#base()),
      ...(planets.length > 0 ? [PLANETS_KEY] : []),
    ]);
    const counts = changedCounts(this.#lensGroups, this.#changed);
    this.#counts = counts;
    this.#rail.mark(counts);
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    setText(this.#lensCount, total > 0 ? `${total} changed` : "");
    const label = `Only what changed (${total > 0 ? `${total} changed` : "nothing yet"})`;
    setAttr(
      this.#lensToggle,
      "title",
      `${label}: narrow every group to the controls that differ from this scene's defaults`,
    );
    setAttr(this.#lensToggle, "aria-label", label);
    setAttr(this.#lensToggle, "aria-pressed", String(this.#lens));
  }

  /**
   * Every knob of the scene and global setting that differs from its default back to it, and its
   * planets gone, in one undoable change; under a search, only the changes it shows (#narrow).
   */
  #resetChanged(): void {
    const keys = this.#search.value.trim() === "" ? this.#changed : this.#shownChanged;
    const base = this.#base();
    const patch: Patch = {};
    for (const [key, value] of Object.entries(this.#defaults))
      if (keys.has(key)) patch[key] = value;
    for (const key of SETTING_KEYS) if (keys.has(key)) patch[key] = base[key];
    if (keys.has(PLANETS_KEY)) patch[PLANETS_KEY] = "";
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
    shelf: Shelf;
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
    layer?: MenuLayer;
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
    const offNote = spec.offNote
      ? h("p", { class: "group-off", hidden: true }, spec.offNote)
      : null;
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
    return {
      id: spec.id,
      title: spec.title,
      icon: spec.icon,
      shelf: spec.shelf,
      on: () => spec.masterOn?.(),
      ...(spec.layer === undefined ? {} : { layer: spec.layer }),
      el,
      toggle,
      open: () => {
        this.#prefs.sections[spec.id] = true;
        this.#prefs.save();
      },
      sync: (searching) => {
        // Lent to the compact bar, it shows open, its toggle a plain heading that folds nothing;
        // the popover's own heading (popover.ts) names it to assistive technology instead.
        const lent = this.#lent?.sections.some((section) => section.id === spec.id) === true;
        const open = isOpen() || searching || lent;
        // Folded, the body leaves the tab order; the focus it held goes to the header.
        setOpen(body, open, toggle);
        el.classList.toggle("is-open", isOpen());
        el.classList.toggle("lent", lent);
        if (toggle.disabled !== lent) toggle.disabled = lent;
        if (lent) setAttr(toggle, "aria-hidden", "true");
        else if (toggle.hasAttribute("aria-hidden")) toggle.removeAttribute("aria-hidden");
        setAttr(toggle, "aria-expanded", String(open));
        const on = spec.masterOn?.() ?? true;
        el.classList.toggle("off", !on);
        if (offNote) setHidden(offNote, on);
        spec.master?.sync();
        setHidden(reset, !(spec.modified?.() ?? false));
        setText(summary, open ? "" : spec.summary().join(" · "));
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

  /**
   * Decide what shows, from one availability model (availability-model.ts narrow): in each group,
   * the controls the search and, while it is on, the lens find (with the switches a dormant one
   * waits on), each gate open, dormant or closed, and the group shown or not, open or folded; then
   * the lens's head, the note for nothing found and the fold button. The rail marks again when a
   * group shows, hides, opens or folds. While a section is lent to the compact bar the search and
   * the lens wait: it shows whole.
   */
  #narrow(): void {
    const whole = this.#lent !== undefined;
    const text = whole ? "" : this.#search.value.trim().toLowerCase();
    const query: LensQuery = { text, lens: this.#lens && !whole, changed: this.#changed };
    const filtering = narrowing(query);
    this.el.classList.toggle("searching", filtering);
    let any = false;
    let layout = "";
    const shown = new Set<string>();
    for (const section of [...this.#sceneSections, ...this.#globalSections]) {
      const { el } = section;
      const titleHit = titleHolds(section.title.toLowerCase(), query);
      const items = [...el.querySelectorAll<HTMLElement>("[data-search]")];
      const gates = [...el.querySelectorAll<HTMLElement>("[data-when]")];
      const gateAt = new Map<Element, number>(gates.map((gate, at) => [gate, at]));
      const narrowItems = items.map((item): NarrowItem => {
        const standsIn: number[] = [];
        for (let up: Element | null = item; up && up !== el; up = up.parentElement) {
          const at = gateAt.get(up);
          if (at !== undefined) standsIn.push(at);
        }
        return {
          search: item.dataset.search ?? "",
          // A control's knobs are its own, else those of the widget it stands in.
          keys: (item.closest<HTMLElement>("[data-keys]")?.dataset.keys ?? "").split(" "),
          held: item.contains(document.activeElement),
          gates: standsIn,
        };
      });
      const lensGates = gates.map((gate): LensGate => ({
        chain: (gate.dataset.when ?? "").split(" ").filter((key) => key !== ""),
        live: isLive(gate),
      }));
      const narrowed = narrow(narrowItems, lensGates, titleHit, query);
      items.forEach((item, at) => item.classList.toggle("no-match", narrowed.found[at] !== true));
      gates.forEach((gate, at) => showGate(gate, narrowed.gates[at] ?? "closed", section.toggle));
      // A layer's sections show while it is switched on, unless the search or the lens finds them.
      const visible =
        groupShows(narrowed.shown, titleHit, query) && (filtering || section.layer?.on() !== false);
      setHidden(el, !visible);
      el.classList.toggle("searching", filtering && visible);
      section.sync(filtering && visible);
      if (visible) {
        any = true;
        for (const key of shownChanges(narrowItems, narrowed, this.#changed)) shown.add(key);
      }
      layout += `${visible ? 1 : 0}${el.classList.contains("is-open") ? 1 : 0}`;
    }
    this.#shownChanged = shown;
    // Under the lens with something to reset: all of it, or under a search only what it shows.
    const searching = query.text !== "";
    setHidden(this.#lensHead, !query.lens || (searching ? shown : this.#changed).size === 0);
    setText(this.#lensCaption, searching ? "Changed, and found" : "Changed from defaults");
    setText(this.#lensResetLabel, searching ? "Reset these" : "Reset what changed");
    setAttr(
      this.#lensReset,
      "title",
      searching
        ? "The changed controls this search shows back to their defaults, in one step (undo brings them back); what it hides stays as it is"
        : "Every changed control back to its default, in one step (undo brings them back)",
    );
    setHidden(this.#empty, any);
    setText(
      this.#empty,
      !query.lens
        ? "Nothing matches. Try another word, or press Esc."
        : query.changed.size === 0
          ? "Nothing has changed: every control is at this scene's default."
          : "Nothing changed matches. Try another word, or press Esc.",
    );
    const all = this.#allOpen();
    if (all !== this.#allShown) {
      this.#allShown = all;
      this.#fold.replaceChildren(icon(all ? "fold" : "unfold"));
      const label = all ? "Fold every group" : "Open every group";
      setAttr(this.#fold, "title", label);
      setAttr(this.#fold, "aria-label", label);
    }
    if (`${filtering}${layout}` !== this.#layout) {
      this.#layout = `${filtering}${layout}`;
      this.#rail.spy();
    }
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
    const planets = sceneDefs[scene].planets;
    this.#lensGroups = [
      ...[...groups].map(([group, list]) => ({
        id: `${scene}:${group}`,
        knobs: [...list.map(knobKeys), ...(planets?.group === group ? [[PLANETS_KEY]] : [])],
      })),
      ...SETTING_GROUPS,
    ];
    const { world, own: sceneOwn } = shelves(sceneDefs[scene]);
    // A composed scene's layers: their sections after the scene's other groups, in role order.
    const layers = sceneDefs[scene].layers;
    const layerOf = (group: string) => sceneDefs[scene].groups[group]?.layer;
    const own = layers ? layerGroupOrder(sceneOwn, layerOf, layers) : sceneOwn;
    const menuLayers = new Map(
      (layers?.offered ?? []).map((layer): [string, MenuLayer] => {
        const def = knobs.def(layer.id);
        return [
          layer.id,
          {
            id: layer.id,
            key: `${scene}:layer:${layer.id}`,
            title: layer.title,
            icon: def ? knobIcon(def) : "layers",
            on: () => knobs.on(layer.id),
          },
        ];
      }),
    );
    const section = (shelf: Shelf) => (group: string) =>
      this.#sceneGroup(
        scene,
        knobs,
        group,
        groups.get(group) ?? [],
        group === defs[0]?.group,
        shelf,
        menuLayers.get(layerOf(group) ?? ""),
      );
    const worldSections = world.filter((group) => groups.has(group)).map(section("world"));
    const ownSections = own.filter((group) => groups.has(group)).map(section("scene"));
    this.#sceneSections = [...worldSections, ...ownSections];
    this.#menu = [...this.#sceneSections, ...this.#globalSections];
    // A lent section of the scene left is gone with it: the bar closes its popover (menu.ts).
    if (this.#lent?.sections.some((lent) => !this.#globalSections.includes(lent)) === true)
      this.#lent = undefined;
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
    shelf: Shelf,
    layer: MenuLayer | undefined,
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
      const sky: SkyParts = {
        time,
        cycle,
        moon: undefined,
        stars: undefined,
        anchor: skyAnchor(sceneDefs[scene].params),
      };
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

    // The Night sky section, at its first part (or the group's first knob, for planets alone),
    // with the scene's planets where they are this group's: ahead of the pads, so it holds its own.
    // "See it at night" sets the scene's own clock.
    const planets: SkyPlanets | undefined =
      sceneDefs[scene].planets?.group === group ? sceneDefs[scene].planets : undefined;
    const night = nightParts(defs.filter((def) => !used.has(def)));
    const firstNight =
      defs.find((def) => night.some((part) => part.def === def)) ?? (planets ? defs[0] : undefined);
    if (firstNight) {
      const clock = sceneDefs[scene].params.find(
        (def): def is RangeDef =>
          def.kind === "range" && def.widget?.kind === "sky" && def.widget.part === "time",
      );
      const cycle = sceneDefs[scene].params.find(
        (def): def is FeatureDef =>
          def.kind === "feature" && def.widget?.kind === "sky" && def.widget.part === "cycle",
      );
      place(
        firstNight,
        nightSection(knobs, night, clock && { time: clock, cycle }, {
          row: (rowKnobs, def) => this.#knobRow(rowKnobs, def),
          ...(planets ? { planets: { spec: planets, ctx: this.#ctx } } : {}),
        }),
      );
      for (const part of night) used.add(part.def);
    }

    // The Layers section, at its first switch: a composed scene's layer switches, by role.
    const layers = sceneDefs[scene].layers;
    const layerSwitches = defs.filter(
      (def): def is SwitchDef =>
        (def.kind === "toggle" || def.kind === "feature") && def.widget?.kind === "layer",
    );
    const firstLayer = layerSwitches[0];
    if (layers && firstLayer) {
      place(firstLayer, holding(layersSection(knobs, layers, layerSwitches), layerSwitches));
      for (const def of layerSwitches) used.add(def);
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
    const chips = switches.length > 0 ? chipGrid(knobs, switches, { marks }) : undefined;
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
      // Where the time of day itself hangs on a switch, the whole dial is its gate.
      const when = time?.when;
      content.push(
        when === undefined
          ? dial.el
          : dependent(dial.el, knobs.chain(when), () => knobs.live(when)),
      );
      syncers.push(dial.sync);
    }
    if (chips) {
      content.push(chips.grid.el, chips.amounts.el);
      syncers.push(chips.grid.sync, chips.amounts.sync);
    }
    for (const { built, when } of items.sort((a, b) => a.at - b.at)) {
      syncers.push(built.sync);
      content.push(
        when === undefined
          ? built.el
          : dependent(built.el, knobs.chain(when), () => knobs.live(when)),
      );
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
      shelf,
      icon: info.icon ?? iconFromWords(group, info.title) ?? "sliders",
      open,
      content,
      summary: () => {
        const count = planets ? this.#ctx.current().planets.length : 0;
        return [
          ...this.#groupSummary(knobs, defs, master),
          ...(count > 0 ? [`${count} planet${count === 1 ? "" : "s"}`] : []),
        ];
      },
      ...(masterSwitch ? { master: masterSwitch } : {}),
      ...(master
        ? {
            masterOn: () => knobs.on(master.key),
            offNote: `Switch on to shape the ${info.title.toLowerCase()}.`,
          }
        : {}),
      modified: () =>
        knobs.modified(keys) || (planets !== undefined && this.#ctx.current().planets.length > 0),
      reset: () => knobs.reset(keys, planets ? { [PLANETS_KEY]: "" } : {}),
      ...(defs.some((def) => !def.steady)
        ? {
            roll: () =>
              knobs.set(
                planets
                  ? {
                      ...rollPatch(defs),
                      [PLANETS_KEY]: encodePlanets(planets, rollPlanets(planets)),
                    }
                  : rollPatch(defs),
                true,
              ),
          }
        : {}),
      ...(layer === undefined ? {} : { layer }),
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

  /** A folded group in words: what of it takes effect (a knob whose switches are off says nothing). */
  #groupSummary(knobs: Knobs, defs: readonly ParamDef[], master: SwitchDef | undefined): string[] {
    if (master && !knobs.on(master.key)) return ["off"];
    const parts: string[] = [];
    for (const def of defs) {
      if (def === master && def.kind !== "feature") continue;
      if (!knobs.live(def.when)) continue;
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

  /**
   * The Look: everything that decides how the picture reaches the screen, in one place: the view,
   * the dither, its colours and tones, the cell size, and the dim and blur behind the page.
   */
  #lookGroup(): Section {
    const change = (patch: Record<string, string | number>, commit = true) =>
      this.#ctx.change(patch, commit);
    const percent = (value: number) => `${Math.round(value * 100)}%`;
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
      (value) => `${value} tones`,
    );
    // In halves of a CSS pixel: the display rounds a cell to whole device pixels (display.ts
    // stageCells), so on a high-density screen a half is a size of its own.
    const pixel = slider(
      "Cell size",
      1,
      8,
      0.5,
      () => this.#state().pixel,
      (value, commit) => change({ pixel: value }, commit),
      (value) => `${value} pixels`,
    );
    const dim = slider(
      "Dim",
      0,
      1,
      0.01,
      () => this.#state().dim,
      (value, commit) => change({ dim: value }, commit),
      percent,
    );
    const blurText = (value: number) => `${(value * 12).toFixed(1)} px`;
    const blur = slider(
      "Blur",
      0,
      1,
      0.01,
      () => this.#state().blur,
      (value, commit) => change({ blur: value }, commit),
      blurText,
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
        help: "The single accent colour. The first swatch follows the scene's own default; the last picks any colour.",
        icon: "drop",
        block: h("div", { class: "swatches" }, ...swatches, custom),
        readout: () => this.#state().accent || "scene's",
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
        label: "Cell size",
        help: "Size of one dither cell in screen pixels, in halves: the screen draws a cell in whole device pixels, so halves tell on a high-density screen. Larger is chunkier and cheaper to draw.",
        icon: "grid",
        block: pixel.el,
        readout: () => `${this.#state().pixel} px`,
        modified: () => this.#state().pixel !== this.#base().pixel,
        reset: () => change({ pixel: this.#base().pixel }),
      }),
      row({
        label: "Dim",
        help: "Darken the picture behind the page, to judge whether the copy needs help to stand out.",
        icon: "tones",
        block: dim.el,
        readout: () => percent(this.#state().dim),
        modified: () => this.#state().dim !== this.#base().dim,
        reset: () => change({ dim: this.#base().dim }),
      }),
      row({
        label: "Blur",
        help: "Soften the picture behind the page, so the copy is the only sharp thing on screen.",
        icon: "fog",
        block: blur.el,
        readout: () => blurText(this.#state().blur),
        modified: () => this.#state().blur !== this.#base().blur,
        reset: () => change({ blur: this.#base().blur }),
      }),
    ];
    this.#syncers.push(
      view.sync,
      dither.sync,
      colour.sync,
      levels.sync,
      pixel.sync,
      dim.sync,
      blur.sync,
      ...rows.map((built) => built.sync),
      () => {
        const state = this.#state();
        for (const swatch of swatches) {
          setAttr(swatch, "aria-pressed", String(swatch.dataset.value === state.accent));
          setStyle(swatch, "--swatch", swatch.dataset.value || sceneDefs[state.scene].accent);
        }
        const accent = accentOf(state);
        if (document.activeElement !== custom && custom.value !== accent) custom.value = accent;
      },
    );
    const keys = SETTINGS.look;
    tagSettings(rows, keys);
    return this.#section({
      id: "look",
      title: "Look",
      blurb:
        "How the picture becomes dots: view, pattern, palette, tones and cell size, and how it sits behind the page.",
      icon: "dither",
      shelf: "global",
      open: false,
      content: rows.map((built) => built.el),
      summary: () => {
        const state = this.#state();
        return [
          DITHER_LABEL[state.dither],
          COLOR_LABEL[state.color],
          `${state.pixel} px`,
          state.view !== "dithered" ? VIEW_LABEL[state.view] : "",
          state.dim > 0 ? `dim ${percent(state.dim)}` : "",
          state.blur > 0 ? "blurred" : "",
        ].filter(Boolean);
      },
      modified: () => keys.some((key) => this.#state()[key] !== this.#base()[key]),
      reset: () => change(Object.fromEntries(keys.map((key) => [key, this.#base()[key]]))),
    });
  }

  /**
   * Motion: how much things move, whether the scene follows the pointer, who moves in it beside
   * you, and how scenes come and go; its only home (pausing the clock is the tools' play button,
   * `p`).
   */
  #motionGroup(): Section {
    const change = (patch: Record<string, string | number>, commit = true) =>
      this.#ctx.change(patch, commit);
    const amount = (value: number) => (value === 0 ? "still" : `${Math.round(value * 100)}%`);
    const motion = slider(
      "Motion",
      0,
      1,
      0.01,
      () => this.#state().motion,
      (value, commit) => change({ motion: value }, commit),
      amount,
    );
    const follow = switchControl(
      "Follow mouse",
      () => this.#state().mouse === "follow",
      (on) => change({ mouse: on ? "follow" : "still" }),
    );
    const agents = segments(
      "Agents",
      [
        { label: "none", value: "0" },
        { label: "one", value: "1" },
        { label: "two", value: "2" },
        { label: "three", value: "3" },
      ],
      () => String(this.#state().agents),
      (value) => change({ agents: Number(value) }),
    );
    const rest = segments(
      "At rest",
      [
        { label: "Full rate", value: "full" },
        { label: "Half rate (saves battery)", value: "half" },
      ],
      () => this.#state().rest,
      (value) => change({ rest: value }),
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
    const rows = [
      row({
        label: "Amount",
        help: "How much things move. 0 is a still frame; triggered events still play. To freeze a frame in its current pose, pause (p).",
        icon: "motion",
        block: motion.el,
        readout: () => amount(this.#state().motion),
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
        label: "Agents",
        help: "Others in the scene beside you: agents who wander, go to what can be done here, pause, act and move on, each drawn as a small ring of the scene's accent trailing where it came from. The scene answers their hands as it answers yours.",
        icon: "pointer",
        block: agents.el,
        modified: () => this.#state().agents !== this.#base().agents,
        reset: () => change({ agents: this.#base().agents }),
      }),
      row({
        label: "At rest",
        help: "How often a moving scene draws while nothing is touched: the full rate, about 60 frames a second, or half of it, which saves battery. A press, a key, the wheel or the pointer over the page or the lab, a passage and an entrance draw at the full rate either way, and a picture that stands still draws nothing.",
        icon: "clock",
        block: rest.el,
        modified: () => this.#state().rest !== this.#base().rest,
        reset: () => change({ rest: this.#base().rest }),
      }),
      row({
        label: "Transitions",
        help: "Scenes come in and leave gracefully: many play their own entrance and exit (a camera settling, a fire catching, lanterns arriving), and the next scene takes over part-way through the leaving one's exit, dot by dot, while both still move. Off: a straight cut. Skipped at motion 0 and under reduced motion; now plays this scene's exit, then its entrance, anyway.",
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
    ];
    // Overlap, blend length, pattern and speed tune transitions: gates on the Transitions setting.
    const tuning = new Set(rows.slice(5));
    const passing = () => this.#state().transitions === "on";
    const keys = SETTINGS.motion;
    tagSettings(rows, keys);
    this.#syncers.push(
      motion.sync,
      follow.sync,
      agents.sync,
      rest.sync,
      transitions.sync,
      overlap.sync,
      weave.sync,
      blend.sync,
      slowmo.sync,
      ...rows.map((built) => built.sync),
    );
    return this.#section({
      id: "motion",
      title: "Motion",
      blurb:
        "How much things move, whether the scene follows you, who is here with you, how often it draws at rest, and how scenes come and go.",
      icon: "motion",
      shelf: "global",
      open: false,
      content: rows.map((built) =>
        tuning.has(built) ? dependent(built.el, ["transitions"], passing) : built.el,
      ),
      summary: () => {
        const state = this.#state();
        return [
          this.#ctx.renderer()?.paused ? "paused" : amount(state.motion),
          state.mouse === "follow" ? "follows mouse" : "fixed camera",
          state.agents > 0 ? `${state.agents} ${state.agents === 1 ? "agent" : "agents"}` : "",
          state.rest === "half" ? "half rate at rest" : "",
          state.transitions === "on" ? "" : "cuts",
        ].filter(Boolean);
      },
      modified: () => keys.some((key) => this.#state()[key] !== this.#base()[key]),
      reset: () => change(Object.fromEntries(keys.map((key) => [key, this.#base()[key]]))),
    });
  }

  /** The Page: what sits on top of the picture (and the name a private instance's card shows). */
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
      modified: () => this.#state().instance !== this.#base().instance,
      reset: () => change({ instance: this.#base().instance }),
    });
    const rows = [
      row({
        label: "Page on top",
        help: "Landing: the public introduction. Loading: what shows while the app boots. Sign-in: the face of a private instance. None: the scene alone (h toggles this). Dim and blur under Look help the copy stand out.",
        icon: "page",
        block: page.el,
        modified: () => this.#state().mode !== this.#base().mode,
        reset: () => change({ mode: this.#base().mode }),
      }),
      nameRow,
    ];
    this.#syncers.push(page.sync, ...rows.map((built) => built.sync), () => {
      const { instance } = this.#state();
      if (document.activeElement !== nameInput && nameInput.value !== instance)
        nameInput.value = instance;
    });
    const keys = SETTINGS.page;
    tagSettings(rows, keys);
    // The instance name: a gate on the page being the sign-in card.
    const named = () => this.#state().mode === "instance";
    return this.#section({
      id: "page",
      title: "Page",
      blurb:
        "What sits on top of the picture: the landing page, the loading screen, a private instance's sign-in, or nothing.",
      icon: "page",
      shelf: "global",
      open: false,
      content: rows.map((built) =>
        built === nameRow ? dependent(built.el, ["mode"], named) : built.el,
      ),
      summary: () => [MODE_LABEL[this.#state().mode]],
      modified: () => keys.some((key) => this.#state()[key] !== this.#base()[key]),
      reset: () => change(Object.fromEntries(keys.map((key) => [key, this.#base()[key]]))),
    });
  }
}
