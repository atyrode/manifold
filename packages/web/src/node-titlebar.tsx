import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

/**
 * The one titlebar every container node wears. A terminal on a canvas, a view
 * widget (portal), and the composed renderer's own header are all the same
 * object seen from different distances, so they share one bar:
 *
 *   icon | title | modular middle slot | right-justified minimize/maximize/close
 *
 * Every part is optional per node type — a control renders exactly when its
 * callback exists — and the title is both hand-editable (double-click) and
 * API-editable (the rename endpoints behind `onRenameTitle`), falling back to
 * the type default when the object has no custom name.
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
export type MaximizeGlyph = "maximize" | "shrink";

/**
 * The desktop-window pair — hollow square grows, shadowed square restores — chosen
 * over U+26F6 (⛶) because that codepoint is missing from common Linux symbol fonts
 * and rendered as tofu in a headless Chromium here; both of these paint everywhere.
 */
const MAXIMIZE_GLYPHS: Record<MaximizeGlyph, string> = {
  maximize: "□",
  shrink: "❐",
};

/** An armed confirm disarms itself rather than sitting there looking clickable. */
const CONFIRM_TIMEOUT_MS = 6_000;

const MAX_TITLE_LENGTH = 120;

export interface NodeTitleBarProps {
  /** Type glyph: ▣ for a terminal, ▤ for a container. */
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
  /** Modular slot: a terminal's origin machine, a view's bubble chip, presence. */
  readonly middle?: ReactNode;
  /** Bar-level double-click, e.g. expand a terminal. Controls never reach it. */
  readonly onDoubleClick?: ((event: ReactMouseEvent<HTMLDivElement>) => void) | undefined;
  readonly onMinimize?: (() => void) | undefined;
  readonly minimizeLabel?: string;
  readonly minimizeTooltip?: string;
  readonly onMaximize?: (() => void) | undefined;
  readonly maximizeGlyph?: MaximizeGlyph;
  readonly maximizeLabel?: string;
  readonly maximizeTooltip?: string;
  readonly onClose?: (() => void) | undefined;
  readonly closeLabel?: string;
  readonly closeTooltip?: string;
  /** Extra classes on the close control, so adopters keep proof-coupled hooks. */
  readonly closeClassName?: string;
  /**
   * Two-step confirm prompt for close: the first click arms the bar, the second
   * commits. Absent means close fires immediately (killing your own terminal is
   * a decision; deleting a view everyone shares is not).
   */
  readonly closeConfirm?: string;
  /** Node-specific controls (Pin), rendered ahead of the standard cluster. */
  readonly extraActions?: ReactNode;
}

export function NodeTitleBar({
  icon,
  title,
  defaultTitle,
  className,
  onRenameTitle,
  middle,
  onDoubleClick,
  onMinimize,
  minimizeLabel = "Minimize",
  minimizeTooltip,
  onMaximize,
  maximizeGlyph = "maximize",
  maximizeLabel,
  maximizeTooltip,
  onClose,
  closeLabel = "Close",
  closeTooltip,
  closeClassName,
  closeConfirm,
  extraActions,
}: NodeTitleBarProps): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editing = draft !== null && onRenameTitle !== undefined;
  const display = title ?? defaultTitle;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const beginRename = (event: ReactMouseEvent<HTMLSpanElement>): void => {
    if (onRenameTitle === undefined) return;
    // The bar's own double-click (expand / enter) must not also fire: renaming a
    // title and blowing the node up are different intentions on adjacent pixels.
    event.stopPropagation();
    setDraft(title ?? defaultTitle);
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

  const maximizeName = maximizeLabel ?? (maximizeGlyph === "shrink" ? "Shrink" : "Maximize");

  return (
    <div
      className={className === undefined ? "node-titlebar" : `node-titlebar ${className}`}
      onDoubleClick={onDoubleClick}
    >
      <span className="node-titlebar__icon" aria-hidden="true">
        {icon}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className="node-titlebar__title-input"
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
            –
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
            {MAXIMIZE_GLYPHS[maximizeGlyph]}
          </button>
        )}
        {onClose === undefined ? null : armed ? (
          <span className="node-titlebar__confirm">
            <span className="node-titlebar__confirm-label">{closeConfirm}</span>
            <button
              type="button"
              className="node-titlebar__confirm-yes"
              aria-label={`Confirm ${closeLabel}`}
              onPointerDown={stopDrag}
              onClick={() => {
                setArmed(false);
                onClose();
              }}
            >
              Delete
            </button>
            <button
              type="button"
              className="node-titlebar__confirm-no"
              aria-label={`Cancel ${closeLabel}`}
              onPointerDown={stopDrag}
              onClick={() => setArmed(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
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
            onClick={() => {
              if (closeConfirm === undefined) {
                onClose();
                return;
              }
              setArmed(true);
            }}
          >
            ✕
          </button>
        )}
      </span>
    </div>
  );
}
