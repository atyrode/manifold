import { describe, expect, test } from "bun:test";
import { testStore } from "./helpers.ts";

interface EventRow {
  ts: number;
  type: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const EXPECTED_MAX_PER_PAD = 10_000;

describe("ServerStore event retention", () => {
  test("addEvent prunes rows older than 30 days using the caller timestamp", () => {
    const store = testStore();
    const now = 40 * DAY_MS;
    store.addEvent("expired-pad", now - 30 * DAY_MS - 1, null, "expired", {});
    store.addEvent("active-pad", now, null, "current", {});

    const expired = store.db
      .query<EventRow, [string]>("SELECT ts, type FROM events WHERE pad_id = ?")
      .all("expired-pad");
    expect(expired).toEqual([]);
    store.close();
  });

  test("addEvent keeps only the newest 10,000 rows per pad", () => {
    const store = testStore();
    const padId = "retained-pad";
    const now = 40 * DAY_MS;
    for (let index = 0; index <= EXPECTED_MAX_PER_PAD; index += 1) {
      store.addEvent(padId, now + index, null, `recent-${index}`, {});
    }

    const rows = store.db
      .query<EventRow, [string]>(
        "SELECT ts, type FROM events WHERE pad_id = ? ORDER BY ts ASC, id ASC",
      )
      .all(padId);
    expect(rows).toHaveLength(EXPECTED_MAX_PER_PAD);
    expect(rows[0]).toEqual({ ts: now + 1, type: "recent-1" });
    expect(rows.at(-1)).toEqual({
      ts: now + EXPECTED_MAX_PER_PAD,
      type: `recent-${EXPECTED_MAX_PER_PAD}`,
    });
    expect(rows.some((row) => row.type === "recent-0")).toBeFalse();
    store.close();
  });
});

describe("ServerStore pad tree", () => {
  test("orders mixed siblings, nests folders, rejects cycles, and promotes children on delete", () => {
    const store = testStore();
    const alpha = { id: "pad-a", name: "Alpha", createdAt: 10 };
    const beta = { id: "pad-b", name: "Beta", createdAt: 20 };
    const gamma = { id: "pad-c", name: "Gamma", createdAt: 30 };
    store.createPad(alpha);
    store.createPad(beta);
    store.createPad(gamma);

    expect(
      store.createPadFolder({ id: "folder-1", name: "Focused", createdAt: 40 }, null),
    ).toBeTrue();
    expect(
      store.createPadFolder({ id: "folder-2", name: "Nested", createdAt: 50 }, "folder-1"),
    ).toBeTrue();
    expect(
      store.createPadFolder({ id: "folder-invalid", name: "Invalid", createdAt: 60 }, "missing"),
    ).toBeFalse();

    const siblingIds = (parentId: string | null): string[] =>
      store
        .listPadTree()
        .filter((item) => item.parentId === parentId)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => (item.kind === "pad" ? item.pad.id : item.id));

    expect(siblingIds(null)).toEqual([alpha.id, beta.id, gamma.id, "folder-1"]);
    expect(siblingIds("folder-1")).toEqual(["folder-2"]);

    expect(store.movePadTreeItem({ kind: "folder", id: "folder-1" }, null, 1)).toBeTrue();
    expect(store.movePadTreeItem({ kind: "pad", id: gamma.id }, "folder-1", 0)).toBeTrue();
    expect(store.movePadTreeItem({ kind: "pad", id: beta.id }, "folder-2", 0)).toBeTrue();
    expect(siblingIds(null)).toEqual([alpha.id, "folder-1"]);
    expect(siblingIds("folder-1")).toEqual([gamma.id, "folder-2"]);
    expect(siblingIds("folder-2")).toEqual([beta.id]);

    expect(store.movePadTreeItem({ kind: "folder", id: "folder-1" }, "folder-2", 0)).toBeFalse();
    expect(siblingIds(null)).toEqual([alpha.id, "folder-1"]);

    expect(store.renamePadFolder("folder-2", "Deep work")).toBeTrue();
    expect(
      store.listPadTree().find((item) => item.kind === "folder" && item.id === "folder-2"),
    ).toMatchObject({ name: "Deep work" });

    expect(store.deletePadFolder("folder-1")).toBeTrue();
    expect(siblingIds(null)).toEqual([alpha.id, gamma.id, "folder-2"]);
    expect(siblingIds("folder-2")).toEqual([beta.id]);
    expect(
      new Set(
        store
          .listPadTree()
          .map((item) => `${item.kind}:${item.kind === "pad" ? item.pad.id : item.id}`),
      ).size,
    ).toBe(store.listPadTree().length);
    expect(store.getPad(alpha.id)).toEqual(alpha);
    expect(store.getPad(beta.id)).toEqual(beta);
    expect(store.getPad(gamma.id)).toEqual(gamma);
    store.close();
  });
});
