import { afterEach, describe, expect, test } from "bun:test";
import {
  currentViewState,
  setViewState,
  subscribeViewState,
  type ViewState,
} from "../src/ui/view-state.ts";

/**
 * VIEW STATE IS PUBLISHED STATE (A2).
 *
 * Which tool a principal holds, what it is editing and whether its sidebar is collapsed used
 * to be component state and `localStorage` — a capability no other principal, human or agent,
 * could observe. It is now one store whose every change becomes a presence frame (D6: it dies
 * with the connection, so presence is its plane).
 *
 * That makes the CHANGE GATE the contract under test. Writers are scattered across chrome
 * that shares no ancestor and re-assert the same value on every re-render; if each write
 * notified, a toolbar repaint would put a frame on the wire, and the throttle protecting the
 * presence plane would be spent on news nobody sent.
 */

const INITIAL: ViewState = {
  tool: null,
  editingElementId: null,
  focusedContainerId: null,
  sidebarCollapsed: false,
};

/** The same value the toolbar re-asserts, written as a full patch rather than a partial. */
const INITIAL_TOOL_PATCH: Partial<ViewState> = {
  tool: "select",
  editingElementId: null,
  focusedContainerId: null,
  sidebarCollapsed: false,
};

/**
 * The store is module-level (deliberately — one door for every writer), so each case hands
 * it back exactly as it found it. Otherwise ordering would leak between cases here and into
 * any other suite sharing the module.
 */
afterEach(() => {
  setViewState(INITIAL);
});

describe("view state store", () => {
  test("starts fully specified: every facet is a value, never a missing key", () => {
    // A peer renders "holding no tool" differently from "we do not know", and presence
    // payloads merge — an absent facet would read as "unchanged" at the far end.
    expect(currentViewState()).toEqual(INITIAL);
  });

  test("a patch merges, and every subscriber hears the WHOLE state", () => {
    const heard: ViewState[] = [];
    const stop = subscribeViewState((view) => {
      heard.push(view);
    });

    setViewState({ tool: "draw" });
    setViewState({ editingElementId: "el-1" });

    // Merged, not replaced: the tool a peer is holding must not be forgotten because the
    // same principal started editing text.
    expect(currentViewState()).toEqual({ ...INITIAL, tool: "draw", editingElementId: "el-1" });
    expect(heard).toHaveLength(2);
    expect(heard[1]).toEqual(currentViewState());
    stop();
  });

  test("re-asserting the same value notifies NOBODY, so a repaint is not a frame", () => {
    let notifications = 0;
    const stop = subscribeViewState(() => {
      notifications += 1;
    });

    setViewState({ tool: "select" });
    expect(notifications).toBe(1);

    // The exact shape a re-rendering toolbar produces, several times per interaction.
    setViewState({ tool: "select" });
    setViewState({ tool: "select", editingElementId: null });
    setViewState({});
    setViewState(INITIAL_TOOL_PATCH);
    expect(notifications).toBe(1);

    // A real change still lands — the gate is about equality, not about rate.
    setViewState({ tool: null });
    expect(notifications).toBe(2);
    expect(currentViewState().tool).toBeNull();
    stop();
  });

  test("the gate compares EVERY facet, so no change can slip through unpublished", () => {
    let notifications = 0;
    const stop = subscribeViewState(() => {
      notifications += 1;
    });

    // One case per facet: a gate that forgot one would make that capability invisible to
    // every other principal while looking perfectly healthy.
    setViewState({ tool: "text" });
    setViewState({ editingElementId: "el-1" });
    setViewState({ focusedContainerId: "pad-1" });
    setViewState({ sidebarCollapsed: true });
    expect(notifications).toBe(4);
    expect(currentViewState()).toEqual({
      tool: "text",
      editingElementId: "el-1",
      focusedContainerId: "pad-1",
      sidebarCollapsed: true,
    });
    stop();
  });

  test("unsubscribing is final, and one subscriber leaving does not silence the rest", () => {
    const staying: ViewState[] = [];
    const leaving: ViewState[] = [];
    const stopStaying = subscribeViewState((view) => {
      staying.push(view);
    });
    const stopLeaving = subscribeViewState((view) => {
      leaving.push(view);
    });

    setViewState({ tool: "draw" });
    expect([staying.length, leaving.length]).toEqual([1, 1]);

    // Chrome mounts and unmounts constantly (a canvas swap, a panel toggle); a subscription
    // that outlived its component would publish through a dead socket.
    stopLeaving();
    setViewState({ tool: "select" });
    expect([staying.length, leaving.length]).toEqual([2, 1]);

    stopStaying();
    setViewState({ tool: null });
    expect([staying.length, leaving.length]).toEqual([2, 1]);
    // The state itself is unaffected by having no listeners: a reconnect republishes it.
    expect(currentViewState().tool).toBeNull();
  });

  test("a subscriber is NOT called with the current value on subscribe", () => {
    setViewState({ tool: "draw" });
    let notifications = 0;
    const stop = subscribeViewState(() => {
      notifications += 1;
    });

    // Presence writers merge `currentViewState()` into the payload they are already sending,
    // so a replay on subscribe would be a duplicate frame at every mount.
    expect(notifications).toBe(0);
    expect(currentViewState().tool).toBe("draw");
    stop();
  });
});
