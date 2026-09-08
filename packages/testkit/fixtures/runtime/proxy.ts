import { createConnection, createServer, type Socket } from "node:net";

export interface BrowserProxy {
  readonly url: string;
  readonly upgrades: number;
  readonly bufferedBytes: number;
  stall(): void;
  resume(): void;
  close(): Promise<void>;
}

/** Fault injection below the SDK: forwards real bytes, never fabricates a protocol message. */
export async function browserProxy(targetPort: number): Promise<BrowserProxy> {
  const sockets = new Set<Socket>();
  const streams = new Set<Socket>();
  let stalled = false;
  let upgrades = 0;
  const server = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    let header = "";
    const inspect = (data: Buffer) => {
      header += data.toString("latin1");
      if (!header.includes("\r\n\r\n") && header.length < 16 * 1024) return;
      if (/\r\nupgrade:\s*websocket\r\n/i.test(header)) {
        streams.add(upstream);
        upgrades++;
        if (stalled) upstream.pause();
      }
      header = "";
      client.off("data", inspect);
    };
    client.on("data", inspect);
    client.pipe(upstream);
    upstream.pipe(client);
    for (const socket of [client, upstream]) {
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on("close", () => {
        sockets.delete(socket);
        streams.delete(socket);
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("proxy did not bind loopback");
  return {
    url: `http://127.0.0.1:${address.port}`,
    get upgrades() {
      return upgrades;
    },
    get bufferedBytes() {
      return [...streams].reduce((sum, socket) => sum + socket.readableLength, 0);
    },
    stall() {
      stalled = true;
      for (const socket of streams) socket.pause();
    },
    resume() {
      stalled = false;
      for (const socket of streams) socket.resume();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
