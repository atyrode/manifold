import { expect, test } from "bun:test";
import {
  CreatePadFolderRequestSchema,
  MovePadTreeItemRequestSchema,
  PadResponseSchema,
  PadTreeResponseSchema,
  type PadTreeItem,
  RenamePadRequestSchema,
} from "@manifold/protocol";
import { createPad, listPads, ownerAction, startServer, type TestServer } from "../src/index.ts";
import { e2eFailure, stopProcesses } from "./helpers.ts";

/**
 * THE WORKSPACE INDEX, end to end, through the doors `core.views` owns. Every verb here was
 * a bespoke HTTP route until the index became a plugin; the behaviour under test is unchanged
 * and that is the point — one published vocabulary answers what four routes used to.
 */

test("pads can be renamed without changing their durable identity", async () => {
  const servers: TestServer[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const created = await createPad(server, "Before rename");

    const renamed = PadResponseSchema.parse(
      await ownerAction(server, "core.views.renamePad", {
        padId: created.id,
        ...RenamePadRequestSchema.parse({ name: "After rename" }),
      }),
    );

    expect(renamed.pad).toEqual({ ...created, name: "After rename" });
    expect(await listPads(server)).toContainEqual(renamed.pad);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await stopProcesses(servers);
  }
});

test("nested pad tree mutations return one authoritative persistent tree", async () => {
  const servers: TestServer[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const alpha = await createPad(server, "Alpha");
    const beta = await createPad(server, "Beta");
    const gamma = await createPad(server, "Gamma");
    const tree = async (name: string, args: unknown): Promise<readonly PadTreeItem[]> =>
      PadTreeResponseSchema.parse(await ownerAction(server, name, args)).items;
    const siblingIds = (items: readonly PadTreeItem[], parentId: string | null): string[] =>
      items
        .filter((item) => item.parentId === parentId)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => (item.kind === "pad" ? item.pad.id : item.id));

    const focusedTree = await tree(
      "core.views.createFolder",
      CreatePadFolderRequestSchema.parse({ name: "Focused", parentId: null }),
    );
    const focused = focusedTree.find((item) => item.kind === "folder" && item.name === "Focused");
    if (focused?.kind !== "folder") throw new Error("focused folder missing");

    const nestedTree = await tree(
      "core.views.createFolder",
      CreatePadFolderRequestSchema.parse({ name: "Nested", parentId: focused.id }),
    );
    const nested = nestedTree.find((item) => item.kind === "folder" && item.name === "Nested");
    if (nested?.kind !== "folder") throw new Error("nested folder missing");

    const move = async (
      item: { readonly kind: "pad" | "folder"; readonly id: string },
      parentId: string | null,
      index: number,
    ): Promise<readonly PadTreeItem[]> =>
      await tree("core.views.move", MovePadTreeItemRequestSchema.parse({ item, parentId, index }));

    await move({ kind: "folder", id: focused.id }, null, 1);
    await move({ kind: "pad", id: gamma.id }, focused.id, 0);
    const moved = await move({ kind: "pad", id: beta.id }, nested.id, 0);
    expect(siblingIds(moved, null)).toEqual([alpha.id, focused.id]);
    expect(siblingIds(moved, focused.id)).toEqual([gamma.id, nested.id]);
    expect(siblingIds(moved, nested.id)).toEqual([beta.id]);

    const persisted = await tree("core.views.tree", {});
    expect(persisted).toEqual(moved);

    // Deleting an organizer is not a cascade: its children move up into its place.
    const afterDelete = await tree("core.views.deleteFolder", { folderId: focused.id });
    expect(siblingIds(afterDelete, null)).toEqual([alpha.id, gamma.id, nested.id]);
    expect(siblingIds(afterDelete, nested.id)).toEqual([beta.id]);
    expect(
      new Set(
        afterDelete.map((item) => `${item.kind}:${item.kind === "pad" ? item.pad.id : item.id}`),
      ).size,
    ).toBe(afterDelete.length);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await stopProcesses(servers);
  }
});
