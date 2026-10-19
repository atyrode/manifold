// A room: a floor, four walls and a ceiling placed in the world, drawn from inside and out. Its
// walls are plaster (any tint), the seventies' papered rings, shoji, wood panelling or brick; its
// floor boards, tiles or carpet. Each wall holds up to three windows and a doorway or a door, the
// windows framed and barred in depth with a sill ledge inside, so the World's sun and moon lay their
// patches through them; the glass shows the world outside with a faint reflection (a see-through
// surface: src/engine/glsl.ts). A skirting board and a cornice give it its scale. Its shape is
// shape.ts's; the lab casts against it exactly, the glass let through.
import { choice, range, toggle } from "../../../params.ts";
import type { KindDef } from "../../types.ts";
import {
  castRoom,
  ROOM_DOORS,
  ROOM_FLOORS,
  ROOM_MAX_WINDOWS,
  ROOM_PANES,
  ROOM_SIDES,
  ROOM_WALLS,
  roomBounds,
  roomValues,
} from "./shape.ts";

const options = (labels: readonly string[]) => labels.map((label, value) => ({ label, value }));

/** Each wall's openings by default: a window in the far wall, a door in the near one. */
const OPENINGS: Readonly<Record<(typeof ROOM_SIDES)[number], readonly [number, number]>> = {
  far: [1, 0],
  right: [0, 0],
  near: [0, 2],
  left: [0, 0],
};

export const roomKind: KindDef = {
  id: "room",
  title: "Room",
  blurb:
    "A floor, four walls and a ceiling, with windows and doors: the sun and the moon come in through the glass.",
  family: "structure",
  options: [
    range("room", "width", "width", 4, "Inside, across, metres.", {
      min: 1.5,
      max: 12,
      step: 0.05,
    }),
    range("room", "depth", "depth", 4, "Inside, front to back, metres.", {
      min: 1.5,
      max: 12,
      step: 0.05,
    }),
    range("room", "height", "height", 2.6, "Floor to ceiling, metres.", {
      min: 2,
      max: 5,
      step: 0.05,
    }),
    choice(
      "room",
      "wall",
      "walls",
      options(ROOM_WALLS),
      0,
      "What the walls are inside: plaster, the seventies' papered rings, shoji, wood panelling or brick.",
    ),
    range(
      "room",
      "tint",
      "tint",
      0,
      "The plaster's and the paper's colour: white at the left, then round the hues, muted.",
    ),
    range("room", "tone", "tone", 0.75, "The walls, dark to light."),
    choice(
      "room",
      "floor",
      "floor",
      options(ROOM_FLOORS),
      0,
      "What the floor is: boards, tiles or carpet.",
    ),
    range("room", "floorTone", "floor tone", 0.45, "The floor, dark to light."),
    range(
      "room",
      "trim",
      "trim",
      1,
      "The skirting, the casings, the window frames and the doors: dark wood at the left, white paint at the right.",
    ),
    toggle(
      "room",
      "ceiling",
      "ceiling",
      true,
      "A ceiling over it, a cornice round it; off, the room is open to the sky.",
    ),
    ...ROOM_SIDES.flatMap((side) => [
      range(
        "room",
        `${side}Windows`,
        `${side} windows`,
        OPENINGS[side][0],
        `How many windows the ${side} wall holds, spread along it.`,
        { min: 0, max: ROOM_MAX_WINDOWS, step: 1 },
      ),
      choice(
        "room",
        `${side}Door`,
        `${side} door`,
        options(ROOM_DOORS),
        OPENINGS[side][1],
        `A doorway or a closed door in the ${side} wall, before its windows.`,
      ),
    ]),
    range("room", "windowWidth", "window width", 1, "Each window's width, metres.", {
      min: 0.3,
      max: 3,
      step: 0.05,
    }),
    range("room", "windowHeight", "window height", 1.3, "Each window's height, metres.", {
      min: 0.3,
      max: 2.6,
      step: 0.05,
    }),
    range(
      "room",
      "sill",
      "sill",
      0.85,
      "How high the windows' sills stand over the floor, metres.",
      {
        min: 0,
        max: 2,
        step: 0.05,
      },
    ),
    choice(
      "room",
      "panes",
      "panes",
      options(ROOM_PANES),
      1,
      "The glazing bars: one pane, four (a mullion and a transom) or six.",
    ),
    toggle("room", "glazed", "glazed", true, "Glass in the windows; off, the frames stand open."),
  ],
  compiled: ["wall", "floor", "glazed"],
  bounds: (options) => roomBounds(roomValues(options)),
  max: 4,
  rests: "surface",
  casts: true,
  cast(options, ro, rd, span) {
    const hit = castRoom(roomValues(options), ro, rd, span, false);
    return hit === undefined ? undefined : { t: hit.t, normal: hit.normal };
  },
  code: () => import("./code.ts"),
};
