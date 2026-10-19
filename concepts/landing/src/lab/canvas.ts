// The lab's canvas mode (src/engine/README.md "The lab"): while an engine view is attached
// (lab.ts attachCanvas) the Controls show the document, not a scene's knobs: its Document (its name,
// the documents saved in this browser, new, export and import), its Objects (the camera and the
// World on top, then every object, to select, duplicate or delete), Add (the kinds by family, a
// refused one saying why), the Object selected (its place, turn and size as fields that scrub, and
// its kind's options as knobs) and the Camera; the World's groups and the Global ones follow
// (inspector.ts setCanvas). In the picture a click selects (the object's bounds drawn as corner
// brackets over it), a drag on the selected object moves it across whatever lies under the pointer
// (Shift turns it, Alt or Shift with the wheel sizes it), a drag elsewhere orbits the camera about the
// point under the pointer, a right or middle drag pans, the wheel dollies toward the pointer, W A S D
// Q E fly while the picture has the keyboard, and Esc lets go of the selection. Every edit makes a new
// document (canvas-model.ts) the view shows at once (EngineView.setDoc); a finished one is an undo
// step of the lab's (`CanvasLab.commit`; a drag, a wheel run or a flight is one).
import type { EngineDoc, KindDef, Placed } from "../engine/types.ts";
import { readKnobs, type ParamDef } from "../params.ts";
import type { Params } from "../state.ts";
import {
  boundsCentre,
  cameraRay,
  dolly,
  fly,
  length,
  lookAt,
  orbit,
  pan,
  PITCH_LIMIT,
  projectBounds,
  sub,
  wrapAngle,
} from "./canvas-camera.ts";
import {
  deleteDoc,
  exportDoc,
  importDoc,
  loadSavedDocs,
  parseDoc,
  saveDoc,
  storeSavedDocs,
  type SavedDoc,
} from "./canvas-docs.ts";
import type { CanvasHost } from "./canvas-host.ts";
import {
  addObject,
  duplicateObject,
  FAMILIES,
  facing,
  knobValues,
  moveObject,
  objectNames,
  palette,
  removeObject,
  SCALE_RANGE,
  scaleObject,
  setCamera,
  setOptions,
  setWorld,
  turnObject,
  type ObjectName,
} from "./canvas-model.ts";
import { dragPoint, dropPoint, grip, type Grip } from "./canvas-place.ts";
import { chipGrid } from "./chips.ts";
import { iconButton, textButton } from "./controls.ts";
import {
  dependent,
  drag,
  h,
  setAttr,
  setHidden,
  setStyle,
  setText,
  svg,
  type Built,
  type LabContext,
  type Patch,
} from "./dom.ts";
import { icon } from "./icons.ts";
import { knobRow, type CanvasControls, type CanvasSection } from "./inspector.ts";
import { Knobs, type SwitchDef } from "./knobs.ts";

/** What the canvas mode needs of the lab (lab.ts attachCanvas). */
export interface CanvasLab {
  /** The lab's context: the setup on screen and the renderer. */
  readonly ctx: LabContext;
  /** The World's knobs (the canvas scene's), the keys of the document's `world`. */
  readonly worldDefs: readonly ParamDef[];
  /** The document "New" starts from: the view's own as it was first attached. */
  readonly starter: EngineDoc;
  /** Where the selection cue is drawn, over the picture. */
  readonly layer: HTMLElement;
  /** Record the document on screen as one undo step: change `what`, in `words`. */
  commit(what: string, words: string): void;
  /** The document or the selection changed: reflect it everywhere. */
  changed(): void;
  /** Open the Controls' section `id` and bring it into view ("world": the World's first). */
  reveal(id: string): void;
}

/** Pixels a press moves before it is a drag rather than a click. */
const CLICK_SLOP = 4;
/** Radians the camera orbits, and an object turns, per pixel dragged. */
const TURN_PER_PIXEL = 0.006;
/** The wheel's pixels per e-fold of size, and per whole step toward what is under the pointer. */
const WHEEL_SCALE = 600;
const WHEEL_DOLLY = 500;
/** Metres a second the camera flies (W A S D Q E), and with Shift. */
const FLY_SPEED = 2;
const FLY_FAST = 8;
/** Metres to the point a press orbits or pans about where it meets nothing. */
const PIVOT_FALLBACK = 6;
/** Pixels the cue's label needs above the box it names (its height and gap). */
const LABEL_ROOM = 22;
const FLY_KEYS: Readonly<Record<string, readonly [number, number, number]>> = {
  KeyW: [1, 0, 0],
  KeyS: [-1, 0, 0],
  KeyD: [0, 1, 0],
  KeyA: [0, -1, 0],
  KeyE: [0, 0, 1],
  KeyQ: [0, 0, -1],
};

const degrees = (radians: number) => (radians * 180) / Math.PI;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * A context over knob values a document holds (an object's options, the World's knobs): the lab's
 * widgets (Knobs) read `read` and write through `write`, so they edit the document as they edit a
 * scene's knobs.
 */
function knobContext(
  lab: LabContext,
  read: () => Params,
  write: (patch: Patch, commit: boolean) => void,
): LabContext {
  return {
    current: () => ({ ...lab.current(), params: read() }),
    change: write,
    on: (key) => key === undefined || (read()[key] ?? 0) > 0.5,
    renderer: () => lab.renderer(),
    reducedMotion: lab.reducedMotion,
  };
}

/**
 * A number as a field: its name, which a drag across scrubs (Shift: finer), the field itself, and its
 * unit. Typing commits on change; a scrub sets as it goes and commits once on release. Empty and
 * disabled while `get` has no value (nothing selected).
 */
function numberField(spec: {
  name: string;
  label: string;
  unit: string;
  step: number;
  perPixel: number;
  min?: number;
  max?: number;
  get: () => number | undefined;
  set: (value: number, commit: boolean) => void;
}): Built {
  const decimals = Math.max(0, Math.ceil(-Math.log10(spec.step)));
  const tidy = (value: number) =>
    Number(
      Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, value)).toFixed(decimals),
    );
  const input = h("input", {
    type: "number",
    step: String(spec.step),
    "aria-label": spec.label,
    ...(spec.min === undefined ? {} : { min: String(spec.min) }),
    ...(spec.max === undefined ? {} : { max: String(spec.max) }),
  });
  const name = h(
    "span",
    { class: "canvas-field-name", title: `${spec.label}: drag across to scrub (Shift: finer)` },
    spec.name,
  );
  input.addEventListener("change", () => {
    const value = Number(input.value);
    if (input.value.trim() !== "" && Number.isFinite(value)) spec.set(tidy(value), true);
  });
  name.addEventListener("pointerdown", (event) => {
    const start = spec.get();
    if (event.button !== 0 || start === undefined) return;
    event.preventDefault();
    let last: number | undefined;
    drag(
      event,
      name,
      (pointer) => {
        const dx = pointer.clientX - event.clientX;
        if (last === undefined && Math.abs(dx) < CLICK_SLOP) return;
        const next = tidy(start + dx * spec.perPixel * (pointer.shiftKey ? 0.1 : 1));
        if (next === last) return;
        last = next;
        spec.set(next, false);
      },
      () => {
        if (last !== undefined) spec.set(last, true);
      },
    );
  });
  return {
    el: h(
      "label",
      { class: "canvas-field", "data-search": spec.label.toLowerCase() },
      name,
      input,
      h("span", { class: "canvas-field-unit" }, spec.unit),
    ),
    sync: () => {
      const value = spec.get();
      if (input.disabled !== (value === undefined)) input.disabled = value === undefined;
      if (document.activeElement === input) return;
      const text = value === undefined ? "" : String(tidy(value));
      if (input.value !== text) input.value = text;
    },
  };
}

/** A press in the picture, as it goes on: what it does, and where it began. */
type Press =
  | { readonly kind: "move"; readonly id: string; readonly held: Grip }
  | { readonly kind: "turn"; readonly id: string; readonly yaw: number }
  | {
      readonly kind: "orbit";
      readonly picked: string | undefined;
      readonly pivot: readonly [number, number, number];
    }
  | { readonly kind: "pan"; readonly metres: number };

export class CanvasEditor {
  /** The Controls' sections and the World's knobs (inspector.ts setCanvas). */
  readonly controls: CanvasControls;
  readonly #host: CanvasHost;
  readonly #lab: CanvasLab;
  readonly #syncers: (() => void)[] = [];
  #selected: string | undefined;
  /** Whether the picture takes the pointer and the cue shows (the lab open). */
  #active = false;
  #listening: AbortController | undefined;
  /** The element's tab index before the canvas mode made it focusable. */
  #tabIndex: string | null = null;
  readonly #overlay: HTMLElement;
  readonly #cue: SVGSVGElement;
  readonly #brackets: SVGPathElement;
  readonly #cueLabel = h("span", { class: "canvas-cue-label" });
  /** Fly keys held, and the flight's frame and last time. */
  readonly #held = new Set<string>();
  #fast = false;
  #flyFrame: number | undefined;
  #flyLast: number | undefined;
  /** Documents saved in this browser, as last read or written. */
  #saved: SavedDoc[] = loadSavedDocs();
  readonly #status = h("p", { class: "canvas-status", role: "status" });

  constructor(host: CanvasHost, lab: CanvasLab) {
    this.#host = host;
    this.#lab = lab;
    this.#brackets = svg("path", { class: "canvas-cue-brackets" });
    this.#cue = svg("svg", { class: "canvas-cue" }, this.#brackets);
    this.#overlay = h("div", { class: "canvas-overlay", hidden: true }, this.#cue, this.#cueLabel);
    this.#overlay.setAttribute("aria-hidden", "true");
    lab.layer.prepend(this.#overlay);
    const worldDefaults = readKnobs(lab.worldDefs, () => null);
    const worldValues = () => ({ ...worldDefaults, ...this.doc.world });
    const world = new Knobs(
      knobContext(lab.ctx, worldValues, (patch, commit) => {
        const keys = Object.keys(patch).sort();
        this.#apply(
          setWorld(this.doc, knobValues(lab.worldDefs, this.doc.world, patch)),
          commit ? { what: `world:${keys.join(",")}`, words: "the World" } : undefined,
        );
      }),
      lab.worldDefs,
      worldDefaults,
    );
    const sections = [
      this.#documentSection(),
      this.#outlinerSection(),
      this.#paletteSection(),
      this.#objectSection(),
      this.#cameraSection(),
    ];
    this.controls = {
      title: () => this.doc.title || "Untitled",
      sections,
      world,
      worldValues,
      sync: () => {
        for (const sync of this.#syncers) sync();
      },
    };
  }

  /** The document on screen. */
  get doc(): EngineDoc {
    return this.#host.view.doc;
  }

  /** The object selected, if any. */
  get selected(): string | undefined {
    return this.#selected;
  }

  /** Select object `id`, or nothing. */
  select(id: string | undefined): void {
    if (id === this.#selected) return;
    this.#selected = id;
    this.#lab.changed();
  }

  /**
   * Take the picture's pointer and keys and show the cue (the lab open), or let them go. The
   * element becomes focusable while active, for the fly keys.
   */
  setActive(active: boolean): void {
    if (active === this.#active) return;
    this.#active = active;
    const element = this.#host.element;
    if (!active) {
      this.#listening?.abort();
      this.#listening = undefined;
      this.#land();
      if (this.#tabIndex === null) element.removeAttribute("tabindex");
      else element.setAttribute("tabindex", this.#tabIndex);
      this.sync();
      return;
    }
    this.#tabIndex = element.getAttribute("tabindex");
    if (element.tabIndex < 0) element.tabIndex = 0;
    const listening = new AbortController();
    this.#listening = listening;
    const options = { signal: listening.signal };
    element.addEventListener("pointerdown", (event) => this.#press(event), options);
    element.addEventListener("wheel", (event) => this.#wheel(event), {
      ...options,
      passive: false,
    });
    element.addEventListener("contextmenu", (event) => event.preventDefault(), options);
    element.addEventListener("keydown", (event) => this.#key(event, true), options);
    element.addEventListener("keyup", (event) => this.#key(event, false), options);
    element.addEventListener("blur", () => this.#land(), options);
    window.addEventListener("resize", () => this.sync(), options);
    this.sync();
  }

  /** Let go of the picture and take the cue away: the view is detached. */
  detach(): void {
    this.setActive(false);
    this.#overlay.remove();
  }

  /** Reflect the document into the selection and its cue (the sections sync with the Controls). */
  sync(): void {
    if (this.#selected !== undefined && !this.#object(this.#selected)) this.#selected = undefined;
    this.#syncCue();
  }

  /** Open a saved document (the Scenes view's Canvas shelf, the Document section): one undo step. */
  open(saved: SavedDoc): void {
    const parsed = parseDoc(saved.doc, this.#host.kinds);
    if ("why" in parsed) {
      setText(this.#status, `Cannot open “${saved.name}”: ${parsed.why}`);
      this.#lab.reveal("canvas:document");
      return;
    }
    this.#selected = undefined;
    this.#apply(parsed.doc, { what: "open", words: `open “${saved.name}”` });
    setText(this.#status, `Opened “${saved.name}”.`);
  }

  // ---- edits ------------------------------------------------------------------------------------

  /** Show `next`; with `commit`, record it as an undo step. */
  #apply(next: EngineDoc, commit?: { what: string; words: string }): void {
    if (next !== this.doc) this.#host.view.setDoc(next);
    if (commit) this.#lab.commit(commit.what, commit.words);
    this.#lab.changed();
  }

  #object(id: string): Placed | undefined {
    return this.doc.objects.find((object) => object.id === id);
  }

  #kind(id: string): KindDef | undefined {
    return this.#host.kinds.find((kind) => kind.id === id);
  }

  /** An object's name in words: its kind's title, and its number where its kind stands more than once. */
  #named(name: ObjectName | undefined): string {
    if (!name) return "";
    return name.label === "" ? name.title : `${name.title} ${name.label}`;
  }

  #name(id: string): string {
    return this.#named(objectNames(this.doc, this.#host.kinds).get(id));
  }

  /** The picture's size and aspect, and a pointer's place on it in normalised coordinates. */
  #picture(event: { clientX: number; clientY: number }): {
    readonly rect: DOMRect;
    readonly aspect: number;
    readonly x: number;
    readonly y: number;
  } {
    const rect = this.#host.element.getBoundingClientRect();
    return {
      rect,
      aspect: rect.width / Math.max(1, rect.height),
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      y: 1 - ((event.clientY - rect.top) / Math.max(1, rect.height)) * 2,
    };
  }

  #add(kind: KindDef): void {
    const rect = this.#host.element.getBoundingClientRect();
    const centre = this.#host.cellAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const at = dropPoint(this.#host.view, centre);
    const added = addObject(this.doc, kind, this.#host.kinds, at, facing(this.doc.camera.yaw));
    if ("why" in added) {
      setText(this.#status, added.why);
      return;
    }
    this.#selected = added.id;
    this.#apply(added.doc, { what: `add:${added.id}`, words: `add ${kind.title.toLowerCase()}` });
  }

  #duplicate(id: string): void {
    const copy = duplicateObject(this.doc, id, this.#host.kinds);
    if (!copy) return;
    if ("why" in copy) return;
    this.#selected = copy.id;
    this.#apply(copy.doc, { what: `add:${copy.id}`, words: `duplicate ${this.#name(id)}` });
  }

  #remove(id: string): void {
    const words = `delete ${this.#name(id)}`;
    if (this.#selected === id) this.#selected = undefined;
    this.#apply(removeObject(this.doc, id), { what: `delete:${id}`, words });
  }

  // ---- the picture ------------------------------------------------------------------------------

  /** Where the selection cue stands: the selected object's bounds, projected, as corner brackets. */
  #syncCue(): void {
    const placed = this.#selected === undefined ? undefined : this.#object(this.#selected);
    const kind = placed && this.#kind(placed.kind);
    const rect = this.#host.element.getBoundingClientRect();
    const box =
      this.#active && placed && kind && rect.width > 0 && rect.height > 0
        ? projectBounds(
            this.doc.camera,
            placed,
            kind.bounds(placed.options),
            rect.width / rect.height,
          )
        : undefined;
    const [w, hgt] = [rect.width, rect.height];
    const x0 = box ? ((box.min[0] + 1) / 2) * w : 0;
    const x1 = box ? ((box.max[0] + 1) / 2) * w : 0;
    const y0 = box ? ((1 - box.max[1]) / 2) * hgt : 0;
    const y1 = box ? ((1 - box.min[1]) / 2) * hgt : 0;
    const shown = box !== undefined && x1 > 0 && x0 < w && y1 > 0 && y0 < hgt;
    setHidden(this.#overlay, !shown);
    if (!shown || !placed) return;
    setStyle(this.#overlay, "left", `${rect.left}px`);
    setStyle(this.#overlay, "top", `${rect.top}px`);
    setStyle(this.#overlay, "width", `${w}px`);
    setStyle(this.#overlay, "height", `${hgt}px`);
    setAttr(this.#cue, "viewBox", `0 0 ${w} ${hgt}`);
    const c = Math.max(4, Math.min(18, (x1 - x0) / 3, (y1 - y0) / 3));
    const r = (n: number) => n.toFixed(1);
    setAttr(
      this.#brackets,
      "d",
      [
        `M${r(x0)} ${r(y0 + c)}V${r(y0)}H${r(x0 + c)}`,
        `M${r(x1 - c)} ${r(y0)}H${r(x1)}V${r(y0 + c)}`,
        `M${r(x1)} ${r(y1 - c)}V${r(y1)}H${r(x1 - c)}`,
        `M${r(x0 + c)} ${r(y1)}H${r(x0)}V${r(y1 - c)}`,
      ].join(""),
    );
    setText(this.#cueLabel, this.#name(placed.id));
    setStyle(this.#cueLabel, "left", `${Math.max(0, Math.min(w - 8, x0))}px`);
    // The label stands over the box, or just inside the picture's top where the box runs above it.
    setStyle(this.#cueLabel, "top", `${Math.max(LABEL_ROOM, y0)}px`);
  }

  /** A press in the picture: a click, a drag of the selected object, an orbit or a pan. */
  #press(event: PointerEvent): void {
    const cell = this.#host.cellAt(event.clientX, event.clientY);
    if (!cell) return;
    event.preventDefault();
    this.#host.element.focus({ preventScroll: true });
    const view = this.#host.view;
    const start = view.doc;
    const { rect, aspect, x, y } = this.#picture(event);
    const eye = start.camera.at;
    const ray = cameraRay(start.camera, x, y, aspect);
    // What lies under the pointer: the point to orbit and pan about, and how far it is.
    const ground = view.surface(cell[0], cell[1])?.at;
    const pivot =
      ground ??
      ([
        eye[0] + ray[0] * PIVOT_FALLBACK,
        eye[1] + ray[1] * PIVOT_FALLBACK,
        eye[2] + ray[2] * PIVOT_FALLBACK,
      ] as const);
    let press: Press;
    if (event.button === 1 || event.button === 2) {
      const metres = (2 * length(sub(pivot, eye)) * Math.tan(start.camera.fov / 2)) / rect.height;
      press = { kind: "pan", metres };
    } else if (event.button === 0) {
      const picked = view.pick(cell[0], cell[1]);
      const placed =
        picked !== undefined && picked === this.#selected ? this.#object(picked) : undefined;
      press =
        placed && event.shiftKey
          ? { kind: "turn", id: placed.id, yaw: placed.yaw }
          : placed
            ? { kind: "move", id: placed.id, held: grip(view, placed, ray) }
            : { kind: "orbit", picked, pivot };
    } else return;
    let moved = false;
    drag(
      event,
      this.#host.element,
      (pointer) => {
        const dx = pointer.clientX - event.clientX;
        const dy = pointer.clientY - event.clientY;
        if (!moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
        moved = true;
        this.#dragged(press, start, pointer, dx, dy);
      },
      () => {
        if (!moved) {
          // A click: an orbit's press selects what it was on (nothing clears), a pan's does nothing.
          if (press.kind === "orbit") this.select(press.picked);
          else if (press.kind !== "pan") this.select(press.id);
          return;
        }
        const name = press.kind === "move" || press.kind === "turn" ? this.#name(press.id) : "";
        if (press.kind === "move") this.#lab.commit(`move:${press.id}`, `move ${name}`);
        else if (press.kind === "turn") this.#lab.commit(`turn:${press.id}`, `turn ${name}`);
        else this.#lab.commit("camera", "the camera");
        this.#lab.changed();
      },
    );
  }

  /** One step of a drag in the picture, `dx` and `dy` pixels from where it was pressed. */
  #dragged(press: Press, start: EngineDoc, pointer: PointerEvent, dx: number, dy: number): void {
    const view = this.#host.view;
    switch (press.kind) {
      case "move": {
        const placed = this.#object(press.id);
        const kind = placed && this.#kind(placed.kind);
        if (!placed || !kind) return;
        const { aspect, x, y } = this.#picture(pointer);
        const ray = cameraRay(this.doc.camera, x, y, aspect);
        const at = dragPoint(view, placed, kind, ray, press.held);
        if (at) this.#apply(moveObject(this.doc, press.id, at));
        return;
      }
      case "turn":
        this.#apply(turnObject(this.doc, press.id, press.yaw + dx * TURN_PER_PIXEL));
        return;
      case "orbit":
        this.#apply(
          setCamera(
            this.doc,
            orbit(start.camera, press.pivot, -dx * TURN_PER_PIXEL, -dy * TURN_PER_PIXEL),
          ),
        );
        return;
      case "pan":
        this.#apply(setCamera(this.doc, pan(start.camera, -dx * press.metres, dy * press.metres)));
        return;
    }
  }

  /** The wheel: with Alt or Shift over the selection, its size; else a dolly toward the pointer. */
  #wheel(event: WheelEvent): void {
    const cell = this.#host.cellAt(event.clientX, event.clientY);
    if (!cell) return;
    event.preventDefault();
    const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    const delta = (event.deltaY || event.deltaX) * lines;
    const placed = this.#selected === undefined ? undefined : this.#object(this.#selected);
    if ((event.altKey || event.shiftKey) && placed) {
      const next = scaleObject(this.doc, placed.id, placed.scale * Math.exp(-delta / WHEEL_SCALE));
      this.#apply(next, { what: `scale:${placed.id}`, words: `size ${this.#name(placed.id)}` });
      return;
    }
    const { aspect, x, y } = this.#picture(event);
    const camera = this.doc.camera;
    const ray = cameraRay(camera, x, y, aspect);
    const target =
      this.#host.view.surface(cell[0], cell[1])?.at ??
      ([
        camera.at[0] + ray[0] * PIVOT_FALLBACK,
        camera.at[1] + ray[1] * PIVOT_FALLBACK,
        camera.at[2] + ray[2] * PIVOT_FALLBACK,
      ] as const);
    const share = Math.max(-1, Math.min(0.5, -delta / WHEEL_DOLLY));
    this.#apply(setCamera(this.doc, dolly(camera, target, share)), {
      what: "camera",
      words: "the camera",
    });
  }

  /** A key in the picture: W A S D Q E fly (Shift faster), Esc lets go of the selection. */
  #key(event: KeyboardEvent, down: boolean): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    this.#fast = event.shiftKey;
    if (down && event.key === "Escape") {
      this.select(undefined);
      return;
    }
    if (!(event.code in FLY_KEYS)) return;
    event.preventDefault();
    if (down) {
      this.#held.add(event.code);
      this.#flyFrame ??= requestAnimationFrame(this.#fly);
    } else {
      this.#held.delete(event.code);
      if (this.#held.size === 0) this.#land();
    }
  }

  /** One frame of a flight: the camera moved by the keys held, for the time since the last. */
  readonly #fly = (now: number): void => {
    this.#flyFrame = undefined;
    if (this.#held.size === 0) return;
    const seconds = this.#flyLast === undefined ? 0 : Math.min(0.1, (now - this.#flyLast) / 1000);
    this.#flyLast = now;
    const step = (this.#fast ? FLY_FAST : FLY_SPEED) * seconds;
    let [ahead, right, up] = [0, 0, 0];
    for (const code of this.#held) {
      const [a, r, u] = FLY_KEYS[code] ?? [0, 0, 0];
      [ahead, right, up] = [ahead + a, right + r, up + u];
    }
    if (seconds > 0)
      this.#apply(setCamera(this.doc, fly(this.doc.camera, ahead * step, right * step, up * step)));
    this.#flyFrame = requestAnimationFrame(this.#fly);
  };

  /** End a flight: the keys let go, and the flight one undo step. */
  #land(): void {
    if (this.#flyLast !== undefined) {
      this.#lab.commit("camera", "the camera");
      this.#lab.changed();
    }
    this.#held.clear();
    if (this.#flyFrame !== undefined) cancelAnimationFrame(this.#flyFrame);
    this.#flyFrame = undefined;
    this.#flyLast = undefined;
  }

  // ---- the sections ---------------------------------------------------------------------------

  /** The document: its name, saving it here, new, export, import, and the documents saved here. */
  #documentSection(): CanvasSection {
    const title = h("input", {
      type: "text",
      class: "canvas-title",
      "aria-label": "Document name",
      placeholder: "Untitled",
      spellcheck: false,
    });
    title.addEventListener("change", () => {
      const text = title.value.trim();
      if (text !== this.doc.title)
        this.#apply({ ...this.doc, title: text }, { what: "title", words: "the name" });
    });
    const file = h("input", { type: "file", accept: ".json,application/json", hidden: true });
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      file.value = "";
      if (!chosen) return;
      void chosen.text().then((text) => {
        const read = importDoc(text, this.#host.kinds);
        if ("why" in read) {
          setText(this.#status, `Cannot import ${chosen.name}: ${read.why}`);
          return;
        }
        this.#selected = undefined;
        this.#apply(read.doc, { what: "import", words: `import “${read.doc.title}”` });
        setText(this.#status, `Imported “${read.doc.title || chosen.name}”.`);
      });
    });
    const list = h("ul", { class: "canvas-docs", "aria-label": "Documents saved in this browser" });
    let listed = "";
    const save = () => {
      const name = this.doc.title.trim() || "Untitled";
      const over = this.#saved.some((saved) => saved.name === name);
      this.#saved = saveDoc(this.#saved, name, this.doc, Date.now());
      storeSavedDocs(this.#saved);
      setText(this.#status, over ? `Saved over “${name}”.` : `Saved as “${name}”.`);
      this.#lab.changed();
    };
    const fresh = () => {
      this.#selected = undefined;
      this.#apply(this.#lab.starter, { what: "new", words: "a new document" });
      setText(this.#status, "A new document, from the view's own.");
    };
    const exported = () => {
      const { name, text } = exportDoc(this.doc);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = h("a", { href: url, download: name });
      link.click();
      URL.revokeObjectURL(url);
      setText(this.#status, `Exported ${name}.`);
    };
    const actions = h(
      "div",
      { class: "lab-actions canvas-doc-actions" },
      textButton("bookmark", "Save", "Save this document in this browser, under its name", save),
      textButton(
        "renew",
        "New",
        "Start a new document from the view's own (undo brings this one back)",
        fresh,
      ),
      textButton("external", "Export", "Download this document as a .json file", exported),
      textButton("down", "Import", "Open a document from a .json file", () => file.click()),
    );
    this.#syncers.push(() => {
      if (document.activeElement !== title && title.value !== this.doc.title)
        title.value = this.doc.title;
      const signature = JSON.stringify(this.#saved.map((saved) => [saved.name, saved.savedAt]));
      if (signature === listed) return;
      listed = signature;
      list.replaceChildren(
        ...this.#saved.map((saved) => {
          const openIt = h(
            "button",
            {
              type: "button",
              class: "canvas-doc-open",
              title: `Open “${saved.name}”, saved ${new Date(saved.savedAt).toLocaleString()} (undo brings this one back)`,
            },
            icon("bookmark"),
            h("span", { class: "canvas-doc-name" }, saved.name),
            h(
              "span",
              { class: "canvas-doc-meta" },
              `${saved.doc.objects.length} object${saved.doc.objects.length === 1 ? "" : "s"}`,
            ),
          );
          openIt.addEventListener("click", () => this.open(saved));
          const remove = iconButton("trash", `Delete “${saved.name}” from this browser`, () => {
            this.#saved = deleteDoc(this.#saved, saved.name);
            storeSavedDocs(this.#saved);
            setText(this.#status, `Deleted “${saved.name}”.`);
            this.#lab.changed();
          });
          return h(
            "li",
            { class: "canvas-doc", "data-search": saved.name.toLowerCase() },
            openIt,
            remove,
          );
        }),
      );
      setHidden(list, this.#saved.length === 0);
    });
    return {
      id: "canvas:document",
      title: "Document",
      blurb:
        "This setup as a document: its name, saving it in this browser (it shows on the Scenes view's Canvas shelf), a new one from the view's own, and a .json file to keep or share.",
      icon: "bookmark",
      open: true,
      content: [
        h(
          "div",
          { class: "canvas-doc-head", "data-search": "document name save new export import" },
          title,
        ),
        actions,
        file,
        this.#status,
        list,
      ],
      summary: () => [this.doc.title || "Untitled", `${this.#saved.length} saved`],
    };
  }

  /** The outliner: the camera and the World, then every object. */
  #outlinerSection(): CanvasSection {
    const fixed = (iconName: "camera" | "sun", label: string, section: string, help: string) => {
      const button = h(
        "button",
        { type: "button", class: "canvas-row-pick", title: help },
        icon(iconName),
        h("span", { class: "canvas-row-title" }, label),
      );
      button.addEventListener("click", () => this.#lab.reveal(section));
      return h("li", { class: "canvas-row fixed", "data-search": label.toLowerCase() }, button);
    };
    const objects = h("ul", { class: "canvas-outline", "aria-label": "Objects in the document" });
    const empty = h("p", { class: "canvas-note" }, "Nothing placed yet: add a kind below.");
    const rows = new Map<string, { li: HTMLElement; meta: HTMLElement; copy: HTMLButtonElement }>();
    let built = "";
    this.#syncers.push(() => {
      const names = objectNames(this.doc, this.#host.kinds);
      const signature = this.doc.objects
        .map((object) => `${object.id}:${this.#named(names.get(object.id))}`)
        .join("|");
      if (signature !== built) {
        built = signature;
        rows.clear();
        objects.replaceChildren(
          ...this.doc.objects.map((object) => {
            const name = names.get(object.id);
            const words = this.#named(name);
            const family = FAMILIES.find((candidate) => candidate.id === name?.kind?.family);
            const meta = h("span", { class: "canvas-row-meta" });
            const pick = h(
              "button",
              { type: "button", class: "canvas-row-pick", title: `Select ${words}` },
              icon(family?.icon ?? "dot"),
              h("span", { class: "canvas-row-title" }, name?.title ?? object.kind),
              name?.label ? h("span", { class: "canvas-row-label" }, name.label) : null,
              meta,
            );
            pick.addEventListener("click", () => this.select(object.id));
            const copy = iconButton("plus", `Duplicate ${words}`, () => this.#duplicate(object.id));
            const remove = iconButton("trash", `Delete ${words}`, () => this.#remove(object.id));
            const li = h(
              "li",
              { class: "canvas-row", "data-search": words.toLowerCase() },
              pick,
              copy,
              remove,
            );
            rows.set(object.id, { li, meta, copy });
            return li;
          }),
        );
      }
      setHidden(empty, this.doc.objects.length > 0);
      for (const object of this.doc.objects) {
        const row = rows.get(object.id);
        if (!row) continue;
        if (object.id === this.#selected) setAttr(row.li, "aria-current", "true");
        else row.li.removeAttribute("aria-current");
        setText(row.meta, object.at.map((v) => v.toFixed(1)).join(", "));
        const kind = this.#kind(object.kind);
        const refused = kind ? duplicateObject(this.doc, object.id, this.#host.kinds) : undefined;
        const why = refused && "why" in refused ? refused.why : undefined;
        if (row.copy.disabled !== (why !== undefined)) row.copy.disabled = why !== undefined;
        setAttr(row.copy, "title", why ?? `Duplicate ${this.#name(object.id)}`);
      }
    });
    return {
      id: "canvas:objects",
      title: "Objects",
      blurb:
        "What the document holds: the camera and the World, then every object placed. Select one here or in the picture; duplicate it beside itself, or delete it.",
      icon: "layers",
      open: true,
      content: [
        h(
          "ul",
          { class: "canvas-outline fixed" },
          fixed("camera", "Camera", "canvas:camera", "The camera: where the eye stands and looks"),
          fixed("sun", "World", "world", "The World: its hour, sky, weather and wind"),
        ),
        objects,
        empty,
      ],
      summary: () => [
        `${this.doc.objects.length} object${this.doc.objects.length === 1 ? "" : "s"}`,
        ...(this.#selected === undefined ? [] : [this.#name(this.#selected)]),
      ],
    };
  }

  /** The palette: every kind by family, searchable, a refused one disabled with its reason. */
  #paletteSection(): CanvasSection {
    const search = h("input", {
      type: "search",
      placeholder: "Find a kind…",
      "aria-label": "Find a kind to add",
      spellcheck: false,
    });
    const body = h("div", { class: "canvas-palette" });
    let built = "";
    const render = () => {
      const rows = palette(this.doc, this.#host.kinds, search.value);
      const signature = JSON.stringify([
        search.value,
        rows.map((row) => row.kinds.map(({ kind, refusal }) => [kind.id, refusal?.why ?? ""])),
      ]);
      if (signature === built) return;
      built = signature;
      body.replaceChildren(
        ...rows.map((row) =>
          h(
            "div",
            { class: "canvas-family" },
            h(
              "h4",
              { class: "canvas-family-title" },
              icon(row.family.icon),
              h("span", {}, row.family.title),
            ),
            h(
              "div",
              { class: "canvas-kinds" },
              ...row.kinds.map(({ kind, refusal }) => {
                const button = h(
                  "button",
                  {
                    type: "button",
                    class: "canvas-kind",
                    disabled: refusal !== undefined,
                    title: refusal
                      ? refusal.why
                      : `${kind.blurb} Adds it where the picture's centre meets the world.`,
                    "data-search": `${kind.title} ${kind.blurb}`.toLowerCase(),
                  },
                  h("span", { class: "canvas-kind-title" }, kind.title),
                  refusal ? h("span", { class: "canvas-refusal" }, refusal.why) : null,
                );
                button.addEventListener("click", () => this.#add(kind));
                return button;
              }),
            ),
          ),
        ),
      );
      if (rows.length === 0) body.append(h("p", { class: "canvas-note" }, "No kind matches."));
    };
    search.addEventListener("input", render);
    this.#syncers.push(render);
    return {
      id: "canvas:add",
      title: "Add",
      blurb:
        "Every kind of object, by family. One the document cannot take says why (one ground, a kind's most); the rest drop where the picture's centre meets the world, facing the eye.",
      icon: "plus",
      open: true,
      content: [h("label", { class: "panel-search canvas-search" }, icon("search"), search), body],
      summary: () => [`${this.#host.kinds.length} kinds`],
    };
  }

  /** The object selected: its place, turn and size, then its kind's options alone. */
  #objectSection(): CanvasSection {
    const selected = () =>
      this.#selected === undefined ? undefined : this.#object(this.#selected);
    const edit =
      (change: (placed: Placed, value: number) => EngineDoc, what: string, words: string) =>
      (value: number, commit: boolean) => {
        const placed = selected();
        if (!placed) return;
        this.#apply(
          change(placed, value),
          commit
            ? { what: `${what}:${placed.id}`, words: `${words} ${this.#name(placed.id)}` }
            : undefined,
        );
      };
    const axis = (index: 0 | 1 | 2, name: string, label: string): Built =>
      numberField({
        name,
        label,
        unit: "m",
        step: 0.01,
        perPixel: 0.02,
        get: () => selected()?.at[index],
        set: edit(
          (placed, value) => {
            const at: [number, number, number] = [...placed.at];
            at[index] = value;
            return moveObject(this.doc, placed.id, at);
          },
          "move",
          "move",
        ),
      });
    const fields = [
      axis(0, "x", "Across (x)"),
      axis(1, "y", "Height (y)"),
      axis(2, "z", "Ahead (z)"),
      numberField({
        name: "turn",
        label: "Turn",
        unit: "°",
        step: 1,
        perPixel: 0.5,
        get: () => {
          const placed = selected();
          return placed && degrees(placed.yaw);
        },
        set: edit(
          (placed, value) => turnObject(this.doc, placed.id, radians(value)),
          "turn",
          "turn",
        ),
      }),
      numberField({
        name: "size",
        label: "Size",
        unit: "×",
        step: 0.01,
        perPixel: 0.01,
        min: SCALE_RANGE.min,
        max: SCALE_RANGE.max,
        get: () => selected()?.scale,
        set: edit((placed, value) => scaleObject(this.doc, placed.id, value), "scale", "size"),
      }),
    ];
    const heading = h("p", { class: "canvas-selected" });
    const none = h("p", { class: "canvas-note" }, "Select an object in the picture or in Objects.");
    const transform = h("div", { class: "canvas-fields" }, ...fields.map((field) => field.el));
    const options = h("div", { class: "canvas-options" });
    let optionsFor = "";
    let optionSyncs: (() => void)[] = [];
    this.#syncers.push(() => {
      const placed = selected();
      const kind = placed && this.#kind(placed.kind);
      setHidden(none, placed !== undefined);
      setHidden(heading, placed === undefined);
      setHidden(transform, placed === undefined);
      setText(heading, placed ? `${this.#name(placed.id)}${kind ? ` · ${kind.blurb}` : ""}` : "");
      for (const field of fields) field.sync();
      const key = placed && kind ? `${placed.id}:${kind.id}` : "";
      if (key !== optionsFor) {
        optionsFor = key;
        const built = placed && kind ? this.#options(placed.id, kind) : { el: [], syncs: [] };
        options.replaceChildren(...built.el);
        optionSyncs = built.syncs;
      }
      for (const sync of optionSyncs) sync();
    });
    return {
      id: "canvas:object",
      title: "Object",
      blurb:
        "The object selected: where its base stands (metres), its turn about the upright and its size over its kind's own, then its kind's options. Drag a field's name across to scrub it.",
      icon: "pointer",
      open: true,
      content: [none, heading, transform, options],
      summary: () => {
        const placed = selected();
        return placed ? [this.#name(placed.id)] : ["nothing selected"];
      },
    };
  }

  /** Object `id`'s options as the lab's knobs: its switches as chips, the rest as rows. */
  #options(id: string, kind: KindDef): { el: HTMLElement[]; syncs: (() => void)[] } {
    const defs = kind.options;
    if (defs.length === 0)
      return { el: [h("p", { class: "canvas-note" }, `${kind.title} has no options.`)], syncs: [] };
    const defaults = readKnobs(defs, () => null);
    const knobs = new Knobs(
      knobContext(
        this.#lab.ctx,
        () => ({ ...defaults, ...(this.#object(id)?.options ?? {}) }),
        (patch, commit) => {
          const placed = this.#object(id);
          if (!placed) return;
          const keys = Object.keys(patch).sort();
          this.#apply(
            setOptions(this.doc, id, knobValues(defs, placed.options, patch)),
            commit
              ? {
                  what: `options:${id}:${keys.join(",")}`,
                  words: `${this.#name(id)}'s ${keys.join(", ")}`,
                }
              : undefined,
          );
        },
      ),
      defs,
      defaults,
    );
    const el: HTMLElement[] = [];
    const syncs: (() => void)[] = [];
    const switches = defs.filter(
      (def): def is SwitchDef => def.kind === "toggle" || def.kind === "feature",
    );
    if (switches.length > 0) {
      const chips = chipGrid(knobs, switches);
      el.push(chips.grid.el, chips.amounts.el);
      syncs.push(chips.grid.sync, chips.amounts.sync);
    }
    for (const def of defs) {
      if (def.kind === "toggle" || def.kind === "feature") continue;
      const built = knobRow(knobs, def);
      const when = def.when;
      el.push(
        when === undefined
          ? built.el
          : dependent(built.el, knobs.chain(when), () => knobs.live(when)),
      );
      syncs.push(built.sync);
    }
    return { el, syncs };
  }

  /** The camera: where the eye stands, its turn, tilt and field of view, and a look at the selection. */
  #cameraSection(): CanvasSection {
    const camera = () => this.doc.camera;
    const set =
      (patch: (value: number) => Partial<EngineDoc["camera"]>) =>
      (value: number, commit: boolean) =>
        this.#apply(
          setCamera(this.doc, { ...camera(), ...patch(value) }),
          commit ? { what: "camera", words: "the camera" } : undefined,
        );
    const axis = (index: 0 | 1 | 2, name: string, label: string): Built =>
      numberField({
        name,
        label,
        unit: "m",
        step: 0.01,
        perPixel: 0.02,
        get: () => camera().at[index],
        set: set((value) => {
          const at: [number, number, number] = [...camera().at];
          at[index] = value;
          return { at };
        }),
      });
    const limit = Math.floor(degrees(PITCH_LIMIT));
    const fields = [
      axis(0, "x", "Eye across (x)"),
      axis(1, "y", "Eye height (y)"),
      axis(2, "z", "Eye ahead (z)"),
      numberField({
        name: "turn",
        label: "Camera turn",
        unit: "°",
        step: 1,
        perPixel: 0.5,
        get: () => degrees(camera().yaw),
        set: set((value) => ({ yaw: wrapAngle(radians(value)) })),
      }),
      numberField({
        name: "tilt",
        label: "Camera tilt",
        unit: "°",
        step: 1,
        perPixel: 0.5,
        min: -limit,
        max: limit,
        get: () => degrees(camera().pitch),
        set: set((value) => ({ pitch: radians(value) })),
      }),
      numberField({
        name: "fov",
        label: "Field of view",
        unit: "°",
        step: 1,
        perPixel: 0.25,
        min: 5,
        max: 150,
        get: () => degrees(camera().fov),
        set: set((value) => ({ fov: radians(value) })),
      }),
    ];
    const look = textButton(
      "eye",
      "Look at selection",
      "Turn the camera to the selected object, where it stands",
      () => {
        const placed = this.#selected === undefined ? undefined : this.#object(this.#selected);
        const kind = placed && this.#kind(placed.kind);
        if (!placed || !kind) return;
        this.#apply(
          setCamera(this.doc, lookAt(camera(), boundsCentre(placed, kind.bounds(placed.options)))),
          {
            what: "camera",
            words: "the camera",
          },
        );
      },
    );
    this.#syncers.push(() => {
      for (const field of fields) field.sync();
      const none = this.#selected === undefined;
      if (look.disabled !== none) look.disabled = none;
    });
    return {
      id: "canvas:camera",
      title: "Camera",
      blurb:
        "Where the eye stands (metres), its turn (counter-clockwise from above, 0 along +z), its tilt and its field of view, top to bottom. In the picture: drag to orbit, right or middle drag to pan, the wheel to dolly, W A S D Q E to fly.",
      icon: "camera",
      open: false,
      content: [
        h("div", { class: "canvas-fields" }, ...fields.map((field) => field.el)),
        h("div", { class: "lab-actions" }, look),
      ],
      summary: () => {
        const { at, fov } = camera();
        return [`${at.map((v) => v.toFixed(1)).join(", ")}`, `${Math.round(degrees(fov))}°`];
      },
    };
  }
}
