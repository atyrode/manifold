import { expect, test } from "bun:test";
import {
  CreatePadFolderRequestSchema,
  MovePadRequestSchema,
  OkResponseSchema,
  PadFolderResponseSchema,
  PadFoldersResponseSchema,
  PadResponseSchema,
  PadsResponseSchema,
  RenamePadRequestSchema,
  ReorderPadsRequestSchema,
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

test("pad order and folders persist through the public HTTP contract", async () => {
  const servers: TestServer[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const alpha = await createPad(server, "Alpha");
    const beta = await createPad(server, "Beta");
    const gamma = await createPad(server, "Gamma");

    await ownerFetch(server, "/api/pads/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        ReorderPadsRequestSchema.parse({ padIds: [gamma.id, alpha.id, beta.id] }),
      ),
      responseSchema: OkResponseSchema,
    });
    const ordered = await ownerFetch(server, "/api/pads", {
      responseSchema: PadsResponseSchema,
    });
    expect(ordered.pads.map((pad) => pad.id)).toEqual([gamma.id, alpha.id, beta.id]);

    const createdFolder = await ownerFetch(server, "/api/pad-folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CreatePadFolderRequestSchema.parse({ name: "Focused" })),
      responseSchema: PadFolderResponseSchema,
    });
    await ownerFetch(server, `/api/pads/${alpha.id}/folder`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MovePadRequestSchema.parse({ folderId: createdFolder.folder.id })),
      responseSchema: OkResponseSchema,
    });
    const folders = await ownerFetch(server, "/api/pad-folders", {
      responseSchema: PadFoldersResponseSchema,
    });
    expect(folders.folders).toEqual([{ ...createdFolder.folder, padIds: [alpha.id] }]);

    await ownerFetch(server, `/api/pad-folders/${createdFolder.folder.id}`, {
      method: "DELETE",
      responseSchema: OkResponseSchema,
    });
    const afterDelete = await ownerFetch(server, "/api/pads", {
      responseSchema: PadsResponseSchema,
    });
    expect(afterDelete.pads).toHaveLength(3);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await stopProcesses(servers);
  }
});
