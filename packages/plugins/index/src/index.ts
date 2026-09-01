import { defineAction } from "@manifold/plugin";
import {
  CreateIndexFolderRequestSchema,
  CreateContainerRequestSchema,
  MoveIndexEntryRequestSchema,
  ContainerResponseSchema,
  IndexResponseSchema,
  ContainersResponseSchema,
  RenameContainerRequestSchema,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";

/**
 * The workspace index, as a plugin. ONE index of everything that exists: canvases,
 * compositions, and the terminals that live in them, with folders over all three — a canvas
 * and a composition are one object told apart by its discipline, so nothing here filters by
 * layout and the row's glyph carries the difference.
 *
 * It owns the index's DOOR as well as its rendering: reading the tree, creating, renaming
 * and deleting containers and folders, and moving any of them. The rows themselves stay in
 * the server's SQLite schema, which is persistence substrate (REGISTRY.md §Foundation); what
 * moved here is the policy — which caller may ask, what a refusal says, and what the answer
 * looks like.
 *
 * `capabilities` is the ceiling those doors need, and `"*"` is in it because retiring a
 * container is root-only: deleting a canvas destroys every principal's work inside it, so
 * the authority to do it is the workspace owner's and no cap short of root stands in for it.
 *
 * ESSENTIAL (issue #113), and the criterion is bootstrap rather than chrome: this is the only
 * door that mints a container and the only door that reads one. Off, a fresh workspace can
 * never make the first thing a principal would inhabit, an existing `/p/:id` cannot resolve
 * the name or the discipline of the container it routes to, and the shell has no inventory to
 * route from — so what is left is a rail with nowhere to go, which is a broken workspace and
 * not a degraded one. That is the same tier `core.shell` holds and for the same reason: the
 * floor's boot path names this plugin (`packages/web/src/assembly.ts`), and the floor may only
 * lean on a seat the engine guarantees is there.
 *
 * The `cleanup` carve-out on `deleteFolder` / `deleteContainer` stays, unchanged and still
 * necessary: `essential` refuses the DOOR, so an assembly can still arrive with this seat off
 * out of band, and an administrator in that state must never be left holding a container or a
 * folder nobody can remove (D12).
 */
export const indexManifest: PluginManifest = {
  id: "core.index",
  version: "1.0.0",
  title: "Index",
  description:
    "The one workspace index: canvases, compositions, the terminals inside them, and folders over all three.",
  capabilities: ["*", "containers:read", "containers:write"],
  essential: true,
  contributes: {
    panels: [],
    /*
      TWO ROWS OF THE RAIL, and the pairing is the point: this plugin owns folders, so it owns
      both the offer to create a top-level one and the tree that lists it. `new-folder` is
      `plain` (a creator plus the form it opens — a control, not a collapsible block) and takes
      `order: 4`, the last of the three creators; `index` keeps `order: 10` and its default
      `disclosure`, and it is the row the rail's leftover height goes to, because it is the
      first row in the order with a body (`railRows`).
     */
    sections: [
      { id: "new-folder", title: "New folder", order: 4, presentation: "plain" },
      { id: "index", title: "Index", order: 10 },
    ],
    elements: [],
    tools: [],
    /*
      THE INDEX'S OWN NEWS (ADR 0012). Every one of these is addressed to this plugin's own
      node — `manifold://plugin/core.index` — rather than to the row that moved, and that is
      the collection rule rather than laziness: a container that does not exist yet cannot be
      subscribed to in advance, and a container that was just deleted has no address left to
      be a topic. The index is a view OF the collection, so the collection is the topic, and a
      section that used to poll `core.index.read` now holds exactly one subscription.

      Folders have no `manifold://` form at all (the grammar's seven do not include one), which
      makes the collection topic the only honest address for their three kinds.
     */
    events: [
      { id: "container_created", title: "Container created" },
      { id: "container_renamed", title: "Container renamed" },
      { id: "container_deleted", title: "Container deleted" },
      { id: "folder_created", title: "Folder created" },
      { id: "folder_renamed", title: "Folder renamed" },
      { id: "folder_deleted", title: "Folder deleted" },
      { id: "index_moved", title: "Index entry moved" },
    ],
  },
};

/**
 * Every door the index owns — its three reads and its six mutations. They are the bodies of
 * the deleted `/api/containers`, `/api/container-folders` and `/api/container-tree` routes, and the input
 * schemas ARE the protocol request schemas those routes parsed: one definition of the wire,
 * whether it arrives as a route body or as action arguments.
 *
 * Every mutation answers the whole new index (`{ items }`) or the row it changed (`{ container }`),
 * exactly as its route did: the sidebar redraws from one answer instead of a write followed
 * by a read that a concurrent principal may have already changed.
 *
 * READS ARE NOT WORKSPACE-GRADE HERE. `read`, `listContainers` and `readContainer` are declared
 * `scope: "container"` because a container-scoped token could read all three through the routes
 * they replace, and converting a read must never narrow who may perform it (ADR 0013 §15). The
 * declaration creates an obligation the handlers carry: with a scope, `read` answers that
 * container and its ancestor folders, `listContainers` answers that container alone, and
 * `readContainer` refuses any other id. `renameContainer` is `scope: "container"` for the same
 * reason — `PATCH /api/containers/:id` authorized `containers:write` AT the named container, so a
 * token scoped to a container could always rename it.
 */
export const indexActions = [
  defineAction({
    name: "read",
    title: "Read the workspace index",
    caps: ["containers:read"],
    scope: "container",
    input: z.strictObject({}),
    result: IndexResponseSchema,
  }),
  defineAction({
    name: "listContainers",
    title: "List the containers",
    caps: ["containers:read"],
    scope: "container",
    input: z.strictObject({}),
    result: ContainersResponseSchema,
  }),
  defineAction({
    // One container by id: what a `/p/:id` deep link resolves before anything is composed.
    name: "readContainer",
    title: "Read one container",
    caps: ["containers:read"],
    scope: "container",
    input: z.strictObject({ containerId: z.string().min(1) }),
    result: ContainerResponseSchema,
  }),
  defineAction({
    name: "createContainer",
    title: "Create a container",
    caps: ["containers:write"],
    input: CreateContainerRequestSchema,
    result: ContainerResponseSchema,
  }),
  defineAction({
    name: "renameContainer",
    title: "Rename a container",
    caps: ["containers:write"],
    scope: "container",
    input: RenameContainerRequestSchema.extend({ containerId: z.string().min(1) }),
    result: ContainerResponseSchema,
  }),
  defineAction({
    // Retiring a container is CLEANUP (D12): it stays dispatchable while this plugin is
    // disabled, so an administrator turning the index off can never strand a container
    // nobody is able to remove. Root authority still answers for it.
    cleanup: true,
    name: "deleteContainer",
    title: "Delete a container",
    caps: ["*"],
    input: z.strictObject({ containerId: z.string().min(1) }),
    result: z.strictObject({}),
  }),
  defineAction({
    name: "createFolder",
    title: "Create an index folder",
    caps: ["containers:write"],
    input: CreateIndexFolderRequestSchema,
    result: IndexResponseSchema,
  }),
  defineAction({
    name: "renameFolder",
    title: "Rename an index folder",
    caps: ["containers:write"],
    input: RenameContainerRequestSchema.extend({ folderId: z.string().min(1) }),
    result: IndexResponseSchema,
  }),
  defineAction({
    // CLEANUP for the same reason `deleteContainer` above is, and not root-only: a folder is
    // presentation over containers nobody loses by removing, so `containers:write` is the
    // whole bar. Children move up rather than dying with it, so this strands nothing either.
    cleanup: true,
    name: "deleteFolder",
    title: "Delete an index folder",
    caps: ["containers:write"],
    input: z.strictObject({ folderId: z.string().min(1) }),
    result: IndexResponseSchema,
  }),
  defineAction({
    name: "moveEntry",
    title: "Move an index entry",
    caps: ["containers:write"],
    input: MoveIndexEntryRequestSchema,
    result: IndexResponseSchema,
  }),
];
