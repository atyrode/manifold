import { expect, test } from "bun:test";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createContainer,
  enrollMachine,
  mintToken,
  startAgent,
  startServer,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import { closeClients, e2eFailure, stopProcesses } from "./helpers.ts";

test("raw bearer and machine tokens never appear in captured child output", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer({ env: { MANIFOLD_ANNOUNCE_KEY: "1" } });
    servers.push(server);
    const container = await createContainer(server, "secret logging guard");
    const enrolled = await enrollMachine(server, "secret-logging-agent");
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Secret Holder", color: "#5e48c7" },
      caps: ["containers:read"],
      containerId: container.id,
    });

    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "secret-logging-agent",
    });
    agents.push(agent);
    clients.push(
      await connect(server, { containerId: container.id, token: grant.token, reconnect: false }),
    );

    closeClients(clients);
    await stopProcesses([...servers, ...agents]);

    const lines = [...servers, ...agents].flatMap((process) => [
      ...process.output.stdout,
      ...process.output.stderr,
    ]);
    const captured = lines.join("\n");
    expect(captured).not.toContain(grant.token);
    expect(captured).not.toContain(enrolled.machineToken);

    const ownerKeyLines = lines.filter((line) => line.includes(server.ownerKey));
    expect(ownerKeyLines).toHaveLength(1);
    expect(ownerKeyLines[0]).toContain(`#key=${server.ownerKey}`);
    expect(ownerKeyLines[0]?.match(new RegExp(server.ownerKey, "g"))).toHaveLength(1);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 30_000);
