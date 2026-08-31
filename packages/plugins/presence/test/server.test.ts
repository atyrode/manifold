import { describe, expect, test } from "bun:test";
import { presenceHandlers } from "../src/server.ts";

/**
 * DRIVING ANOTHER PRINCIPAL'S VIEW (A2), and the three guards that make it consensual.
 *
 * `core.presence.focus` is the sharpest action in the wave: it moves somebody else's viewport.
 * A2 says every capability must be reachable by a remote human and an agent identically, which
 * means the guard cannot be "only humans may" — it has to be structural. So: the target must be
 * an addressable node, the two principals must already share a live room the caller may write
 * to, and one spotlight per pair per two seconds keeps a door from becoming a viewport jammer.
 *
 * The handler declares its own slice of the host (D1: no store, no broker — a spotlight is
 * presence, so it cannot reach anything durable), which is exactly what lets these cases drive
 * it directly with no server, no socket and no clock.
 */

interface Attempt {
  readonly padId: string;
  readonly principalId: string;
  readonly spotlight: { readonly uri: string; readonly from: string };
}

interface Recorder {
  readonly ctx: Parameters<typeof presenceHandlers.focus>[0];
  readonly attempts: Attempt[];
  readonly sharedAsked: string[][];
  time: number;
}

/**
 * A host slice under the test's control: which rooms are shared, where the caller holds
 * `scene:write`, whether the target is still there, and what time it is.
 */
function recorder(options: {
  caller: string;
  shared?: readonly string[];
  writable?: readonly string[];
  present?: boolean;
}): Recorder {
  const attempts: Attempt[] = [];
  const sharedAsked: string[][] = [];
  const state = { time: 10_000 };
  return {
    attempts,
    sharedAsked,
    get time() {
      return state.time;
    },
    set time(value: number) {
      state.time = value;
    },
    ctx: {
      principal: { id: options.caller },
      auth: {
        allows: (_cap, padId) =>
          padId !== undefined && (options.writable ?? options.shared ?? []).includes(padId),
      },
      rooms: {
        sharedPadIds: (left, right) => {
          sharedAsked.push([left, right]);
          return options.shared ?? [];
        },
        setSpotlight: (padId, principalId, spotlight) => {
          attempts.push({ padId, principalId, spotlight });
          return options.present ?? true;
        },
      },
      now: () => state.time,
    },
  };
}

const URI = "manifold://pad/p1/element/el-1";

describe("core.presence.focus", () => {
  test("a target that is not an ADDRESS is refused before anything is looked up", async () => {
    const host = recorder({ caller: "pr-a", shared: ["p1"] });

    const outcome = await presenceHandlers.focus(host.ctx, {
      targetPrincipalId: "pr-b",
      uri: "https://example.com/look-here",
    });

    // A spotlight names a node (D7); a client cannot center on prose. Refusing first also
    // means a malformed call never costs a room lookup or the pair's budget.
    expect(outcome).toEqual({ refused: "uri is not a manifold:// address" });
    expect(host.sharedAsked).toEqual([]);
    expect(host.attempts).toEqual([]);
  });

  test("no shared room, no spotlight: consent is co-presence, not a setting", async () => {
    const host = recorder({ caller: "pr-a", shared: [] });

    const outcome = await presenceHandlers.focus(host.ctx, {
      targetPrincipalId: "pr-b",
      uri: URI,
    });

    // Otherwise any principal could yank any other principal's viewport across the whole
    // workspace, which is the difference between collaborating and hijacking.
    expect(outcome).toEqual({ refused: "no room shared with that principal" });
    expect(host.sharedAsked).toEqual([["pr-a", "pr-b"]]);
    expect(host.attempts).toEqual([]);
  });

  test("sharing a room is not enough: the caller must be able to WRITE there", async () => {
    const host = recorder({ caller: "pr-a", shared: ["p1", "p2"], writable: [] });

    const outcome = await presenceHandlers.focus(host.ctx, {
      targetPrincipalId: "pr-b",
      uri: URI,
    });

    // A read-only spectator watching a board may not steer the people working on it.
    expect(outcome).toEqual({ refused: "scene:write capability required in a shared room" });
    expect(host.attempts).toEqual([]);
  });

  test("the spotlight is written in the shared room the caller may actually write to", async () => {
    const host = recorder({
      caller: "pr-a",
      shared: ["read-only-1", "read-only-2", "writable"],
      writable: ["writable"],
    });

    const outcome = await presenceHandlers.focus(host.ctx, {
      targetPrincipalId: "pr-b",
      uri: URI,
    });

    // Several shared rooms is the ordinary case; the guard is "authority SOMEWHERE the two of
    // us both are", so the search must not stop at the first room that fails.
    expect(outcome).toEqual({});
    expect(host.attempts).toEqual([
      { padId: "writable", principalId: "pr-b", spotlight: { uri: URI, from: "pr-a" } },
    ]);
  });

  test("`from` is the CALLER, never anything the caller sent", async () => {
    const host = recorder({ caller: "pr-real", shared: ["p1"] });

    await presenceHandlers.focus(host.ctx, {
      targetPrincipalId: "pr-target",
      uri: URI,
      // Not part of the action's schema; here to prove the handler cannot be talked into
      // attributing a spotlight to somebody else.
      from: "pr-impersonated",
    } as never);

    // The target renders a source chip and a dismiss control from this field, so a forgeable
    // `from` would turn a consent affordance into a disguise.
    expect(host.attempts[0]?.spotlight.from).toBe("pr-real");
    expect(host.attempts[0]?.principalId).toBe("pr-target");
  });

  test("one spotlight per pair per two seconds, and the budget is per PAIR", async () => {
    const host = recorder({ caller: "pr-thrott", shared: ["p1"] });
    const focus = (target: string) =>
      presenceHandlers.focus(host.ctx, { targetPrincipalId: target, uri: URI });

    expect(await focus("pr-x")).toEqual({});
    // Immediately again: an interruption, not a stream (D6) — a continuous drive would belong
    // on a channel, and this door is deliberately not one.
    expect(await focus("pr-x")).toEqual({ refused: "throttled" });
    host.time += 1_999;
    expect(await focus("pr-x")).toEqual({ refused: "throttled" });

    // A DIFFERENT target is a different conversation and is not throttled by the first.
    expect(await focus("pr-y")).toEqual({});

    host.time += 1;
    expect(await focus("pr-x")).toEqual({});
    expect(host.attempts.map((attempt) => attempt.principalId)).toEqual(["pr-x", "pr-y", "pr-x"]);
  });

  test("the same target from a different caller has its own budget", async () => {
    const first = recorder({ caller: "pr-one", shared: ["p1"] });
    const second = recorder({ caller: "pr-two", shared: ["p1"] });

    expect(
      await presenceHandlers.focus(first.ctx, { targetPrincipalId: "pr-shared", uri: URI }),
    ).toEqual({});
    // Were the budget keyed on the target alone, one principal could deny every other
    // principal the ability to point at a busy collaborator.
    expect(
      await presenceHandlers.focus(second.ctx, { targetPrincipalId: "pr-shared", uri: URI }),
    ).toEqual({});
  });

  test("a refused attempt does not spend the pair's budget", async () => {
    const blocked = recorder({ caller: "pr-budget", shared: [] });
    const allowed = recorder({ caller: "pr-budget", shared: ["p1"] });

    expect(
      await presenceHandlers.focus(blocked.ctx, { targetPrincipalId: "pr-z", uri: URI }),
    ).toEqual({ refused: "no room shared with that principal" });

    // A guard that consumed the budget would let a caller lock ITSELF out for two seconds by
    // asking a question the workspace answered "no" to.
    expect(
      await presenceHandlers.focus(allowed.ctx, { targetPrincipalId: "pr-z", uri: URI }),
    ).toEqual({});
  });

  test("a target who left the room is refused, and may be pointed at again at once", async () => {
    const gone = recorder({ caller: "pr-gone", shared: ["p1"], present: false });

    expect(
      await presenceHandlers.focus(gone.ctx, { targetPrincipalId: "pr-left", uri: URI }),
    ).toEqual({ refused: "that principal is no longer in the room" });

    // Presence dies with the connection (D6), so "they were here a moment ago" is an ordinary
    // race rather than an error — and it must not cost the caller its next attempt.
    const back = recorder({ caller: "pr-gone", shared: ["p1"] });
    expect(
      await presenceHandlers.focus(back.ctx, { targetPrincipalId: "pr-left", uri: URI }),
    ).toEqual({});
  });
});
