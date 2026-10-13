// Above the clouds: the view from an airliner window at cruise altitude, time of day as the dial.
import { feature, range, toggle } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { cloudsGlsl } from "./shader.ts";

export const cloudsScene: SceneDef = {
  id: "clouds",
  title: "Above the clouds",
  blurb: "A window seat at cruise altitude: a sea of cloud below, the day turning overhead.",
  accent: "#ff8a3d",
  look: { color: "full", levels: 4 },
  params: [
    ...skyKnobs({ time: 0.72 }),
    range("clouds", "cover", "cloud cover", 0.75, "How much of the sea below is cloud: lower opens gaps down to the ocean, higher is an unbroken white floor."),
    range("clouds", "altitude", "height above", 0.5, "How far above the cloud tops the plane flies: low skims over big billows, high looks down on a fine-grained sea."),
    range("clouds", "drift", "drift speed", 0.35, "How fast the cloud sea slides past below as the plane flies on."),
    feature("clouds", "thunderheads", "thunderheads", true, "size", 0.5, "Towering storm clouds on the horizon, their flat anvil tops blown out by the high winds."),
    toggle("seat", "window", "window", true, "Frame the view in the cabin's porthole: moulded bevel, scuffed pane, the dim cabin around it."),
    toggle("seat", "wing", "wing", true, "The wingtip and its winglet reaching in from the lower corner: red navigation light blinking, white strobe flashing twice."),
    feature("seat", "contrail", "passing plane", true, "frequency", 0.3, "Now and then a distant plane crosses the sky, its contrail forming behind it, spreading and drifting away.", { trigger: 1 }),
    ...weatherKnobs({ lightning: 0, aurora: true, wind: true }),
    toggle("manifold", "livery", "M on the winglet", false, "The Manifold M painted on the winglet, lit by the sun or caught by the strobe.", { when: "wing" }),
  ],
  groups: {
    sky: atmosphereGroups.sky,
    clouds: { title: "Cloud sea", blurb: "The deck below: how much cloud, how far down, how fast it passes, and storms on the horizon." },
    seat: { title: "Window seat", blurb: "What frames the view: the porthole, the wing, and the odd plane passing far off." },
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold livery", blurb: "A landmark of its own: the M on the winglet." },
  },
  glsl: cloudsGlsl,
  entry: "sceneClouds",
  // Daylight fills the screen only without the dark cabin around it, and only on a still clock.
  theme: (params) => {
    const time = params.time ?? 0.72;
    const daylight = time > 0.3 && time < 0.68 && (params.cycle ?? 0) < 0.5;
    return daylight && (params.window ?? 1) < 0.5 ? "paper" : "night";
  },
};
