import type { AssemblyCreator, SectionProps } from "@manifold/plugin";
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import type { CreatorIcon } from "@manifold/protocol";
import { ControlIcon, ItemIcon, Menu } from "@manifold/ui";
import { useState, type ReactElement } from "react";
import {
  browserCreatorStorage,
  creatorFace,
  recallCreator,
  rememberCreator,
} from "./creator-choice.ts";

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

/**
 * `core.shell.creators` — THE rail's one creation control: a split button whose face runs the
 * last creator picked on this device and whose ▾ opens a menu of every creator offered to this
 * reader, in declared order. Choosing an entry runs it and makes it the face.
 *
 * The entries are DATA (`host.assembly.creators`, from every plugin's `contributes.creators`),
 * so this row names no kind of thing anybody can create and a stranger's offer — hardened or
 * not — is one more row in the same menu. Running one is the host's single door
 * (`runCreator`): the declared action as the presser, a notice on refusal, and landing in a
 * container the answer names. Both controls carry the entry's `data-action`.
 *
 * Nothing offered, nothing drawn: the row renders null and the stack keeps its seat. Collapsed
 * to icons, the control is a lone "+" that opens the picker beside the rail; running an entry
 * opens the rail first, because what was made appears in a list nobody can read at 64 pixels.
 */
export function CreatorsRow({ host }: SectionProps): ReactElement | null {
  const { creating, runCreator, setSidebarOpen, sidebarOpen } = useWorkspaceShell();
  const creators = host.assembly.creators;
  const [lastPick, setLastPick] = useState(() => recallCreator(browserCreatorStorage()));
  const [picking, setPicking] = useState(false);
  const face = creatorFace(creators, lastPick);
  if (face === null) return null;

  const run = (creator: AssemblyCreator): void => {
    if (!sidebarOpen) setSidebarOpen(true);
    rememberCreator(browserCreatorStorage(), creator.id);
    setLastPick(creator.id);
    runCreator(creator);
  };
  const picker = (trigger: ReactElement): ReactElement => (
    <Menu
      open={picking}
      onOpenChange={setPicking}
      trigger={trigger}
      label="Create"
      side={sidebarOpen ? "bottom" : "right"}
      align="start"
      items={creators.map((creator) => ({
        id: creator.id,
        label: creator.title,
        icon: <CreatorGlyph icon={creator.icon} />,
        action: creator.action,
      }))}
      onSelect={(id) => {
        const chosen = creators.find((creator) => creator.id === id);
        if (chosen !== undefined) run(chosen);
      }}
    />
  );

  if (!sidebarOpen) {
    return picker(
      <button
        className="sidebar-creator-pick is-alone"
        type="button"
        aria-haspopup="menu"
        aria-label="Create…"
        title="Create…"
        disabled={creating}
      >
        <ControlIcon kind="add" />
      </button>,
    );
  }
  return (
    <div className="sidebar-creator" role="group" aria-label="Create">
      <button
        className="sidebar-creator-face"
        type="button"
        data-action={face.action}
        data-creator={face.id}
        title={face.title}
        disabled={creating}
        onClick={() => run(face)}
      >
        <ControlIcon kind="add" />
        <span>{face.title}</span>
      </button>
      {picker(
        <button
          className="sidebar-creator-pick"
          type="button"
          aria-haspopup="menu"
          aria-label="Choose what to create"
          title="Choose what to create"
          disabled={creating}
        >
          <ControlIcon kind="disclosed" size={14} />
        </button>,
      )}
    </div>
  );
}
