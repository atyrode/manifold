import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  ACTION_TRACE_ID_HEADER,
  AGENT_JUSTIFICATION_HEADER,
  PROTOCOL_VERSION,
  decodeAgentJustification,
  type ActionOutcome,
  type ActionSummary,
} from "@manifold/protocol";
import { ActionHttpError, discoverActions, invokeAction } from "../src/action-http.ts";
import { SessionClient } from "../src/session-client.ts";

const TOKEN = "a".repeat(64);
const options = { origin: "http://runner.invalid////", token: TOKEN };
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  const replacement = Object.assign(handler, { preconnect: globalThis.fetch.preconnect });
  mocks.push(spyOn(globalThis, "fetch").mockImplementation(replacement));
}

describe("shared action HTTP boundary", () => {
  test("a session preserves the structured refusal while headless callers retain its durable reference", async () => {
    const denial: ActionOutcome = {
      ok: false,
      denial: { rule: "forbidden", message: "containers:create capability required" },
    };
    const requests: Request[] = [];
    mockFetch(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(denial, { headers: { [ACTION_TRACE_ID_HEADER]: "731" } });
    });
    const client = new SessionClient({
      url: "ws://runner.invalid/ws/session",
      token: TOKEN,
      containerId: "room",
    });
    expect(await client.action("installed.example.effect", { target: "one" })).toEqual(denial);
    expect(
      await invokeAction(
        options,
        "installed.example.effect",
        { target: "one" },
        { agentJustification: "Repair the approved target —\nthen verify it." },
      ),
    ).toEqual({ outcome: denial, traceId: 731 });
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/api/actions/installed.example.effect"],
      ["POST", "/api/actions/installed.example.effect"],
    ]);
    expect(
      decodeAgentJustification(requests[1]?.headers.get(AGENT_JUSTIFICATION_HEADER) ?? ""),
    ).toBe("Repair the approved target —\nthen verify it.");
    expect(await requests[1]?.json()).toEqual({ target: "one" });
    client.close();
  });

  test("discovery is authenticated and preserves installed schemas, refusing version mismatch and duplicate doors", async () => {
    const action: ActionSummary = {
      name: "stranger.toolbox.effect",
      title: "Effect",
      caps: [],
      scope: "workspace",
      input: { type: "object", properties: { count: { type: "integer" } } },
      result: { type: "null" },
    };
    let payload: unknown = { protocolVersion: PROTOCOL_VERSION, actions: [action] };
    mockFetch(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(new URL(request.url).pathname).toBe("/api/protocol");
      expect(request.redirect).toBe("error");
      return Response.json(payload);
    });
    expect((await discoverActions(options)).actions).toEqual([action]);
    payload = { protocolVersion: PROTOCOL_VERSION + 1, actions: [action] };
    await expect(discoverActions(options)).rejects.toMatchObject({ code: "incompatible_protocol" });
    payload = { protocolVersion: PROTOCOL_VERSION, actions: [action, action] };
    await expect(discoverActions(options)).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("known handler failure retains its trace without inventing one on untraced responses", async () => {
    let response = () =>
      Response.json(
        { error: { code: "internal", message: "internal server error" } },
        { status: 500, headers: { [ACTION_TRACE_ID_HEADER]: "33" } },
      );
    mockFetch(async () => response());
    await expect(invokeAction(options, "installed.effect", {})).rejects.toMatchObject({
      status: 500,
      traceId: 33,
    });
    response = () =>
      Response.json({ ok: false, denial: { rule: "unknown_action", message: "unknown action" } });
    expect((await invokeAction(options, "unknown.effect", {})).traceId).toBeNull();
    response = () => new Response("not JSON", { headers: { [ACTION_TRACE_ID_HEADER]: "34" } });
    await expect(invokeAction(options, "installed.effect", {})).rejects.toBeInstanceOf(
      ActionHttpError,
    );
  });

  test("ordinary SDK requests do not impose an unsolicited deadline", async () => {
    const timeout = spyOn(AbortSignal, "timeout");
    mocks.push(timeout);
    mockFetch(async () => Response.json({ ok: true, result: {} }));
    await invokeAction(options, "installed.longService", {});
    expect(timeout).not.toHaveBeenCalled();
  });

  for (const source of ["caller", "deadline"] as const) {
    test(`an explicitly bounded request preserves ${source} cancellation`, async () => {
      const caller = new AbortController();
      const started = Promise.withResolvers<void>();
      let activeSignal: AbortSignal | null = null;
      mockFetch(async (_input, init) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) throw new Error("missing cancellation");
        activeSignal = signal;
        started.resolve();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      const pending = invokeAction(
        { ...options, signal: caller.signal, timeoutMs: source === "deadline" ? 1 : 30_000 },
        "installed.longService",
        {},
      );
      await started.promise;
      if (source === "caller") {
        caller.abort();
        expect(activeSignal!.aborted).toBe(true);
      }
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DOMException);
      expect((failure as DOMException).name).toBe(
        source === "caller" ? "AbortError" : "TimeoutError",
      );
    });
  }
});
