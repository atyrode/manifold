// DOM plumbing shared by the lab's panels and widgets: an element factory and the `Built` pair every
// control returns (its element, and how to reflect the setup into it).
import type { DitherRenderer } from "../renderer.ts";
import type { LabState, Params } from "../state.ts";

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

export type Patch = Record<string, string | number>;

/** What the lab's panels and widgets reach the setup through. */
export interface LabContext {
  /** The setup on screen. */
  current(): { state: LabState; params: Params };
  /** Apply a patch over the setup on screen; `commit` records it as one undo step. */
  change(patch: Patch, commit: boolean): void;
  /** Whether switch `key` (a toggle or feature) is on; true for no key. */
  on(key: string | undefined): boolean;
  renderer(): DitherRenderer | undefined;
  readonly reducedMotion: boolean;
}

/** Open while `isOpen` holds; animates its height through a grid row. */
export function reveal(child: HTMLElement, isOpen: () => boolean): Built {
  const el = h("div", { class: "reveal" }, h("div", { class: "reveal-inner" }, child));
  return { el, sync: () => el.classList.toggle("open", isOpen()) };
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
