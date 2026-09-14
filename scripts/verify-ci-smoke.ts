import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  connect,
  createContainer,
  listContainers,
  mintToken,
  ownerFetch,
  startServer,
  type TestServer,
} from "../packages/testkit/src/index.ts";
import type { SessionClient } from "../packages/sdk/src/index.ts";

const dist = process.env["MANIFOLD_GATE_DIST"];
if (dist === undefined || !isAbsolute(dist) || !existsSync(join(dist, "index.html"))) {
  throw new Error(
    "verify-ci-smoke requires an absolute built MANIFOLD_GATE_DIST containing index.html",
  );
}

let server: TestServer | undefined;
let client: SessionClient | undefined;
try {
  server = await startServer({ env: { MANIFOLD_WEB_DIST: dist } });
  const health = await ownerFetch(server, "/healthz");
  if (typeof health !== "object" || health === null)
    throw new Error("server health response was not an object");

  const root = await fetch(server.httpUrl);
  if (!root.ok || !(await root.text()).includes("<html")) {
    throw new Error(`server did not serve the supplied web artifact (${root.status})`);
  }

  const container = await createContainer(server, "CI smoke");
  const grant = await mintToken(server, {
    principal: { kind: "human", name: "CI smoke", color: "#3155a4" },
    caps: ["containers:read", "scenes:write"],
    containerId: container.id,
  });
  client = await connect(server, {
    containerId: container.id,
    token: grant.token,
    reconnect: false,
  });
  if (client.self?.id !== grant.principal.id) {
    throw new Error("SDK joined without the minted principal identity");
  }
  if (!(await listContainers(server)).some((candidate) => candidate.id === container.id)) {
    throw new Error("created container was absent from the authoritative index");
  }
  console.log("PASS  CI smoke: built web, server health, owner action, and SDK join");
} finally {
  client?.close();
  await server?.stop();
}
