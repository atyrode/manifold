import { defineServerPlugin } from "@manifold/plugin-kit/server";
import { machinesActions, machinesManifest } from "@manifold-plugin/machines";
import { machinesHandlers } from "@manifold-plugin/machines/server";

/**
 * THE HARDENED SERVER ENTRY for `core.machines` (ADR 0053 §7): the SAME manifest, doors and
 * handlers `assembly.ts` registers in-realm, started as a guest when this module is the entry
 * of a supervised child and inert anywhere else. It is compiled only by the trusted bootstrap
 * (`first-party-builds.ts`) and is part of the server composition root, beside the recipe that
 * names it.
 */
defineServerPlugin({ manifest: machinesManifest, actions: machinesActions, handlers: machinesHandlers });
