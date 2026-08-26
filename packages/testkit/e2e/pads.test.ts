import { expect, test } from "bun:test";
import { PadResponseSchema, PadsResponseSchema, RenamePadRequestSchema } from "@manifold/protocol";
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
