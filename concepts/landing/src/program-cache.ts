// The renderer's scene programs (src/renderer.ts): each scene's fragment program for each
// compile-time feature set it draws with, built in the background and never waited for, and kept
// least recently drawn first (PROGRAMS_PER_SCENE a scene, PROGRAMS_KEPT in all), or why it failed
// to build. A scene's program builds once its code has loaded (src/scenes/index.ts `loadScene`),
// which the first ask for it starts. The renderer asks for the program to enter a scene with
// (`entryProgram`) and for the one to draw a knob change with (`programSoon`): each answers with
// the program, the failure, or undefined while the code loads or the program builds; once a frame
// `settle` keeps the builds the driver has finished.
import { constellationUniforms } from "./constellations.ts";
import { MAX_TRIGGERS } from "./params.ts";
import type { RenderSettings, SceneFailure } from "./renderer.ts";
import { loadedScene, loadScene, sceneDefs, type SceneId } from "./scenes/index.ts";
import type { LoadedScene } from "./scenes/types.ts";
import {
  featureKey,
  fragmentSourceFor,
  sceneFeatures,
  sceneFeaturesAll,
  settingKeyed,
} from "./shaders/index.ts";

/** Texture units: `uSim0..uSim3`, one per sim slot, then `uLeaving`. */
export const SIM_SLOTS = 4;
export const LEAVING_UNIT = SIM_SLOTS;
/**
 * Programs kept per scene: those it entered with, one per compile-time feature set
 * (`SceneDef.featuresFor`, the library gates and its planets, `settingKeyed`, and the cursors' gate
 * while the cast has agents), and its all-features program (`sceneFeaturesAll`); past this many the
 * least recently drawn one is freed.
 */
const PROGRAMS_PER_SCENE = 4;
/**
 * Programs kept across scenes: past this many the least recently drawn one of any scene is freed
 * (never one on screen, leaving, run ahead or primed), so a tour of the scenes does not keep one of
 * each in driver memory.
 */
const PROGRAMS_KEPT = 8;
/** Milliseconds a link status query may take without waiting on the link (see `#learnLink`). */
const LINK_WAITED_MS = 4;

const uniformNames = [
  "uRes",
  "uTime",
  "uMotionTime",
  "uFallTime",
  "uDither",
  "uColor",
  "uLevels",
  "uMotion",
  "uPointer",
  "uPrincipals",
  "uPrincipalCount",
  "uPrincipalMotion",
  "uBg",
  "uInk",
  "uAccent",
  "uParams",
  "uPhases",
  "uView",
  "uConStars",
  "uConBright",
  "uConLines",
  "uConStarCount",
  "uConLineCount",
  "uConMarkStar",
  "uConMarkLine",
  "uPlanets",
  "uPlanetCount",
  "uTriggers",
  "uMotionTriggers",
  "uSim0",
  "uSim1",
  "uSim2",
  "uSim3",
  "uSimOn",
  "uWeather",
  "uPassage",
  "uDissolve",
  "uLeaving",
] as const;
type UniformName = (typeof uniformNames)[number];

/**
 * One scene's linked program for one feature set (`key`, see `featureKey`), where its uniforms live,
 * and what they hold. Uniforms keep their values per program, so a frame sends again only what
 * changed since this program last drew: `settings` is the settings object its look and knobs were
 * sent from (`DitherRenderer.update` installs a new object for every change, so identity is the
 * version), then the motion amount (0 while frozen), the trigger stamps as the shader reads them,
 * and which sim slots are bound (bit per slot).
 */
export interface SceneProgram {
  key: string;
  program: WebGLProgram;
  uniforms: Record<UniformName, WebGLUniformLocation | null>;
  sent: {
    settings: RenderSettings | undefined;
    motion: number;
    triggers: number[];
    motionTriggers: number[];
    simOn: number;
  };
}

/** A compile-time feature set and its key (`featureKey`). */
export interface FeatureSet {
  features: Readonly<Record<string, number>>;
  key: string;
}

/**
 * A program compiling and linking in the background, never waited for: it is done once the driver
 * says so (KHR_parallel_shader_compile) or, without that extension, once `fence`, set after the
 * link, has signalled and a link of its length has had time to finish (see `#linkedByNow`); until
 * then nothing may ask about it, which would wait for the driver. `started`: performance.now() at
 * the link.
 */
interface Building {
  id: SceneId;
  key: string;
  program: WebGLProgram;
  fragment: WebGLShader;
  source: string;
  fence: WebGLSync | null;
  started: number;
}

/** A kept build (see `#programs`): a scene's program for a feature set, or why it failed. */
interface Kept {
  id: SceneId;
  built: SceneProgram | SceneFailure;
}

/** Where `#programs` keeps `id`'s build for the feature set `key` (see `featureKey`). */
function keptName(id: SceneId, key: string): string {
  return `${id} ${key}`;
}

/**
 * The feature set a settings object asks of its scene's program, and the scene's all-features set
 * (undefined for a scene without knob-keyed features).
 */
export interface Wanted extends FeatureSet {
  all: FeatureSet | undefined;
}

/**
 * What every scene's program is built with on the context, made again once a lost context is
 * restored (the renderer's `GlResources`): the vertex shader they share, and
 * KHR_parallel_shader_compile when the browser has it (programs then build off the main thread).
 */
export interface ProgramContext {
  readonly vertex: WebGLShader;
  readonly parallel: { readonly COMPLETION_STATUS_KHR: number } | null;
  /**
   * The context renders in software: it runs every line of a program whatever branch a pixel
   * takes, and compiling the countryside's all-features program takes it some 20 s (its own
   * programs 2-5 s), so a knob change builds the setting's own program instead (`programSoon`).
   */
  readonly software: boolean;
}

/** A scene's program that could not be built: the failure it becomes carries its message. */
class ProgramError extends Error {}

/**
 * The info log with the offending source line under each `ERROR: 0:<line>:`, since the scene's
 * fragment source is generated and otherwise never seen.
 */
export function annotate(log: string, source: string): string {
  const lines = source.split("\n");
  return log
    .split("\n")
    .map((entry) => {
      const line = /^ERROR: \d+:(\d+):/.exec(entry)?.[1];
      return line === undefined
        ? entry
        : `${entry}\n    > ${(lines[Number(line) - 1] ?? "").trim()}`;
    })
    .join("\n");
}

export class ScenePrograms {
  readonly #gl: WebGL2RenderingContext;
  /** What programs are built with: the renderer's, made again once a lost context is restored. */
  readonly #gpu: () => ProgramContext;
  /** Whether the renderer draws a program or is about to (see `#held`). */
  readonly #drawing: (program: SceneProgram) => boolean;
  /**
   * Each scene's programs by feature key (`keptName`, `featureKey`), built on first use, or why one
   * failed to build (logged); least recently drawn first, at most PROGRAMS_PER_SCENE a scene and
   * PROGRAMS_KEPT in all.
   */
  readonly #programs = new Map<string, Kept>();
  /** The program building in the background for what is wanted now (a change, the next scene), if any. */
  #building: Building | undefined;
  /**
   * A program building beside `#building` that nothing waits for: a scene's all-features program
   * built ahead of any change (`buildAside`), or one for a scene passed over (`#programFor`). The
   * next scene's program never waits for it, nor a change it does not serve.
   */
  #ahead: Building | undefined;
  /**
   * A scene's all-features program just built in the background that the scene does not draw with
   * yet: the next frame of that scene draws with it once (see `takeWarm`).
   */
  #warm: { id: SceneId; program: SceneProgram } | undefined;
  /**
   * Milliseconds of link per character of fragment source, as links have taken on this context
   * without KHR_parallel_shader_compile (see `#linkedByNow`).
   */
  #linkRate = 0;
  /** A link was asked about this frame: one a frame at most (see `#linkedByNow`). */
  #linkAsked = false;
  /** The feature set each settings object asks for, or why it cannot be had (see `want`). */
  #wanted = new WeakMap<RenderSettings, Wanted | SceneFailure>();
  /** Scenes whose code loads for a build (see `#code`). */
  readonly #loading = new Set<SceneId>();
  /** Scenes whose code could not be loaded, and the failure that stops them, until `retry`. */
  readonly #unloaded = new Map<SceneId, SceneFailure>();

  /**
   * `gpu`: what the context holds to build programs with, as it is now. `drawing`: whether the
   * renderer draws a program or is about to (the scene on screen's, the leaving scene's, the
   * incoming one's, run ahead or primed for a passage), which is then never freed.
   */
  constructor(
    gl: WebGL2RenderingContext,
    gpu: () => ProgramContext,
    drawing: (program: SceneProgram) => boolean,
  ) {
    this.#gl = gl;
    this.#gpu = gpu;
    this.#drawing = drawing;
  }

  /**
   * Whether a scene's code loads, a program builds in the background or one just built waits to
   * draw its first frame (`takeWarm`).
   */
  get busy(): boolean {
    return (
      this.#loading.size > 0 ||
      this.#building !== undefined ||
      this.#ahead !== undefined ||
      this.#warm !== undefined
    );
  }

  /**
   * After a failure, work out every feature set again (features that could not be worked out are
   * tried again) and, if `failed` is a scene whose program failed to build or whose code failed to
   * load, build or load it again.
   */
  retry(failed: SceneId | undefined): void {
    if (failed !== undefined) {
      this.#unloaded.delete(failed);
      for (const [name, kept] of this.#programs)
        if (kept.id === failed && "stage" in kept.built) this.#programs.delete(name);
    }
    this.#wanted = new WeakMap();
  }

  /** The context is lost: forget every program and build, which went with it. */
  lose(): void {
    this.#programs.clear();
    this.#building = undefined;
    this.#ahead = undefined;
    this.#warm = undefined;
  }

  /**
   * The compile-time features `s` asks of its scene's program (see `sceneFeatures`) and the scene's
   * all-features set (`sceneFeaturesAll`), worked out once per settings object; or, if the scene's
   * features cannot be worked out (SceneShaderError), the failure that stops it as a build would.
   */
  want(s: RenderSettings): Wanted | SceneFailure {
    let wanted = this.#wanted.get(s);
    if (wanted === undefined) {
      const def = sceneDefs[s.scene];
      try {
        const values = settingKeyed(def)
          ? Object.fromEntries(def.params.map((knob, index) => [knob.key, s.params[index] ?? 0]))
          : undefined;
        const features = sceneFeatures(def, values, s.planets.count, s.agents > 0);
        const all = sceneFeaturesAll(def);
        wanted = {
          features,
          key: featureKey(features),
          all: all === undefined ? undefined : { features: all, key: featureKey(all) },
        };
      } catch (error: unknown) {
        wanted = this.#failed(s.scene, undefined, error);
      }
      this.#wanted.set(s, wanted);
    }
    return wanted;
  }

  /**
   * Scene `id` with its code; undefined while the code loads, the load started here (the renderer
   * keeps drawing frames while it does: `busy`); or why it could not be loaded, until `retry`.
   */
  #code(id: SceneId): LoadedScene | SceneFailure | undefined {
    const scene = loadedScene(id) ?? this.#unloaded.get(id);
    if (scene !== undefined || this.#loading.has(id)) return scene;
    this.#loading.add(id);
    loadScene(id).then(
      () => this.#loading.delete(id),
      (error: unknown) => {
        this.#loading.delete(id);
        this.#unloaded.set(id, this.#failed(id, undefined, error));
      },
    );
    return undefined;
  }

  /**
   * Start building `scene`'s program with a feature set in the background: compile and link,
   * without waiting for either, with a fence after the link where the browser lacks
   * KHR_parallel_shader_compile (see `#settled`). A source that does not assemble fails at once.
   */
  #build(id: SceneId, scene: LoadedScene, set: FeatureSet): Building | SceneFailure {
    const gl = this.#gl;
    const gpu = this.#gpu();
    let source: string;
    try {
      source = fragmentSourceFor(scene, set.features);
    } catch (error: unknown) {
      return this.#failed(id, set.key, error);
    }
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fragment)
      return this.#failed(id, set.key, new ProgramError(`scene ${id}: could not allocate shader`));
    gl.shaderSource(fragment, source);
    gl.compileShader(fragment);
    const program = gl.createProgram();
    gl.attachShader(program, gpu.vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    const fence = gpu.parallel === null ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
    gl.flush();
    return { id, key: set.key, program, fragment, source, fence, started: performance.now() };
  }

  /**
   * A built program, its constant uniforms set (waits for the driver unless the build is done);
   * throws ProgramError (with the info log) on failure.
   */
  #link(building: Building): SceneProgram {
    const gl = this.#gl;
    const { id, program, fragment } = building;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const compiled = gl.getShaderParameter(fragment, gl.COMPILE_STATUS) === true;
      const log = (compiled ? gl.getProgramInfoLog(program) : gl.getShaderInfoLog(fragment)) ?? "";
      gl.deleteShader(fragment);
      gl.deleteProgram(program);
      throw new ProgramError(
        compiled
          ? `scene ${id}: program link failed\n${log}`
          : `scene ${id}: shader compile failed\n${annotate(log, building.source)}`,
      );
    }
    // Only flagged while attached: freed together with the program.
    gl.deleteShader(fragment);
    gl.useProgram(program);
    const uniforms = Object.fromEntries(
      uniformNames.map((name) => [name, gl.getUniformLocation(program, name)]),
    ) as Record<UniformName, WebGLUniformLocation | null>;
    // Constant for the program's lifetime: the constellation figures (orbit's sky, and the shared
    // sky's constellations where a scene has that knob; the other programs drop the uniforms) and
    // the texture unit of every sampler. Brightness and lines go up packed, four stars and two
    // lines a vec4 (common.ts `conBright`, `conLine`).
    const figures = constellationUniforms;
    gl.uniform4fv(uniforms.uConStars, figures.stars);
    gl.uniform4fv(uniforms.uConBright, figures.brightness);
    gl.uniform4fv(uniforms.uConLines, figures.lines);
    gl.uniform1i(uniforms.uConStarCount, figures.starCount);
    gl.uniform1i(uniforms.uConLineCount, figures.lineCount);
    gl.uniform1i(uniforms.uConMarkStar, figures.markStar);
    gl.uniform1i(uniforms.uConMarkLine, figures.markLine);
    [uniforms.uSim0, uniforms.uSim1, uniforms.uSim2, uniforms.uSim3].forEach((location, slot) =>
      gl.uniform1i(location, slot),
    );
    gl.uniform1i(uniforms.uLeaving, LEAVING_UNIT);
    // Nothing sent yet: NaN and -1 differ from every value the first frame sends.
    const triggers = Array.from({ length: MAX_TRIGGERS }, () => Number.NaN);
    return {
      key: building.key,
      program,
      uniforms,
      sent: {
        settings: undefined,
        motion: Number.NaN,
        triggers,
        motionTriggers: [...triggers],
        simOn: -1,
      },
    };
  }

  /** Finish a build and keep what came of it: the program, or why it failed to build. */
  #finish(building: Building | SceneFailure): SceneProgram | SceneFailure {
    if ("stage" in building) return building;
    if (building.fence !== null) this.#gl.deleteSync(building.fence);
    try {
      const built = this.#link(building);
      this.#keep(building.id, building.key, built);
      return built;
    } catch (error: unknown) {
      return this.#failed(building.id, building.key, error);
    }
  }

  /** Log why a scene's program failed to build; keep it under its feature `key` if it has one. */
  #failed(id: SceneId, key: string | undefined, error: unknown): SceneFailure {
    console.error(`evt=landing.renderer.scene_failed scene=${id} stage=build`, error);
    const failure: SceneFailure = {
      scene: id,
      stage: "build",
      message: error instanceof Error ? error.message : String(error),
    };
    if (key !== undefined) this.#keep(id, key, failure);
    return failure;
  }

  /**
   * Keep a scene's program (or failure) under its feature key as the most recently drawn, freeing the
   * least recently drawn of the scene's past PROGRAMS_PER_SCENE and of all past PROGRAMS_KEPT
   * (never the one just kept, nor one that draws or is about to: `#held`).
   */
  #keep(id: SceneId, key: string, built: SceneProgram | SceneFailure): void {
    const programs = this.#programs;
    const name = keptName(id, key);
    programs.delete(name);
    programs.set(name, { id, built });
    let total = programs.size;
    let own = 0;
    for (const kept of programs.values()) if (kept.id === id) own++;
    for (const [old, kept] of programs) {
      if (total <= PROGRAMS_KEPT && own <= PROGRAMS_PER_SCENE) break;
      const mine = kept.id === id;
      if (old === name || (!mine && total <= PROGRAMS_KEPT) || this.#held(kept.built)) continue;
      programs.delete(old);
      total--;
      if (mine) own--;
      if ("program" in kept.built) this.#gl.deleteProgram(kept.built.program);
    }
  }

  /**
   * Whether a kept program draws or is about to: one the renderer draws or is about to draw
   * (`#drawing`), or one warming (`#warm`).
   */
  #held(built: SceneProgram | SceneFailure): boolean {
    return "program" in built && (built === this.#warm?.program || this.#drawing(built));
  }

  /** A kept program (or failure) for `id` under `key`, marked as the most recently drawn. */
  #kept(id: SceneId, key: string): SceneProgram | SceneFailure | undefined {
    const kept = this.#programs.get(keptName(id, key));
    if (kept !== undefined) this.#keep(id, key, kept.built);
    return kept?.built;
  }

  /** A kept program (or failure) that draws `wanted`: its own set's, else the all-features one. */
  #keptFor(id: SceneId, wanted: Wanted): SceneProgram | SceneFailure | undefined {
    return (
      this.#kept(id, wanted.key) ??
      (wanted.all === undefined ? undefined : this.#kept(id, wanted.all.key))
    );
  }

  /**
   * Once a frame: keep each background build once the driver has finished it (`#settled`), and say
   * whether one had.
   */
  settle(): boolean {
    this.#linkAsked = false;
    let settled = false;
    if (this.#building !== undefined && this.#settled(this.#building)) {
      this.#building = undefined;
      settled = true;
    }
    if (this.#ahead !== undefined && this.#settled(this.#ahead)) {
      this.#ahead = undefined;
      settled = true;
    }
    return settled;
  }

  /**
   * Keep a background build if the driver has finished it, asked without waiting (the completion
   * status, else `#linkedByNow`), and say whether it had. A scene's all-features program then draws
   * one frame of it at once (`#warm`).
   */
  #settled(building: Building): boolean {
    const parallel = this.#gpu().parallel;
    const done =
      parallel !== null
        ? this.#gl.getProgramParameter(building.program, parallel.COMPLETION_STATUS_KHR) === true
        : this.#linkedByNow(building);
    if (!done) return false;
    const asked = performance.now();
    const built = this.#finish(building);
    if (parallel === null) this.#learnLink(building, asked);
    const all = sceneFeaturesAll(sceneDefs[building.id]);
    if ("program" in built && all !== undefined && featureKey(all) === building.key)
      this.#warm = { id: building.id, program: built };
    return true;
  }

  /**
   * Without KHR_parallel_shader_compile nothing tells without waiting when a link is done. The
   * fence set after it signals once the GPU has run what came before, but ANGLE links on worker
   * threads of its own past that, so asking then can still wait out the whole link (seconds under
   * SwiftShader). A build is asked about once its fence has signalled, no sooner than links have
   * taken on this context for a source of its length (`#linkRate`), and one a frame at most.
   */
  #linkedByNow(building: Building): boolean {
    const gl = this.#gl;
    if (this.#linkAsked) return false;
    if (
      building.fence !== null &&
      gl.getSyncParameter(building.fence, gl.SYNC_STATUS) !== gl.SIGNALED
    )
      return false;
    if (performance.now() - building.started < this.#linkRate * building.source.length)
      return false;
    this.#linkAsked = true;
    return true;
  }

  /**
   * Learn how long links take on this context from one just asked about (`asked`: when). If asking
   * waited (LINK_WAITED_MS or more), the link took as long as the build had run; if it did not, the
   * link may have been done well before, and the estimate shrinks.
   */
  #learnLink(building: Building, asked: number): void {
    const now = performance.now();
    this.#linkRate =
      now - asked >= LINK_WAITED_MS
        ? (now - building.started) / Math.max(1, building.source.length)
        : this.#linkRate * 0.75;
  }

  /**
   * The all-features program just built in the background that its scene does not draw with yet,
   * handed over once: the next frame of that scene draws with it in its own program's place.
   */
  takeWarm(): { id: SceneId; program: SceneProgram } | undefined {
    const warm = this.#warm;
    this.#warm = undefined;
    return warm;
  }

  /**
   * `id`'s program (or failure) for the wanted features, to enter the scene with: the set's own or
   * the all-features one if kept; else undefined while one of them builds in the background,
   * started here (the set's own) if need be. A build under way for another scene or set is moved
   * aside (`#ahead`), as one for a scene passed over, rather than holding this one up.
   */
  #programFor(id: SceneId, wanted: Wanted): SceneProgram | SceneFailure | undefined {
    const kept = this.#keptFor(id, wanted);
    if (kept !== undefined) return kept;
    for (const building of [this.#building, this.#ahead])
      if (
        building !== undefined &&
        building.id === id &&
        (building.key === wanted.key || building.key === wanted.all?.key)
      )
        return undefined;
    const stale = this.#building;
    if (stale !== undefined && this.#ahead === undefined) {
      this.#ahead = stale;
      this.#building = undefined;
    }
    return this.#buildAhead(id, wanted);
  }

  /** The program (or failure) to enter the scene `s` sets with: see `#programFor`. */
  entryProgram(s: RenderSettings): SceneProgram | SceneFailure | undefined {
    const wanted = this.want(s);
    return "stage" in wanted ? wanted : this.#programFor(s.scene, wanted);
  }

  /**
   * The same for a knob change, never waiting: undefined while a program for it builds in the
   * background, started here if need be. That is the scene's all-features program, so a change
   * never builds one for its own set, except on a software rasteriser (`ProgramContext.software`),
   * where it is the set's own. One build at a time: one started for another set or scene finishes
   * first (the all-features program building ahead counts only for the changes it serves).
   */
  programSoon(id: SceneId, wanted: Wanted): SceneProgram | SceneFailure | undefined {
    const kept = this.#keptFor(id, wanted);
    if (kept !== undefined) return kept;
    const set = this.#gpu().software ? wanted : (wanted.all ?? wanted);
    if (this.#ahead?.id === id && this.#ahead.key === set.key) return undefined;
    return this.#buildAhead(id, set);
  }

  /**
   * Start building `id`'s all-features program `all` beside any build under way (`#ahead`), for
   * changes to come: unless a build is aside already, `all` builds already, it is kept, or the
   * scene's code has not loaded.
   */
  buildAside(id: SceneId, all: FeatureSet): void {
    if (
      this.#ahead !== undefined ||
      (this.#building?.id === id && this.#building.key === all.key) ||
      this.#programs.has(keptName(id, all.key))
    )
      return;
    const scene = this.#code(id);
    if (scene === undefined || "stage" in scene) return;
    const started = this.#build(id, scene, all);
    if (!("stage" in started)) this.#ahead = started;
  }

  /**
   * Start building `id`'s program for `set` in the background once the scene's code has loaded
   * (see `#code`; its load starts at once), unless a build is under way.
   */
  #buildAhead(id: SceneId, set: FeatureSet): SceneFailure | undefined {
    const scene = this.#code(id);
    if (scene === undefined || "stage" in scene) return scene;
    if (this.#building !== undefined) return undefined;
    const started = this.#build(id, scene, set);
    if ("stage" in started) return started;
    this.#building = started;
    return undefined;
  }
}
