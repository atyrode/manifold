// The transport bar's popovers: a small panel that opens from a button on the bar (A/B compare,
// the tour, every "now", the shortcuts), above or below it as there is room, one at a time. Escape
// or a press elsewhere closes it, and the keyboard comes back to its button.
import { h } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

export class Popover {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly #onOpen: (() => void) | undefined;
  /** The one popover open at a time, if any. */
  static #open: Popover | undefined;

  constructor(
    layer: HTMLElement,
    spec: { id: string; title: string; icon: IconName; label: string; content: HTMLElement[] },
    onOpen?: () => void,
  ) {
    this.#onOpen = onOpen;
    this.button = h(
      "button",
      {
        type: "button",
        class: "icon-button pop-button",
        title: spec.label,
        "aria-label": spec.label,
        "aria-expanded": "false",
        "aria-controls": `pop-${spec.id}`,
        "aria-haspopup": "dialog",
      },
      icon(spec.icon),
    );
    this.el = h(
      "div",
      {
        class: "popover",
        id: `pop-${spec.id}`,
        role: "dialog",
        "aria-label": spec.title,
        hidden: true,
      },
      h("header", { class: "popover-head" }, icon(spec.icon), h("h2", {}, spec.title)),
      ...spec.content,
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
    } else if (Popover.#open === this) Popover.#open = undefined;
    this.el.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    this.button.classList.toggle("active", open);
    if (!open) {
      if (focus) this.button.focus();
      return;
    }
    this.#onOpen?.();
    this.place();
    if (focus)
      this.el
        .querySelector<HTMLElement>(
          "button:not(:disabled), input, select, textarea, [tabindex='0']",
        )
        ?.focus();
  }

  /** Next to its button: above it in the lower half of the screen, below it in the upper. */
  place(): void {
    if (!this.open) return;
    const anchor = this.button.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = this.el.offsetWidth;
    const style = this.el.style;
    style.left = `${Math.round(Math.min(vw - width - 8, Math.max(8, anchor.left + anchor.width / 2 - width / 2)))}px`;
    if (anchor.top > vh / 2) {
      style.top = "";
      style.bottom = `${Math.round(vh - anchor.top + 10)}px`;
      style.maxHeight = `${Math.round(anchor.top - 18)}px`;
    } else {
      style.bottom = "";
      style.top = `${Math.round(anchor.bottom + 10)}px`;
      style.maxHeight = `${Math.round(vh - anchor.bottom - 18)}px`;
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

/** A thin rule between the bar's groups of buttons. */
export function separator(): HTMLElement {
  return h("span", { class: "bar-sep", "aria-hidden": "true" });
}
