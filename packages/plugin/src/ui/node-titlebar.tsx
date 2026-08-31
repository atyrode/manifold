import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { ControlIcon } from "./icons.tsx";

/**
 * The one titlebar every container node wears. A terminal on a canvas, a view
 * widget (portal), and the composed renderer's own header are all the same
 * object seen from different distances, so they share one bar:
 *
 *   icon | title | modular middle slot | right-justified minimize/maximize/close
 *
 * Every part is optional per node type — a control renders exactly when its
 * callback exists — and the title is both hand-editable (double-click) and
 * API-editable (the action behind `onRenameTitle`), falling back to the type
 * default when the object has no custom name.
 *
 * Adopters keep their own class on the bar (`className`): those classes are
 * drag handles and proof hooks (TERMINAL_DRAG_HANDLE, PORTAL_DRAG_HANDLE,
 * `.tiled-header`), so the bar never owns them.
 */

/** Wrapper class of the control cluster; adopters guard bar-level gestures with it. */
export const TITLEBAR_ACTIONS_CLASS = "node-titlebar__actions";

/**
 * `shrink` is the composed renderer's maximize slot: inside a view the same corner
 * that would blow a node up is the way back out of it.
 */
export type MaximizeControl = "maximize" | "shrink";

const MAX_TITLE_LENGTH = 120;

export interface NodeTitleBarProps {
  /** The object's identity mark — an `ItemIcon`, never a hand-picked drawing. */
  readonly icon: ReactNode;
  /** The object's custom name; null falls back to `defaultTitle`. */
  readonly title: string | null;
  /** Type default shown while the object is unnamed. */
  readonly defaultTitle: string;
  /** Adopter class (drag handle / assertion hook), merged onto the bar. */
  readonly className?: string;
  /**
   * Renames the object. Double-clicking the TITLE opens an inline input — Enter
   * commits, Escape cancels, blur cancels — and the gesture stops propagating so
   * a bar-level double-click (expand, enter) still belongs to the bar.
   *
   * The callback props below spell `| undefined` out: adopters compute them from
   * their own optional props (a preview terminal has no controls at all), and
   * `exactOptionalPropertyTypes` rejects passing `undefined` otherwise.
   */
  readonly onRenameTitle?: ((name: string) => void) | undefined;
  /**
   * The FULL composed action name {@link NodeTitleBarProps.onRenameTitle} fires, marked into
   * the DOM as `data-action` (AGENTS invariant 12; gate S4/R7 checks every marker against the
   * live roster). Supplied by the adopter because the same bar renames pads and compositions
   * too, and those doors are not actions yet.
   */
  readonly renameAction?: string | undefined;
  /** Modular slot: a terminal's origin machine, a view's bubble chip, presence. */
  readonly middle?: ReactNode;
  /** Bar-level double-click, e.g. expand a terminal. Controls never reach it. */
  readonly onDoubleClick?: ((event: ReactMouseEvent<HTMLDivElement>) => void) | undefined;
  readonly onMinimize?: (() => void) | undefined;
  readonly minimizeLabel?: string;
  readonly minimizeTooltip?: string;
  readonly onMaximize?: (() => void) | undefined;
  readonly maximizeControl?: MaximizeControl;
  readonly maximizeLabel?: string;
  readonly maximizeTooltip?: string;
  /**
   * Destruction is ONE click, everywhere. An armed second step in a titlebar bought
   * hesitation at the price of a control that lied about what a click does.
   */
  readonly onClose?: (() => void) | undefined;
  readonly closeLabel?: string;
  readonly closeTooltip?: string;
  /** Extra classes on the close control, so adopters keep proof-coupled hooks. */
  readonly closeClassName?: string;
  /** Node-specific controls (Pin), rendered ahead of the standard cluster. */
  readonly extraActions?: ReactNode;
}

export function NodeTitleBar({
  icon,
  title,
  defaultTitle,
  className,
  onRenameTitle,
  renameAction,
  middle,
  onDoubleClick,
  onMinimize,
  minimizeLabel = "Minimize",
  minimizeTooltip,
  onMaximize,
  maximizeControl = "maximize",
  maximizeLabel,
  maximizeTooltip,
  onClose,
  closeLabel = "Close",
  closeTooltip,
  closeClassName,
  extraActions,
}: NodeTitleBarProps): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editing = draft !== null && onRenameTitle !== undefined;
  const display = title ?? defaultTitle;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.select();
  }, [editing]);

  /**
   * Double-click ZONES. Three of them, and every pixel of the bar belongs to exactly one:
   * the title TEXT opens the rename, the control cluster is its own gesture, and everything
   * else — icon, middle slot, and the empty run that is most of a bar — is the bar's own
   * action. That partition only holds because `.node-titlebar__title` sizes to its content
   * (`justify-self: start`) instead of stretching across its grid column: a stretched title
   * swallows the bar, and renaming becomes the only thing a double-click can ever do.
   */
  const beginRename = (event: ReactMouseEvent<HTMLSpanElement>): void => {
    if (onRenameTitle === undefined) return;
    // Renaming a title and blowing the node up are different intentions on adjacent pixels.
    event.stopPropagation();
    setDraft(title ?? defaultTitle);
  };

  /** A control's own double-click is the control's, never the bar's. */
  const barDoubleClick =
    onDoubleClick === undefined
      ? undefined
      : (event: ReactMouseEvent<HTMLDivElement>): void => {
          if (
            event.target instanceof Element &&
            event.target.closest(`.${TITLEBAR_ACTIONS_CLASS}`) !== null
          ) {
            return;
          }
          onDoubleClick(event);
        };

  const commitRename = (): void => {
    const next = (draft ?? "").trim();
    setDraft(null);
    if (next === "" || next === display) return;
    onRenameTitle?.(next);
  };

  const stopDrag = (event: ReactMouseEvent | React.PointerEvent): void => {
    event.stopPropagation();
  };

  const maximizeName = maximizeLabel ?? (maximizeControl === "shrink" ? "Shrink" : "Maximize");

  return (
    <div
      className={className === undefined ? "node-titlebar" : `node-titlebar ${className}`}
      onDoubleClick={barDoubleClick}
    >
      <span className="node-titlebar__icon" aria-hidden="true">
        {icon}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className="node-titlebar__title-input"
          {...(renameAction === undefined ? {} : { "data-action": renameAction })}
          aria-label={`Rename ${display}`}
          maxLength={MAX_TITLE_LENGTH}
          value={draft ?? ""}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onPointerDown={stopDrag}
          onDoubleClick={stopDrag}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") {
              // The composed renderer shrinks on a window-level Escape and only
              // yields to a handled one, so cancelling an edit must mark it.
              event.preventDefault();
              setDraft(null);
            }
          }}
          onBlur={() => setDraft(null)}
        />
      ) : (
        <span
          className="node-titlebar__title"
          title={onRenameTitle === undefined ? display : `${display} — double-click to rename`}
          onDoubleClick={beginRename}
        >
          {display}
        </span>
      )}
      <span className="node-titlebar__middle">{middle}</span>
      <span className={TITLEBAR_ACTIONS_CLASS}>
        {extraActions}
        {onMinimize === undefined ? null : (
          <button
            type="button"
            className="node-titlebar__ctl node-titlebar__ctl--minimize"
            title={minimizeTooltip ?? minimizeLabel}
            aria-label={minimizeLabel}
            onPointerDown={stopDrag}
            onClick={onMinimize}
          >
            <ControlIcon kind="park" size={12} />
          </button>
        )}
        {onMaximize === undefined ? null : (
          <button
            type="button"
            className="node-titlebar__ctl node-titlebar__ctl--maximize"
            title={maximizeTooltip ?? maximizeName}
            aria-label={maximizeName}
            onPointerDown={stopDrag}
            onClick={onMaximize}
          >
            <ControlIcon kind={maximizeControl} size={12} />
          </button>
        )}
        {onClose === undefined ? null : (
          <button
            type="button"
            className={
              closeClassName === undefined
                ? "node-titlebar__ctl node-titlebar__ctl--close"
                : `node-titlebar__ctl node-titlebar__ctl--close ${closeClassName}`
            }
            title={closeTooltip ?? closeLabel}
            aria-label={closeLabel}
            onPointerDown={stopDrag}
            onClick={onClose}
          >
            <ControlIcon kind="close" size={12} />
          </button>
        )}
      </span>
    </div>
  );
}
