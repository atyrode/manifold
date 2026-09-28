import type { PortableSectionProps } from "@manifold/plugin";
import type { ComponentType } from "react";
import { MACHINES_PLUGIN_ID } from "./names.ts";
import { MachinesSection } from "./web.tsx";

/**
 * THE PORTABLE WEB DEFINITION: the one Machines section component, named for the compiler.
 *
 * A trusted bootstrap that hardens `core.machines` compiles this module as the build's web
 * source; the packer wraps it into the self-contained `web.worker.js` that attaches the guest
 * runtime, and links the in-realm `web.js` to the page's registry. Nothing here chooses an
 * execution mode, and the in-realm page assembly keeps importing `MachinesSection` itself.
 */
const machinesWebPlugin: {
  readonly id: string;
  readonly sections: Readonly<Record<string, ComponentType<PortableSectionProps>>>;
} = { id: MACHINES_PLUGIN_ID, sections: { machines: MachinesSection } };

export default machinesWebPlugin;
