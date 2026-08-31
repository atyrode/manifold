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
import { Lock, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";

/**
 * Composition administration, rendered by the composition it administers. The list is the
 * server's roster verbatim (`host.composition.roster()`), so this section can never disagree
 * with what the workspace actually composed, and the toggle is one action — enablement is
 * workspace-GLOBAL and hot, so flipping it here changes what every principal's client
 * composes and the new roster is pushed rather than polled (D4).
 *
 * The door it calls is the ENGINE's (`engine.plugins.setEnabled`), not this plugin's. This
 * plugin owns the UI and only the UI; it is itself an ordinary, disableable row in the list
 * it renders.
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

export function PluginManagerSection({ host }: SectionProps): ReactElement {
  const roster = host.assembly.roster();
  const caps = host.client.selfCaps();
  const canManage = caps.includes("*") || caps.includes("plugins:manage");
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

  return (
    <div className="plugin-manager" data-testid="plugin-manager">
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
      {roster.length === 0 ? (
        <span className="sidebar-section-empty">No plugins composed</span>
      ) : null}
      {roster.map((entry) => {
        const { manifest } = entry;
        const hint = lockHint(entry);
        const lifecycle = entry.lifecycle === undefined ? null : LIFECYCLE_LABELS[entry.lifecycle];
        const attribution =
          typeof entry.changedBy === "string" ? `Last changed by ${entry.changedBy}` : null;
        /*
          A purge is offered on a DISABLED row and nowhere else, because that is the door's own
          rule rather than a second one written here: `engine.plugins.purge` is refused while
          the plugin is enabled (class `still_enabled`), and an affordance that always fails is
          exactly what §5's "never offer a lever the door refuses" forbids. Disable first,
          purge second — and the first step is the reversible one.
         */
        const purgeable = canManage && !entry.enabled;
        const armed = armedId === manifest.id;
        return (
          <div
            className={`plugin-manager-row${entry.enabled ? "" : " is-disabled"}`}
            data-plugin={manifest.id}
            data-source={entry.source}
            key={manifest.id}
          >
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
                aria-label={`${entry.enabled ? "Disable" : "Enable"} ${manifest.title}`}
                title={
                  canManage
                    ? [
                        `${entry.enabled ? "Disable" : "Enable"} ${manifest.title} for everyone`,
                        attribution,
                      ]
                        .filter((line) => line !== null)
                        .join(" · ")
                    : "Requires plugins:manage"
                }
                data-action={ENGINE_SET_ENABLED_ACTION}
                data-testid="plugin-manager-toggle"
                disabled={!canManage || pendingId === manifest.id}
                onClick={() => void toggle(manifest.id, !entry.enabled)}
              >
                {entry.enabled ? "On" : "Off"}
              </button>
            ) : (
              <span className="plugin-manager-lock" title={hint} aria-label={hint}>
                <Lock className="mf-icon" size={13} strokeWidth={1.75} absoluteStrokeWidth />
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
                // Losing focus disarms: an armed destructive control that stays armed while
                // the reader looks away is a trap, and Escape is the same retreat by keyboard.
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
                {armed ? (
                  "Purge?"
                ) : (
                  <Trash2 className="mf-icon" size={13} strokeWidth={1.75} absoluteStrokeWidth />
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
