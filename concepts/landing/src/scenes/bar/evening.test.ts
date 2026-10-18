import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";

const barScene = await loadScene("bar");
/** The back bar's field 0 (sim.ts): slot 2, after the composed sim's speck map and records atlas. */
const EVENING = 2;

/** The room as the shader sees it: the bartender, every stool and every glass (texels 0..17; 18 holds the candle and the fan, which carry on). */
function room(sim: HeadlessSim): number[] {
  return Array.from(sim.upload(EVENING).data.subarray(0, 18 * 4));
}

/** The room at the opening frame and then every 30 s for two minutes, in tenths of a second. */
function evening(sim: HeadlessSim): number[][] {
  const seen = [room(sim)];
  for (let tenth = 1; tenth <= 1200; tenth++) {
    sim.step({ dt: 0.1 });
    if (tenth % 300 === 0) seen.push(room(sim));
  }
  return seen;
}

test("the lab restarting the scene opens the same evening again", () => {
  const fresh = new HeadlessSim(barScene).step({ dt: 0 });
  const opening = evening(fresh);

  const restarted = new HeadlessSim(barScene).step({ dt: 0 });
  for (let tenth = 0; tenth < 1500; tenth++) restarted.step({ dt: 0.1 });
  // Two and a half minutes on, the room has changed; then the clock goes back and the evening starts over.
  expect(room(restarted)).not.toEqual(opening[0]);
  restarted.step({ dt: -30 });
  expect(evening(restarted)).toEqual(opening);
});
