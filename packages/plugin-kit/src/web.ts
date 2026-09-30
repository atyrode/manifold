import type {
  PortableElementProps,
  PortablePanelProps,
  PortableSectionProps,
} from "@manifold/plugin";
import type { ComponentType } from "react";

/**
 * THE WEB AUTHORING DOOR (ADR 0053). A portable web half is ordinary React: one component
 * source whose default export is this definition. Packed for the page, the module is linked to
 * the shell's React and design system and runs in-realm like any mod; packed for a hardened
 * install, the same components run in the plugin's Worker under the kit's frame renderer, which
 * the packer's Worker entry attaches. Nothing here starts a runtime, so importing it is inert.
 *
 * Components receive the portable host: the viewer's identity, the mounted container, feed
 * topics, the authoring door and the client slice whose calls have a bounded representation —
 * never a bearer, a DOM handle or a room replica. In a Worker, `@manifold/ui` resolves to its
 * frame barrel and `@manifold/plugin/hooks` to its portable entry; anything else the Worker
 * cannot honor is refused when packing or rendering, never dropped.
 */
export interface ReactWebPluginDef {
  readonly id: string;
  /** Keyed by LOCAL panel id, the ids the manifest's `contributes.panels` declares. */
  readonly panels?: Readonly<Record<string, ComponentType<PortablePanelProps>>> | undefined;
  /** Keyed by LOCAL section id, the ids the manifest's `contributes.sections` declares. */
  readonly sections?: Readonly<Record<string, ComponentType<PortableSectionProps>>> | undefined;
  /** Keyed by the manifest's element type, with no DOM, Yjs or layout-library props. */
  readonly elements?: Readonly<Record<string, ComponentType<PortableElementProps>>> | undefined;
}

/** Identity helper for `export default defineWebPlugin({ ... })`: typed once, at the definition. */
export function defineWebPlugin(def: ReactWebPluginDef): ReactWebPluginDef {
  return def;
}
