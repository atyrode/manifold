// The icon rail beside a view's scrolling body: a button per section that jumps to it, the section
// in view marked as the body scrolls, the sections a search hides dimmed and, where the view counts
// them, a dot on those with changes. Each view of the lab panel has its own: scene shelves
// (Scenes), preset groups (Presets), control groups (Controls). Marking the section in view reads
// the layout, so it waits for the next frame and runs once however often it is asked for.
import { h, setAttr } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

export interface RailEntry {
  id: string;
  title: string;
  icon: IconName;
  /** The section, laid out in the body (the body is its offset parent). */
  el: HTMLElement;
  /** Open the section before the jump, so the jump lands on its final place. */
  open?: () => void;
  /** Where the keyboard goes after the jump (a hidden element keeps it on the rail). */
  focus?: HTMLElement | undefined;
}

export class Rail {
  readonly el: HTMLElement;
  readonly #body: HTMLElement;
  readonly #reducedMotion: boolean;
  #entries: RailEntry[] = [];
  readonly #buttons = new Map<string, HTMLButtonElement>();
  /**
   * The section jumped to or opened by hand: marked until the body is scrolled by hand (it may sit
   * too low to reach the top), however its controls are used meanwhile.
   */
  #pinned: string | undefined;
  /** The frame the next spy runs in, while one is asked for. */
  #spying: number | undefined;

  constructor(body: HTMLElement, label: string, reducedMotion: boolean) {
    this.#body = body;
    this.#reducedMotion = reducedMotion;
    this.el = h("nav", { class: "rail", "aria-label": label });
    body.addEventListener("scroll", () => this.spy(), { passive: true });
    const unpin = () => (this.#pinned = undefined);
    body.addEventListener("wheel", unpin, { passive: true });
    body.addEventListener("touchmove", unpin, { passive: true });
    // The scrollbar (a press on the body itself) and the page keys scroll; controls do not, unless
    // they are another section's.
    body.addEventListener("pointerdown", (event) => event.target === body && unpin());
    body.addEventListener(
      "keydown",
      (event) => (event.key === "PageUp" || event.key === "PageDown") && unpin(),
    );
    body.addEventListener("focusin", (event) => {
      const pinned = this.#entries.find((entry) => entry.id === this.#pinned);
      if (pinned && event.target instanceof Node && !pinned.el.contains(event.target)) unpin();
    });
  }

  /** The rail's buttons: one per entry, a divider between the lists. */
  set(lists: readonly (readonly RailEntry[])[]): void {
    this.#entries = lists.flat();
    this.#buttons.clear();
    const children: HTMLElement[] = [];
    for (const list of lists.filter((entries) => entries.length > 0)) {
      if (children.length > 0)
        children.push(h("span", { class: "rail-divider", "aria-hidden": "true" }));
      for (const entry of list) {
        const button = h(
          "button",
          {
            type: "button",
            class: "rail-button",
            title: entry.title,
            "aria-label": entry.title,
            "data-id": entry.id,
          },
          icon(entry.icon),
        );
        button.addEventListener("click", () => this.#jump(entry));
        this.#buttons.set(entry.id, button);
        children.push(button);
      }
    }
    this.el.replaceChildren(...children);
    this.spy();
  }

  /** Mark `id` as the section in hand (opened from its own header), or nothing. */
  pin(id: string | undefined): void {
    this.#pinned = id;
  }

  /** Dot the buttons of the sections with changes, `counts` by id; their names say how many. */
  mark(counts: ReadonlyMap<string, number>): void {
    for (const entry of this.#entries) {
      const button = this.#buttons.get(entry.id);
      if (!button) continue;
      const count = counts.get(entry.id) ?? 0;
      const label = count > 0 ? `${entry.title} (${count} changed)` : entry.title;
      button.classList.toggle("changed", count > 0);
      setAttr(button, "title", label);
      setAttr(button, "aria-label", label);
    }
  }

  /**
   * Mark, in the next frame, the button of the section in view: the one jumped to or opened while
   * it shows, otherwise the first at the top of the body, the last at its end, and in between the
   * one under a reading line a little below the top. Hidden sections' buttons are dimmed. Asked for
   * on a scroll, when the view shows, is rebuilt or its sections show, hide, open or fold; the frame
   * lays the body out anyway, so reading it then forces no layout of its own.
   */
  spy(): void {
    if (this.#spying !== undefined) return;
    this.#spying = requestAnimationFrame(() => {
      this.#spying = undefined;
      this.#mark();
    });
  }

  #mark(): void {
    const body = this.#body;
    const top = body.scrollTop;
    const bottom = top + body.clientHeight;
    const visible = this.#entries.filter((entry) => !entry.el.hidden);
    const pinned = visible.find((entry) => entry.id === this.#pinned);
    let current: RailEntry | undefined;
    if (
      pinned &&
      pinned.el.offsetTop < bottom &&
      pinned.el.offsetTop + pinned.el.offsetHeight > top
    )
      current = pinned;
    else if (top <= 0) current = visible[0];
    else if (bottom >= body.scrollHeight - 1) current = visible.at(-1);
    else {
      const line = top + Math.min(body.clientHeight / 4, 96);
      current = visible.findLast((entry) => entry.el.offsetTop <= line) ?? visible[0];
    }
    for (const entry of this.#entries) {
      const button = this.#buttons.get(entry.id);
      if (!button) continue;
      button.classList.toggle("dim", entry.el.hidden);
      if (entry === current) setAttr(button, "aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  }

  #jump(entry: RailEntry): void {
    // Open at once (no height animation), so the jump lands on the section's final place.
    this.#body.classList.add("jumping");
    this.#pinned = entry.id;
    entry.open?.();
    this.#body.scrollTo({
      top: entry.el.offsetTop,
      behavior: this.#reducedMotion ? "auto" : "smooth",
    });
    entry.focus?.focus({ preventScroll: true });
    this.spy();
    requestAnimationFrame(() => this.#body.classList.remove("jumping"));
  }
}
