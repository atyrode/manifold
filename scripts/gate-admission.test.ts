import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TASK_MEMORY_MIB,
  availableMemory,
  runAdmitted,
  taskMemoryBudget,
  type Admission,
  type MemoryReading,
} from "./gate-admission.ts";

const GIB = 1024 * 1024 * 1024;

/** Fake tasks that start when admitted and finish only when the test says so. */
function fakeTasks(count: number) {
  const started: string[] = [];
  const finishers = new Map<string, () => void>();
  let running = 0;
  let peak = 0;
  const jobs = Array.from({ length: count }, (_, index) => {
    const name = `task ${index}`;
    return {
      name,
      run: () => {
        const { promise, resolve } = Promise.withResolvers<string>();
        started.push(name);
        running += 1;
        peak = Math.max(peak, running);
        finishers.set(name, () => {
          running -= 1;
          resolve(name);
        });
        return promise;
      },
    };
  });
  const finish = (...names: readonly string[]): void => {
    for (const name of names) {
      const finisher = finishers.get(name);
      if (finisher === undefined) throw new Error(`${name} has not started`);
      finisher();
    }
  };
  return { jobs, started, finish, peak: () => peak };
}

/** Admission over scripted readings, with re-checks that fire only when the test says so. */
function scripted(read: () => MemoryReading | null, budget = GIB) {
  const log: string[] = [];
  const pending: (() => void)[] = [];
  const admission: Admission = {
    budget,
    readMemory: read,
    recheck: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      pending.push(resolve);
      return promise;
    },
    log: (line) => log.push(line),
  };
  const recheck = (): void => {
    for (const fire of pending.splice(0)) fire();
  };
  return { admission, log, recheck };
}

/** Lets every queued continuation run; the scheduler is driven by promises, not time. */
const flush = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

describe("gate memory admission", () => {
  test("ample memory admits up to the cap in job order", async () => {
    const tasks = fakeTasks(8);
    const { admission, log } = scripted(() => ({ available: 64 * GIB, taskResident: [] }));
    const schedule = runAdmitted(6, tasks.jobs, admission);
    await flush();
    expect(tasks.started).toEqual(["task 0", "task 1", "task 2", "task 3", "task 4", "task 5"]);

    tasks.finish("task 0", "task 1");
    await flush();
    expect(tasks.started.slice(6)).toEqual(["task 6", "task 7"]);
    tasks.finish("task 2", "task 3", "task 4", "task 5", "task 6", "task 7");

    expect(await schedule).toEqual(tasks.jobs.map((job) => job.name));
    expect(tasks.peak()).toBe(6);
    expect(log).toEqual([]);
  });

  test("started tasks reserve their unclaimed budget, so free memory does not admit a burst", async () => {
    const tasks = fakeTasks(4);
    let reading: MemoryReading = { available: 3.5 * GIB, taskResident: [] };
    const { admission, log, recheck } = scripted(() => reading);
    const schedule = runAdmitted(6, tasks.jobs, admission);
    await flush();

    // Nothing has grown yet, so three whole budgets are reserved against 3.5 GiB.
    expect(tasks.started).toEqual(["task 0", "task 1", "task 2"]);
    expect(log).toEqual([
      "gate: waiting for memory before starting task 3: 3584 MiB available, 3072 MiB reserved by started tasks, 1024 MiB budget",
    ]);

    // Grown into their budgets, the tasks reserve nothing more, but the host is still short.
    reading = { available: 0.5 * GIB, taskResident: [GIB, GIB, GIB] };
    recheck();
    await flush();
    expect(tasks.started.length).toBe(3);

    reading = { available: 1.5 * GIB, taskResident: [GIB, GIB] };
    tasks.finish("task 1");
    await flush();
    expect(tasks.started).toEqual(["task 0", "task 1", "task 2", "task 3"]);

    tasks.finish("task 0", "task 2", "task 3");
    expect(await schedule).toEqual(["task 0", "task 1", "task 2", "task 3"]);
    expect(log.length).toBe(1);
  });

  test("low memory holds admission until memory recovers, logging once per wait", async () => {
    const tasks = fakeTasks(2);
    let available = 0.5 * GIB;
    const { admission, log, recheck } = scripted(() => ({
      available,
      taskResident: [0.2 * GIB],
    }));
    const schedule = runAdmitted(6, tasks.jobs, admission);
    await flush();
    expect(tasks.started).toEqual(["task 0"]);

    recheck();
    await flush();
    expect(tasks.started).toEqual(["task 0"]);

    available = 3 * GIB;
    recheck();
    await flush();
    expect(tasks.started).toEqual(["task 0", "task 1"]);
    expect(log).toEqual([
      "gate: waiting for memory before starting task 1: 512 MiB available, 819 MiB reserved by started tasks, 1024 MiB budget",
    ]);

    tasks.finish("task 0", "task 1");
    expect(await schedule).toEqual(["task 0", "task 1"]);
  });

  test("zero running tasks always admits one, so an exhausted host still completes", async () => {
    const tasks = fakeTasks(3);
    const { admission, log } = scripted(() => ({ available: 0, taskResident: [] }));
    const schedule = runAdmitted(6, tasks.jobs, admission);

    for (const name of ["task 0", "task 1", "task 2"]) {
      await flush();
      expect(tasks.started.at(-1)).toBe(name);
      tasks.finish(name);
    }

    expect(await schedule).toEqual(["task 0", "task 1", "task 2"]);
    expect(tasks.peak()).toBe(1);
    expect(log).toEqual(
      ["task 1", "task 2"].map(
        (name) =>
          `gate: waiting for memory before starting ${name}: 0 MiB available, 1024 MiB reserved by started tasks, 1024 MiB budget`,
      ),
    );
  });

  test.each([
    ["unreadable memory", () => scripted(() => null)],
    ["a zero budget", () => scripted(() => ({ available: 0, taskResident: [] }), 0)],
  ])("%s falls back to the cap", async (_, admit) => {
    const { admission, log } = admit();
    const tasks = fakeTasks(8);
    const schedule = runAdmitted(6, tasks.jobs, admission);
    await flush();
    expect(tasks.started.length).toBe(6);

    tasks.finish(...tasks.started);
    await flush();
    tasks.finish("task 6", "task 7");
    expect((await schedule).length).toBe(8);
    expect(log).toEqual([]);
  });

  test("a job that throws rejects the schedule while other jobs are still running", async () => {
    const tasks = fakeTasks(2);
    const { admission } = scripted(() => ({ available: 64 * GIB, taskResident: [] }));
    const broken = { name: "broken", run: () => Promise.reject(new Error("spawn failed")) };

    await expect(runAdmitted(6, [broken, ...tasks.jobs], admission)).rejects.toThrow(
      "spawn failed",
    );
    expect(tasks.started).toEqual(["task 0", "task 1"]);
  });

  test("MANIFOLD_GATE_TASK_MEMORY_MIB is a whole number of MiB, with 0 turning admission off", () => {
    expect(taskMemoryBudget(undefined)).toBe(DEFAULT_TASK_MEMORY_MIB * 1024 * 1024);
    expect(taskMemoryBudget("")).toBe(DEFAULT_TASK_MEMORY_MIB * 1024 * 1024);
    expect(taskMemoryBudget("0")).toBe(0);
    expect(taskMemoryBudget("2048")).toBe(2 * GIB);
    for (const malformed of ["-1", "1.5", "2G", " 512", "0x10", "9".repeat(20)]) {
      expect(taskMemoryBudget(malformed)).toBeNull();
    }
  });

  test("available memory is MemAvailable, bounded by each finite cgroup's working-set headroom", () => {
    const meminfo = "MemTotal:       32864928 kB\nMemAvailable:    8388608 kB\n";
    const unlimited = { max: "max\n", current: `${20 * GIB}\n`, stat: null };
    expect(availableMemory(meminfo, [unlimited])).toBe(8 * GIB);

    // A 6 GiB limit with 5 GiB charged, 2 GiB of it reclaimable file cache: 3 GiB headroom.
    const limited = {
      max: `${6 * GIB}\n`,
      current: `${5 * GIB}\n`,
      stat: `anon ${3 * GIB}\nactive_file 0\ninactive_file ${2 * GIB}\n`,
    };
    expect(availableMemory(meminfo, [unlimited, limited])).toBe(3 * GIB);
    expect(availableMemory(meminfo, [{ max: null, current: null, stat: null }])).toBe(8 * GIB);
    expect(availableMemory(null, [limited])).toBeNull();
    expect(availableMemory("MemFree: 1 kB\n", [])).toBeNull();
  });
});
