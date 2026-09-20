import { isPublicArtifactAddress } from "@manifold/plugin-kit/artifacts";
import { lookup } from "node:dns/promises";
import { Agent, request } from "node:http";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { checkServerIdentity, connect } from "node:tls";
import type { TLSSocket } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function hostname(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

async function destination(url: URL, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("artifact sources require HTTPS without URL credentials at every hop");
  }
  const host = hostname(url);
  let abort: (() => void) | undefined;
  try {
    const addresses =
      isIP(host) !== 0
        ? [{ address: host }]
        : await Promise.race([
            lookup(host, { all: true, verbatim: true }),
            new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
            }),
          ]);
    signal.throwIfAborted();
    // Reject mixed answers, not merely whichever answer the runtime happens to prefer.
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => !isPublicArtifactAddress(address))
    ) {
      throw new Error(
        "artifact destination is not ordinary public unicast; use the local upload drop box for private sources",
      );
    }
    return addresses[0]!.address;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function sameAddress(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (isIP(actual) !== 6 || isIP(expected) !== 6) return false;
  return new URL(`https://[${actual}]`).hostname === new URL(`https://[${expected}]`).hostname;
}

/** Complete TLS and verify the actual peer before any HTTP request bytes are sent. */
async function connectedResponse(
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  const host = hostname(url);
  let socket: TLSSocket | undefined;
  const abort = () => socket?.destroy(new Error("artifact fetch deadline exceeded"));
  const agent = new Agent({ keepAlive: false });
  const cleanup = () => {
    signal.removeEventListener("abort", abort);
    agent.destroy();
    socket?.destroy();
  };
  try {
    socket = await new Promise<TLSSocket>((resolve, reject) => {
      const candidate = connect({
        host: address,
        port: url.port === "" ? 443 : Number(url.port),
        ...(isIP(host) === 0 ? { servername: host } : {}),
        rejectUnauthorized: true,
        checkServerIdentity: (_, certificate) => checkServerIdentity(host, certificate),
      });
      socket = candidate;
      signal.addEventListener("abort", abort, { once: true });
      candidate.once("error", reject);
      candidate.once("secureConnect", () => {
        const actual = candidate.remoteAddress;
        if (
          actual === undefined ||
          !isPublicArtifactAddress(actual) ||
          !sameAddress(actual, address)
        ) {
          candidate.destroy(
            new Error("artifact connection did not reach its validated destination"),
          );
          return;
        }
        resolve(candidate);
      });
      if (signal.aborted) abort();
    });
    // HTTP framing over this already-verified TLS socket. The agent cannot resolve again,
    // pool another connection, or inherit an ambient HTTP(S)_PROXY route.
    agent.createConnection = () => socket!;
    return await new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: host,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: {
            Host: url.host,
            "Accept-Encoding": "gzip, deflate, br",
            "User-Agent": "manifold",
          },
          agent,
          signal,
        },
        (incoming) => {
          try {
            const status = incoming.statusCode;
            if (status === undefined) throw new Error("artifact response has no HTTP status");
            const headers = new Headers();
            for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
              headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
            }
            let body: Readable = incoming;
            const encoding = headers.get("content-encoding")?.trim().toLowerCase();
            if (encoding && encoding !== "identity") {
              const decoder =
                encoding === "gzip"
                  ? createGunzip()
                  : encoding === "deflate"
                    ? createInflate()
                    : encoding === "br"
                      ? createBrotliDecompress()
                      : null;
              if (decoder === null) throw new Error("unsupported artifact content encoding");
              incoming.once("error", (error) => decoder.destroy(error));
              decoder.once("close", () => incoming.destroy());
              body = incoming.pipe(decoder);
            }
            body.once("close", cleanup);
            if (status === 204 || status === 205 || status === 304) {
              incoming.destroy();
              cleanup();
              resolve(new Response(null, { status, headers }));
            } else {
              const iterator = body[Symbol.asyncIterator]();
              const stream = new ReadableStream<Uint8Array>({
                async pull(controller) {
                  const chunk = await iterator.next();
                  if (chunk.done) controller.close();
                  else if (chunk.value instanceof Uint8Array) controller.enqueue(chunk.value);
                  else
                    controller.error(new Error("artifact response contained a non-binary chunk"));
                },
                async cancel() {
                  body.destroy();
                  await iterator.return?.();
                },
              });
              resolve(new Response(stream, { status, headers }));
            }
          } catch (error) {
            incoming.destroy();
            cleanup();
            reject(error);
          }
        },
      );
      outgoing.once("error", (error) => {
        cleanup();
        reject(error);
      });
      outgoing.end();
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** One bounded policy for initial URLs, every redirect, resolution and the connected peer. */
export async function fetchArtifactResponse(
  source: string,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  let url = new URL(source);
  for (let hop = 0; ; hop++) {
    const address = await destination(url, signal);
    const response = fetchImpl
      ? await fetchImpl(url, { method: "GET", redirect: "manual", signal })
      : await connectedResponse(url, address, signal);
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (location === null) throw new Error("artifact redirect has no Location");
    if (hop === MAX_REDIRECTS) throw new Error("artifact redirect limit exceeded");
    url = new URL(location, url);
  }
}
