import { expect, test } from "bun:test";
import {
  MAX_PANEL_RESULT_BYTES,
  PanelResultSchema,
  PortablePanelInputSchema,
} from "@manifold/protocol";

function nestedRecord(levels: number): Record<string, unknown> {
  let result: Record<string, unknown> = { value: true };
  for (let level = 1; level < levels; level++) result = { child: result };
  return result;
}

test("transient intake results count UTF-8 bytes including the JSON envelope", () => {
  const overhead = JSON.stringify({ path: "" }).length;
  const payloadBytes = MAX_PANEL_RESULT_BYTES - overhead;
  const path = "é".repeat(Math.floor(payloadBytes / 2)) + "x".repeat(payloadBytes % 2);
  expect(PanelResultSchema.safeParse({ path }).success).toBe(true);
  expect(PanelResultSchema.safeParse({ path: `${path}é` }).success).toBe(false);
  expect(PortablePanelInputSchema.safeParse({ value: { path }, files: [] }).success).toBe(false);
});

test("intake results bound nesting and reject byte carriers and cyclic data", () => {
  expect(PanelResultSchema.safeParse(nestedRecord(32)).success).toBe(true);
  expect(PanelResultSchema.safeParse(nestedRecord(33)).success).toBe(false);
  expect(PanelResultSchema.safeParse(nestedRecord(20_000)).success).toBe(false);
  expect(PanelResultSchema.safeParse({ data: new Uint8Array([1, 2]) }).success).toBe(false);
  const cycle: Record<string, unknown> = {};
  cycle["self"] = cycle;
  expect(PanelResultSchema.safeParse(cycle).success).toBe(false);
});
