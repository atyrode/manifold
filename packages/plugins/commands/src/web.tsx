import "./styles.css";
import type { WebBinding } from "@manifold/plugin";
import { DoorForm } from "@manifold/plugin/ui";
import {
  FALLBACK_POLL_MS,
  INDEX_RESOURCE,
  keyCapLabel,
  requestRebind,
  useNotice,
  usePolledResource,
  type WorkspaceOverlayProps,
} from "@manifold/plugin/hooks";
import { KeyCap, ScrollRegion } from "@manifold/ui";
import { formatManifoldUri, type Cap, type IndexEntry } from "@manifold/protocol";
import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  GROUP_HEADINGS,
  composeCommands,
  type Command as CommandRow,
  type CommandKind,
} from "./commands.ts";
import { COMMANDS_OPEN_BINDING } from "./index.ts";
import { closeCommands, toggleCommands, useCommandsOpen } from "./store.ts";

/**
 * `core.commands`' browser half: the key that opens the surface, and the surface.
 *
 * WHAT IT IS MADE OF is three composed registries and nothing else — the projection lives in
 * `./commands.ts`, tested on its own, and this file paints its answer. The list itself is
 * `cmdk`: filtering, scoring, arrow-key traversal and the `role="option"` wiring are its job,
 * because a search list is a small interaction system with many failure modes and re-typing
 * one is how a product grows a second, worse one
 * (`docs/decisions/2026-09-01-cmdk-command-menu.md`).
 *
 * ONE VERB PER GROUP, and each is the only thing that group's rows can honestly do:
 *
 *   DOORS RUN. A composed action publishes its input schema; a row with no fields dispatches
 *   immediately, while a row with fields opens the shared generated form. Caps are read from
 *   `selfCaps()`, and a door the caller may not open is SHOWN, disabled, carrying the reason —
 *   never hidden. Hiding it would make the workspace's own vocabulary depend on who is looking
 *   without saying so, and a reader (or a stranger's agent) would conclude the door does not
 *   exist. Absence is rendered here for the reason a disabled plugin's panel renders a named
 *   placeholder rather than vanishing (D4′, ADR 0013).
 *
 *   KEYS REBIND. A key row prints what the composition composed and its Enter is a JUMP to the
 *   editor that changes it (`requestRebind`) — because RUNNING the key is what the key is for,
 *   and a row that duplicated the keystroke printed beside it would add nothing, while nothing
 *   else in the product lets a reader go from "what does this do" to "make it something else".
 *   The jump names a binding id and no plugin: whoever owns the binding editor answers.
 *
 *   CONTAINERS OPEN. `manifold://container/<id>` through `host.navigate`, which is the one way
 *   anything sends a viewer anywhere.
 *
 * WHAT IT NEVER DOES is hold state the composition owns. There is no command registry here, no
 * cached roster, no second key table — the surface reads `host.assembly` and the shared index
 * feed while it is open and holds nothing at all while it is closed.
 */

const NO_ENTRIES: readonly IndexEntry[] = [];

/** What Enter does on a row, by group. Rendered on the highlighted row, the way a menu hints. */
const VERBS: Record<CommandKind, string> = {
  door: "Run",
  key: "Rebind",
  container: "Open",
};

/**
 * THE KEY. `Mod+k` is Control on a PC and Command on a Mac, one row either way, because the
 * registry's grammar has one token for the platform's primary modifier.
 *
 * IT COLLIDES WITH A BROWSER DEFAULT, and the honest version of that sentence matters. Chrome,
 * Edge and Firefox all map Ctrl/Cmd+K to "focus the address bar to search" — a real default,
 * not a free key. It is also a CONTENT-PREVENTABLE one: unlike Ctrl+T, Ctrl+N, Ctrl+W or Cmd+Q,
 * the browser lets a page take it, which is why every command menu on the web is on this
 * chord. The engine's dispatcher calls `preventDefault()` on a matched row, so taking it is
 * deliberate rather than incidental — and a reader whose browser, extension or muscle memory
 * disagrees rebinds this row like any other, from the table that lists it.
 *
 * `always` scope: a surface that lists the workspace's doors is not about a canvas or a
 * composition, and it is reachable at the workspace root where neither is mounted.
 */
export const COMMANDS_BINDINGS: readonly WebBinding[] = [
  {
    id: COMMANDS_OPEN_BINDING,
    key: "Mod+k",
    label: "Commands",
    when: "always",
    run: toggleCommands,
  },
];

export function CommandsOverlay({ host }: WorkspaceOverlayProps): ReactElement | null {
  const open = useCommandsOpen();
  return open ? <CommandsDialog host={host} /> : null;
}

function CommandsDialog({ host }: WorkspaceOverlayProps): ReactElement {
  const { notify } = useNotice();
  const { assembly, client } = host;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [formAction, setFormAction] = useState<string | null>(null);

  const readIndex = useCallback(() => client.index(), [client]);
  /*
    The SHARED index feed (ADR 0012), joined rather than duplicated: naming `INDEX_RESOURCE` is
    what puts this subscriber on the one poller the sidebar already runs. This component exists
    only while the dialog is open, so closing it removes this subscriber and its fallback timer.
  */
  const { value: containers } = usePolledResource<readonly IndexEntry[]>(
    readIndex,
    FALLBACK_POLL_MS,
    {
      key: INDEX_RESOURCE,
      initial: NO_ENTRIES,
      enabled: true,
      topics: host.topics.index,
      events: client,
    },
  );

  /*
    UNKNOWN IS NOT DENIED. `selfCaps()` answers from the room this device joined, and at the
    workspace root there is no room — so an empty set means "nobody has told us yet", and the
    projection is handed null rather than an empty grant. The footer says so out loud.
  */
  const granted = client.selfCaps();
  const caps: readonly Cap[] | null = granted.length === 0 ? null : granted;

  const rows = useMemo(
    () =>
      composeCommands({
        roster: assembly.roster(),
        bindings: assembly.bindings,
        containers,
        caps,
        containerId: host.containerId,
        pluginTitle: (id) => assembly.pluginTitle(id),
      }),
    [assembly, containers, caps, host.containerId],
  );

  /*
    The surface UNMOUNTS when it closes, which is what makes the search box empty every time
    without anybody resetting it: there is no state here to reset, because cmdk owns the query
    and the query dies with the dialog.

    FOCUS IS MOVED EXPLICITLY after every view swap. `showModal` puts focus on the dialog itself,
    and selecting a form unmounts the focused cmdk input; returning unmounts the focused Back
    button. The list therefore focuses its search input and the form focuses Back, so keyboard
    and screen-reader users never fall through to the document behind the still-open modal.
  */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    (formAction === null ? inputRef.current : backRef.current)?.focus();
  }, [formAction]);

  const closeDialog = (): void => {
    setFormAction(null);
    closeCommands();
  };

  const select = (row: CommandRow): void => {
    if (row.refusal !== null) return;
    switch (row.kind) {
      case "door": {
        if (row.form) {
          setFormAction(row.target);
          return;
        }
        closeDialog();
        void client.action(row.target, {}).then((outcome) => {
          notify(outcome.ok ? `${row.title} — done` : `${row.title} — ${outcome.denial.message}`, {
            key: COMMANDS_OPEN_BINDING,
          });
        });
        return;
      }
      case "key": {
        closeDialog();
        requestRebind(row.target);
        return;
      }
      case "container": {
        closeDialog();
        host.navigate(formatManifoldUri({ kind: "container", containerId: row.target }));
        return;
      }
      default: {
        const unreachable: never = row.kind;
        throw new Error(`unhandled command kind ${String(unreachable)}`);
      }
    }
  };

  const formTitle =
    formAction === null
      ? null
      : (rows.find((row) => row.target === formAction)?.title ?? formAction);

  return (
    <dialog
      ref={dialogRef}
      className="commands-dialog"
      aria-label="Commands"
      data-testid="commands-modal"
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        closeDialog();
      }}
    >
      {formAction === null ? (
        <Command className="commands-card" label="Commands" loop>
          <div className="commands-search">
            <Command.Input
              ref={inputRef}
              placeholder="Search doors, keys and containers…"
              data-testid="commands-input"
            />
            <KeyCap label={keyCapLabel("Mod+k")} />
          </div>
          <ScrollRegion className="commands-body">
            <Command.List>
              <Command.Empty>Nothing in this workspace answers to that.</Command.Empty>
              {(Object.keys(GROUP_HEADINGS) as readonly CommandKind[]).map((kind) => {
                const group = rows.filter((row) => row.kind === kind);
                if (group.length === 0) return null;
                return (
                  <Command.Group key={kind} heading={GROUP_HEADINGS[kind]}>
                    {group.map((row) => (
                      <Command.Item
                        key={row.id}
                        value={row.value}
                        disabled={row.refusal !== null}
                        onSelect={() => select(row)}
                        data-commands-kind={kind}
                        data-commands-here={row.here}
                        {...(kind === "door" ? { "data-action": row.target } : {})}
                      >
                        <span className="commands-title">
                          {row.title}
                          <small>
                            {row.owner}
                            {row.here ? " · you are here" : ""}
                            {row.refusal === null ? "" : ` · ${row.refusal}`}
                          </small>
                        </span>
                        {row.stroke === null ? null : <KeyCap label={keyCapLabel(row.stroke)} />}
                        <span className="commands-verb">{row.form ? "Open" : VERBS[kind]}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })}
            </Command.List>
          </ScrollRegion>
          <footer className="commands-foot">
            <span>
              {caps === null
                ? "No container open, so this device holds no granted authority yet — doors are listed, not judged."
                : "Doors you cannot open are listed with the authority they cost."}
            </span>
            <span>{keyCapLabel("Mod+k")} closes</span>
          </footer>
        </Command>
      ) : (
        <div className="commands-card commands-door-card">
          <header className="commands-door-head">
            <button
              ref={backRef}
              type="button"
              className="commands-door-back"
              onClick={() => setFormAction(null)}
            >
              Back
            </button>
            <span>
              <strong>{formTitle}</strong>
              <code>{formAction}</code>
            </span>
          </header>
          <ScrollRegion className="commands-door-body">
            <DoorForm action={formAction} host={host} />
          </ScrollRegion>
          <footer className="commands-foot">
            <span>The fields come from this door's published protocol schema.</span>
            <span>{keyCapLabel("Mod+k")} closes</span>
          </footer>
        </div>
      )}
    </dialog>
  );
}
