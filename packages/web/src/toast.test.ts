import { describe, expect, test } from "bun:test";

import {
  evictionIndex,
  markLeaving,
  MAX_VISIBLE_TOASTS,
  pushToast,
  removeToast,
  type ToastEntry,
} from "./toast.tsx";

function entry(overrides: Partial<ToastEntry> & Pick<ToastEntry, "id">): ToastEntry {
  return {
    message: overrides.id,
    lifetime: "toast",
    key: null,
    leaving: false,
    ...overrides,
  };
}

/** Oldest-to-newest reading order, so the fixtures read the way the stack looks. */
function ids(queue: readonly ToastEntry[]): readonly string[] {
  return queue.map((item) => item.id);
}

describe("pushToast", () => {
  test("newest lands on top", () => {
    const queue = pushToast(pushToast([], entry({ id: "a" })), entry({ id: "b" }));
    expect(ids(queue)).toEqual(["b", "a"]);
  });

  test("keyless notices stack even when their text repeats", () => {
    const queue = pushToast(
      pushToast([], entry({ id: "a", message: "same" })),
      entry({ id: "b", message: "same" }),
    );
    expect(ids(queue)).toEqual(["b", "a"]);
  });

  test("a repeated key replaces its row where it stands", () => {
    const seeded = pushToast(
      pushToast([], entry({ id: "a", key: "connect", message: "first" })),
      entry({ id: "b" }),
    );
    const queue = pushToast(seeded, entry({ id: "c", key: "connect", message: "second" }));
    // Slot preserved: the replacement does not jump above the unrelated notice.
    expect(ids(queue)).toEqual(["b", "c"]);
    expect(queue[1]?.message).toBe("second");
  });

  test("a key never revives a row that is already fading", () => {
    const fading = markLeaving(pushToast([], entry({ id: "a", key: "connect" })), "a");
    const queue = pushToast(fading, entry({ id: "b", key: "connect" }));
    expect(ids(queue)).toEqual(["b", "a"]);
    expect(queue[1]?.leaving).toBe(true);
  });

  test("overflow evicts the oldest fading row first", () => {
    let queue: readonly ToastEntry[] = [];
    for (const id of ["a", "b", "c", "d"]) queue = pushToast(queue, entry({ id }));
    queue = markLeaving(queue, "b");
    queue = pushToast(queue, entry({ id: "e" }));
    expect(queue).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(ids(queue)).toEqual(["e", "d", "c", "a"]);
  });

  test("a burst of refusals can never push a sticky failure off the stack", () => {
    let queue: readonly ToastEntry[] = pushToast([], entry({ id: "outage", lifetime: "sticky" }));
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) queue = pushToast(queue, entry({ id }));
    expect(queue).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(ids(queue)).toEqual(["r5", "r4", "r3", "outage"]);
  });

  test("only an all-sticky stack gives up its oldest sticky", () => {
    let queue: readonly ToastEntry[] = [];
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
      queue = pushToast(queue, entry({ id, lifetime: "sticky" }));
    }
    expect(ids(queue)).toEqual(["s5", "s4", "s3", "s2"]);
  });
});

describe("evictionIndex", () => {
  test("prefers fading, then toast, then sticky — oldest within each tier", () => {
    const queue = [
      entry({ id: "new-toast" }),
      entry({ id: "old-toast" }),
      entry({ id: "sticky", lifetime: "sticky" }),
    ];
    expect(evictionIndex(queue)).toBe(1);
    expect(evictionIndex([queue[0]!, queue[2]!])).toBe(0);
    expect(evictionIndex([entry({ id: "s1", lifetime: "sticky" }), queue[2]!])).toBe(1);
    expect(evictionIndex(markLeaving(queue, "new-toast"))).toBe(0);
  });
});

describe("markLeaving / removeToast", () => {
  test("both are identity for ids the stack does not hold", () => {
    const queue = pushToast([], entry({ id: "a" }));
    expect(markLeaving(queue, "ghost")).toBe(queue);
    expect(removeToast(queue, "ghost")).toBe(queue);
  });

  test("marking twice is idempotent, so a hand dismissal mid-fade is harmless", () => {
    const fading = markLeaving(pushToast([], entry({ id: "a" })), "a");
    expect(markLeaving(fading, "a")).toBe(fading);
  });

  test("removal drops exactly one row", () => {
    const queue = pushToast(pushToast([], entry({ id: "a" })), entry({ id: "b" }));
    expect(ids(removeToast(queue, "a"))).toEqual(["b"]);
  });
});
