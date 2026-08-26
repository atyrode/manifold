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

describe("ServerStore pad organization", () => {
  test("persists pad order and folder membership without deleting pads with a folder", () => {
    const store = testStore();
    const alpha = { id: "pad-a", name: "Alpha", createdAt: 10 };
    const beta = { id: "pad-b", name: "Beta", createdAt: 20 };
    const gamma = { id: "pad-c", name: "Gamma", createdAt: 30 };
    store.createPad(alpha);
    store.createPad(beta);
    store.createPad(gamma);

    expect(store.reorderPads([gamma.id, alpha.id, beta.id])).toBeTrue();
    expect(store.listPads().map((pad) => pad.id)).toEqual([gamma.id, alpha.id, beta.id]);
    expect(store.reorderPads([alpha.id, beta.id])).toBeFalse();
    expect(store.listPads().map((pad) => pad.id)).toEqual([gamma.id, alpha.id, beta.id]);

    const folder = store.createPadFolder({
      id: "folder-1",
      name: "Focused",
      createdAt: 40,
    });
    expect(store.movePadToFolder(alpha.id, folder.id)).toBeTrue();
    expect(store.getPadFolder(folder.id)?.padIds).toEqual([alpha.id]);
    expect(store.deletePadFolder(folder.id)).toBeTrue();
    expect(store.getPad(alpha.id)).toEqual(alpha);
    expect(store.listPadFolders()).toEqual([]);
    store.close();
  });
});
