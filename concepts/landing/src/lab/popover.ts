// The lab's popovers: a panel that opens from a button (a chip of the compact bar, menu.ts, or the
// tools' "⋯", lab.ts), above or below it as there is room, one at a time, as wide as the inspector
// and never taller than most of the screen. On a narrow screen it is a sheet the full width of the
// screen, standing on the bar or panel foot it opens from. Open, it stands in the tab order after
// what its button stands in (the panels' zone, or the sheet). Escape or a press elsewhere closes it,
// and the keyboard comes back to its button; closed, nothing in it takes the focus. A popover may
// show what the inspector panel holds (a Controls section, the Scenes view): its `open`
// takes the element in, its `close` gives it back, so both presentations share one set of controls.
import { h, reveal, setAttr, setOpen, setStyle } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { NARROW } from "./panels.ts";

export interface PopoverSpec {
  id: string;
  /** Its name, and its heading unless `bare`. */
  title: string;
  icon: IconName;
  /** Its button: an icon button named `label` unless given (a chip). */
  button?: HTMLButtonElement;
  label?: string;
  /** What it always holds. */
  content?: HTMLElement[];
  /**
   * No heading on screen: what it shows brings its own (a section's), and its title is a heading
   * for assistive technology alone.
   */
  bare?: boolean;
  /** A view (Scenes, Presets): a fixed height its own body scrolls in. */
  view?: boolean;
  /** It came up: show what it holds (before it is placed). */
  open?: () => void;
  /** It went: give back what it held. */
  close?: () => void;
  /** Hand the keyboard in as it opens; by default to its first control on screen. */
  focus?: () => void;
}

const narrow = matchMedia(NARROW);

export class Popover {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly #spec: PopoverSpec;
  /** The one popover open at a time, if any. */
  static #open: Popover | undefined;

  constructor(layer: HTMLElement, spec: PopoverSpec) {
    this.#spec = spec;
    const id = `pop-${spec.id.replace(/[^a-z0-9]+/gi, "-")}`;
    const label = spec.label ?? spec.title;
    this.button =
      spec.button ??
      h(
        "button",
        { type: "button", class: "icon-button", title: label, "aria-label": label },
        icon(spec.icon),
      );
    setAttr(this.button, "aria-expanded", "false");
    setAttr(this.button, "aria-controls", id);
    setAttr(this.button, "aria-haspopup", "dialog");
    this.el = h(
      "div",
      {
        class: `popover${spec.view ? " view-pop" : ""}${spec.bare ? " bare" : ""}`,
        id,
        role: "dialog",
        "aria-label": spec.title,
        tabIndex: -1,
        hidden: true,
      },
      spec.bare
        ? h("h2", { class: "sr-only" }, spec.title)
        : h("header", { class: "popover-head" }, icon(spec.icon), h("h2", {}, spec.title)),
      ...(spec.content ?? []),
    );
    layer.append(this.el);
    this.button.addEventListener("click", () => this.toggle(!this.open, true));
    this.el.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      this.toggle(false, true);
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  toggle(open: boolean, focus = false): void {
    if (open === this.open) return;
    if (open) {
      Popover.#open?.toggle(false);
      Popover.#open = this;
      this.#follow();
    } else if (Popover.#open === this) Popover.#open = undefined;
    this.el.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    if (!open) {
      this.#spec.close?.();
      if (focus) this.button.focus();
      return;
    }
    this.#spec.open?.();
    this.place();
    if (!focus) return;
    if (this.#spec.focus) {
      this.#spec.focus();
      return;
    }
    // Its first control that can take the keyboard: rendered (not hidden), not folded away (inert).
    for (const control of this.el.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input, select, textarea, [tabindex='0']",
    )) {
      if (control.getClientRects().length === 0 || control.closest("[inert]")) continue;
      control.focus();
      return;
    }
  }

  /**
   * Stand in the layer straight after what its button stands in (the panels' zone, or the sheet):
   * next in the tab order after its button's panel, wherever the layer had it.
   */
  #follow(): void {
    const layer = this.el.parentElement;
    let stands: Element = this.button;
    while (stands.parentElement !== null && stands.parentElement !== layer)
      stands = stands.parentElement;
    if (stands.parentElement === layer && stands.nextElementSibling !== this.el)
      stands.after(this.el);
  }

  /** Close it for good and take it off the page (its button went: a scene's section chip). */
  remove(): void {
    this.toggle(false);
    this.el.remove();
  }

  /**
   * By its button, clear of what the button stands in (the bar, or the inspector's foot): above
   * it in the lower half of the screen, below it in the upper, its height capped by the room there
   * (`--room`). On a narrow screen, a sheet across the screen standing on it.
   */
  place(): void {
    if (!this.open) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const style = this.el.style;
    const sheet = narrow.matches;
    const stands = this.button.closest(".panel-foot, .panel") ?? this.button;
    const edge = stands.getBoundingClientRect();
    this.el.classList.toggle("sheeted", sheet);
    if (sheet) {
      style.left = "0px";
      style.top = "";
      style.bottom = `${Math.round(vh - edge.top)}px`;
      setStyle(this.el, "--room", `${Math.round(edge.top - 8)}px`);
      return;
    }
    const anchor = this.button.getBoundingClientRect();
    const width = this.el.offsetWidth;
    style.left = `${Math.round(Math.min(vw - width - 8, Math.max(8, anchor.left + anchor.width / 2 - width / 2)))}px`;
    if (anchor.top > vh / 2) {
      style.top = "";
      style.bottom = `${Math.round(vh - edge.top + 8)}px`;
      setStyle(this.el, "--room", `${Math.round(edge.top - 16)}px`);
    } else {
      style.bottom = "";
      style.top = `${Math.round(edge.bottom + 8)}px`;
      setStyle(this.el, "--room", `${Math.round(vh - edge.bottom - 16)}px`);
    }
  }

  /** Close whichever popover is open (the lab hides, a press lands elsewhere). */
  static closeAll(): void {
    Popover.#open?.toggle(false);
  }

  static placeOpen(): void {
    Popover.#open?.place();
  }

  /** Whether `target` is inside the open popover or on its button. */
  static owns(target: EventTarget | null): boolean {
    const open = Popover.#open;
    if (!open || !(target instanceof Node)) return false;
    return open.el.contains(target) || open.button.contains(target);
  }
}

/**
 * A fold inside a popover: a button (its chevron, icon, title and `note`, a summary its owner
 * writes) over `content`, which leaves the tab order while folded. It starts folded.
 */
export function fold(spec: { id: string; icon: IconName; title: string; content: HTMLElement[] }): {
  el: HTMLElement;
  note: HTMLElement;
} {
  const note = h("span", { class: "fold-note" });
  let open = false;
  const body = reveal(h("div", { class: "fold-body" }, ...spec.content), () => open);
  body.el.id = `fold-${spec.id}`;
  const button = h(
    "button",
    { type: "button", class: "fold-toggle", "aria-expanded": "false", "aria-controls": body.el.id },
    icon("chevron"),
    icon(spec.icon),
    h("span", { class: "fold-title" }, spec.title),
    note,
  );
  button.addEventListener("click", () => {
    open = !open;
    button.setAttribute("aria-expanded", String(open));
    setOpen(body.el, open, button);
  });
  body.sync();
  return { el: h("section", { class: "fold" }, button, body.el), note };
}
