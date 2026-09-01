import type { HostServices } from "@manifold/plugin";
import { Chip, Popover } from "@manifold/plugin/ui";
import type { ActionSummary } from "@manifold/protocol";
import { Suspense, lazy, useState, type ReactElement } from "react";

/**
 * THE DOOR-INVOCATION SECTION (#128, #131 item 6): the pinned card's doors, each one
 * openable into a GENERATED argument form — the inspector as the no-code console.
 *
 * A door chip is a button exactly when the assembly composed that door (the popover opens
 * on it, the schema is its published `input`), and inert prose when the DOM declares a
 * `data-action` the roster does not hold — a half-disabled plugin's affordance, honestly
 * rendered as unreachable instead of hidden. Submission goes through `host.client.action`,
 * THE action door, and a refusal comes back as data into the same popover.
 *
 * The FORM ENGINE ARRIVES ONLY ON DEMAND: `door-form.tsx` (rjsf and its validator) is
 * behind `React.lazy`, so its chunk is fetched the first time a reader opens a door, and
 * an idle workspace never loads it. That seam is the ADR's lazy-loading consequence made
 * structural.
 */
/* Not a runtime-selected module: the ONE deliberate code-split seam (vite chunks on the
   dynamic import), keeping the form engine off the boot path per the ADR. */
const LazyDoorForm = lazy(() =>
  import("./door-form.tsx").then((module) => ({ default: module.DoorForm })),
);

/** The roster's summary for a declared door, when the assembly composed one. */
function summaryOf(door: string, host: HostServices): ActionSummary | null {
  for (const entry of host.assembly.roster()) {
    const found = entry.actions.find((action) => action.name === door);
    if (found !== undefined) return found;
  }
  return null;
}

export function DoorForms({
  doors,
  host,
}: {
  readonly doors: readonly string[];
  readonly host: HostServices;
}): ReactElement {
  /** The one open door; opening another closes it, because two open forms is two claims. */
  const [open, setOpen] = useState<string | null>(null);
  return (
    <span className="inspector-doors">
      {doors.map((door) => {
        const summary = summaryOf(door, host);
        if (summary === null) {
          return (
            <Chip key={door} className="inspector-door">
              {door}
            </Chip>
          );
        }
        return (
          <Popover
            key={door}
            open={open === door}
            onOpenChange={(next) => setOpen(next ? door : null)}
            side="bottom"
            align="start"
            contentClassName="door-form__layer"
            trigger={
              /* No onClick of our own: the popover injects its toggle handler through the
                 trigger slot, and that injection is what flips the chip into a button. */
              <Chip className="inspector-door">{door}</Chip>
            }
          >
            <header className="door-form__head">
              <strong>{summary.title}</strong> <code>{summary.name}</code>
            </header>
            <Suspense
              fallback={<p className="door-form__loading">loading the form engine…</p>}
            >
              <LazyDoorForm
                summary={summary}
                dispatch={(args) => host.client.action(summary.name, args)}
              />
            </Suspense>
          </Popover>
        );
      })}
    </span>
  );
}
