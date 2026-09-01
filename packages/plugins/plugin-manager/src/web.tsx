import "./styles.css";
import {
  ENGINE_PURGE_ACTION,
  ENGINE_SET_ENABLED_ACTION,
  type SectionProps,
} from "@manifold/plugin";
import {
  PLUGIN_PURGE_TARGETS,
  PluginPurgeResultSchema,
  type PluginPurgeResult,
  type PluginPurgeTarget,
  type PluginRefusalReason,
  type PluginRosterEntry,
} from "@manifold/protocol";
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { Cluster, ControlIcon, ScrollRegion, Stack } from "@manifold/plugin/ui";
import { Fragment, useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import {
  PLUGIN_FILTERS,
  PLUGIN_FILTER_LABELS,
  pluginCatalog,
  pluginDependencies,
  type PluginFilter,
  type PluginRelations,
} from "./catalog.ts";

/**
 * Composition administration, rendered by the composition it administers. The list is the
 * server's roster verbatim (`host.assembly.roster()`), so this section can never disagree
 * with what the workspace actually composed, and the toggle is one action — enablement is
 * workspace-GLOBAL and hot, so flipping it here changes what every principal's client
 * composes and the new roster is pushed rather than polled (D4).
 *
 * The door it calls is the ENGINE's (`engine.plugins.setEnabled`), not this plugin's. This
 * plugin owns the UI and only the UI.
 *
 * WHAT THE RAIL SEES is one discreet row that opens a MODAL (issue #91). The ledger of what
 * is on and off is a whole administrative screen — two tabs, a search, a filter, categories,
 * dependencies in both directions — and a rail row is 240px wide: the inline disclosure it
 * used to be could only ever show a slice of it, and the rail's foot is precisely where a
 * reader wants a door rather than a drawer. The row clusters beside the key table's row
 * (`cluster: "utility"`), which is why the opener wears the shell's own `.sidebar-opener`
 * vocabulary instead of a skin of its own: two doors side by side must be identical by
 * construction, not by two stylesheets agreeing. Its MARKS come from the same door for the
 * same reason — `ControlIcon kind="assembly" | "locked" | "discard"`, never a lucide import of
 * its own. Three call sites here used to hand-import a drawing and retype the wrapper's four
 * props, one of them re-drawing `discard`, a kind the vocabulary already mapped (#116).
 *
 * Which rows offer a lever is decided by the roster's own `refusal` class rather than by a
 * rule written twice. Every class below is a refusal the door would produce, so the UI names
 * the authority or the obstacle instead of offering a lever that always fails.
 */
const LOCK_HINTS: Partial<Record<PluginRefusalReason, string>> = {
  builtin: "An engine door: the thing that would switch it off is itself",
  essential: "Essential: the workspace cannot be drawn without it",
  dependency_disabled: "Needs plugins that are turned off",
  incompatible_dependency: "Shares the workspace with a plugin that declares it incompatible",
};

/** A failed lifecycle hook is reported, never hidden: the transition happened regardless. */
const LIFECYCLE_LABELS: Record<string, string> = {
  enable_failed: "Its startup hook failed — the plugin is on, but it may not be ready",
  disable_failed: "Its shutdown hook failed — the plugin is off regardless",
};

/**
 * The purge vocabulary, in a human's words. The KEYS are the protocol's closed target set,
 * so a fourth target cannot be added without this table refusing to compile — a destructive
 * verb whose UI silently omits one of the things it destroys is worse than no UI at all.
 */
const PURGE_TARGET_LABELS: Readonly<Record<PluginPurgeTarget, string>> = {
  storage: "stored data",
  elements: "element records",
  ownership: "element-type claims",
};

/**
 * What the manifest SAYS a purge of this plugin would cost, which is the whole reason
 * `purges` exists: it is audit visibility, read before the button is pressed and bound to no
 * verb (ADR 0013 §1). Silence is a real answer and is shown as one — "declares nothing" is
 * information, and rendering nothing there would leave a reader unable to tell a plugin that
 * holds nothing from a plugin that never said.
 */
function purgeDeclaration(entry: PluginRosterEntry): string {
  const declared = entry.manifest.purges ?? [];
  if (declared.length === 0) return "Declares nothing a purge would destroy";
  return `Purging drops ${declared.map((target) => PURGE_TARGET_LABELS[target]).join(", ")}`;
}

function lockHint(entry: PluginRosterEntry): string | null {
  const reason = entry.refusal;
  if (reason === undefined) return null;
  return LOCK_HINTS[reason] ?? reason;
}

/** The two views the modal holds. `installed` is the ledger; `browse` is the deferral. */
const MANAGER_TABS = ["installed", "browse"] as const;
type ManagerTab = (typeof MANAGER_TABS)[number];
const TAB_LABELS: Readonly<Record<ManagerTab, string>> = {
  installed: "Installed",
  browse: "Browse",
};

/**
 * WHAT DEPENDS ON WHAT, in both directions and in words rather than a graph.
 *
 * A sentence renders only when it has members (operator-ratified, #105): "Needs nothing"
 * in every row was noise that buried the rows where the answer matters, and the block's
 * absence now MEANS independence — the roster computes relations for every row, so an
 * absent block is a computed empty, never a UI that forgot to ask. Both rows empty, the
 * block is gone entirely.
 *
 * Every named plugin is a JUMP, not prose: pressing it clears the search and filter (the
 * target may be hidden by either) and scrolls to that plugin's own row, because the reason
 * a reader looks at a dependency is to go look at the dependency.
 *
 * Titles come from the ASSEMBLY (`host.assembly.pluginTitle`), the one name table for
 * plugins, and fall back to the id: a `required` dependency that was never composed has no
 * title anywhere, and printing its id is exactly the information a `missing_dependency`
 * refusal is about.
 */
function DependencyNames({
  ids,
  pluginTitle,
  onJump,
}: {
  readonly ids: readonly string[];
  readonly pluginTitle: (id: string) => string;
  readonly onJump: (id: string) => void;
}): ReactElement {
  return (
    <>
      {ids.map((id, index) => (
        <Fragment key={id}>
          {index === 0 ? null : ", "}
          <button
            className="plugin-manager-dep-link"
            type="button"
            aria-label={`Go to ${pluginTitle(id)}`}
            onClick={() => onJump(id)}
          >
            {pluginTitle(id)}
          </button>
        </Fragment>
      ))}
    </>
  );
}

function DependencyBlock({
  relations,
  pluginTitle,
  onJump,
}: {
  readonly relations: PluginRelations;
  readonly pluginTitle: (id: string) => string;
  readonly onJump: (id: string) => void;
}): ReactElement | null {
  const { needs, neededBy } = relations;
  if (needs.length === 0 && neededBy.length === 0) return null;
  return (
    <p className="plugin-manager-deps">
      {needs.length === 0 ? null : (
        <span className="plugin-manager-dep">
          Needs <DependencyNames ids={needs} pluginTitle={pluginTitle} onJump={onJump} />
        </span>
      )}
      {neededBy.length === 0 ? null : (
        <span className="plugin-manager-dep">
          Needed by <DependencyNames ids={neededBy} pluginTitle={pluginTitle} onJump={onJump} />
        </span>
      )}
    </p>
  );
}

/**
 * THE BROWSE TAB, which is a named absence rather than an empty panel.
 *
 * Installing a plugin that is not compiled into this build is a RATIFIED roadmap wave —
 * "Marketplace and dynamic plugin distribution" (AXIOMS.md §Roadmap) — gated behind a dated
 * isolation ADR that must ratify a runner first, because a marketplace is the moment code
 * manifold did not author runs in-process. That ordering is a hard prerequisite, not a
 * preference, so this tab cannot ship a store and must not pretend the question was never
 * asked: a deferral has to be visible IN THE PRODUCT, as a placeholder that says what is
 * missing, never only in prose an operator would have to go and find (AGENTS.md
 * §Conventions). A reader who opens a plugin manager and finds a blank second tab learns
 * that the product is broken; a reader who finds this learns what manifold has decided.
 *
 * It names the seams too, because they are the reason this is a wave rather than a wish: the
 * manifest's `entry { web?, server? }` and the roster's `source` field are already reserved
 * for it, and the roster already distinguishes a builtin door from an assembled plugin.
 */
function BrowsePanel(): ReactElement {
  return (
    <Stack className="plugin-manager-browse" gap="0.6rem" data-testid="plugin-manager-browse">
      <h3 className="plugin-manager-browse-title">Marketplace and dynamic plugin distribution</h3>
      <p>
        Not built yet, and named rather than hidden: installing plugin code that is not compiled
        into this build is a ratified roadmap wave (<code>AXIOMS.md</code> §Roadmap), not an
        oversight in this screen.
      </p>
      <p>
        What is missing is the isolation verdict it waits on. Every plugin in this workspace is
        first-party code compiled into the build, so a store is the moment code manifold did not
        author starts running in-process; a dated ADR has to ratify a runner for it first, and that
        ordering is a hard prerequisite. The seams are already reserved — a manifest may declare{" "}
        <code>entry</code>, and every row in the Installed tab already publishes the{" "}
        <code>source</code> a downloaded plugin would arrive under.
      </p>
      <p className="plugin-manager-browse-meanwhile">
        Until that wave lands, the Installed tab is the whole list: what this workspace composed,
        and every door you can open on it.
      </p>
    </Stack>
  );
}

export function PluginManagerSection({ host }: SectionProps): ReactElement {
  const assembly = host.assembly;
  const roster = assembly.roster();
  const caps = host.client.selfCaps();
  const canManage = caps.includes("*") || caps.includes("plugins:manage");
  const { sidebarOpen } = useWorkspaceShell();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ManagerTab>("installed");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * Which row's purge is ARMED. A purge is destructive and workspace-global, so it is a
   * two-press act by construction: the first press says what will happen, the second does it.
   * One slot rather than a flag per row, because arming a second row must disarm the first.
   */
  const [armedId, setArmedId] = useState<string | null>(null);
  /**
   * The last purge's own record, kept at SECTION level on purpose: the row it describes is
   * gone from the roster by the time it renders, and a destructive verb that leaves nothing
   * behind to read cannot be audited.
   */
  const [removed, setRemoved] = useState<PluginPurgeResult | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /**
   * The row a dependency link is jumping to. Set together with clearing the search and
   * filter (either may be hiding the target); the effect below scrolls once the unfiltered
   * list has painted, and the highlight retires itself. State rather than a classList poke,
   * so the flash cannot outlive the row it describes.
   */
  const [jumpId, setJumpId] = useState<string | null>(null);

  useEffect(() => {
    if (jumpId === null) return;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(`[data-plugin="${CSS.escape(jumpId)}"]`)
        ?.scrollIntoView({ block: "center" });
    });
    const timer = window.setTimeout(() => setJumpId(null), 1400);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [jumpId]);

  const jumpTo = (id: string): void => {
    setQuery("");
    setFilter("all");
    setJumpId(id);
  };

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [open]);

  /**
   * Closing DISARMS. An armed destructive control that survives the dialog it was armed in
   * would be waiting behind a closed door for the next press — the same trap `onBlur`
   * disarming prevents inside the row, one level up.
   */
  const close = (): void => {
    setOpen(false);
    setArmedId(null);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    setPendingId(id);
    setFailure(null);
    setArmedId(null);
    setRemoved(null);
    try {
      const outcome = await host.client.action(ENGINE_SET_ENABLED_ACTION, { id, enabled });
      // No local flip: the roster is server-owned and arrives on the connection frame, so
      // the list changes when the WORKSPACE changes, never because this tab clicked.
      if (!outcome.ok) setFailure(outcome.denial.message);
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not change the plugin");
    } finally {
      setPendingId(null);
    }
  };

  /**
   * The destructive door, and the only caller of it in the UI. It answers an EXHAUSTIVE
   * record — every target, zeros included — so the outcome is parsed rather than trusted:
   * "nothing was removed" and "that target was not considered" must not read alike, and a
   * result this section could not read is a failure worth saying out loud.
   */
  const purge = async (id: string): Promise<void> => {
    setPendingId(id);
    setFailure(null);
    setRemoved(null);
    try {
      const outcome = await host.client.action(ENGINE_PURGE_ACTION, { id });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      const record = PluginPurgeResultSchema.safeParse(outcome.result);
      if (record.success) setRemoved(record.data);
      else setFailure(`${id} was purged, but its removal record could not be read`);
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not purge the plugin");
    } finally {
      setPendingId(null);
      setArmedId(null);
    }
  };

  const categories = pluginCatalog(roster, query, filter);

  const installed = (
    <Stack className="plugin-manager" gap="0.35rem" data-testid="plugin-manager">
      <Cluster className="plugin-manager-controls" justify="space-between" gap="0.5rem">
        <input
          className="plugin-manager-search"
          type="search"
          value={query}
          placeholder="Search plugins"
          aria-label="Search plugins by name, id or description"
          data-testid="plugin-manager-search"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="plugin-manager-filters" role="group" aria-label="Show">
          {PLUGIN_FILTERS.map((value) => (
            <button
              key={value}
              className="plugin-manager-filter"
              type="button"
              aria-pressed={filter === value}
              data-testid={`plugin-manager-filter-${value}`}
              onClick={() => setFilter(value)}
            >
              {PLUGIN_FILTER_LABELS[value]}
            </button>
          ))}
        </div>
      </Cluster>
      {!canManage ? (
        <p className="sidebar-muted">
          Read-only: turning plugins on and off needs the <code>plugins:manage</code> capability.
        </p>
      ) : null}
      {failure === null ? null : (
        <p className="plugin-manager-error" role="alert">
          {failure}
        </p>
      )}
      {removed === null ? null : (
        <p className="plugin-manager-removed" data-testid="plugin-manager-removed" role="status">
          Purged {removed.id} —{" "}
          {PLUGIN_PURGE_TARGETS.map(
            (target) => `${PURGE_TARGET_LABELS[target]} ${String(removed.removed[target] ?? 0)}`,
          ).join(", ")}
        </p>
      )}
      {/*
        Two different emptinesses, said differently. "No plugins composed" is a claim about the
        WORKSPACE; "nothing matches" is a claim about what the reader just typed, and a single
        message for both would tell someone whose search missed that their workspace is empty.
       */}
      {roster.length === 0 ? (
        <span className="sidebar-section-empty">No plugins composed</span>
      ) : categories.length === 0 ? (
        <span className="sidebar-section-empty">Nothing matches this search</span>
      ) : null}
      {categories.map((category) => (
        <section className="plugin-manager-category" key={category.kind}>
          <h3 className="plugin-manager-category-title">
            {category.title}
            <span className="plugin-manager-category-count">{category.rows.length}</span>
          </h3>
          {category.rows.map((entry) => {
            const { manifest } = entry;
            const hint = lockHint(entry);
            const lifecycle =
              entry.lifecycle === undefined ? null : LIFECYCLE_LABELS[entry.lifecycle];
            const attribution =
              typeof entry.changedBy === "string" ? `Last changed by ${entry.changedBy}` : null;
            const verb = entry.enabled ? "Disable" : "Enable";
            /*
              The toggle's tooltip says FOR EVERYONE, because that is what the door does:
              enablement is workspace-global, so a reader hovering a switch in their own tab is
              owed the fact that pressing it changes what every principal composes. The
              attribution rides in the same string when the roster carries one — who last moved
              this row is the other half of "is this safe to touch".
             */
            const toggleTitle = canManage
              ? [`${verb} ${manifest.title} for everyone`, attribution]
                  .filter((line) => line !== null)
                  .join(" · ")
              : "Requires plugins:manage";
            /*
              A purge is offered on a DISABLED row and nowhere else, because that is the door's
              own rule rather than a second one written here: `engine.plugins.purge` is refused
              while the plugin is enabled (class `still_enabled`), and an affordance that always
              fails is exactly what §5's "never offer a lever the door refuses" forbids. Disable
              first, purge second — and the first step is the reversible one.
             */
            const purgeable = canManage && !entry.enabled;
            const armed = armedId === manifest.id;
            return (
              <div
                className={`plugin-manager-row${entry.enabled ? "" : " is-disabled"}${jumpId === manifest.id ? " is-jump-target" : ""}`}
                data-plugin={manifest.id}
                data-source={entry.source}
                key={manifest.id}
              >
                <div className="plugin-manager-row-main">
                  <span className="plugin-manager-label">
                    <strong title={manifest.description}>{manifest.title}</strong>
                    <small>
                      {manifest.id} · {manifest.version}
                    </small>
                    {lifecycle === null ? null : (
                      <small className="plugin-manager-lifecycle" role="status">
                        {lifecycle}
                      </small>
                    )}
                    {!purgeable ? null : (
                      <small className="plugin-manager-purges">{purgeDeclaration(entry)}</small>
                    )}
                  </span>
                  {hint === null ? (
                    <button
                      className="plugin-manager-toggle"
                      type="button"
                      role="switch"
                      aria-checked={entry.enabled}
                      aria-label={`${verb} ${manifest.title}`}
                      title={toggleTitle}
                      data-action={ENGINE_SET_ENABLED_ACTION}
                      data-testid="plugin-manager-toggle"
                      disabled={!canManage || pendingId === manifest.id}
                      onClick={() => void toggle(manifest.id, !entry.enabled)}
                    >
                      {entry.enabled ? "On" : "Off"}
                    </button>
                  ) : (
                    <span className="plugin-manager-lock" title={hint} aria-label={hint}>
                      <ControlIcon kind="locked" size={13} />
                    </span>
                  )}
                  {!purgeable ? null : (
                    <button
                      className={`plugin-manager-purge${armed ? " is-confirming" : ""}`}
                      type="button"
                      aria-label={
                        armed
                          ? `Confirm purging ${manifest.title} — this cannot be undone`
                          : `Purge ${manifest.title}`
                      }
                      title={`${purgeDeclaration(entry)}. ${
                        armed ? "Press again to destroy it." : "Press to confirm."
                      }`}
                      data-action={ENGINE_PURGE_ACTION}
                      data-testid="plugin-manager-purge"
                      data-confirming={armed}
                      disabled={pendingId === manifest.id}
                      // Losing focus disarms: an armed destructive control that stays armed
                      // while the reader looks away is a trap, and Escape is the same retreat
                      // by keyboard.
                      onBlur={() => setArmedId(null)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setArmedId(null);
                      }}
                      onClick={() => {
                        if (armed) void purge(manifest.id);
                        else {
                          setArmedId(manifest.id);
                          setFailure(null);
                          setRemoved(null);
                        }
                      }}
                    >
                      {armed ? "Purge?" : <ControlIcon kind="discard" size={13} />}
                    </button>
                  )}
                </div>
                <DependencyBlock
                  relations={pluginDependencies(roster, manifest.id)}
                  pluginTitle={(id) => assembly.pluginTitle(id) ?? id}
                  onJump={jumpTo}
                />
              </div>
            );
          })}
        </section>
      ))}
    </Stack>
  );

  return (
    <>
      <button
        ref={buttonRef}
        className="sidebar-opener"
        type="button"
        title="Plugins: what this workspace composed, and what is on"
        aria-label="Show the plugin manager"
        data-testid="plugin-manager-open"
        onClick={() => setOpen(true)}
      >
        <ControlIcon kind="assembly" />
        {sidebarOpen ? <span>Plugins</span> : null}
      </button>
      {typeof document !== "undefined" && open
        ? createPortal(
            <dialog
              ref={dialogRef}
              className="plugin-manager-dialog"
              aria-labelledby="plugin-manager-title"
              onCancel={(event) => {
                event.preventDefault();
                close();
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                close();
              }}
            >
              <section className="plugin-manager-card" data-testid="plugin-manager-modal">
                <header>
                  <div>
                    <span>Workspace</span>
                    <h2 id="plugin-manager-title">Plugins</h2>
                  </div>
                  <button type="button" aria-label="Close the plugin manager" onClick={close}>
                    <ControlIcon kind="close" />
                  </button>
                </header>
                <div className="plugin-manager-tabs" role="tablist" aria-label="Plugin manager">
                  {MANAGER_TABS.map((value) => (
                    <button
                      key={value}
                      id={`plugin-manager-tab-${value}`}
                      className="plugin-manager-tab"
                      type="button"
                      role="tab"
                      aria-selected={tab === value}
                      aria-controls="plugin-manager-panel"
                      data-testid={`plugin-manager-tab-${value}`}
                      onClick={() => setTab(value)}
                    >
                      {TAB_LABELS[value]}
                    </button>
                  ))}
                </div>
                <ScrollRegion className="plugin-manager-body">
                  <div
                    id="plugin-manager-panel"
                    role="tabpanel"
                    aria-labelledby={`plugin-manager-tab-${tab}`}
                  >
                    {tab === "installed" ? installed : <BrowsePanel />}
                  </div>
                </ScrollRegion>
              </section>
            </dialog>,
            document.body,
          )
        : null}
    </>
  );
}
