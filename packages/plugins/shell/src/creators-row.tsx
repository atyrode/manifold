import type { AssemblyCreator, SectionProps } from "@manifold/plugin";
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import type { CreatorIcon } from "@manifold/protocol";
import { ControlIcon, ItemIcon, Menu } from "@manifold/ui";
import { useState, type ReactElement } from "react";
import { creatorFace, recallCreator, rememberCreator } from "./creator-choice.ts";
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

/**
 * `core.shell.creators` — THE rail's one creation control, read as one phrase: "+ New Canvas ▾".
 * The shell owns the one verb, "+ New", which runs the current choice in one press; the title
 * beside it IS the choice, a menu button opening every creator offered to this reader by name
 * ("Canvas", "Composition", "Folder"), in declared order. Choosing an entry runs it and makes it
 * the current choice, remembered on this device. The menu lists THINGS, not acts, because the
 * verb is already on the control: an entry that said "New canvas" would repeat it.
 *
 * The entries are DATA (`host.assembly.creators`, from every plugin's `contributes.creators`),
 * so this row names no kind of thing anybody can create and a stranger's offer — hardened or
 * not — is one more row in the same menu. Running one is the host's single door
 * (`runCreator`): the declared action as the presser, a notice on refusal, and landing in a
 * container the answer names. The verb carries the current entry's `data-action`, each menu
 * item its own.
 *
 * Nothing offered, nothing drawn: the row renders null and the stack keeps its seat. Collapsed
 * to icons, the control is a lone "+" that opens the picker beside the rail; running an entry
 * opens the rail first, because what was made appears in a list nobody can read at 64 pixels.
 */
export function CreatorsRow({ host }: SectionProps): ReactElement | null {
  const { creating, runCreator, setSidebarOpen, sidebarOpen } = useWorkspaceShell();
  const creators = host.assembly.creators;
  const [lastPick, setLastPick] = useState(() => recallCreator(browserStorage()));
  const [picking, setPicking] = useState(false);
  const face = creatorFace(creators, lastPick);
  if (face === null) return null;

  const run = (creator: AssemblyCreator): void => {
    if (!sidebarOpen) setSidebarOpen(true);
    rememberCreator(browserStorage(), creator.id);
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
      current={face.id}
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
        aria-label="New…"
        title="New…"
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
        aria-label={`New ${face.title}`}
        title={`New ${face.title}`}
        disabled={creating}
        onClick={() => run(face)}
      >
        <ControlIcon kind="add" />
        <span>New</span>
      </button>
      {picker(
        <button
          className="sidebar-creator-pick"
          type="button"
          aria-haspopup="menu"
          aria-label={`${face.title}, choose what to create`}
          title="Choose what to create"
          disabled={creating}
        >
          <CreatorGlyph icon={face.icon} />
          <span className="sidebar-creator-noun">{face.title}</span>
          <ControlIcon kind="disclosed" size={14} />
        </button>,
      )}
    </div>
  );
}
