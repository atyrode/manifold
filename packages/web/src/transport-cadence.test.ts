import { describe, expect, test } from "bun:test";
import { createTransportCadence, type VersionStamp } from "./transport-cadence.ts";

interface TimerEntry {
  readonly at: number;
  readonly callback: () => void;
}

interface SceneRecord extends VersionStamp {
  readonly data: string;
}

function scene(id: string, version: number, data = id): SceneRecord {
  return { id, version, versionNonce: version * 10, data };
}

function createHarness(options: { readonly canSendScene?: boolean } = {}) {
  let now = 0;
  let canSendScene = options.canSendScene ?? true;
  let nextTimer = 1;
  const timers = new Map<number, TimerEntry>();
  const delays: number[] = [];
  const sceneSends: SceneRecord[][] = [];
  const cursorSends: string[] = [];
  const viewportSends: number[] = [];

  const cadence = createTransportCadence<SceneRecord, string, number>({
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = nextTimer++;
      delays.push(delayMs);
      timers.set(timer, { at: now + delayMs, callback });
      return timer;
    },
    clearTimer: (timer) => {
      timers.delete(timer);
    },
    sceneIntervalMs: 16,
    cursorIntervalMs: 10,
    viewportIntervalMs: 10,
    maxSceneBatchSize: 2,
    canSendScene: () => canSendScene,
    sendScene: (elements) => sceneSends.push([...elements]),
    sendCursor: (cursor) => cursorSends.push(cursor),
    sendViewport: (viewport) => viewportSends.push(viewport),
    sameViewport: (left, right) => left === right,
  });

  const runNextTimer = (): void => {
    const next = [...timers.entries()].sort(
      ([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId,
    )[0];
    if (next === undefined) throw new Error("No timer scheduled");
    const [id, entry] = next;
    timers.delete(id);
    now = entry.at;
    entry.callback();
  };

  return {
    cadence,
    delays,
    sceneSends,
    cursorSends,
    viewportSends,
    timers,
    setNow: (value: number) => {
      now = value;
    },
    setCanSendScene: (value: boolean) => {
      canSendScene = value;
    },
    runNextTimer,
  };
}

describe("transport cadence", () => {
  test("deduplicates scene stamps before parsing and clamps the next interval", () => {
    const harness = createHarness();
    let parses = 0;
    const parse = (value: VersionStamp): SceneRecord => {
      parses += 1;
      return { ...value, data: value.id };
    };

    harness.cadence.queueScene([scene("a", 1)], parse);
    harness.cadence.queueScene([scene("a", 1)], parse);
    expect(parses).toBe(1);
    expect(harness.delays).toEqual([16]);

    harness.runNextTimer();
    expect(harness.sceneSends).toEqual([[scene("a", 1)]]);
    harness.setNow(20);
    harness.cadence.queueScene([scene("a", 2)], parse);
    expect(harness.delays.at(-1)).toBe(12);
    harness.runNextTimer();
    harness.setNow(100);
    harness.cadence.queueScene([scene("a", 3)], parse);
    expect(harness.delays.at(-1)).toBe(0);
  });

  test("coalesces scene updates by id, preserves insertion order, and chunks on flush", () => {
    const harness = createHarness();
    const parse = (value: VersionStamp): SceneRecord => ({ ...value, data: `v${value.version}` });

    harness.cadence.queueScene([scene("a", 1), scene("b", 1), scene("c", 1)], parse);
    harness.cadence.queueScene([scene("a", 2)], parse);
    harness.runNextTimer();

    expect(harness.sceneSends).toEqual([
      [scene("a", 2, "v2"), scene("b", 1, "v1")],
      [scene("c", 1, "v1")],
    ]);
    harness.cadence.flushScene();
    expect(harness.sceneSends).toHaveLength(2);
  });

  test("retains pending scene elements while sending is unavailable", () => {
    const harness = createHarness({ canSendScene: false });
    harness.cadence.queueScene([scene("a", 1)], (value) => ({ ...value, data: value.id }));
    harness.runNextTimer();
    expect(harness.sceneSends).toEqual([]);

    harness.setCanSendScene(true);
    harness.cadence.flushScene();
    expect(harness.sceneSends).toEqual([[scene("a", 1)]]);
  });

  test("immediate scene publication clears matching pending work and its timer", () => {
    const harness = createHarness();
    const updated = scene("a", 2);
    harness.cadence.queueScene([scene("a", 1)], (value) => ({ ...value, data: value.id }));
    harness.cadence.publishSceneImmediately([updated]);

    expect(harness.sceneSends).toEqual([[updated]]);
    expect(harness.timers.size).toBe(0);
    harness.cadence.flushScene();
    expect(harness.sceneSends).toHaveLength(1);
  });

  test("cursor sends leading, then trails with the latest coalesced value", () => {
    const harness = createHarness();
    harness.cadence.sendCursor("first");
    harness.setNow(2);
    harness.cadence.sendCursor("stale");
    harness.setNow(4);
    harness.cadence.sendCursor("latest");

    expect(harness.cursorSends).toEqual(["first"]);
    expect(harness.delays).toEqual([8]);
    harness.runNextTimer();
    expect(harness.cursorSends).toEqual(["first", "latest"]);
  });

  test("cursor leading send cancels an overdue trailing timer", () => {
    const harness = createHarness();
    harness.cadence.sendCursor("first");
    harness.setNow(2);
    harness.cadence.sendCursor("queued");
    harness.setNow(12);
    harness.cadence.sendCursor("new-leading");

    expect(harness.cursorSends).toEqual(["first", "new-leading"]);
    expect(harness.timers.size).toBe(0);
  });

  test("viewport schedules a zero-delay leading send and trails latest-wins", () => {
    const harness = createHarness();
    harness.cadence.sendViewport(1);
    harness.cadence.sendViewport(2);
    expect(harness.viewportSends).toEqual([]);
    expect(harness.delays).toEqual([0]);
    harness.runNextTimer();
    expect(harness.viewportSends).toEqual([2]);

    harness.cadence.sendViewport(2);
    expect(harness.timers.size).toBe(0);
    harness.setNow(3);
    harness.cadence.sendViewport(3);
    harness.setNow(5);
    harness.cadence.sendViewport(4);
    expect(harness.delays.at(-1)).toBe(7);
    harness.runNextTimer();
    expect(harness.viewportSends).toEqual([2, 4]);
    expect(harness.cadence.latestViewport()).toBe(4);
  });

  test("viewport-sent listener observes each send and detaches cleanly", () => {
    const harness = createHarness();
    const observed: number[] = [];
    harness.cadence.setViewportSentListener((viewport) => observed.push(viewport));
    harness.cadence.sendViewport(1);
    harness.runNextTimer();
    expect(harness.viewportSends).toEqual([1]);
    expect(observed).toEqual([1]);

    harness.cadence.setViewportSentListener(null);
    harness.setNow(20);
    harness.cadence.sendViewport(2);
    harness.runNextTimer();
    expect(harness.viewportSends).toEqual([1, 2]);
    expect(observed).toEqual([1]);
  });
});
