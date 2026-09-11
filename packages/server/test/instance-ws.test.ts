import { describe, expect, test } from "bun:test";
import { MAX_SESSION_FRAME_BYTES, PROTOCOL_VERSION, type Container } from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { InstanceGateway } from "../src/instance-ws.ts";
import { silentLogger } from "../src/log.ts";
import type { RawSocket } from "../src/session-channel.ts";
import { FakeClock, FakeRuntime, testStore } from "./helpers.ts";

const OWNER_KEY = "b".repeat(64);
const GUEST_ORIGIN = "https://guest.example";

/** A socket whose send status and buffer depth the test chooses, as `machine-ws.test.ts` does. */
class StatusSocket implements RawSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  constructor(private readonly status: number) {}

  send(data: string): number {
    this.sent.push(data);
    return this.status;
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

/** A gateway with one live share, and the guest hello that dials it. */
function dial(status: number): { socket: StatusSocket; open: () => void } {
  const runtime = new FakeRuntime();
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const root = auth.authenticate(OWNER_KEY);
  const container: Container = {
    id: runtime.newId(),
    name: "shared canvas",
    createdAt: runtime.now(),
    discipline: "canvas",
  };
  store.createContainer(container);
  const share = auth.mintShare(
    {
      node: { kind: "container", containerId: container.id },
      caps: ["containers:read"],
      origin: GUEST_ORIGIN,
    },
    root,
  );
  const gateway = new InstanceGateway(
    auth,
    store,
    new FakeClock(runtime),
    silentLogger,
    "epoch",
    () => "https://host.example",
  );
  const socket = new StatusSocket(status);
  return {
    socket,
    open: () => {
      gateway.open("connection", socket);
      gateway.message(
        "connection",
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          origin: GUEST_ORIGIN,
          instanceVersion: "0.0.0",
          token: share.token,
        }),
      );
    },
  };
}

describe("instance channel send status", () => {
  test("an enqueued welcome keeps the authenticated link open", () => {
    // Bun returns -1 for "buffered, backpressure applied". Reading that as a lost frame closed
    // a live control link the first time the kernel buffer filled.
    const dialed = dial(-1);
    dialed.open();

    expect(dialed.socket.sent).toHaveLength(1);
    expect(JSON.parse(dialed.socket.sent[0]!).type).toBe("welcome");
    expect(dialed.socket.closed).toBeNull();
  });

  test("a dropped welcome still closes the link", () => {
    const dialed = dial(0);
    dialed.open();

    expect(dialed.socket.closed?.code).toBe(1011);
    expect(dialed.socket.closed?.reason).toBe("welcome frame dropped");
  });

  test("an outbound queue past the frame ceiling sheds the link instead of growing", () => {
    const dialed = dial(-1);
    dialed.socket.bufferedAmount = MAX_SESSION_FRAME_BYTES;
    dialed.open();

    expect(dialed.socket.sent).toHaveLength(0);
    expect(dialed.socket.closed?.code).toBe(1013);
    expect(dialed.socket.closed?.reason).toBe("outbound queue overflow");
  });
});
