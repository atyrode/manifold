import type { AssemblyCreator, SectionProps } from "@manifold/plugin";
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import type { CreatorIcon } from "@manifold/protocol";
import { ControlIcon, ItemIcon } from "@manifold/ui";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { cycleCreator, draftCreator, recallCreator, rememberCreator } from "./creator-choice.ts";
import { browserStorage } from "./device-storage.ts";

/** A creator's declared mark: the neutral glyph for `add`, the item mark for everything else. */
function CreatorGlyph({ icon }: { readonly icon: CreatorIcon }): ReactElement {
  switch (icon) {
    case "add":
      return <ControlIcon kind="add" />;
    case "canvas":
    case "composition":
    case "folder":
    case "terminal":
    case "machine":
      return <ItemIcon kind={icon} />;
    default: {
      const unhandled: never = icon;
      return unhandled;
    }
  }
}

/** The declared name a creator makes with when the field is left empty, if it takes a name. */
function defaultName(creator: AssemblyCreator): string | null {
  if (creator.nameInput === undefined) return null;
  const declared = creator.input[creator.nameInput];
  return typeof declared === "string" ? declared : null;
}

/**
 * `core.shell.creators` — THE rail's one creation control: a DRAFT ENTRY. At rest it is a quiet
 * "+ New…" row; pressing it turns that row, in place, into an unsaved entry — the chosen
 * creator's mark and a focused name field whose placeholder is that creator's default name —
 * with every creator offered to this reader listed under it by title, the chosen one checked.
 * "New … what?" is answered ON the thing being named: Tab / Shift+Tab or the mark step the
 * choice, a listed title picks it, Enter makes the thing already named (the default name when
 * the field is empty), Escape drops the draft, and leaving the draft drops it when empty and
 * makes it when named. A refused creation keeps the draft and its typed name. The draft opens
 * on the creator last run on this device.
 *
 * The creators are DATA (`host.assembly.creators`, from every plugin's `contributes.creators`),
 * so this row names nothing anybody can create and a stranger's offer — hardened or not — is
 * one more title in the same list. Running one is the host's single door (`runCreator`): the
 * declared action as the presser with the typed name in its `nameInput`, a notice on refusal,
 * and landing in a container the answer names. The draft form carries the chosen creator's
 * `data-action`. A creator that takes no name shows its title where the field would be.
 *
 * Nothing offered, nothing drawn: the row renders null and the stack keeps its seat. Collapsed
 * to icons, the control is a lone "+" that opens the rail with the draft, because a name is
 * typed in a field nobody can read at 64 pixels.
 */
export function CreatorsRow({ host }: SectionProps): ReactElement | null {
  const { creating, runCreator, setSidebarOpen, sidebarOpen } = useWorkspaceShell();
  const creators = host.assembly.creators;
  const [lastPick, setLastPick] = useState(() => recallCreator(browserStorage()));
  const [drafting, setDrafting] = useState(false);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const focusTarget = useRef<HTMLInputElement & HTMLButtonElement>(null);
  // One settle at a time: Enter, then the focus a landing navigation steals, must not run twice.
  const settling = useRef(false);
  // Escape hands focus back to "+ New…", where the reader started.
  const returnFocus = useRef(false);
  const hintId = useId();
  const chosen =
    creators.find((creator) => creator.id === chosenId) ?? draftCreator(creators, lastPick);

  // The field (or a nameless creator's button) takes focus when the draft opens and when the
  // choice swaps one for the other, so typing and Tab always land on the draft.
  useEffect(() => {
    if (drafting) focusTarget.current?.focus();
  }, [drafting, chosen?.id]);

  if (chosen === null) return null;

  const open = (): void => {
    if (!sidebarOpen) setSidebarOpen(true);
    setChosenId(null);
    setName("");
    setDrafting(true);
  };
  const close = (): void => {
    setDrafting(false);
    setName("");
  };
  const submit = async (): Promise<void> => {
    if (settling.current) return;
    settling.current = true;
    try {
      if (await runCreator(chosen, name)) {
        rememberCreator(browserStorage(), chosen.id);
        setLastPick(chosen.id);
        close();
      } else {
        focusTarget.current?.focus();
      }
    } finally {
      settling.current = false;
    }
  };
  const step = (by: 1 | -1): void => {
    const next = cycleCreator(creators, chosen.id, by);
    if (next !== null) setChosenId(next.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      returnFocus.current = true;
      close();
    } else if (event.key === "Tab" && creators.length > 1) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };
  // Leaving the draft settles it: a named draft is made, an empty one is dropped. Checked after
  // the focus move lands, because a swap between field and button remounts inside the draft; a
  // draft already gone (Escape, or made) has nothing left to settle.
  const onBlur = (event: FocusEvent<HTMLFormElement>): void => {
    const form = event.currentTarget;
    setTimeout(() => {
      if (settling.current || !form.isConnected || form.contains(document.activeElement)) return;
      if (name.trim() === "") close();
      else void submit();
    }, 0);
  };

  if (!drafting) {
    return (
      <button
        ref={(button) => {
          if (button !== null && returnFocus.current) {
            returnFocus.current = false;
            button.focus();
          }
        }}
        className={sidebarOpen ? "sidebar-creator" : "sidebar-creator is-alone"}
        type="button"
        aria-label="New…"
        title="New…"
        disabled={creating}
        onClick={open}
      >
        <ControlIcon kind="add" />
        {sidebarOpen ? <span>New…</span> : null}
      </button>
    );
  }

  const placeholder = defaultName(chosen);
  return (
    <form
      className="sidebar-draft"
      aria-label="New"
      aria-busy={creating}
      data-action={chosen.action}
      data-creator={chosen.id}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="sidebar-draft-line">
        <button
          className="sidebar-draft-mark"
          type="button"
          tabIndex={-1}
          aria-label={`${chosen.title}, change what to create`}
          title="Change what to create (Tab)"
          // Pressed with the name field still focused, so typing carries on after the swap.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => step(1)}
        >
          <CreatorGlyph icon={chosen.icon} />
        </button>
        {placeholder === null ? (
          <button
            ref={focusTarget}
            className="sidebar-draft-name is-fixed"
            type="submit"
            aria-describedby={hintId}
          >
            {chosen.title}
          </button>
        ) : (
          <input
            ref={focusTarget}
            className="sidebar-draft-name"
            type="text"
            value={name}
            placeholder={placeholder}
            aria-label={`${chosen.title} name`}
            aria-describedby={hintId}
            readOnly={creating}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </div>
      {creators.length > 1 ? (
        <div className="sidebar-draft-choices" role="radiogroup" aria-label="What to create">
          {creators.map((creator) => (
            <button
              key={creator.id}
              className="sidebar-draft-choice"
              type="button"
              role="radio"
              tabIndex={-1}
              aria-checked={creator.id === chosen.id}
              data-creator={creator.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setChosenId(creator.id)}
            >
              {creator.title}
            </button>
          ))}
        </div>
      ) : null}
      <p className="sidebar-draft-hint" id={hintId}>
        {creators.length > 1 ? "Tab switch · ↵ create · Esc cancel" : "↵ create · Esc cancel"}
      </p>
    </form>
  );
}
