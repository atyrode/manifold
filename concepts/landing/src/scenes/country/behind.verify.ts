// GPU check (verify-browser.ts, `countryBehind`): a ray that meets a tree's bound near the eye but
// no crown there goes on to the ground behind (shader.ts countryBehind), and lands where it first
// meets the land. The probe runs the scene's own march, crown search and step to the ground over
// the real sim's textures for every pixel of the view, and where a ray passed between the crowns
// finds that first meeting by a fine march (10 cm steps, then bisection) and checks the scene's
// step ended within 5 cm of it along the ray, or 0.2% of its distance: all but one ray in 200 (one
// grazing a crest finer than the march's own steps may land beyond it). A single step onto the
// ground taken flat under the bound's hit (what it was) is counted beside: under a third land, the
// rest metres off, which drew the land seen between the trees displaced, in a halo round each tree.
import { fragmentSourceFor, sceneFeaturesAll } from "../../shaders/index.ts";
import { countryScene } from "./index.ts";
import { countryBuild, countryDraw, countryProgram } from "./terrain.verify.ts";

const WIDTH = 320;
const HEIGHT = 180;

const probeGlsl = /* glsl */ `
// Where the ray first meets the land beyond t0: 10 cm steps up to 250 m, then bisection; -1 none.
float probeFirstLand(vec3 ro, vec3 rd, float t0) {
  float t = t0;
  float prev = t0;
  bool met = false;
  for (int i = 0; i < 2500; i++) {
    vec3 q = ro + rd * t;
    if (q.y < terrainSurface(terrainGround(uSim0, q.xz, COUNTRY_EXTENT))) {
      met = true;
      break;
    }
    prev = t;
    t += 0.1;
  }
  if (!met) return -1.0;
  for (int i = 0; i < 16; i++) {
    float mid = 0.5 * (prev + t);
    vec3 q = ro + rd * mid;
    if (q.y < terrainSurface(terrainGround(uSim0, q.xz, COUNTRY_EXTENT))) t = mid;
    else prev = mid;
  }
  return 0.5 * (prev + t);
}

Shade probeCountryBehind(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  float cellAngle = (1.0 / uRes.y) / COUNTRY_FOCAL;
  countryFwd = vec3(COUNTRY_HEADING.x, 0.0, COUNTRY_HEADING.y);
  countryRight = vec3(COUNTRY_HEADING.y, 0.0, -COUNTRY_HEADING.x);
  vec3 rd = countryToWorld(viewRay(uv, aspect, COUNTRY_HORIZON, COUNTRY_FOV));
  vec3 eye = terrainEye(uSim3);
  float tHit = countryMarch(eye, rd);
  vec3 o = vec3(0.0);
  if (tHit > 0.0) {
    vec3 p = eye + rd * tHit;
    vec4 g = terrainGround(uSim0, p.xz, COUNTRY_EXTENT);
    float ground = terrainSurface(g);
    float fall = dot(g.zw, rd.xz) - rd.y;
    if (p.y > ground + 0.3 && 3.0 / (tHit * cellAngle) >= 1.2 && fall >= 0.02) {
      CountryTree tree;
      vec3 n;
      float up;
      if (countryCrowns(eye, rd, tHit, p, g, tree, n, up) < 0.0) {
        float first = probeFirstLand(eye, rd, tHit);
        if (first > 0.0) {
          float once = abs(tHit + (p.y - ground) / fall - first);
          float land = abs(countryBehind(eye, rd, tHit, p, g) - first);
          // Within 5 cm along the ray, or 0.2% of the distance (a shallow ray's end moves far along
          // it for a small error in height): r carries which ended within it.
          float tol = max(0.05, 0.002 * first);
          float flags = 128.0 + (land <= tol ? 64.0 : 0.0) + (once <= tol ? 32.0 : 0.0);
          o = vec3(flags, min(land * 100.0, 255.0), min(once * 100.0, 255.0)) / 255.0;
        }
      }
    }
  }
  return shadeOf(o, 0.0, 0.0);
}
`;

export function verifyCountryBehind(gl: WebGL2RenderingContext): Record<string, unknown> {
  const all = sceneFeaturesAll(countryScene);
  const probe = countryProgram(
    gl,
    fragmentSourceFor(
      { ...countryScene, entry: "probeCountryBehind", glsl: countryScene.glsl + probeGlsl },
      all,
    ),
  );
  const built = countryBuild(gl, {});
  try {
    const bytes = countryDraw(gl, probe, built, {}, { width: WIDTH, height: HEIGHT });
    let between = 0;
    let landed = 0;
    let onceLanded = 0;
    let worst = 0;
    const misses: string[] = [];
    for (let i = 0; i < bytes.length; i += 4) {
      const flags = bytes[i] ?? 0;
      if (flags < 128) continue;
      between++;
      const off = bytes[i + 1] ?? 255;
      if (flags & 64) landed++;
      else misses.push(`${off} cm at ${(i / 4) % WIDTH},${Math.floor(i / 4 / WIDTH)}`);
      if (flags & 32) onceLanded++;
      worst = Math.max(worst, off);
    }
    if (between < 50) throw new Error(`country: only ${between} rays passed between the crowns`);
    // A ray grazing a crest finer than the march's own steps may still land beyond it, as the
    // march itself would.
    if (landed < 0.995 * between)
      throw new Error(
        `country: ${between - landed} of ${between} rays between the crowns ended off the land: ${misses.slice(0, 30).join(", ")}`,
      );
    return { between, landed, worstCm: worst, singleStepLanded: onceLanded };
  } finally {
    built.dispose();
    gl.deleteProgram(probe);
  }
}
