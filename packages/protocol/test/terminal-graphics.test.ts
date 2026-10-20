import { expect, test } from "bun:test";
import {
  TERMINAL_GRAPHICS_AXIS,
  TERMINAL_GRAPHICS_ENVELOPE_BYTES,
  TERMINAL_GRAPHICS_IMAGES,
  TERMINAL_GRAPHICS_POLICY,
  TERMINAL_GRAPHICS_PREFIX,
  TerminalGraphicsSnapshotSchema,
  TerminalImageBudget,
} from "../src/index.ts";

const longest = (values: readonly string[]): string =>
  values.reduce((left, right) => (right.length > left.length ? right : left));

test("the largest envelope skeleton and image entry the schema admits fit their reserved charges", () => {
  const current = TerminalGraphicsSnapshotSchema.options[1].shape;
  const image = current.images.element.shape;
  const skeleton = {
    version: 2,
    scrolling: false,
    palette: Buffer.alloc(1024).toString("base64"),
    paletteLimit: 256,
    images: [],
  };
  const framed = (state: object): number =>
    Buffer.byteLength(`\x1b]1337;${TERMINAL_GRAPHICS_PREFIX}${JSON.stringify(state)}\x07`);
  expect(TerminalGraphicsSnapshotSchema.safeParse(skeleton).success).toBe(true);
  expect(framed(skeleton)).toBeLessThanOrEqual(TERMINAL_GRAPHICS_ENVELOPE_BYTES);
  // Data and cell records are charged by length; what remains is the entry's own JSON.
  const entry = {
    id: TERMINAL_GRAPHICS_IMAGES - 1,
    width: TERMINAL_GRAPHICS_AXIS,
    height: TERMINAL_GRAPHICS_AXIS,
    format: longest(image.format.options),
    data: "",
    buffer: longest(image.buffer.options),
    cells: "",
  };
  const perEntry =
    (framed({ ...skeleton, images: Array.from({ length: TERMINAL_GRAPHICS_IMAGES }, () => entry) }) -
      framed(skeleton)) /
    TERMINAL_GRAPHICS_IMAGES;
  // A one-tile image may encode exactly what its retained charge leaves after its base64
  // data and single record; the remainder is the entry allowance every image is charged.
  const allowance =
    TERMINAL_GRAPHICS_POLICY.retainedBytes -
    8 -
    Math.ceil(new TerminalImageBudget().encodedLimit(7, 14) / 3) * 4;
  expect(perEntry).toBeLessThanOrEqual(allowance);
});
