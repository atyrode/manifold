import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect, createServer as createTCPServer, type Socket } from "node:net";
import type { ServiceTunnelFrame } from "@manifold/protocol";
import { createServiceTunnel, type ServiceTunnel } from "../src/job-service-tunnel.ts";

const FRAME_BYTES = 16 * 1024;
const channelId = "proved-owner-channel";

function pair() {
  const leftController = new AbortController();
  const rightController = new AbortController();
  const leftFrames: ServiceTunnelFrame[] = [];
  const rightFrames: ServiceTunnelFrame[] = [];
  const errors: Error[] = [];
  const left = createServiceTunnel({
    channelId,
    signal: leftController.signal,
    send(frame) {
      leftFrames.push(frame);
      right.receive(frame);
      return true;
    },
  });
  const right = createServiceTunnel({
    channelId,
    signal: rightController.signal,
    send(frame) {
      rightFrames.push(frame);
      left.receive(frame);
      return true;
    },
  });
  left.stream.on("error", (error: Error) => errors.push(error));
  right.stream.on("error", (error: Error) => errors.push(error));
  return {
    left,
    right,
    leftController,
    rightController,
    leftFrames,
    rightFrames,
    errors,
    close() {
      left.close();
      right.close();
    },
  };
}

function collect(tunnel: ServiceTunnel): Promise<Buffer> {
  const result = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  tunnel.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  tunnel.stream.once("error", result.reject);
  tunnel.stream.once("end", () => result.resolve(Buffer.concat(chunks)));
  return result.promise;
}

test("real HTTP upload completion preserves a gated streaming response through paired tunnels", async () => {
  const tunnels = pair();
  const upload = Buffer.alloc(5 * FRAME_BYTES + 17, 0x75);
  const first = Buffer.from("first-response-before-completion\n");
  const responseBody = Buffer.concat([first, Buffer.alloc(9 * FRAME_BYTES + 31, 0x72)]);
  const uploaded = Promise.withResolvers<Buffer>();
  const continueResponse = Promise.withResolvers<void>();
  const firstReceived = Promise.withResolvers<void>();
  const responseEnded = Promise.withResolvers<void>();
  const responseChunks: Buffer[] = [];
  let responseComplete = false;
  let serverSocket: Socket | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      uploaded.resolve(Buffer.concat(chunks));
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": responseBody.length,
        connection: "close",
      });
      response.write(first);
      await continueResponse.promise;
      response.end(responseBody.subarray(first.length));
    })().catch((error: unknown) => {
      uploaded.reject(error);
      firstReceived.reject(error);
      response.destroy();
    });
  });
  server.on("connection", (socket) => {
    serverSocket = socket;
  });
  let socket: Socket | undefined;
  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing HTTP address");
    socket = connect({ port: address.port, host: "127.0.0.1", allowHalfOpen: true });
    socket.on("error", () => tunnels.right.close());
    await once(socket, "connect");
    const upstream = socket;
    tunnels.right.stream.once("close", () => upstream.destroy());
    socket.once("close", () => tunnels.right.close());
    socket.pipe(tunnels.right.stream).pipe(socket);
    tunnels.left.stream.on("data", (chunk: Buffer) => {
      responseChunks.push(chunk);
      if (Buffer.concat(responseChunks).includes(first)) firstReceived.resolve();
    });
    tunnels.left.stream.once("end", () => {
      tunnels.left.stream.end();
      responseComplete = true;
      responseEnded.resolve();
    });
    tunnels.left.stream.once("error", (error) => {
      firstReceived.reject(error);
      responseEnded.resolve();
    });
    const headers = Buffer.from(
      `POST /stream HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${upload.length}\r\nConnection: close\r\n\r\n`,
    );
    tunnels.left.stream.write(Buffer.concat([headers, upload]));
    const [receivedUpload] = await Promise.all([uploaded.promise, firstReceived.promise]);
    expect(receivedUpload).toEqual(upload);
    expect(responseComplete).toBe(false);
    continueResponse.resolve();
    await responseEnded.promise;
    expect(tunnels.errors).toEqual([]);
    const response = Buffer.concat(responseChunks);
    const headerEnd = response.indexOf("\r\n\r\n");
    expect(response.subarray(0, headerEnd).toString()).toContain("HTTP/1.1 200 OK");
    expect(response.subarray(headerEnd + 4)).toEqual(responseBody);
  } finally {
    continueResponse.resolve();
    tunnels.close();
    socket?.destroy();
    serverSocket?.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    server.closeAllConnections();
    await closed.promise;
  }
});

test("TCP request half-close leaves the native response channel writable", async () => {
  const tunnels = pair();
  const upload = Buffer.alloc(3 * FRAME_BYTES + 11, 0x75);
  const response = Buffer.alloc(5 * FRAME_BYTES + 23, 0x72);
  const uploaded = Promise.withResolvers<Buffer>();
  let peer: Socket | undefined;
  let socket: Socket | undefined;
  const server = createTCPServer({ allowHalfOpen: true }, (connection) => {
    peer = connection;
    const chunks: Buffer[] = [];
    connection.on("data", (bytes: Buffer) => chunks.push(bytes));
    connection.once("error", uploaded.reject);
    connection.once("end", () => {
      uploaded.resolve(Buffer.concat(chunks));
      connection.end(response);
    });
  });
  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    socket = connect({ host: "127.0.0.1", port: address.port, allowHalfOpen: true });
    const upstream = socket;
    socket.on("error", () => tunnels.right.close());
    await once(socket, "connect");
    tunnels.right.stream.once("close", () => upstream.destroy());
    socket.once("close", () => tunnels.right.close());
    socket.pipe(tunnels.right.stream).pipe(socket);
    const received = collect(tunnels.left);
    tunnels.left.stream.end(upload);
    const [requestBytes, responseBytes] = await Promise.all([uploaded.promise, received]);
    expect(requestBytes).toEqual(upload);
    expect(responseBytes).toEqual(response);
    expect(tunnels.errors).toEqual([]);
  } finally {
    tunnels.close();
    socket?.destroy();
    peer?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an unread peer bounds frames and propagates writable backpressure until consumption", async () => {
  const tunnels = pair();
  try {
    const payload = Buffer.alloc(4 * FRAME_BYTES + 7, 0x61);
    const drained = once(tunnels.left.stream, "drain");
    let completed = false;
    const written = Promise.withResolvers<void>();
    expect(
      tunnels.left.stream.write(payload, (error) => {
        completed = true;
        if (error) written.reject(error);
        else written.resolve();
      }),
    ).toBe(false);
    expect(completed).toBe(false);
    expect(tunnels.leftFrames.filter((frame) => frame.type === "data")).toHaveLength(1);
    expect(tunnels.right.stream.readableLength).toBe(FRAME_BYTES);
    expect(tunnels.rightFrames).toEqual([]);

    const received = collect(tunnels.right);
    await Promise.all([written.promise, drained]);
    tunnels.left.stream.end();
    expect(await received).toEqual(payload);
    // Sending EOF did not end the other half. It remains usable for the reply.
    const reply = collect(tunnels.left);
    tunnels.right.stream.end("reply after EOF");
    expect((await reply).toString()).toBe("reply after EOF");
    expect(tunnels.errors).toEqual([]);
  } finally {
    tunnels.close();
  }
});

test("small buffered frames cannot grow the readable backlog without bound", async () => {
  const tunnels = pair();
  try {
    tunnels.left.stream.write(Buffer.alloc(FRAME_BYTES - 1, 0x61));
    const pending = Promise.withResolvers<Error | null | undefined>();
    tunnels.left.stream.write(Buffer.alloc(3 * FRAME_BYTES, 0x62), pending.resolve);
    expect(tunnels.right.stream.readableLength).toBe(2 * FRAME_BYTES - 1);
    expect(tunnels.leftFrames.filter((frame) => frame.type === "data")).toHaveLength(2);
    tunnels.right.close();
    expect(await pending.promise).toBeInstanceOf(Error);
  } finally {
    tunnels.close();
  }
});

test.each(["abort", "peer close"] as const)(
  "%s releases blocked and queued writes without reflecting arbitrary reasons or echoing close",
  async (cause) => {
    const tunnels = pair();
    try {
      const first = Promise.withResolvers<Error | null | undefined>();
      const queued = Promise.withResolvers<Error | null | undefined>();
      const leftClosed = Promise.withResolvers<void>();
      const rightClosed = Promise.withResolvers<void>();
      tunnels.left.stream.once("close", leftClosed.resolve);
      tunnels.right.stream.once("close", rightClosed.resolve);
      tunnels.left.stream.write(Buffer.alloc(2 * FRAME_BYTES), first.resolve);
      tunnels.left.stream.write("queued", queued.resolve);
      if (cause === "abort") tunnels.leftController.abort(new Error("private-owner-token"));
      else tunnels.right.close();
      const results = await Promise.all([first.promise, queued.promise]);
      await Promise.all([leftClosed.promise, rightClosed.promise]);
      for (const error of results) {
        expect(error).toBeInstanceOf(Error);
        expect(error?.message).not.toContain("private-owner-token");
      }
      expect(tunnels.left.stream.destroyed).toBe(true);
      expect(tunnels.right.stream.destroyed).toBe(true);
      expect(
        [...tunnels.leftFrames, ...tunnels.rightFrames].filter((frame) => frame.type === "close"),
      ).toHaveLength(1);
      const sent = tunnels.leftFrames.length + tunnels.rightFrames.length;
      tunnels.left.receive({ type: "close", channelId });
      tunnels.right.receive({ type: "close", channelId });
      tunnels.close();
      expect(tunnels.leftFrames.length + tunnels.rightFrames.length).toBe(sent);
      expect(tunnels.errors.every((error) => !error.message.includes("private-owner-token"))).toBe(
        true,
      );
    } finally {
      tunnels.close();
    }
  },
);

test.each(["refused", "throws"] as const)(
  "a %s transport fails the active write safely",
  async (mode) => {
    const controller = new AbortController();
    const tunnel = createServiceTunnel({
      channelId,
      signal: controller.signal,
      send() {
        if (mode === "throws") throw new Error("private-transport-detail");
        return false;
      },
    });
    const errors: Error[] = [];
    tunnel.stream.on("error", (error: Error) => errors.push(error));
    const closed = Promise.withResolvers<void>();
    tunnel.stream.once("close", closed.resolve);
    const written = Promise.withResolvers<Error | null | undefined>();
    tunnel.stream.write("payload", written.resolve);
    const error = await written.promise;
    await closed.promise;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain("private-transport-detail");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).not.toContain("private-transport-detail");
    expect(tunnel.stream.destroyed).toBe(true);
  },
);

const invalidFrames: [string, unknown][] = [
  ["foreign channel", { type: "data", channelId: "another-channel", sequence: 0, data: "AA==" }],
  ["foreign close", { type: "close", channelId: "another-channel" }],
  ["unknown frame", { type: "error", channelId, message: "private-peer-detail" }],
  [
    "extra field",
    { type: "data", channelId, sequence: 0, data: "AA==", secret: "private-peer-detail" },
  ],
  ["skipped data sequence", { type: "data", channelId, sequence: 1, data: "AA==" }],
  ["skipped EOF sequence", { type: "end", channelId, sequence: 1 }],
  ["wrong acknowledgement", { type: "ack", channelId, sequence: 1 }],
  ["negative sequence", { type: "data", channelId, sequence: -1, data: "AA==" }],
  ["fractional sequence", { type: "data", channelId, sequence: 0.5, data: "AA==" }],
  [
    "unsafe sequence",
    { type: "data", channelId, sequence: Number.MAX_SAFE_INTEGER + 1, data: "AA==" },
  ],
  ["empty data", { type: "data", channelId, sequence: 0, data: "" }],
  [
    "oversize data",
    {
      type: "data",
      channelId,
      sequence: 0,
      data: Buffer.alloc(FRAME_BYTES + 1).toString("base64"),
    },
  ],
  ["missing base64 padding", { type: "data", channelId, sequence: 0, data: "AA" }],
  ["nonzero base64 pad bits", { type: "data", channelId, sequence: 0, data: "AB==" }],
  ["base64 whitespace", { type: "data", channelId, sequence: 0, data: "AA==\n" }],
];

test.each(invalidFrames)(
  "rejects %s without releasing bytes or leaking peer content",
  async (_name, frame) => {
    const sent: ServiceTunnelFrame[] = [];
    const tunnel = createServiceTunnel({
      channelId,
      signal: new AbortController().signal,
      send(outbound) {
        sent.push(outbound);
        return true;
      },
    });
    tunnel.stream.on("error", () => {});
    const closed = Promise.withResolvers<void>();
    tunnel.stream.once("close", closed.resolve);
    const written = Promise.withResolvers<Error | null | undefined>();
    tunnel.stream.write("blocked until ack", written.resolve);
    tunnel.receive(frame);
    const error = await written.promise;
    await closed.promise;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain("private-peer-detail");
    expect(tunnel.stream.readableLength).toBe(0);
    expect(sent.filter((outbound) => outbound.type === "close")).toEqual([
      { type: "close", channelId },
    ]);
  },
);

test("a peer cannot bypass withheld credit with another data frame", async () => {
  const tunnels = pair();
  try {
    const written = Promise.withResolvers<Error | null | undefined>();
    tunnels.left.stream.write(Buffer.alloc(2 * FRAME_BYTES), written.resolve);
    tunnels.right.receive({ type: "data", channelId, sequence: 1, data: "AA==" });
    expect(await written.promise).toBeInstanceOf(Error);
    expect(tunnels.right.stream.destroyed).toBe(true);
    expect(tunnels.right.stream.readableLength).toBeLessThanOrEqual(FRAME_BYTES);
  } finally {
    tunnels.close();
  }
});

test.each(["ack", "end", "data"] as const)(
  "rejects a replayed %s after valid traffic",
  async (type) => {
    const tunnels = pair();
    try {
      const written = Promise.withResolvers<void>();
      tunnels.left.stream.write("request", () => written.resolve());
      await written.promise;
      let target = tunnels.left;
      let frame: ServiceTunnelFrame = { type: "ack", channelId, sequence: 0 };
      if (type === "data") {
        target = tunnels.right;
        frame = {
          type: "data",
          channelId,
          sequence: 0,
          data: Buffer.from("request").toString("base64"),
        };
      } else if (type === "end") {
        target = tunnels.right;
        tunnels.left.stream.end();
        frame = { type: "end", channelId, sequence: 1 };
      }
      const closed = Promise.withResolvers<void>();
      target.stream.once("close", closed.resolve);
      target.receive(frame);
      await closed.promise;
      expect(target.stream.destroyed).toBe(true);
    } finally {
      tunnels.close();
    }
  },
);

test("already aborted channels send no data and release subsequent writes", async () => {
  const frames: ServiceTunnelFrame[] = [];
  const controller = new AbortController();
  controller.abort("private-abort-reason");
  const tunnel = createServiceTunnel({
    channelId,
    signal: controller.signal,
    send(frame) {
      frames.push(frame);
      return true;
    },
  });
  tunnel.stream.on("error", () => {});
  const written = Promise.withResolvers<Error | null | undefined>();
  tunnel.stream.write("never forwarded", written.resolve);
  expect(await written.promise).toBeInstanceOf(Error);
  expect(tunnel.stream.destroyed).toBe(true);
  expect(frames.some((frame) => frame.type === "data")).toBe(false);
});

test("cancellation releases an unacknowledged EOF callback", async () => {
  const controller = new AbortController();
  const tunnel = createServiceTunnel({
    channelId,
    signal: controller.signal,
    send: () => true,
  });
  tunnel.stream.on("error", () => {});
  const ended = Promise.withResolvers<Error | null | undefined>();
  tunnel.stream.end((error?: Error | null) => ended.resolve(error));
  expect(tunnel.stream.writableFinished).toBe(false);
  controller.abort();
  expect(await ended.promise).toBeInstanceOf(Error);
  expect(tunnel.stream.destroyed).toBe(true);
});

test("oversized read demand cannot raise the tunnel's readable memory ceiling", async () => {
  const tunnels = pair();
  try {
    tunnels.right.stream.read(8 * FRAME_BYTES);
    const written = Promise.withResolvers<Error | null | undefined>();
    tunnels.left.stream.write(Buffer.alloc(4 * FRAME_BYTES), written.resolve);
    expect(tunnels.right.stream.readableLength).toBeLessThanOrEqual(2 * FRAME_BYTES);
    tunnels.close();
    expect(await written.promise).toBeInstanceOf(Error);
  } finally {
    tunnels.close();
  }
});
