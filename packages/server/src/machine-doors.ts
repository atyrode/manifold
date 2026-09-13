import { defineAction } from "@manifold/plugin";
import {
  MachineRepositoryFactSchema,
  MachineRepositoryQuerySchema,
  type MachineRepositoryQuery,
} from "@manifold/protocol";
import { z } from "zod";
import type { ActionCtx, ServerPluginDef } from "./plugin-host.ts";

/**
 * THE MACHINE'S OWN FACTS, as doors (issue #529).
 *
 * A job runs in a sandbox that sees only its declared locations, so a plugin inside one
 * cannot ask git about a folder nobody declared — and widening the sandbox to the whole home
 * read-only was refused, because it would expose every secret file in `~` to reach one
 * `.git`. The enrolled agent is already on the host and already reports facts about the
 * machine, so the manifold-shaped answer is a READ: the hub asks the agent, the agent looks,
 * and the observation comes back as data.
 *
 * It is an ENGINE row rather than a member of `core.machines` for the reason every engine
 * row is one: `core.machines` is a plugin an administrator may switch off, and switching off
 * the fleet's UI must not take a governed machine read away from every plugin that depends
 * on it. It is the second thing on this row's namespace and the first that reaches a host.
 */
export const machineDoorSchemas = { repository: MachineRepositoryQuerySchema };

/** Either the published fact, or the refusal the door turns into a `refused` denial. */
const result = z.union([
  MachineRepositoryFactSchema,
  z.strictObject({ refused: z.string().min(1) }),
]);

export const machineDoors: ServerPluginDef = {
  manifest: {
    id: "engine.machines",
    version: "1.0.0",
    title: "Machine facts",
    description: "Governed reads of what an enrolled machine's agent can see on its host.",
    capabilities: ["machines:read"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  },
  actions: [
    defineAction<MachineRepositoryQuery, unknown>({
      name: "repository",
      title: "What repository a folder on a machine is",
      caps: ["machines:read"],
      /*
        OPAQUE, and the argument is the reason. A path names somebody's directory layout —
        a client name under `~/work`, a checkout under `/srv/customers/…` — and the trace
        ledger is read by everybody who can read the ledger. The ACT is recorded, the machine
        it was asked of is named as the target (`ctx.target` below), and the folder stays out
        of the row: an audit answers "who asked this machine about a folder, and when",
        which is the question a ledger is for, without publishing the folder itself.
      */
      trace: "opaque",
      input: machineDoorSchemas.repository,
      result,
    }),
  ],
  handlers: {
    /**
     * The cap is asked TWICE and neither is redundant. The ladder above proves the caller
     * holds `machines:read` at its own anchor — that is what makes the door openable at all
     * — and this line proves it holds it AT THIS MACHINE, which is the only question worth
     * asking of a fleet: a token granted the cap at one machine must not read another's
     * host. The declaration cannot express it, because the requirement seam takes a
     * `manifold://` reference out of the arguments and this door's argument is a machine ID
     * beside a path, not a reference.
     *
     * The refusal names no machine and no path: telling a caller that the machine it may not
     * read exists is a disclosure the denial does not need.
     */
    repository: async (ctx: ActionCtx, args: MachineRepositoryQuery) => {
      const node = { kind: "machine", machineId: args.machineId } as const;
      ctx.target(node);
      if (!ctx.auth.allows("machines:read", node)) {
        return { refused: "machines:read capability required at this machine" };
      }
      if (ctx.store.getMachine(args.machineId) === null) return { refused: "unknown machine" };
      const outcome = await ctx.machines.repository(args.machineId, args.path);
      return outcome.ok ? outcome.fact : { refused: outcome.reason };
    },
  },
};
