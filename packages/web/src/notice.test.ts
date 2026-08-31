import { describe, expect, test } from "bun:test";

import {
  evictionIndex,
  markLeaving,
  MAX_VISIBLE_NOTICES,
  pushNotice,
  removeNotice,
  type NoticeEntry,
} from "./notice.tsx";

function entry(overrides: Partial<NoticeEntry> & Pick<NoticeEntry, "id">): NoticeEntry {
  return {
    message: overrides.id,
    lifetime: "notice",
    key: null,
    leaving: false,
    ...overrides,
  };
}

/** Oldest-to-newest reading order, so the fixtures read the way the stack looks. */
function ids(queue: readonly NoticeEntry[]): readonly string[] {
  return queue.map((item) => item.id);
}

describe("pushNotice", () => {
  test("newest lands on top", () => {
    const queue = pushNotice(pushNotice([], entry({ id: "a" })), entry({ id: "b" }));
    expect(ids(queue)).toEqual(["b", "a"]);
  });

  test("keyless notices stack even when their text repeats", () => {
    const queue = pushNotice(
      pushNotice([], entry({ id: "a", message: "same" })),
      entry({ id: "b", message: "same" }),
    );
    expect(ids(queue)).toEqual(["b", "a"]);
  });

  test("a repeated key replaces its row where it stands", () => {
    const seeded = pushNotice(
      pushNotice([], entry({ id: "a", key: "connect", message: "first" })),
      entry({ id: "b" }),
    );
    const queue = pushNotice(seeded, entry({ id: "c", key: "connect", message: "second" }));
    // Slot preserved: the replacement does not jump above the unrelated notice.
    expect(ids(queue)).toEqual(["b", "c"]);
    expect(queue[1]?.message).toBe("second");
  });

  test("a key never revives a row that is already fading", () => {
    const fading = markLeaving(pushNotice([], entry({ id: "a", key: "connect" })), "a");
    const queue = pushNotice(fading, entry({ id: "b", key: "connect" }));
    expect(ids(queue)).toEqual(["b", "a"]);
    expect(queue[1]?.leaving).toBe(true);
  });

  test("overflow evicts the oldest fading row first", () => {
    let queue: readonly NoticeEntry[] = [];
    for (const id of ["a", "b", "c", "d"]) queue = pushNotice(queue, entry({ id }));
    queue = markLeaving(queue, "b");
    queue = pushNotice(queue, entry({ id: "e" }));
    expect(queue).toHaveLength(MAX_VISIBLE_NOTICES);
    expect(ids(queue)).toEqual(["e", "d", "c", "a"]);
  });

  test("a burst of refusals can never push a sticky failure off the stack", () => {
    let queue: readonly NoticeEntry[] = pushNotice([], entry({ id: "outage", lifetime: "sticky" }));
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) queue = pushNotice(queue, entry({ id }));
    expect(queue).toHaveLength(MAX_VISIBLE_NOTICES);
    expect(ids(queue)).toEqual(["r5", "r4", "r3", "outage"]);
  });

  test("only an all-sticky stack gives up its oldest sticky", () => {
    let queue: readonly NoticeEntry[] = [];
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
      queue = pushNotice(queue, entry({ id, lifetime: "sticky" }));
    }
    expect(ids(queue)).toEqual(["s5", "s4", "s3", "s2"]);
  });
});

describe("evictionIndex", () => {
  test("prefers fading, then notice, then sticky — oldest within each tier", () => {
    const queue = [
      entry({ id: "new-notice" }),
      entry({ id: "old-notice" }),
      entry({ id: "sticky", lifetime: "sticky" }),
    ];
    expect(evictionIndex(queue)).toBe(1);
    expect(evictionIndex([queue[0]!, queue[2]!])).toBe(0);
    expect(evictionIndex([entry({ id: "s1", lifetime: "sticky" }), queue[2]!])).toBe(1);
    expect(evictionIndex(markLeaving(queue, "new-notice"))).toBe(0);
  });
});

describe("markLeaving / removeNotice", () => {
  test("both are identity for ids the stack does not hold", () => {
    const queue = pushNotice([], entry({ id: "a" }));
    expect(markLeaving(queue, "ghost")).toBe(queue);
    expect(removeNotice(queue, "ghost")).toBe(queue);
  });

  test("marking twice is idempotent, so a hand dismissal mid-fade is harmless", () => {
    const fading = markLeaving(pushNotice([], entry({ id: "a" })), "a");
    expect(markLeaving(fading, "a")).toBe(fading);
  });

  test("removal drops exactly one row", () => {
    const queue = pushNotice(pushNotice([], entry({ id: "a" })), entry({ id: "b" }));
    expect(ids(removeNotice(queue, "a"))).toEqual(["b"]);
  });
});
