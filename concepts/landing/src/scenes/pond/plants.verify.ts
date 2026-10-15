// GPU check for the plant sheet (sims/plantsheet.ts) the pond's border is drawn into, on real WebGL:
//   - a stroke organ covers the pixels along its arc with its material and layer, and nothing else;
//   - a sprite organ is cut from its atlas cell (coverage from the cell, the cell's own material);
//   - a green organ's phenology byte is exactly 128 (the pond's colour path is untouched);
//   - a breeze stepped through RootedPlants moves the stroke's tip on the sheet.
import { PlantSheet, type PlantSheetFamily } from "../../sims/plantsheet.ts";
import { PlantHabit, PlantRole, RootedPlants, plantClimate, type PlantSpecies } from "../../sims/plants.ts";

const SIZE = 64;

function fail(message: string): never {
  throw new Error(`pond plants: ${message}`);
}

export function verifyPondPlants(gl: WebGL2RenderingContext): Record<string, unknown> {
  // An atlas of one 8×8 cell: its left half covered, material 3 (pothos) at lightness 128.
  const atlas = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, atlas);
  const texels = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) texels.set([255, 128, 3 * 16 + 2, 255], (y * 8 + x) * 4);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, texels);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  const family: PlantSheetFamily = { material: 3, cells: [[0, 0, 1, 1]], box: [0, -0.5, 1, 0.5] };
  const species: PlantSpecies = {
    id: "check",
    moisture: [0, 1],
    sway: { hz: 0.5, damping: 0.7, give: 0.3, limit: 0.6 },
    year: { shed: 0, turn: 2, bloom: [0, 1] },
    life: { unfold: 1, span: 100 },
    detail: { simple: 2, min: 0.5 },
    build(plant) {
      // A stem up the left of the sheet (material 8, layer 1), a sprite low on the right (layer 2).
      plant.organ({ angle: Math.PI / 2, length: 0.6, width: 0.06, a: 1, form: 8, layer: 1, shade: 0.5 });
      plant.organ({ angle: 0, length: 0.3, form: 3, layer: 2, shade: 0.5, role: PlantRole.leaf, habit: PlantHabit.rigid });
    },
  };
  const plants = new RootedPlants(8);
  plants.cells = SIZE;
  plants.add(species, { x: 0.2, y: 0.2, heading: 0 }, () => 0);
  plants.add(species, { x: 0.6, y: 0.7, heading: 0 }, () => 0);
  const climate = plantClimate();
  plants.settle(climate);
  const sheet = new PlantSheet(gl);
  const families: (PlantSheetFamily | undefined)[] = [];
  families[3] = family;
  const order = Int32Array.from([0, 1, 2, 3]);
  const framebuffer = gl.createFramebuffer();
  const read = (): Uint8Array => {
    sheet.draw(plants, order, families, atlas, { width: SIZE, height: SIZE, scale: SIZE });
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sheet.texture, 0);
    const bytes = new Uint8Array(SIZE * SIZE * 4);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return bytes;
  };
  try {
    const rest = read();
    // Sheet x right, y down: row r of the readback is sheet y = SIZE - 1 - r.
    const at = (bytes: Uint8Array, x: number, y: number) => Array.from(bytes.subarray(((SIZE - 1 - y) * SIZE + x) * 4, ((SIZE - 1 - y) * SIZE + x) * 4 + 4));
    const stem = at(rest, Math.round(0.2 * SIZE), Math.round(0.5 * SIZE));
    if (stem[0] !== 255 || stem[2] !== 8 * 16 + 4 + 2) fail(`the stem's texel reads ${stem.join(",")}, not covered stem material on layer 1`);
    if (stem[3] !== 128) fail(`a green organ's phenology byte is ${stem[3]}, not 128`);
    if (at(rest, Math.round(0.45 * SIZE), Math.round(0.5 * SIZE))[0] !== 0) fail("the stem covers the sheet beside it");
    // The sprite: covered where its cell is (the left of its box, along its first half), bare beyond.
    const leaf = at(rest, Math.round(0.6 * SIZE + 0.07 * SIZE), Math.round(0.7 * SIZE));
    if (leaf[0] !== 255 || leaf[2] !== 3 * 16 + 8 + 2) fail(`the sprite's texel reads ${leaf.join(",")}, not its cell's material on layer 2`);
    if (at(rest, Math.round(0.6 * SIZE + 0.25 * SIZE), Math.round(0.7 * SIZE))[0] !== 0) fail("the sprite covers the bare half of its cell");
    // A breeze toward +x bends the upright stem: its tip leaves where it stood.
    climate.air.x = 1;
    climate.dt = 1 / 60;
    for (let k = 0; k < 240; k++) {
      climate.time += climate.dt;
      plants.step(climate);
    }
    const blown = read();
    const tip = (bytes: Uint8Array) => at(bytes, Math.round(0.2 * SIZE), Math.round(0.78 * SIZE))[0];
    if (tip(rest) !== 255 || tip(blown) !== 0) fail(`the stem's tip did not move in the breeze (${tip(rest)} → ${tip(blown)})`);
    return { stem, leaf, bend: plants.theta[0] };
  } finally {
    sheet.dispose();
    gl.deleteTexture(atlas);
    gl.deleteFramebuffer(framebuffer);
  }
}
