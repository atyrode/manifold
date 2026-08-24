/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  INITIAL_CANVAS_PAINT_READINESS,
  advanceCanvasPaintReadiness,
  canPaintCanvas,
  type CanvasPaintReadiness,
} from "./canvas-readiness.ts";

describe("canvas paint readiness", () => {
  it("paints when init arrives before the API becomes ready", () => {
    let state: CanvasPaintReadiness = INITIAL_CANVAS_PAINT_READINESS;
    state = advanceCanvasPaintReadiness(state, { type: "scene_reset" });
    expect(canPaintCanvas(state)).toBe(false);

    state = advanceCanvasPaintReadiness(state, { type: "api_registered", generation: 1 });
    expect(canPaintCanvas(state)).toBe(false);

    state = advanceCanvasPaintReadiness(state, { type: "api_ready", generation: 1 });
    expect(canPaintCanvas(state)).toBe(true);
  });

  it("paints when the API becomes ready before init", () => {
    let state: CanvasPaintReadiness = INITIAL_CANVAS_PAINT_READINESS;
    state = advanceCanvasPaintReadiness(state, { type: "api_registered", generation: 1 });
    state = advanceCanvasPaintReadiness(state, { type: "api_ready", generation: 1 });
    expect(canPaintCanvas(state)).toBe(false);

    state = advanceCanvasPaintReadiness(state, { type: "scene_reset" });
    expect(canPaintCanvas(state)).toBe(true);
  });

  it("waits for the surviving API after StrictMode double construction", () => {
    let state: CanvasPaintReadiness = INITIAL_CANVAS_PAINT_READINESS;
    state = advanceCanvasPaintReadiness(state, { type: "scene_reset" });
    state = advanceCanvasPaintReadiness(state, { type: "api_registered", generation: 1 });
    state = advanceCanvasPaintReadiness(state, { type: "api_registered", generation: 2 });
    state = advanceCanvasPaintReadiness(state, { type: "api_ready", generation: 1 });
    expect(canPaintCanvas(state)).toBe(false);

    state = advanceCanvasPaintReadiness(state, { type: "api_ready", generation: 2 });
    expect(state.apiGeneration).toBe(2);
    expect(state.readyApiGeneration).toBe(2);
    expect(canPaintCanvas(state)).toBe(true);
  });

  it("changes generation so resync repaints an already-ready API", () => {
    let state: CanvasPaintReadiness = INITIAL_CANVAS_PAINT_READINESS;
    state = advanceCanvasPaintReadiness(state, { type: "api_registered", generation: 1 });
    state = advanceCanvasPaintReadiness(state, { type: "api_ready", generation: 1 });
    state = advanceCanvasPaintReadiness(state, { type: "scene_reset" });
    const paintedGeneration = state.sceneGeneration;
    expect(canPaintCanvas(state)).toBe(true);

    state = advanceCanvasPaintReadiness(state, { type: "scene_reset" });
    expect(state.sceneGeneration).toBe(paintedGeneration + 1);
    expect(canPaintCanvas(state)).toBe(true);
  });
});
