import { ENGINE_SET_ENABLED_ACTION, type SectionProps } from "@manifold/plugin";
import type { PluginRefusalReason, PluginRosterEntry } from "@manifold/protocol";
import { Lock } from "lucide-react";
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

function lockHint(entry: PluginRosterEntry): string | null {
  const reason = entry.refusal;
  if (reason === undefined) return null;
  return LOCK_HINTS[reason] ?? reason;
}

export function PluginManagerSection({ host }: SectionProps): ReactElement {
  const roster = host.composition.roster();
  const caps = host.client.selfCaps();
  const canManage = caps.includes("*") || caps.includes("plugins:manage");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    setPendingId(id);
    setFailure(null);
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

  return (
    <div className="plugin-manager" data-testid="plugin-manager">
      {!canManage ? (
        <p className="pad-sidebar-muted">
          Read-only: turning plugins on and off needs the <code>plugins:manage</code> capability.
        </p>
      ) : null}
      {failure === null ? null : (
        <p className="plugin-manager-error" role="alert">
          {failure}
        </p>
      )}
      {roster.length === 0 ? <span className="workspace-empty">No plugins composed</span> : null}
      {roster.map((entry) => {
        const { manifest } = entry;
        const hint = lockHint(entry);
        const lifecycle = entry.lifecycle === undefined ? null : LIFECYCLE_LABELS[entry.lifecycle];
        const attribution =
          typeof entry.changedBy === "string" ? `Last changed by ${entry.changedBy}` : null;
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
          </div>
        );
      })}
    </div>
  );
}
