import { afterEach, describe, expect, test } from "bun:test";
import {
  currentVantage,
  setVantage,
  subscribeVantage,
  toggleArranging,
  type Vantage,
} from "../src/vantage.ts";

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

const INITIAL: Vantage = {
  tool: null,
  editingElementId: null,
  focusedContainerId: null,
  locationPath: null,
  sidebarCollapsed: false,
  arranging: false,
  arrangeScope: null,
};

/** The same value the toolbar re-asserts, written as a full patch rather than a partial. */
const INITIAL_TOOL_PATCH: Partial<Vantage> = {
  tool: "select",
  editingElementId: null,
  focusedContainerId: null,
  sidebarCollapsed: false,
  arranging: false,
  arrangeScope: null,
};

/**
 * The store is module-level (deliberately — one door for every writer), so each case hands
 * it back exactly as it found it. Otherwise ordering would leak between cases here and into
 * any other suite sharing the module.
 */
afterEach(() => {
  setVantage(INITIAL);
});

describe("view state store", () => {
  test("equivalent mounted paths do not echo; changing placement and clearing do publish", () => {
    const heard: Vantage[] = [];
    const stop = subscribeVantage((view) => heard.push(view));
    try {
      setVantage({
        locationPath: [
          { kind: "container", containerId: "root" },
          { kind: "element", containerId: "root", elementId: "p1" },
        ],
      });
      setVantage({
        locationPath: [
          { kind: "container", containerId: "root" },
          { kind: "element", containerId: "root", elementId: "p1" },
        ],
      });
      expect(heard).toHaveLength(1);
      setVantage({
        locationPath: [
          { kind: "container", containerId: "root" },
          { kind: "element", containerId: "root", elementId: "p2" },
        ],
      });
      expect(heard).toHaveLength(2);
      setVantage({ locationPath: null });
      expect(heard).toHaveLength(3);
      expect(currentVantage().locationPath).toBeNull();
    } finally {
      stop();
    }
  });

  test("a patch merges, and every subscriber hears the WHOLE state", () => {
    const heard: Vantage[] = [];
    const stop = subscribeVantage((view) => {
      heard.push(view);
    });

    setVantage({ tool: "draw" });
    setVantage({ editingElementId: "el-1" });

    // Merged, not replaced: the tool a peer is holding must not be forgotten because the
    // same principal started editing text.
    expect(currentVantage()).toEqual({ ...INITIAL, tool: "draw", editingElementId: "el-1" });
    expect(heard).toHaveLength(2);
    expect(heard[1]).toEqual(currentVantage());
    stop();
  });

  test("re-asserting the same value notifies NOBODY, so a repaint is not a frame", () => {
    let notifications = 0;
    const stop = subscribeVantage(() => {
      notifications += 1;
    });

    setVantage({ tool: "select" });
    expect(notifications).toBe(1);

    // The exact shape a re-rendering toolbar produces, several times per interaction.
    setVantage({ tool: "select" });
    setVantage({ tool: "select", editingElementId: null });
    setVantage({});
    setVantage(INITIAL_TOOL_PATCH);
    expect(notifications).toBe(1);

    // A real change still lands — the gate is about equality, not about rate.
    setVantage({ tool: null });
    expect(notifications).toBe(2);
    expect(currentVantage().tool).toBeNull();
    stop();
  });

  test("the gate compares EVERY facet, so no change can slip through unpublished", () => {
    let notifications = 0;
    const stop = subscribeVantage(() => {
      notifications += 1;
    });

    // One case per facet: a gate that forgot one would make that capability invisible to
    // every other principal while looking perfectly healthy.
    setVantage({ tool: "text" });
    setVantage({ editingElementId: "el-1" });
    setVantage({ focusedContainerId: "container-1" });
    setVantage({ sidebarCollapsed: true });
    // The mode flips through its own door, and that door IS a vantage write — so a mode
    // entered by F8 is on the wire for the same reason a held tool is.
    toggleArranging();
    expect(notifications).toBe(5);
    // Zooming into one panel's own arrangement is a sixth facet, and it publishes like the
    // rest: a collaborator who cannot see WHICH arrangement is live cannot tell why the rows
    // of one pane suddenly answer the pointer and nothing else does.
    setVantage({ arrangeScope: "core.shell.sidebar" });
    expect(notifications).toBe(6);
    expect(currentVantage()).toEqual({
      tool: "text",
      editingElementId: "el-1",
      focusedContainerId: "container-1",
      locationPath: null,
      sidebarCollapsed: true,
      arranging: true,
      arrangeScope: "core.shell.sidebar",
    });
    // Re-asserting the same scope is not news, exactly as re-asserting a tool is not.
    setVantage({ arrangeScope: "core.shell.sidebar" });
    expect(notifications).toBe(6);
    // And F8 is the whole-mode key in both directions: the second press leaves, and it leaves
    // from wherever the reader was standing rather than stranding a scope behind it.
    toggleArranging();
    expect(notifications).toBe(7);
    expect(currentVantage().arranging).toBe(false);
    expect(currentVantage().arrangeScope).toBeNull();
    stop();
  });

  test("F8 arms at the ROOT scope, never inside a stale one", () => {
    // Arming is "arrange the workspace". A ref left over from a previous session of the mode
    // would drop the reader straight into somebody's inner arrangement with no gesture that
    // asked for it — so the toggle clears the scope on the way in as well as on the way out.
    setVantage({ arranging: true, arrangeScope: "core.shell.sidebar" });
    toggleArranging();
    expect(currentVantage()).toEqual({ ...INITIAL, arranging: false, arrangeScope: null });
    toggleArranging();
    expect(currentVantage()).toEqual({ ...INITIAL, arranging: true, arrangeScope: null });
  });

  test("unsubscribing is final, and one subscriber leaving does not silence the rest", () => {
    const staying: Vantage[] = [];
    const leaving: Vantage[] = [];
    const stopStaying = subscribeVantage((view) => {
      staying.push(view);
    });
    const stopLeaving = subscribeVantage((view) => {
      leaving.push(view);
    });

    setVantage({ tool: "draw" });
    expect([staying.length, leaving.length]).toEqual([1, 1]);

    // Chrome mounts and unmounts constantly (a canvas swap, a panel toggle); a subscription
    // that outlived its component would publish through a dead socket.
    stopLeaving();
    setVantage({ tool: "select" });
    expect([staying.length, leaving.length]).toEqual([2, 1]);

    stopStaying();
    setVantage({ tool: null });
    expect([staying.length, leaving.length]).toEqual([2, 1]);
    // The state itself is unaffected by having no listeners: a reconnect republishes it.
    expect(currentVantage().tool).toBeNull();
  });

  test("a subscriber is NOT called with the current value on subscribe", () => {
    setVantage({ tool: "draw" });
    let notifications = 0;
    const stop = subscribeVantage(() => {
      notifications += 1;
    });

    // Presence writers merge `currentVantage()` into the payload they are already sending,
    // so a replay on subscribe would be a duplicate frame at every mount.
    expect(notifications).toBe(0);
    expect(currentVantage().tool).toBe("draw");
    stop();
  });
});
