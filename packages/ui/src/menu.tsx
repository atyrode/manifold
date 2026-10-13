import { useRef, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Popover } from "./popover.tsx";

/**
 * ONE CHOICE IN A {@link Menu}. `action`, when the item dispatches a door, is stamped on the
 * item as `data-action` — the DOM names what pressing it opens, exactly as on any other
 * control (AXIOMS.md §Foundation law) — and the menu itself never dispatches anything.
 */
export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly action?: string;
}

export interface MenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * The menu button, the adopter's own element exactly as {@link Popover} takes one; it should
   * say `aria-haspopup="menu"`, which overrides the layer's default announcement.
   */
  readonly trigger: ReactElement;
  /** The menu's accessible name: nothing inside it labels the list as a whole. */
  readonly label: string;
  readonly items: readonly MenuItem[];
  /** The chosen item's id. The menu closes itself after; what choosing MEANS is the adopter's. */
  readonly onSelect: (id: string) => void;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
}

/** The one key table a menu answers: where focus goes from `at` among `count` items. */
const MOVES: Readonly<Record<string, (at: number, count: number) => number>> = {
  ArrowDown: (at, count) => (at + 1) % count,
  ArrowUp: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_at, count) => count - 1,
};

/**
 * THE one menu: a list of choices anchored to a menu button, built ON {@link Popover} rather
 * than beside it — the layer, its positioning, outside-press and Escape dismissal, and focus
 * returning to the trigger when the layer closes are the popover's, so this file owns only
 * what makes a list a MENU:
 *
 *   - the roles: the layer is `role="menu"` with the given name, each choice a `menuitem`;
 *   - roving focus: opening focuses the first item, the arrow keys move between items and wrap,
 *     Home and End jump to either end, and only one item is ever a tab stop, so Tab leaves the
 *     menu (and closes it) instead of walking its rows;
 *   - choosing: Enter, Space or a press selects, then the menu closes.
 *
 * No typeahead and no submenus: nothing that adopts this needs them, and each is a prop the day
 * something does.
 */
export function Menu({
  open,
  onOpenChange,
  trigger,
  label,
  items,
  onSelect,
  side,
  align,
}: MenuProps): ReactElement {
  const list = useRef<HTMLDivElement>(null);
  const rove = (event: KeyboardEvent<HTMLDivElement>): void => {
    const move = MOVES[event.key];
    const buttons = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (move === undefined || buttons.length === 0) return;
    event.preventDefault();
    const at = buttons.findIndex((button) => button === document.activeElement);
    buttons[move(Math.max(at, 0), buttons.length)]?.focus();
  };
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      {...(side === undefined ? {} : { side })}
      {...(align === undefined ? {} : { align })}
      contentClassName="menu"
      contentRole="menu"
      contentLabel={label}
    >
      <div className="menu__items" ref={list} onKeyDown={rove}>
        {items.map((item, index) => (
          <button
            key={item.id}
            className="menu__item"
            type="button"
            role="menuitem"
            tabIndex={index === 0 ? 0 : -1}
            data-menu-item={item.id}
            {...(item.action === undefined ? {} : { "data-action": item.action })}
            onClick={() => {
              onSelect(item.id);
              onOpenChange(false);
            }}
          >
            {item.icon === undefined ? null : (
              <span className="menu__icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="menu__label">{item.label}</span>
          </button>
        ))}
      </div>
    </Popover>
  );
}
