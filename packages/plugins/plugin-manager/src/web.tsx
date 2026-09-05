import "./styles.css";
import {
  ENGINE_INSTALL_ACTION,
  ENGINE_PURGE_ACTION,
  ENGINE_SET_ENABLED_ACTION,
  ENGINE_SET_SETTING_ACTION,
  ENGINE_UNINSTALL_ACTION,
  PluginInstallResultSchema,
  type ComposedSetting,
  type SectionProps,
} from "@manifold/plugin";
import {
  CapSchema,
  PLUGIN_PURGE_TARGETS,
  PluginPurgeResultSchema,
  type Cap,
  type PluginPurgeResult,
  type PluginPurgeTarget,
  type PluginRefusalReason,
  type ManifoldRef,
  type PluginRosterEntry,
} from "@manifold/protocol";
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { Cluster, ControlIcon, ScrollRegion, Stack } from "@manifold/plugin/ui";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
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

/**
 * A failed lifecycle hook is reported, never hidden: the transition happened regardless. The
 * two `isolate_` states are an INSTALLED plugin's child process as the runner sees it (ADR
 * 0016 §6) — a degraded row every principal reads, rather than a log line somebody greps.
 */
const LIFECYCLE_LABELS: Record<string, string> = {
  enable_failed: "Its startup hook failed — the plugin is on, but it may not be ready",
  disable_failed: "Its shutdown hook failed — the plugin is off regardless",
  isolate_starting: "Its process is starting — its doors answer once it reports in",
  isolate_crashed:
    "Its process crashed past the restart budget — its doors answer unavailable until it is switched off and on",
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

/**
 * The two views the modal holds. `composed` is the ledger of everything this workspace
 * assembled — engine doors, core seats, installed plugins alike — with its toggles; `installed`
 * is the door onto a stranger's code and the bundles that walked through it (ADR 0016 §8).
 */
const MANAGER_TABS = ["composed", "installed"] as const;
type ManagerTab = (typeof MANAGER_TABS)[number];
const TAB_LABELS: Readonly<Record<ManagerTab, string>> = {
  composed: "Composed",
  installed: "Installed",
};

/** What the install form hands the door, before the door grades it. */
interface InstallDraft {
  readonly source: string;
  readonly sha256: string;
  readonly grant: readonly Cap[];
}

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
 * THE GENERIC SETTINGS PANE (#133): one control per DECLARED setting, and a named absence for
 * a plugin that declares none.
 *
 * Generic is the whole point, and it is what makes this a mechanism rather than a screen. The
 * pane is rendered from `host.assembly.settings` — the composed table, effective values already
 * applied — so this component knows nothing about what any setting means, no plugin registers
 * a form, and a stranger's plugin gets the pane `core.canvas` gets by declaring one line of
 * manifest. When a second `kind` lands (`SETTING_KINDS`), this is the one place a second
 * control appears, which is the same shape the purge-target table keeps: the closed protocol
 * set is switched on here and nowhere else.
 *
 * "Declares no settings" is a NAMED absence, not an empty box: a reader who opened this pane
 * asked a question, and the honest answer is that this plugin has nothing to offer rather than
 * a blank rectangle they will read as a failure to load.
 *
 * WRITES GO TO THE ENGINE'S DOOR and the table is then RE-READ (`refreshSettings`), never
 * flipped locally: the value is stored per principal on the server, so the switch showing "off"
 * and the sidebar dropping a row are the same fact arriving from the same place. A row's
 * `declared` sits beside its `value` so the pane can say which ones the reader has moved.
 */
function SettingsPane({
  settings,
  pluginTitle,
  pending,
  onSet,
}: {
  readonly settings: readonly ComposedSetting[];
  readonly pluginTitle: string;
  readonly pending: string | null;
  readonly onSet: (setting: ComposedSetting, value: boolean) => void;
}): ReactElement {
  if (settings.length === 0) {
    return (
      <p className="plugin-manager-settings-empty" data-testid="plugin-manager-settings-empty">
        {pluginTitle} declares no settings.
      </p>
    );
  }
  return (
    <div className="plugin-manager-settings" data-testid="plugin-manager-settings">
      {settings.map((setting) => (
        <div className="plugin-manager-setting" key={setting.ref}>
          <span className="plugin-manager-setting-label">
            <strong>{setting.title}</strong>
            {setting.value === setting.declared ? null : (
              <small className="plugin-manager-setting-moved">Changed from default</small>
            )}
          </span>
          <button
            className="plugin-manager-setting-toggle"
            type="button"
            role="switch"
            aria-checked={setting.value}
            aria-label={`${setting.value ? "Turn off" : "Turn on"} ${setting.title}`}
            title={`${setting.title} — your own preference, on every device you sign in from`}
            data-action={ENGINE_SET_SETTING_ACTION}
            data-testid="plugin-manager-setting-toggle"
            data-setting={setting.ref}
            disabled={pending === setting.ref}
            onClick={() => onSet(setting, !setting.value)}
          >
            {setting.value ? "On" : "Off"}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * THE INSTALLED TAB (ADR 0016 §8 stage 2): a form onto `engine.plugins.install`, and one row
 * per bundle that walked through it, with its uninstall lever.
 *
 * The form asks for exactly what the door asks for — where the artifact is, and the hash of its
 * bytes — because consent to run a stranger's code is consent to THESE bytes, and a form that
 * fetched first and asked later would have already decided. The grant is optional and explicit:
 * the door's default withholds the high-risk caps, so a reader who types nothing gets the safe
 * answer and a reader who widens it has said so in writing.
 *
 * The rows are the roster's own `install` blocks — the hash, the source as the installer spelled
 * it, the granted caps, who and when — never a second list: what this tab shows is what every
 * principal and every agent reads at `GET /api/plugins`. Uninstall is offered only on a row
 * that is OFF, for the reason purge is (the door refuses `still_enabled`, and §5 forbids a
 * lever that always fails), and it says out loud that stored data is kept.
 */
function InstalledPanel({
  roster,
  canInstall,
  busy,
  failure,
  notice,
  onInstall,
  onUninstall,
}: {
  readonly roster: readonly PluginRosterEntry[];
  readonly canInstall: boolean;
  /** The id an uninstall is in flight for, or the install action while an install is. */
  readonly busy: string | null;
  readonly failure: string | null;
  readonly notice: string | null;
  readonly onInstall: (draft: InstallDraft) => void;
  readonly onUninstall: (id: string) => void;
}): ReactElement {
  const [source, setSource] = useState("");
  const [sha256, setSha256] = useState("");
  const [grant, setGrant] = useState("");
  const [grantProblem, setGrantProblem] = useState<string | null>(null);
  const installed = roster.filter((entry) => entry.install !== undefined);
  const installing = busy === ENGINE_INSTALL_ACTION;

  const submit = (): void => {
    const words = grant
      .split(",")
      .map((word) => word.trim())
      .filter((word) => word.length > 0);
    const caps = CapSchema.array().safeParse(words);
    if (!caps.success) {
      setGrantProblem(`Not a capability: ${words.filter((word) => !CapSchema.safeParse(word).success).join(", ")}`);
      return;
    }
    setGrantProblem(null);
    onInstall({ source: source.trim(), sha256: sha256.trim().toLowerCase(), grant: caps.data });
  };

  return (
    <Stack className="plugin-manager-installs" gap="0.6rem" data-testid="plugin-manager-installs">
      <form
        className="plugin-manager-install"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="plugin-manager-install-field">
          <span>Source — an https:// URL, or a path under the server's plugin-uploads box</span>
          <input
            className="plugin-manager-search"
            type="text"
            value={source}
            placeholder="https://example.org/vendor.sample.manifold-plugin.json"
            spellCheck={false}
            disabled={!canInstall || installing}
            data-testid="plugin-manager-install-source"
            onChange={(event) => setSource(event.target.value)}
          />
        </label>
        <label className="plugin-manager-install-field">
          <span>SHA-256 of the bundle's exact bytes — what you are consenting to run</span>
          <input
            className="plugin-manager-search"
            type="text"
            value={sha256}
            placeholder="64 hex characters"
            spellCheck={false}
            disabled={!canInstall || installing}
            data-testid="plugin-manager-install-sha256"
            onChange={(event) => setSha256(event.target.value)}
          />
        </label>
        <label className="plugin-manager-install-field">
          <span>
            Grant — optional, comma-separated capabilities to add to the default (which withholds
            *, tokens:mint and plugins:manage)
          </span>
          <input
            className="plugin-manager-search"
            type="text"
            value={grant}
            placeholder="containers:write, terminals:spawn"
            spellCheck={false}
            disabled={!canInstall || installing}
            data-testid="plugin-manager-install-grant"
            onChange={(event) => setGrant(event.target.value)}
          />
        </label>
        {grantProblem === null ? null : (
          <p className="plugin-manager-error" role="alert">
            {grantProblem}
          </p>
        )}
        <button
          className="plugin-manager-filter"
          type="submit"
          data-action={ENGINE_INSTALL_ACTION}
          data-testid="plugin-manager-install"
          title={
            canInstall
              ? "Install this bundle for everyone in the workspace"
              : "Installing a plugin needs the root capability"
          }
          disabled={
            !canInstall || installing || source.trim().length === 0 || sha256.trim().length === 0
          }
        >
          {installing ? "Installing…" : "Install"}
        </button>
      </form>
      {canInstall ? null : (
        <p className="sidebar-muted">
          Read-only: installing and uninstalling a plugin needs the root capability, because a
          bundle is code nobody in this build wrote.
        </p>
      )}
      {failure === null ? null : (
        <p className="plugin-manager-error" role="alert">
          {failure}
        </p>
      )}
      {notice === null ? null : (
        <p className="plugin-manager-notice" data-testid="plugin-manager-install-notice" role="status">
          {notice}
        </p>
      )}
      {installed.length === 0 ? (
        <span className="sidebar-section-empty">Nothing installed</span>
      ) : (
        installed.map((entry) => {
          const { manifest } = entry;
          const install = entry.install;
          if (install === undefined) return null;
          const lifecycle =
            entry.lifecycle === undefined ? null : LIFECYCLE_LABELS[entry.lifecycle];
          const removable = canInstall && !entry.enabled;
          return (
            <div
              className={`plugin-manager-row${entry.enabled ? "" : " is-disabled"}`}
              data-plugin={manifest.id}
              data-source={entry.source}
              key={manifest.id}
            >
              <div className="plugin-manager-row-main">
                <span className="plugin-manager-label">
                  <strong title={manifest.description}>{manifest.title}</strong>
                  <small title={install.sha256}>
                    {manifest.id} · {manifest.version} · {install.sha256.slice(0, 12)}
                  </small>
                  <small title={install.source}>
                    Granted {install.grantedCaps.length === 0 ? "nothing" : install.grantedCaps.join(", ")}{" "}
                    · installed by {install.installedBy}
                  </small>
                  {lifecycle === null ? null : (
                    <small className="plugin-manager-lifecycle" role="status">
                      {lifecycle}
                    </small>
                  )}
                  {install.refusal === undefined ? null : (
                    <small className="plugin-manager-purges" role="status">
                      Refused at boot: {install.refusal} — nothing from its bundle was loaded
                    </small>
                  )}
                </span>
                <button
                  className="plugin-manager-purge"
                  type="button"
                  aria-label={`Uninstall ${manifest.title}`}
                  title={
                    entry.enabled
                      ? "Switch it off first: uninstall is refused while a plugin is on"
                      : `Uninstall ${manifest.title} — its stored data is kept; purge destroys it`
                  }
                  data-action={ENGINE_UNINSTALL_ACTION}
                  data-testid="plugin-manager-uninstall"
                  disabled={!removable || busy === manifest.id}
                  onClick={() => onUninstall(manifest.id)}
                >
                  Uninstall
                </button>
              </div>
            </div>
          );
        })
      )}
    </Stack>
  );
}

export function PluginManagerSection({ host }: SectionProps): ReactElement {
  const assembly = host.assembly;
  const roster = assembly.roster();
  /*
    THE COMPOSED SETTINGS TABLE, read exactly as the roster is: the engine's own join of every
    manifest's declarations with this principal's stored values. The panes below are a view of
    it and nothing more — this section holds no settings state of its own, so a switch and the
    sidebar row it governs can never disagree.
  */
  const settings = assembly.settings;
  const caps = host.client.selfCaps();
  const canManage = caps.includes("*") || caps.includes("plugins:manage");
  /** Installing admits a stranger's code: root only, the door's own rule (`caps: ["*"]`). */
  const canInstall = caps.includes("*");
  const { sidebarOpen } = useWorkspaceShell();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ManagerTab>("composed");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * The last install or uninstall's own record, in words — kept at section level for the
   * reason `removed` is: an uninstalled row is gone from the roster by the time it renders.
   */
  const [installNotice, setInstallNotice] = useState<string | null>(null);
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
  /**
   * WHICH ROW'S SETTINGS PANE IS OPEN, by plugin id. One slot rather than a flag per row: a
   * pane is a place a reader is looking, and two places at once is not one.
   */
  const [settingsId, setSettingsId] = useState<string | null>(null);
  /** The setting ref a write is in flight for, so exactly that switch goes inert. */
  const [pendingSetting, setPendingSetting] = useState<string | null>(null);

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

  const jumpTo = useCallback((id: string): void => {
    setQuery("");
    setFilter("all");
    setJumpId(id);
  }, []);

  /**
   * THE DEEP-LINK ANSWER (#133). `manifold://plugin/<id>` is an address like any other, and
   * this is the surface that shows a plugin — so when the shell publishes such a request
   * (`host.requestedRef`), the manager opens on that row with its settings pane out.
   *
   * A ROUTE ANSWER, not a modal bus. Nothing calls into this component: the shell puts an
   * address on the route, this reads it, and a build where `core.plugins` is disabled simply
   * leaves the address unanswered — exactly as an unregistered panel leaves a leaf empty.
   * The address is consumed once by the shell, so closing the dialog does not fight a request
   * that keeps arriving, and following the same link again opens it again.
   *
   * ANSWERED DURING RENDER, not in an effect, and the difference is visible: an effect would
   * paint the workspace once with the manager shut and then open it, so a deep link would
   * flash. React re-runs this component immediately on a set-during-render, before anything
   * reaches the screen, which is exactly the "adjust state when the input changes" shape. The
   * guard is the LAST ANSWERED address rather than a boolean, so a second link to a second
   * plugin is answered while a re-render for any other reason is not.
   *
   * It reuses `jumpTo` verbatim, because "clear the filters that may be hiding the row, scroll
   * to it, flash it" is already this component's answer to "go look at that plugin" and a
   * second implementation of it would drift from the first.
   */
  const requested = host.requestedRef;
  // Starts NULL rather than at the current request: a cold load straight onto a link mounts
  // this section with the address already published, and that is the case the link exists for.
  const [answered, setAnswered] = useState<ManifoldRef | null>(null);
  if (requested !== answered) {
    setAnswered(requested);
    if (requested !== null && requested.kind === "plugin") {
      setOpen(true);
      setTab("composed");
      jumpTo(requested.pluginId);
      setSettingsId(requested.pluginId);
    }
  }

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

  /**
   * THE PREFERENCE DOOR. Unlike the two above it changes nothing about the workspace: the value
   * is stored against this principal, so nobody else's composition moves and no capability is
   * asked for.
   *
   * NO LOCAL FLIP, for the reason the toggle above has none — and here it also buys the proof
   * that matters: the switch changes when the engine re-reads the stored map
   * (`assembly.refreshSettings`), which is the same read the sidebar composes its rows from. A
   * switch that flipped itself could show "off" beside a row that was still there.
   */
  const setSetting = async (setting: ComposedSetting, value: boolean): Promise<void> => {
    setPendingSetting(setting.ref);
    setFailure(null);
    try {
      const outcome = await host.client.action(ENGINE_SET_SETTING_ACTION, {
        plugin: setting.plugin,
        setting: setting.id,
        value,
      });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      assembly.refreshSettings();
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not change the setting");
    } finally {
      setPendingSetting(null);
    }
  };

  /**
   * THE INSTALL DOOR, and its inverse. Both are the engine's (`engine.plugins.install` /
   * `uninstall`), both refuse by a named class the message carries first, and neither is
   * followed by a local flip: an installed row arrives on the next `plugins` frame exactly as a
   * toggled one does, because the roster is server-owned. The result is parsed rather than
   * trusted, for the reason purge's is — a row that says "installed" but whose grant this tab
   * could not read would be a consent nobody can audit.
   */
  const install = async (draft: InstallDraft): Promise<void> => {
    setPendingId(ENGINE_INSTALL_ACTION);
    setFailure(null);
    setInstallNotice(null);
    try {
      const outcome = await host.client.action(ENGINE_INSTALL_ACTION, {
        source: draft.source,
        sha256: draft.sha256,
        ...(draft.grant.length === 0 ? {} : { grant: [...draft.grant] }),
      });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      const record = PluginInstallResultSchema.safeParse(outcome.result);
      if (record.success) {
        const granted =
          record.data.grantedCaps.length === 0 ? "nothing" : record.data.grantedCaps.join(", ");
        setInstallNotice(`Installed ${record.data.id} ${record.data.version} — granted ${granted}`);
      } else {
        setFailure("The bundle was installed, but its install record could not be read");
      }
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not install the plugin");
    } finally {
      setPendingId(null);
    }
  };

  const uninstall = async (id: string): Promise<void> => {
    setPendingId(id);
    setFailure(null);
    setInstallNotice(null);
    try {
      const outcome = await host.client.action(ENGINE_UNINSTALL_ACTION, { id });
      if (!outcome.ok) setFailure(outcome.denial.message);
      else setInstallNotice(`Uninstalled ${id} — its stored data is kept; purge destroys it`);
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not uninstall the plugin");
    } finally {
      setPendingId(null);
    }
  };

  const categories = pluginCatalog(roster, query, filter);

  const composed = (
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
            const settingsOpen = settingsId === manifest.id;
            /*
              THE GEAR IS OFFERED ON EVERY ROW, declared settings or not (#133) — the one
              affordance here that is not conditional on what the row can do. "This plugin has
              nothing to configure" is an ANSWER a reader can only get by asking, and hiding the
              question on the rows with no answer means the absence of a gear has to be read as
              two different things at once. The pane says which it is, by name.

              It needs no capability either: a preference is written against the caller's own
              principal, so a read-only visitor who may not touch the enablement switch may
              still decide what their own rail holds.
             */
            const declared = settings.filter((setting) => setting.plugin === manifest.id);
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
                  <button
                    className={`plugin-manager-settings-open${settingsOpen ? " is-open" : ""}`}
                    type="button"
                    aria-expanded={settingsOpen}
                    aria-label={`${settingsOpen ? "Hide" : "Show"} ${manifest.title} settings`}
                    title={`${manifest.title} settings — yours, on every device you sign in from`}
                    data-testid="plugin-manager-settings-open"
                    onClick={() => setSettingsId(settingsOpen ? null : manifest.id)}
                  >
                    <ControlIcon kind="settings" size={13} />
                  </button>
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
                {!settingsOpen ? null : (
                  <SettingsPane
                    settings={declared}
                    pluginTitle={manifest.title}
                    pending={pendingSetting}
                    onSet={(setting, value) => void setSetting(setting, value)}
                  />
                )}
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
                    {tab === "composed" ? (
                      composed
                    ) : (
                      <InstalledPanel
                        roster={roster}
                        canInstall={canInstall}
                        busy={pendingId}
                        failure={failure}
                        notice={installNotice}
                        onInstall={(draft) => void install(draft)}
                        onUninstall={(id) => void uninstall(id)}
                      />
                    )}
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
