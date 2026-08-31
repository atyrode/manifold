import type { SectionProps } from "@manifold/plugin";
import { Lock } from "lucide-react";
import { useState, type ReactElement } from "react";

/**
 * Composition administration, rendered by the composition it administers. The list is the
 * server's roster verbatim (`host.composition.roster()`), so this section can never disagree
 * with what the workspace actually composed, and the toggle is one action — enablement is
 * workspace-GLOBAL and hot, so flipping it here changes what every principal's client
 * composes and the new roster is pushed rather than polled (D4).
 *
 * Two refusals are shown rather than attempted:
 *  - without `plugins:manage` the toggles are inert. The door would refuse anyway; offering a
 *    lever that always fails is worse than naming the missing authority.
 *  - an `essential` plugin shows a lock. Its answer is already known: nothing else can draw
 *    the workspace, so `setEnabled` refuses it with `essential`.
 */
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
      const outcome = await host.client.action("core.plugins.setEnabled", { id, enabled });
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
        const essential = manifest.essential === true;
        return (
          <div
            className={`plugin-manager-row${entry.enabled ? "" : " is-disabled"}`}
            data-plugin={manifest.id}
            key={manifest.id}
          >
            <span className="plugin-manager-label">
              <strong title={manifest.description}>{manifest.title}</strong>
              <small>
                {manifest.id} · {manifest.version}
              </small>
            </span>
            {essential ? (
              <span
                className="plugin-manager-lock"
                title="Essential: the workspace cannot be drawn without it"
                aria-label="Essential plugin"
              >
                <Lock className="mf-icon" size={13} strokeWidth={1.75} absoluteStrokeWidth />
              </span>
            ) : (
              <button
                className="plugin-manager-toggle"
                type="button"
                role="switch"
                aria-checked={entry.enabled}
                aria-label={`${entry.enabled ? "Disable" : "Enable"} ${manifest.title}`}
                title={
                  canManage
                    ? `${entry.enabled ? "Disable" : "Enable"} ${manifest.title} for everyone`
                    : "Requires plugins:manage"
                }
                data-action="core.plugins.setEnabled"
                disabled={!canManage || pendingId === manifest.id}
                onClick={() => void toggle(manifest.id, !entry.enabled)}
              >
                {entry.enabled ? "On" : "Off"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
