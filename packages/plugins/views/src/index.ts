import { defineAction } from "@manifold/plugin";
import {
  CreatePadFolderRequestSchema,
  CreatePadRequestSchema,
  MovePadTreeItemRequestSchema,
  PadResponseSchema,
  PadTreeResponseSchema,
  PadsResponseSchema,
  RenamePadRequestSchema,
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
 * the server's SQLite schema, which is persistence substrate (AXIOMS.md §Foundation); what
 * moved here is the policy — which caller may ask, what a refusal says, and what the answer
 * looks like.
 *
 * `capabilities` is the ceiling those doors need, and `"*"` is in it because retiring a
 * container is root-only: deleting a canvas destroys every principal's work inside it, so
 * the authority to do it is the workspace owner's and no cap short of root stands in for it.
 */
export const viewsManifest: PluginManifest = {
  id: "core.views",
  version: "1.0.0",
  title: "Views",
  description:
    "The one workspace index: canvases, compositions, the terminals inside them, and folders over all three.",
  capabilities: ["*", "pads:read", "pads:write"],
  contributes: {
    panels: [],
    sections: [{ id: "views", title: "Views", order: 10 }],
    elements: [],
    tools: [],
    events: [],
  },
};

/**
 * Every door the index owns — its three reads and its six mutations. They are the bodies of
 * the deleted `/api/pads`, `/api/pad-folders` and `/api/pad-tree` routes, and the input
 * schemas ARE the protocol request schemas those routes parsed: one definition of the wire,
 * whether it arrives as a route body or as action arguments.
 *
 * Every mutation answers the whole new index (`{ items }`) or the row it changed (`{ pad }`),
 * exactly as its route did: the sidebar redraws from one answer instead of a write followed
 * by a read that a concurrent principal may have already changed.
 *
 * READS ARE NOT WORKSPACE-GRADE HERE. `tree`, `list` and `pad` are declared `scope: "pad"`
 * because a pad-scoped token could read all three through the routes they replace, and
 * converting a read must never narrow who may perform it (ADR 0013 §15). The declaration
 * creates an obligation the handlers carry: with a scope, `tree` answers that container and
 * its ancestor folders, `list` answers that container alone, and `pad` refuses any other id.
 * `renamePad` is `scope: "pad"` for the same reason — `PATCH /api/pads/:id` authorized
 * `pads:write` AT the named pad, so a token scoped to a container could always rename it.
 */
export const viewsActions = [
  defineAction({
    name: "tree",
    title: "Read the workspace index",
    caps: ["pads:read"],
    scope: "pad",
    input: z.strictObject({}),
    result: PadTreeResponseSchema,
  }),
  defineAction({
    name: "list",
    title: "List the containers",
    caps: ["pads:read"],
    scope: "pad",
    input: z.strictObject({}),
    result: PadsResponseSchema,
  }),
  defineAction({
    // One container by id: what a `/p/:id` deep link resolves before anything is composed.
    name: "pad",
    title: "Read one container",
    caps: ["pads:read"],
    scope: "pad",
    input: z.strictObject({ padId: z.string().min(1) }),
    result: PadResponseSchema,
  }),
  defineAction({
    name: "createPad",
    title: "Create a container",
    caps: ["pads:write"],
    input: CreatePadRequestSchema,
    result: PadResponseSchema,
  }),
  defineAction({
    name: "renamePad",
    title: "Rename a container",
    caps: ["pads:write"],
    scope: "pad",
    input: RenamePadRequestSchema.extend({ padId: z.string().min(1) }),
    result: PadResponseSchema,
  }),
  defineAction({
    // Retiring a container is CLEANUP (D12): it stays dispatchable while this plugin is
    // disabled, so an administrator turning the index off can never strand a container
    // nobody is able to remove. Root authority still answers for it.
    cleanup: true,
    name: "deletePad",
    title: "Delete a container",
    caps: ["*"],
    input: z.strictObject({ padId: z.string().min(1) }),
    result: z.strictObject({}),
  }),
  defineAction({
    name: "createFolder",
    title: "Create an index folder",
    caps: ["pads:write"],
    input: CreatePadFolderRequestSchema,
    result: PadTreeResponseSchema,
  }),
  defineAction({
    name: "renameFolder",
    title: "Rename an index folder",
    caps: ["pads:write"],
    input: RenamePadRequestSchema.extend({ folderId: z.string().min(1) }),
    result: PadTreeResponseSchema,
  }),
  defineAction({
    cleanup: true,
    name: "deleteFolder",
    title: "Delete an index folder",
    caps: ["pads:write"],
    input: z.strictObject({ folderId: z.string().min(1) }),
    result: PadTreeResponseSchema,
  }),
  defineAction({
    name: "move",
    title: "Move an index item",
    caps: ["pads:write"],
    input: MovePadTreeItemRequestSchema,
    result: PadTreeResponseSchema,
  }),
];
