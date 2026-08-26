export const RIGHT_CLICK_ERASER_HOLD_MS = 350;

export interface RightClickPointer {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerType: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export type IdleRightClickState = { readonly phase: "idle" };

export type RightClickState =
  | IdleRightClickState
  | { readonly phase: "pending"; readonly pointer: RightClickPointer }
  | { readonly phase: "erasing"; readonly pointer: RightClickPointer };

export const IDLE_RIGHT_CLICK_STATE: IdleRightClickState = { phase: "idle" };

export function beginRightClick(pointer: RightClickPointer): RightClickState {
  return { phase: "pending", pointer };
}

export function moveRightClick(
  state: RightClickState,
  pointer: RightClickPointer,
): RightClickState {
  if (state.phase === "idle" || state.pointer.pointerId !== pointer.pointerId) return state;
  return { ...state, pointer };
}

export function activateRightClickEraser(
  state: RightClickState,
  pointerId: number,
): RightClickState {
  if (state.phase !== "pending" || state.pointer.pointerId !== pointerId) return state;
  return { phase: "erasing", pointer: state.pointer };
}

export type RightClickRelease =
  | { readonly action: "ignore"; readonly state: RightClickState }
  | { readonly action: "open_context_menu"; readonly state: typeof IDLE_RIGHT_CLICK_STATE }
  | { readonly action: "finish_erasing"; readonly state: typeof IDLE_RIGHT_CLICK_STATE };

export function releaseRightClick(
  state: RightClickState,
  pointer: RightClickPointer,
): RightClickRelease {
  if (state.phase === "idle" || state.pointer.pointerId !== pointer.pointerId) {
    return { action: "ignore", state };
  }
  return {
    action: state.phase === "pending" ? "open_context_menu" : "finish_erasing",
    state: IDLE_RIGHT_CLICK_STATE,
  };
}
