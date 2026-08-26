import { expect, test } from "bun:test";
import {
  CreatePadFolderRequestSchema,
  MovePadTreeItemRequestSchema,
  PadResponseSchema,
  PadTreeResponseSchema,
  type PadTreeItem,
  PadsResponseSchema,
  RenamePadRequestSchema,
} from "@manifold/protocol";
import { createPad, ownerFetch, startServer, type TestServer } from "../src/index.ts";
import { e2eFailure, stopProcesses } from "./helpers.ts";

test("pads can be renamed without changing their durable identity", async () => {
  const servers: TestServer[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const created = await createPad(server, "Before rename");

    const response = await ownerFetch(server, `/api/pads/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(RenamePadRequestSchema.parse({ name: "After rename" })),
      responseSchema: PadResponseSchema,
    });

    expect(response.pad).toEqual({ ...created, name: "After rename" });
    const listed = await ownerFetch(server, "/api/pads", {
      responseSchema: PadsResponseSchema,
    });
    expect(listed.pads).toContainEqual(response.pad);
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
    const requestTree = (path: string, init?: RequestInit) =>
      ownerFetch(server, path, { ...init, responseSchema: PadTreeResponseSchema });
    const siblingIds = (items: readonly PadTreeItem[], parentId: string | null): string[] =>
      items
        .filter((item) => item.parentId === parentId)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => (item.kind === "pad" ? item.pad.id : item.id));

    const focusedTree = await requestTree("/api/pad-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CreatePadFolderRequestSchema.parse({ name: "Focused", parentId: null })),
    });
    const focused = focusedTree.items.find(
      (item) => item.kind === "folder" && item.name === "Focused",
    );
    if (focused?.kind !== "folder") throw new Error("focused folder missing");

    const nestedTree = await requestTree("/api/pad-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        CreatePadFolderRequestSchema.parse({ name: "Nested", parentId: focused.id }),
      ),
    });
    const nested = nestedTree.items.find(
      (item) => item.kind === "folder" && item.name === "Nested",
    );
    if (nested?.kind !== "folder") throw new Error("nested folder missing");

    const move = (
      item: { readonly kind: "pad" | "folder"; readonly id: string },
      parentId: string | null,
      index: number,
    ) =>
      requestTree("/api/pad-tree", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(MovePadTreeItemRequestSchema.parse({ item, parentId, index })),
      });

    await move({ kind: "folder", id: focused.id }, null, 1);
    await move({ kind: "pad", id: gamma.id }, focused.id, 0);
    const moved = await move({ kind: "pad", id: beta.id }, nested.id, 0);
    expect(siblingIds(moved.items, null)).toEqual([alpha.id, focused.id]);
    expect(siblingIds(moved.items, focused.id)).toEqual([gamma.id, nested.id]);
    expect(siblingIds(moved.items, nested.id)).toEqual([beta.id]);

    const persisted = await requestTree("/api/pad-tree");
    expect(persisted).toEqual(moved);

    const afterDelete = await requestTree(`/api/pad-folders/${focused.id}`, {
      method: "DELETE",
    });
    expect(siblingIds(afterDelete.items, null)).toEqual([alpha.id, gamma.id, nested.id]);
    expect(siblingIds(afterDelete.items, nested.id)).toEqual([beta.id]);
    expect(
      new Set(
        afterDelete.items.map(
          (item) => `${item.kind}:${item.kind === "pad" ? item.pad.id : item.id}`,
        ),
      ).size,
    ).toBe(afterDelete.items.length);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await stopProcesses(servers);
  }
});
