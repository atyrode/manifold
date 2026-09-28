import type { UiIcon, UiSelectOption, UiTone } from "@manifold/protocol";
import type { ReactElement } from "react";
import {
  frameElement,
  frameMeta,
  refuseInFrame,
  useFrameMode,
  type FrameMeta,
} from "./frame-mode.tsx";
import { ControlIcon, ItemIcon } from "./icons.tsx";

/**
 * THE COMPONENT VOCABULARY (ADR 0016 §3, ADR 0053): the closed set of things a panel can show
 * and press that holds in BOTH execution modes. Each component here is the one implementation
 * of its `UiNode` kind. In the page it paints its own DOM into the `mf-vocab` family
 * (`styles.css`); under a frame root it emits its kind's intrinsic instead
 * (`frame-mode.tsx`); and the host paints a Worker's tree back through these same components
 * — so a portable plugin and the tree it sent look and behave exactly alike, and the semantics
 * of a button or a field are written once.
 *
 * THE PROPS ARE THE VOCABULARY'S, NOT THE DOM'S. Text comes as children (flattened to one
 * string: anything that is not text refuses in both modes, because a frame cannot carry an
 * element inside a label), callbacks take the scalar a control produces and never an event,
 * and the only attributes are the four the protocol names as metadata — `title`,
 * `aria-label`, `data-testid` and a `status`/`alert` `role`. Metadata lands on the CONTROL
 * for the four controls and on the component's own root otherwise. Anything else refuses by
 * name, in both modes, so a panel that works in the page cannot lose a prop in a Worker.
 *
 * Tones are the shell's own colours read back; keyboard focus and hover follow the shell's
 * row conventions; nothing animates.
 */

/** What a text-bearing component accepts as children: text, numbers, and React's blanks. */
export type VocabularyText =
  string | number | bigint | boolean | null | undefined | readonly VocabularyText[];

/** The metadata every vocabulary component may carry, spelled as the standard attributes. */
export interface VocabularyMeta {
  readonly title?: string | undefined;
  readonly "aria-label"?: string | undefined;
  readonly "data-testid"?: string | undefined;
  readonly role?: "status" | "alert" | undefined;
}

/** Joins children into the one string a node shows, exactly as React would print them. */
function textOf(component: string, children: unknown): string {
  if (typeof children === "string") return children;
  if (typeof children === "number" || typeof children === "bigint") return String(children);
  if (children === null || children === undefined || typeof children === "boolean") return "";
  if (Array.isArray(children)) {
    let text = "";
    for (const child of children) text += textOf(component, child);
    return text;
  }
  return refuseInFrame(component, "a child that is not text");
}

/** The metadata back as the DOM attributes it was authored as. */
function attributes(meta: FrameMeta): VocabularyMeta {
  return {
    title: meta.title,
    "aria-label": meta.ariaLabel,
    "data-testid": meta.testId,
    role: meta.role,
  };
}

/**
 * The anchor plus the shell's `is-<flag>` state class for every flag that is on
 * (`.sidebar-row.is-editing`): the anchor names the family for S13, a flag qualifies it and
 * registers nothing.
 */
function anchored(anchor: string, flags: Readonly<Record<string, boolean | undefined>>): string {
  let className = anchor;
  for (const flag in flags) if (flags[flag] === true) className += ` is-${flag}`;
  return className;
}

/** A glyph named as protocol data, drawn from the icon vocabulary's own tables. */
function IconGlyph({ icon }: { readonly icon: UiIcon }): ReactElement {
  return icon.family === "control" ? (
    <ControlIcon kind={icon.name} size={icon.size} />
  ) : (
    <ItemIcon kind={icon.name} size={icon.size} />
  );
}

export interface HeadingProps extends VocabularyMeta {
  /** Unset: 2, the section's own title size. */
  readonly level?: 1 | 2 | 3 | undefined;
  readonly children?: VocabularyText;
}

export function Heading({ level, children, ...rest }: HeadingProps): ReactElement {
  const inFrame = useFrameMode();
  const text = textOf("Heading", children);
  const meta = frameMeta("Heading", rest);
  if (inFrame) return frameElement("heading", { text, level, ...meta });
  const shown = level ?? 2;
  const Tag = `h${String(shown)}` as "h1" | "h2" | "h3";
  return (
    <Tag className="mf-vocab-heading" data-level={shown} {...attributes(meta)}>
      {text}
    </Tag>
  );
}

export interface TextProps extends VocabularyMeta {
  readonly tone?: UiTone | undefined;
  readonly mono?: boolean | undefined;
  /** Wraps anywhere instead of truncating with an ellipsis, the default overflow contract. */
  readonly wrap?: boolean | undefined;
  readonly strong?: boolean | undefined;
  /**
   * Takes the free space of the row or column it sits in, from a zero basis: a growing label
   * truncates in place rather than pushing its neighbours onto a new line.
   */
  readonly grow?: boolean | undefined;
  readonly children?: VocabularyText;
}

export function Text({
  tone,
  mono,
  wrap,
  strong,
  grow,
  children,
  ...rest
}: TextProps): ReactElement {
  const inFrame = useFrameMode();
  const text = textOf("Text", children);
  const meta = frameMeta("Text", rest);
  if (inFrame) return frameElement("text", { text, tone, mono, wrap, strong, grow, ...meta });
  return (
    <span
      className={anchored("mf-vocab-text", { mono, wrap, strong, grow })}
      data-tone={tone}
      {...attributes(meta)}
    >
      {text}
    </span>
  );
}

export interface CodeProps extends VocabularyMeta {
  readonly children?: VocabularyText;
}

export function Code({ children, ...rest }: CodeProps): ReactElement {
  const inFrame = useFrameMode();
  const text = textOf("Code", children);
  const meta = frameMeta("Code", rest);
  if (inFrame) return frameElement("code", { text, ...meta });
  return (
    <pre className="mf-vocab-code" {...attributes(meta)}>
      {text}
    </pre>
  );
}

export interface BadgeProps extends VocabularyMeta {
  readonly tone?: UiTone | undefined;
  readonly children?: VocabularyText;
}

export function Badge({ tone, children, ...rest }: BadgeProps): ReactElement {
  const inFrame = useFrameMode();
  const text = textOf("Badge", children);
  const meta = frameMeta("Badge", rest);
  if (inFrame) return frameElement("badge", { text, tone, ...meta });
  return (
    <span className="mf-vocab-badge" data-tone={tone} {...attributes(meta)}>
      {text}
    </span>
  );
}

export type DividerProps = VocabularyMeta;

export function Divider(props: DividerProps): ReactElement {
  const inFrame = useFrameMode();
  const meta = frameMeta("Divider", props);
  if (inFrame) return frameElement("divider", { ...meta });
  return <hr className="mf-vocab-divider" {...attributes(meta)} />;
}

export interface SpinnerProps extends VocabularyMeta {
  /** What is arriving. Unset: "Loading". */
  readonly label?: string | undefined;
}

/** A still ring and its words: "the answer is arriving", announced politely, never animated. */
export function Spinner({ label, ...rest }: SpinnerProps): ReactElement {
  const inFrame = useFrameMode();
  const meta = frameMeta("Spinner", rest);
  if (inFrame) return frameElement("spinner", { label, ...meta });
  return (
    <div
      className="mf-vocab-spinner"
      aria-live="polite"
      {...attributes(meta)}
      role={meta.role ?? "status"}
    >
      <span className="mf-vocab-spinner__mark" aria-hidden="true" />
      <span className="mf-vocab-spinner__label">{label ?? "Loading"}</span>
    </div>
  );
}

export interface ButtonProps extends VocabularyMeta {
  /** The label. An icon-only button keeps it as its accessible name. */
  readonly children?: VocabularyText;
  readonly onClick: () => void;
  /** Focus left the button — the idiom that disarms a two-press confirmation. */
  readonly onBlur?: (() => void) | undefined;
  readonly tone?: UiTone | undefined;
  readonly disabled?: boolean | undefined;
  /**
   * The FULL action name the press ultimately dispatches, painted as `data-action` so the
   * affordance names the door it opens (AXIOMS.md §Foundation law and REGISTRY.md §Foundation,
   * S4). Unset when the press dispatches none.
   */
  readonly "data-action"?: string | undefined;
  readonly icon?: UiIcon | undefined;
  /** Shows only the icon; ignored without one, so a label is never lost. */
  readonly iconOnly?: boolean | undefined;
}

export function Button({
  children,
  onClick,
  onBlur,
  tone,
  disabled,
  "data-action": action,
  icon,
  iconOnly,
  ...rest
}: ButtonProps): ReactElement {
  const inFrame = useFrameMode();
  const label = textOf("Button", children);
  const meta = frameMeta("Button", rest);
  if (inFrame) {
    return frameElement("button", {
      label,
      onClick,
      onBlur,
      tone,
      disabled,
      action,
      icon,
      iconOnly,
      ...meta,
    });
  }
  const bare = iconOnly === true && icon !== undefined;
  return (
    <button
      type="button"
      className={anchored("mf-vocab-button", { "icon-only": bare })}
      data-tone={tone}
      data-action={action}
      disabled={disabled === true}
      {...attributes(meta)}
      aria-label={meta.ariaLabel ?? (bare ? label : undefined)}
      onClick={() => onClick()}
      onBlur={onBlur === undefined ? undefined : () => onBlur()}
    >
      {icon === undefined ? null : <IconGlyph icon={icon} />}
      {bare ? null : label}
    </button>
  );
}

export interface SelectProps extends VocabularyMeta {
  /** `null` is "nothing chosen yet": an empty option holds the seat so the field can say so. */
  readonly value: string | null;
  readonly options: readonly UiSelectOption[];
  readonly label?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly onChange: (value: string) => void;
  readonly onBlur?: (() => void) | undefined;
}

/** Controlled by its value: the owner renders the choice back. */
export function Select({
  value,
  options,
  label,
  disabled,
  onChange,
  onBlur,
  ...rest
}: SelectProps): ReactElement {
  const inFrame = useFrameMode();
  const meta = frameMeta("Select", rest);
  if (inFrame) {
    return frameElement("select", { value, options, label, disabled, onChange, onBlur, ...meta });
  }
  const control = (
    <select
      className="mf-vocab-select"
      value={value ?? ""}
      disabled={disabled === true}
      {...attributes(meta)}
      onChange={(event) => onChange(event.currentTarget.value)}
      onBlur={onBlur === undefined ? undefined : () => onBlur()}
    >
      {value === null ? <option value="" /> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
  if (label === undefined) return control;
  return (
    <label className="mf-vocab-select__field">
      <span className="mf-vocab-select__label">{label}</span>
      {control}
    </label>
  );
}

export interface InputProps extends VocabularyMeta {
  readonly value: string;
  readonly label?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly mono?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  /** Every edit, as the field's whole text. */
  readonly onChange: (value: string) => void;
  readonly onBlur?: (() => void) | undefined;
}

/**
 * A one-line text field that posts every edit but keeps the DOM as its buffer while focused.
 * A controlled field would revert to `value` until the owner's echo arrived — a Worker round
 * trip away when the owner is a portable plugin — which drops characters typed inside that
 * trip and breaks composition (IME) outright. So the field is uncontrolled: `value` is
 * written into it on every render it is NOT focused for, and on blur — the owner's answer
 * wins the moment the reader stops typing, never while they are.
 */
export function Input({
  value,
  label,
  placeholder,
  mono,
  disabled,
  onChange,
  onBlur,
  ...rest
}: InputProps): ReactElement {
  const inFrame = useFrameMode();
  const meta = frameMeta("Input", rest);
  if (inFrame) {
    return frameElement("input", {
      value,
      label,
      placeholder,
      mono,
      disabled,
      onChange,
      onBlur,
      ...meta,
    });
  }
  const control = (
    <input
      type="text"
      className={anchored("mf-vocab-input", { mono })}
      defaultValue={value}
      placeholder={placeholder}
      disabled={disabled === true}
      {...attributes(meta)}
      /*
        The buffer discipline described above: this callback runs on every commit (it is a
        fresh closure each render), so a value that arrived while the field was not being typed
        into lands in the DOM; one that arrived mid-typing waits for the blur.
      */
      ref={(element) => {
        if (element !== null && element.ownerDocument.activeElement !== element) {
          element.value = value;
        }
      }}
      onChange={(event) => onChange(event.currentTarget.value)}
      onBlur={(event) => {
        event.currentTarget.value = value;
        onBlur?.();
      }}
    />
  );
  if (label === undefined) return control;
  return (
    <label className="mf-vocab-input__field">
      <span className="mf-vocab-input__label">{label}</span>
      {control}
    </label>
  );
}

export interface ToggleProps extends VocabularyMeta {
  readonly value: boolean;
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly onChange: (value: boolean) => void;
  readonly onBlur?: (() => void) | undefined;
}

/** Controlled by its value, like the select. */
export function Toggle({
  value,
  label,
  disabled,
  onChange,
  onBlur,
  ...rest
}: ToggleProps): ReactElement {
  const inFrame = useFrameMode();
  const meta = frameMeta("Toggle", rest);
  if (inFrame) {
    return frameElement("toggle", { value, label, disabled, onChange, onBlur, ...meta });
  }
  return (
    <label className="mf-vocab-toggle">
      <input
        type="checkbox"
        className="mf-vocab-toggle__control"
        checked={value}
        disabled={disabled === true}
        {...attributes(meta)}
        onChange={(event) => onChange(event.currentTarget.checked)}
        onBlur={onBlur === undefined ? undefined : () => onBlur()}
      />
      <span className="mf-vocab-toggle__label">{label}</span>
    </label>
  );
}

/** One row of a {@link List}: pressable exactly when it has an `onClick`. */
export interface ListItem {
  readonly key: string;
  readonly primary: string;
  readonly secondary?: string | undefined;
  readonly tone?: UiTone | undefined;
  readonly onClick?: (() => void) | undefined;
}

export interface ListProps extends VocabularyMeta {
  readonly items: readonly ListItem[];
}

/** A row with a press is a button; one without is a reading. One shape, so a list reads evenly. */
function ListRow({ item }: { readonly item: ListItem }): ReactElement {
  const body = (
    <>
      <span className="mf-vocab-list__primary">{item.primary}</span>
      {item.secondary === undefined ? null : (
        <span className="mf-vocab-list__secondary">{item.secondary}</span>
      )}
    </>
  );
  const { onClick } = item;
  return (
    <li className="mf-vocab-list__item" data-tone={item.tone}>
      {onClick === undefined ? (
        <div className="mf-vocab-list__row">{body}</div>
      ) : (
        <button type="button" className="mf-vocab-list__row is-pressable" onClick={() => onClick()}>
          {body}
        </button>
      )}
    </li>
  );
}

export function List({ items, ...rest }: ListProps): ReactElement {
  const inFrame = useFrameMode();
  const meta = frameMeta("List", rest);
  if (inFrame) return frameElement("list", { items, ...meta });
  return (
    <ul className="mf-vocab-list" {...attributes(meta)}>
      {items.map((item) => (
        <ListRow key={item.key} item={item} />
      ))}
    </ul>
  );
}

export interface EmptyProps extends VocabularyMeta {
  readonly children?: VocabularyText;
}

/** The placeholder idiom: what a region says when it has nothing to show. */
export function Empty({ children, ...rest }: EmptyProps): ReactElement {
  const inFrame = useFrameMode();
  const text = textOf("Empty", children);
  const meta = frameMeta("Empty", rest);
  if (inFrame) return frameElement("empty", { text, ...meta });
  return (
    <p className="mf-vocab-empty" {...attributes(meta)}>
      {text}
    </p>
  );
}
