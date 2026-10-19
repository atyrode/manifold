// DOM plumbing shared by the lab's panels and widgets: an element factory, the `Built` pair every
// control returns (its element, and how to reflect the setup into it), write-if-changed setters,
// reveals, and the gates through which the Controls view shows what hangs on a switch.
import type { CameraPose } from "../composer/camera.ts";
import type { DitherRenderer } from "../renderer.ts";
import type { SkyPlanet } from "../scenes/planets.ts";
import type { LabState, Params } from "../state.ts";
import type { GateState } from "./availability-model.ts";

export type Child = Node | string | false | null | undefined;

/** Element factory: attributes for data-/aria-/role, properties otherwise. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key.startsWith("data-") || key.startsWith("aria-") || key === "role")
      el.setAttribute(key, String(value));
    else (el as unknown as Record<string, unknown>)[key] = value;
  }
  for (const child of children)
    if (child !== false && child !== null && child !== undefined) el.append(child);
  return el;
}

/** An SVG element with attributes. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
  ...children: SVGElement[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  el.append(...children);
  return el;
}

/** A control: its element, and how to reflect the setup on screen into it. */
export interface Built {
  el: HTMLElement;
  sync: () => void;
}

// Reflecting the setup writes only what changed. The lab syncs every control on every change, a
// frame at a time while a slider moves, and writing text, `hidden` or an attribute even to what it
// already is restyles or lays out the element again (its text node is replaced, its attribute set).
// So a sync that changes nothing writes nothing. Toggling a class to the state it is in writes
// nothing either (DOMTokenList.toggle with `force`); `add` and `remove` always do.

/** Set `el`'s text unless it already reads so. */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Hide or show `el` unless it already is. */
export function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

/** Set `el`'s attribute `name` unless it already holds `value`. */
export function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** The inline style values setStyle last wrote, by element and property. */
const styled = new WeakMap<Element, Map<string, string>>();

/**
 * Set `el`'s inline style property `name` (a custom property too; "" removes it) unless setStyle
 * last wrote it so. It compares with what it wrote, not with the style read back, which the browser
 * normalises ("12.500%" reads "12.5%").
 */
export function setStyle(el: HTMLElement | SVGElement, name: string, value: string): void {
  let written = styled.get(el);
  if (!written) styled.set(el, (written = new Map()));
  if (written.get(name) === value) return;
  written.set(name, value);
  el.style.setProperty(name, value);
}

export type Patch = Record<string, string | number>;

/** What the lab's panels and widgets reach the setup through. */
export interface LabContext {
  /** The setup on screen: its lab settings, its scene's knobs and planets, a room's camera pose. */
  current(): {
    state: LabState;
    params: Params;
    planets: readonly SkyPlanet[];
    camera: CameraPose;
  };
  /** Apply a patch over the setup on screen; `commit` records it as one undo step. */
  change(patch: Patch, commit: boolean): void;
  /** Whether switch `key` (a toggle or feature) is on; true for no key. */
  on(key: string | undefined): boolean;
  renderer(): DitherRenderer | undefined;
  readonly reducedMotion: boolean;
}

/**
 * Take `el` from where it stands, leaving a mark in its place; the returned function puts it back
 * there. The compact bar's popovers show the panel's own views and sections this way (menu.ts).
 */
export function borrow(el: HTMLElement): () => void {
  const mark = document.createComment("");
  el.replaceWith(mark);
  return () => mark.replaceWith(el);
}

/** Open while `isOpen` holds; animates its height through a grid row (setOpen). */
export function reveal(child: HTMLElement, isOpen: () => boolean): Built {
  const el = h("div", { class: "reveal" }, h("div", { class: "reveal-inner" }, child));
  return { el, sync: () => setOpen(el, isOpen()) };
}

/**
 * Open or close reveal `el`. Closed, its content leaves the tab order and the accessibility tree
 * (`inert`) while its height animates away; the focus it held goes to `fallback`, if given.
 */
export function setOpen(el: HTMLElement, open: boolean, fallback?: HTMLElement): void {
  const inner = el.firstElementChild;
  if (!open && fallback && el.contains(document.activeElement)) fallback.focus();
  el.classList.toggle("open", open);
  if (inner instanceof HTMLElement && inner.inert === open) inner.inert = !open;
}

/** Whether each gate's switches are on (gate), by element. */
const gates = new WeakMap<Element, () => boolean>();

/**
 * Mark `el` as a control that hangs on switches: `chain` their URL keys, nearest first, `live`
 * whether they are all on (availability-model.ts). The Controls view alone shows it or not, after
 * every sync (showGate): open while live; while not, closed, unless the search or the lens finds
 * what it holds, then dormant. It starts as `live` says, so a gate built between syncs (a planet's
 * controls) stands right. A reveal (`dependent`) opens and closes; any other element hides.
 */
export function gate<E extends HTMLElement>(
  el: E,
  chain: readonly string[],
  live: () => boolean,
): E {
  el.dataset.when = chain.join(" ");
  gates.set(el, live);
  showGate(el, live() ? "open" : "closed");
  return el;
}

/** `child` in a reveal that is a gate (above). */
export function dependent(
  child: HTMLElement,
  chain: readonly string[],
  live: () => boolean,
): HTMLElement {
  return gate(
    h("div", { class: "reveal" }, h("div", { class: "reveal-inner" }, child)),
    chain,
    live,
  );
}

/** Whether gate `el`'s switches are all on (true for an element that is no gate). */
export function isLive(el: Element): boolean {
  return gates.get(el)?.() ?? true;
}

/**
 * Show gate `el` in `state`: a dormant one dimmed but in reach; a closed one hands the focus it held
 * to `fallback`, if given.
 */
export function showGate(el: HTMLElement, state: GateState, fallback?: HTMLElement): void {
  el.classList.toggle("dormant", state === "dormant");
  if (el.classList.contains("reveal")) {
    setOpen(el, state !== "closed", fallback);
    return;
  }
  if (state === "closed" && fallback && el.contains(document.activeElement)) fallback.focus();
  setHidden(el, state === "closed");
}

/** `value` clamped to min..max and snapped to `step` from `min`, without float dust. */
export function snap(value: number, min: number, max: number, step: number): number {
  const stepped = min + Math.round((Math.min(max, Math.max(min, value)) - min) / step) * step;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return Number(Math.min(max, Math.max(min, stepped)).toFixed(decimals));
}

/** Keyboard steps of a slider-like widget: the change for a key, or undefined for other keys. */
export function keyStep(event: KeyboardEvent, step: number, span: number): number | undefined {
  const big = Math.max(step, span / 10);
  switch (event.key) {
    case "ArrowRight":
    case "ArrowUp":
      return event.shiftKey ? big : step;
    case "ArrowLeft":
    case "ArrowDown":
      return event.shiftKey ? -big : -step;
    case "PageUp":
      return big;
    case "PageDown":
      return -big;
    default:
      return undefined;
  }
}

/**
 * Follow a drag from a pointerdown: `move` with each position (the first included), `end` once on
 * release or cancel. The element captures the pointer, so the drag survives leaving it.
 */
export function drag(
  event: PointerEvent,
  target: HTMLElement,
  move: (event: PointerEvent) => void,
  end: (event: PointerEvent) => void,
): void {
  target.setPointerCapture(event.pointerId);
  move(event);
  const onMove = (next: PointerEvent) => {
    if (next.pointerId === event.pointerId) move(next);
  };
  const onEnd = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", onEnd);
    target.removeEventListener("pointercancel", onEnd);
    end(next);
  };
  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", onEnd);
  target.addEventListener("pointercancel", onEnd);
}
