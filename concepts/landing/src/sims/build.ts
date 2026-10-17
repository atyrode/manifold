// Pure CPU builds off the page's thread: a country's terrain, frost's crystal field, dew's web spun
// for a frame, a bonsai's tree drawn into its maps, the dry garden's layout, the forest's warm-up, a
// slime mould's dish, the pond's painted sheets. One module worker (src/build-worker.ts, which lists
// every kind) runs them all, a slice at a time, and hands each result back by transfer: its typed
// arrays move to the page, never copied. A build is the same code on either side, so a result is
// the same bytes wherever it ran.
//
//   BuildKind<Request, Result>   { name, builder() }: builder() makes one slot's Builder, whose
//                                build(request) is a generator that yields undefined between slices
//                                of work, may yield an early result (a quick draft), and returns the
//                                finished one. What a Builder keeps for a later build to reuse (an
//                                earlier build's work) lives in it, one per slot, and a result never
//                                shares a buffer with it (the result is transferred).
//   new BuildSlot(kind, worker?) one consumer's builds of one kind, the newest request winning
//     request(key, request)      build this under `key`; a new key supersedes the build in progress
//                                (dropped on the worker at its next slice, and never landing); the
//                                key in progress again does nothing, nor the key whose finished
//                                result last landed (the build in progress is dropped: no rebuild)
//     advance(budget, slices?)   once a frame: send the build to the worker, or run it here for up
//                                to `budget` ms and `slices` slices (stopping at an early result);
//                                returns the newest result landed since, else undefined
//     cancel()                   drop the build in progress; nothing more lands until a request,
//                                which builds afresh (even the key last landed)
//     dispose()                  cancel, and drop what the worker keeps for this slot
//   new BuildWorker(worker)      the page's side of a worker running build-worker.ts (tests pass
//                                their own; a slot otherwise takes the page's, buildWorker())
//
// The scene keeps drawing what it last adopted while a build runs. A build runs on the page instead
// when no worker can start (headless tests: no document), when it failed (its builds are run again
// here), and for a frame that wants everything now: SimFrame.budget Infinity (HeadlessSim, checks)
// builds here and finishes in that frame (or stops at its early result, to finish in the next), so
// tests and checks stay synchronous and deterministic.
//
// Usage (one slot per sim, asked every frame, the newest landed result adopted):
//   readonly #build = new BuildSlot(frostGrowth);
//   frame(frame) {
//     this.#build.request(`${seed}|${width}x${height}`, { pattern: seed, size, quick });
//     const landed = this.#build.advance(frame.budget);
//     if (landed) this.#show(landed.result);
//   }
import { runBudgeted } from "./clock.ts";

/** One builder's work for one request: slices, an optional early result, the finished result. */
export type Build<Result> = Generator<Result | undefined, Result, undefined>;

export interface Builder<Request, Result> {
  /** One build of `request` (see the header). */
  build(request: Request): Build<Result>;
}

export interface BuildKind<Request, Result> {
  /** Unique among the kinds build-worker.ts lists: the worker finds the kind by it. */
  readonly name: string;
  /** A builder for one slot (see the header). */
  builder(): Builder<Request, Result>;
}

/** A result as it landed: the key it was asked under, and whether it is the finished one. */
export interface Landed<Result> {
  readonly key: string;
  readonly result: Result;
  readonly done: boolean;
}

/** Page → worker. */
export type BuildMessage =
  | {
      readonly type: "build";
      readonly slot: number;
      readonly id: number;
      readonly kind: string;
      readonly request: unknown;
    }
  | { readonly type: "cancel"; readonly slot: number }
  | { readonly type: "release"; readonly slot: number };

/** Worker → page: a result of build `id` (early or finished), or what it threw. */
export type BuildReply =
  | { readonly slot: number; readonly id: number; readonly result: unknown; readonly done: boolean }
  | { readonly slot: number; readonly id: number; readonly error: string };

export class BuildError extends Error {}

/**
 * The buffers of every typed array in a result (plain objects and arrays, walked), each once: what
 * postMessage transfers so the page receives the arrays without a copy.
 */
export function transferables(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const walk = (item: unknown): void => {
    if (typeof item !== "object" || item === null || seen.has(item)) return;
    seen.add(item);
    if (ArrayBuffer.isView(item)) {
      if (item.buffer instanceof ArrayBuffer) buffers.add(item.buffer);
      return;
    }
    if (item instanceof ArrayBuffer) {
      buffers.add(item);
      return;
    }
    for (const child of Array.isArray(item) ? item : Object.values(item)) walk(child);
  };
  walk(value);
  return [...buffers];
}

/** The page's side of a build worker: slots by number, each reply routed to its slot. */
export class BuildWorker {
  readonly #worker: Worker;
  readonly #slots = new Map<number, (reply: BuildReply | undefined) => void>();
  #next = 1;
  #failed = false;

  constructor(worker: Worker) {
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<BuildReply>) => {
      this.#slots.get(event.data.slot)?.(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      console.error("evt=landing.build_worker.failed", event.message);
      this.#failed = true;
      // Stopped, so the builds already sent to it go no further: every slot runs its build in
      // progress on the page from its next frame.
      worker.terminate();
      for (const listener of this.#slots.values()) listener(undefined);
      this.#slots.clear();
    };
  }

  /** Whether the worker failed (it runs nothing more; its slots build on the page). */
  get failed(): boolean {
    return this.#failed;
  }

  /** A new slot; `listener` gets its replies, and undefined if the worker fails. */
  attach(listener: (reply: BuildReply | undefined) => void): number {
    const slot = this.#next++;
    this.#slots.set(slot, listener);
    return slot;
  }

  post(message: BuildMessage): void {
    this.#worker.postMessage(message);
  }

  /** Drop the slot's build and what its builder keeps; it gets no more replies. */
  release(slot: number): void {
    this.#slots.delete(slot);
    if (!this.#failed) this.post({ type: "release", slot });
  }
}

let shared: BuildWorker | undefined;
let unavailable = false;

/**
 * The page's build worker, started on first use; undefined without a page (headless tests), where
 * none can start, or once it failed. A committed build's page (serve.ts, which names the commit in
 * the page's `landing-build` meta) loads the worker built with it, from the commit's own pinned
 * path even at the root, so a page never runs against another commit's worker; a page served from
 * a working tree loads the one beside it.
 */
export function buildWorker(): BuildWorker | undefined {
  if (unavailable || typeof document === "undefined" || typeof Worker === "undefined")
    return undefined;
  if (!shared) {
    const build =
      document.querySelector<HTMLMetaElement>('meta[name="landing-build"]')?.content ?? "";
    const url = new URL(build ? `/@${build}/build-worker.js` : "build-worker.js", document.baseURI);
    try {
      shared = new BuildWorker(new Worker(url, { type: "module" }));
    } catch (error: unknown) {
      console.error("evt=landing.build_worker.unavailable", error);
      unavailable = true;
      return undefined;
    }
  }
  return shared.failed ? undefined : shared;
}

/** Where the newest request stands. */
type Status = "idle" | "asked" | "sent" | "done";

/** One consumer's builds of one kind (see the header). */
export class BuildSlot<Request, Result> {
  readonly #kind: BuildKind<Request, Result>;
  readonly #given: BuildWorker | undefined;
  /** The worker this slot's builds go to, and its slot number there (0: none yet). */
  #worker: BuildWorker | undefined;
  #slot = 0;
  #key = "";
  #request: Request | undefined;
  /** The newest request's id: a reply for any other is a superseded build's, and is dropped. */
  #id = 0;
  #status: Status = "idle";
  #builder: Builder<Request, Result> | undefined;
  #local: Build<Result> | undefined;
  #landed: Landed<Result> | undefined;
  /**
   * The key of the finished result advance last handed over, unless a draft followed it: what the
   * consumer shows, so asking for it again builds nothing.
   */
  #shown = "";
  #error: BuildError | undefined;

  constructor(kind: BuildKind<Request, Result>, worker?: BuildWorker) {
    this.#kind = kind;
    this.#given = worker;
  }

  /** Build `request` under `key`, superseding any build in progress (see the header). */
  request(key: string, request: Request): void {
    if (key === this.#key) return;
    if (this.#status === "sent") this.#cancelSent();
    this.#key = key;
    this.#request = request;
    this.#id++;
    // Back to the result on show: the build in progress is dropped and nothing lands.
    this.#status = key === this.#shown ? "done" : "asked";
    this.#local = undefined;
    this.#landed = undefined;
  }

  /**
   * Work on the newest request for this frame (see the header): on the worker, or here within
   * `budget` milliseconds (Infinity: to the end, or to an early result) and `slices` slices.
   * Returns the newest result landed since the last call; throws what the build threw.
   */
  advance(budget: number, slices = Infinity): Landed<Result> | undefined {
    const error = this.#error;
    if (error) {
      this.#error = undefined;
      throw error;
    }
    if (this.#status === "asked" || this.#status === "sent") {
      const worker = budget === Infinity ? undefined : this.#workerNow();
      if (worker) {
        if (this.#status === "asked") this.#send(worker);
      } else {
        if (this.#status === "sent") this.#cancelSent();
        this.#runHere(budget, slices);
      }
    }
    const landed = this.#landed;
    this.#landed = undefined;
    if (landed) this.#shown = landed.done ? landed.key : "";
    return landed;
  }

  /** Drop the build in progress: nothing lands until the next request, which builds afresh. */
  cancel(): void {
    if (this.#status === "sent") this.#cancelSent();
    this.#key = "";
    this.#request = undefined;
    this.#id++;
    this.#status = "idle";
    this.#local = undefined;
    this.#landed = undefined;
    this.#shown = "";
  }

  /** Cancel, and let the worker drop what this slot's builder keeps (an earlier build to reuse). */
  dispose(): void {
    this.cancel();
    this.#builder = undefined;
    if (this.#worker && this.#slot !== 0) this.#worker.release(this.#slot);
    this.#worker = undefined;
    this.#slot = 0;
  }

  /** The worker to build on now, if any: the given one, else the page's, unless it failed. */
  #workerNow(): BuildWorker | undefined {
    const worker = this.#given ?? buildWorker();
    return worker && !worker.failed ? worker : undefined;
  }

  #send(worker: BuildWorker): void {
    if (this.#worker !== worker) {
      this.#worker = worker;
      this.#slot = worker.attach((reply) => this.#reply(reply));
    }
    this.#status = "sent";
    worker.post({
      type: "build",
      slot: this.#slot,
      id: this.#id,
      kind: this.#kind.name,
      request: this.#request,
    });
  }

  /** The build on the worker is no longer wanted (superseded, cancelled, or now built here). */
  #cancelSent(): void {
    if (this.#worker && !this.#worker.failed)
      this.#worker.post({ type: "cancel", slot: this.#slot });
    this.#id++;
    this.#status = "asked";
  }

  #reply(reply: BuildReply | undefined): void {
    if (reply === undefined) {
      // The worker failed: run the build it had here, from the next frame.
      this.#worker = undefined;
      this.#slot = 0;
      if (this.#status === "sent") this.#status = "asked";
      return;
    }
    if (reply.id !== this.#id || this.#status !== "sent") return;
    if ("error" in reply) {
      this.#status = "done";
      this.#error = new BuildError(`landing: ${this.#kind.name} build failed: ${reply.error}`);
      return;
    }
    // The worker ran this slot's own kind: its result is that kind's.
    this.#land(reply.result as Result, reply.done);
  }

  #runHere(budget: number, slices: number): void {
    const request = this.#request;
    if (request === undefined) return;
    if (!this.#local) {
      this.#builder ??= this.#kind.builder();
      this.#local = this.#builder.build(request);
    }
    const steps = this.#local;
    runBudgeted(
      () => {
        const step = steps.next();
        if (step.done) {
          this.#local = undefined;
          this.#land(step.value, true);
          return true;
        }
        if (step.value === undefined) return false;
        this.#land(step.value, false);
        return true;
      },
      budget,
      slices,
    );
  }

  #land(result: Result, done: boolean): void {
    this.#landed = { key: this.#key, result, done };
    if (done) this.#status = "done";
  }
}
