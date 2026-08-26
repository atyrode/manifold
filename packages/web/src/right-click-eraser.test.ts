import { describe, expect, test } from "bun:test";
import {
  IDLE_RIGHT_CLICK_STATE,
  activateRightClickEraser,
  beginRightClick,
  moveRightClick,
  hasRightClickDragStarted,
  releaseRightClick,
  shouldSuppressNativeContextMenu,
  type RightClickPointer,
} from "./right-click-eraser.ts";

const pointer = (overrides: Partial<RightClickPointer> = {}): RightClickPointer => ({
  pointerId: 7,
  clientX: 120,
  clientY: 80,
  pointerType: "mouse",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("right-click eraser policy", () => {
  test("a release before activation opens the canvas context menu", () => {
    const release = releaseRightClick(beginRightClick(pointer()), pointer({ clientX: 125 }));

    expect(release).toEqual({ action: "open_context_menu", state: IDLE_RIGHT_CLICK_STATE });
  });

  test("holding activates erasing at the latest pointer position", () => {
    const moved = moveRightClick(
      beginRightClick(pointer()),
      pointer({ clientX: 180, clientY: 95 }),
    );
    const active = activateRightClickEraser(moved, 7);

    expect(active).toEqual({
      phase: "erasing",
      pointer: pointer({ clientX: 180, clientY: 95 }),
    });
    expect(releaseRightClick(active, pointer({ clientX: 200 }))).toEqual({
      action: "finish_erasing",
      state: IDLE_RIGHT_CLICK_STATE,
    });
  });

  test("the first right-button movement activates drag", () => {
    const pending = beginRightClick(pointer());

    expect(hasRightClickDragStarted(pending, pointer())).toBe(false);
    expect(hasRightClickDragStarted(pending, pointer({ clientX: 121 }))).toBe(true);
  });

  test("native canvas menus are suppressed even when Excalidraw changes the event target", () => {
    expect(
      shouldSuppressNativeContextMenu({
        isTrusted: true,
        button: 2,
        isCanvas: false,
        isHeldRightClick: false,
        isCompletedRightClick: true,
      }),
    ).toBe(true);
    expect(
      shouldSuppressNativeContextMenu({
        isTrusted: false,
        button: 2,
        isCanvas: true,
        isHeldRightClick: false,
        isCompletedRightClick: true,
      }),
    ).toBe(false);
    expect(
      shouldSuppressNativeContextMenu({
        isTrusted: true,
        button: 2,
        isCanvas: false,
        isHeldRightClick: false,
        isCompletedRightClick: false,
      }),
    ).toBe(false);
  });

  test("events from another pointer cannot activate or release the gesture", () => {
    const pending = beginRightClick(pointer());

    expect(activateRightClickEraser(pending, 8)).toBe(pending);
    expect(releaseRightClick(pending, pointer({ pointerId: 8 }))).toEqual({
      action: "ignore",
      state: pending,
    });
  });
});
