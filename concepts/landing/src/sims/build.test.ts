import { expect, test } from "bun:test";
import {
  type BuildKind,
  type BuildMessage,
  type BuildReply,
  BuildSlot,
  BuildWorker,
} from "./build.ts";

// BuildSlot asked again for the key whose finished result is on show, while another build runs:
// that build is dropped and nothing is built or lands, on the page and on a worker; after a draft
// or a cancel the key builds anew.

/** A build of a few slices, its result its request (a draft first, request + 0.5, if `draft`). */
function counting(draft = false): { kind: BuildKind<number, number>; begun: number[] } {
  const begun: number[] = [];
  return {
    begun,
    kind: {
      name: "counting",
      builder: () => ({
        *build(request) {
          begun.push(request);
          yield undefined;
          if (draft) yield request + 0.5;
          yield undefined;
          return request;
        },
      }),
    },
  };
}

test("the key on show asked for again drops the build in progress, building nothing", () => {
  const { kind, begun } = counting();
  const slot = new BuildSlot(kind);
  slot.request("a", 1);
  expect(slot.advance(Infinity)).toEqual({ key: "a", result: 1, done: true });
  slot.request("b", 2);
  // A slice of b, as a frame with no time to spare runs it.
  expect(slot.advance(0, 1)).toBeUndefined();
  slot.request("a", 1);
  expect(slot.advance(Infinity)).toBeUndefined();
  expect(begun).toEqual([1, 2]);
  // b again builds anew, and lands.
  slot.request("b", 2);
  expect(slot.advance(Infinity)).toEqual({ key: "b", result: 2, done: true });
  expect(begun).toEqual([1, 2, 2]);
});

test("after a draft on show, or a cancel, the key last finished builds anew", () => {
  const { kind, begun } = counting(true);
  const slot = new BuildSlot(kind);
  slot.request("a", 1);
  expect(slot.advance(Infinity)?.done).toBe(false);
  expect(slot.advance(Infinity)).toEqual({ key: "a", result: 1, done: true });
  slot.request("b", 2);
  expect(slot.advance(Infinity)).toEqual({ key: "b", result: 2.5, done: false });
  // b's draft is on show, not a's result.
  slot.request("a", 1);
  expect(slot.advance(Infinity)).toEqual({ key: "a", result: 1.5, done: false });
  expect(slot.advance(Infinity)).toEqual({ key: "a", result: 1, done: true });
  slot.cancel();
  slot.request("a", 1);
  expect(slot.advance(Infinity)?.result).toBe(1.5);
  expect(begun).toEqual([1, 2, 1, 1]);
});

/** A stand-in for the build worker: what the page posts, and replies sent back by hand. */
class Posts {
  readonly sent: BuildMessage[] = [];
  onmessage: ((event: MessageEvent<BuildReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(message: BuildMessage): void {
    this.sent.push(message);
  }
  reply(data: BuildReply): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

test("on a worker, the key on show asked again cancels the build there; nothing lands", () => {
  const { kind } = counting();
  const posts = new Posts();
  // BuildWorker only sets onmessage and onerror and posts: the stand-in has those.
  const worker = posts as unknown as Worker;
  const slot = new BuildSlot(kind, new BuildWorker(worker));
  slot.request("a", 1);
  slot.advance(8);
  const first = posts.sent[0];
  if (first?.type !== "build") throw new Error("no build posted");
  posts.reply({ slot: first.slot, id: first.id, result: 1, done: true });
  expect(slot.advance(8)).toEqual({ key: "a", result: 1, done: true });
  slot.request("b", 2);
  slot.advance(8);
  const second = posts.sent[1];
  if (second?.type !== "build") throw new Error("no second build posted");
  slot.request("a", 1);
  expect(slot.advance(8)).toBeUndefined();
  // b's result, finished there before the cancel arrived, is dropped.
  posts.reply({ slot: second.slot, id: second.id, result: 2, done: true });
  expect(slot.advance(8)).toBeUndefined();
  expect(posts.sent.map((message) => message.type)).toEqual(["build", "build", "cancel"]);
});
