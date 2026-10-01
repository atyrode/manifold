import {
  defineServerAction,
  defineServerPlugin,
  type ServerActionDef,
  type ServerPluginDef,
} from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
import manifestJson from "./manifest.json";
import { CAPS, DOORS, contracts } from "./src/contract.ts";
import { handlers, lifecycle } from "./src/publication.ts";

const metadata = {
  [DOORS.configureConnection]: {
    title: "Register an existing owner-native GitHub connection",
    caps: [CAPS.configure],
    delegates: ["services:configure", "services:read"],
  },
  [DOORS.readConnections]: {
    title: "Read currently authorized GitHub destinations",
    caps: [CAPS.read],
    delegates: ["services:read"],
  },
  [DOORS.prepareIssuePublication]: {
    title: "Prepare exact public issue text for review",
    caps: [CAPS.prepare],
    delegates: ["services:read"],
  },
  [DOORS.publishIssue]: {
    title: "Publish the reviewed GitHub issue once",
    caps: [CAPS.publish],
    delegates: ["services:read", "services:invoke"],
  },
  [DOORS.readPublication]: {
    title: "Read your reviewed publication and receipt",
    caps: [CAPS.read],
    delegates: ["services:read"],
  },
  [DOORS.reconcilePublication]: {
    title: "Reconcile an unknown publication without creating an issue",
    caps: [CAPS.read],
    delegates: ["services:read"],
  },
} satisfies Record<keyof typeof contracts, Pick<ServerActionDef, "title" | "caps" | "delegates">>;

export const actions = Object.values(DOORS).map((name) =>
  defineServerAction<unknown, unknown>({
    name,
    ...metadata[name],
    trace: "opaque",
    input: contracts[name].input,
    result: contracts[name].result,
  }),
);

export { handlers, lifecycle };

const definition = {
  manifest: PluginManifestSchema.parse(manifestJson),
  actions,
  handlers,
  lifecycle,
} satisfies ServerPluginDef;

// Ordinary installation loads the definition; hardened installation attaches
// the same definition to the authored guest transport.
export default definition;
defineServerPlugin(definition);
