// The constants Pendulum wave's definition (index.ts) shares with its code (shader.ts), kept apart
// from that code so that the scene registry loads without it (SceneDef.code).

/** Seconds of the entrance and exit (SceneDef.passage). */
export const PENDULA_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

export interface PendulaCamera {
  label: string;
  /** Degrees round the vertical from the front (the camera sits toward +x for a positive yaw). */
  yaw: number;
  /** Degrees above the horizontal. */
  pitch: number;
  /** Distance from the aim point, world units. */
  dist: number;
  /** Height of the aim point. */
  aim: number;
  /** Centre of the scene's extent on the image plane at focal length 1. */
  centre: readonly [number, number];
  /** Half the scene's width and height there. */
  half: readonly [number, number];
}

/** In `camera` knob order. The extents were measured from the beam, posts, feet and the bobs' reach. */
export const pendulaCameras: readonly PendulaCamera[] = [
  {
    label: "side",
    yaw: 62,
    pitch: 6,
    dist: 5,
    aim: 0.95,
    centre: [0.0347, -0.0479],
    half: [0.1951, 0.2466],
  },
  {
    label: "3/4",
    yaw: 38,
    pitch: 17,
    dist: 5,
    aim: 0.95,
    centre: [0.0498, -0.0426],
    half: [0.2751, 0.2365],
  },
  {
    label: "top",
    yaw: 0,
    pitch: 80,
    dist: 5,
    aim: 0.55,
    centre: [0, -0.0065],
    half: [0.4126, 0.0822],
  },
];

export interface PendulaBeam {
  label: string;
  color: string;
  /** 0 matt wood .. 1 polished metal. */
  gloss: number;
}

/** In `beam` knob order. */
export const pendulaBeams: readonly PendulaBeam[] = [
  { label: "oak", color: "#8d5f31", gloss: 0 },
  { label: "walnut", color: "#5b3822", gloss: 0 },
  { label: "brass", color: "#d9a64a", gloss: 1 },
];
