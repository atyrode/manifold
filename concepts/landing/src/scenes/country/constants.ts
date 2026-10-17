// The constants Countryside's definition (index.ts) shares with its code (shader.ts, season.ts,
// murmuration.ts, verges.ts), kept apart from that code so that the scene registry loads without it
// (SceneDef.code).
import { counts, feature } from "../../params.ts";
import { FLOCK_SIZES } from "../flock/constants.ts";

/** Seconds of the entrance (the camera comes down out of the sky and settles) and exit. */
export const COUNTRY_PASSAGE = { enter: 2.8, exit: 1.4 } as const;

/** The farming year's keys (year positions): the land exactly as the old season choice showed it. */
export const COUNTRY_SEASONS = { summer: 0.375, harvest: 0.47, autumn: 0.6 } as const;

/** The year from the first round bale dropped on a cut barley field to the last one carted away. */
export const COUNTRY_BALES = [0.418, 0.497] as const;

export const countryMurmurationKnob = feature(
  "birds",
  "murmuration",
  "murmuration",
  false,
  "starlings",
  3000,
  "A starling murmuration wheeling over the far fields, from late afternoon until it goes down to roost at dusk (set the time of day near sunset to see it): the valley's sides hide it where it dips below them, the wind carries it, and steady rain keeps it away, as does the nesting season from mid-spring to early summer. The amount is how many starlings: more make a darker cloud.",
  { options: counts(...FLOCK_SIZES) },
);

export const countryVergesKnob = feature(
  "land",
  "verges",
  "verges",
  false,
  "fullness",
  0.6,
  "Clumps of cow parsley, red campion and tussock grass at the foot of the hedges on the fields nearest the hill. They sway in the wind and bow as its gusts roll across the fields, follow the farming year (new leaves in spring, the parsley's white umbels in early summer, gone to seed at harvest with the campion still in flower, everything browning in autumn, dead stems through winter) and carry the snow; they keep off the roads, the streams and the river, the yards, the woods and the grazed pastures. Fullness: how many clumps, from one here and there to a row along every hedge.",
  { icon: "flower" },
);
