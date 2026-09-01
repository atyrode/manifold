import type { SectionProps } from "@manifold/plugin";
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import type { ReactElement } from "react";

/**
 * `core.shell.identity` — who this device is, at the foot of the rail. A PLAIN row, and the
 * last one in the default order.
 *
 * The colour and the name come from `host.principal`, which every plugin is handed: identity
 * is engine mechanism (the device's bootstrap answers it before any plugin exists), so this
 * row reads it and never owns it. Collapsed to icons the dot alone carries it, with the name
 * on the row's own `title` — a colour is recognisable at rail width and a truncated name is
 * not.
 */
export function IdentityRow({ host }: SectionProps): ReactElement {
  const { sidebarOpen } = useWorkspaceShell();
  return (
    <footer className="sidebar-identity" title={host.principal.name}>
      <span className="identity-dot" style={{ backgroundColor: host.principal.color }} />
      {sidebarOpen ? <span>{host.principal.name}</span> : null}
    </footer>
  );
}
