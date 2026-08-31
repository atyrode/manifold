import { describe, expect, test } from "bun:test";
import {
  assertStorageKey,
  assertStorageValue,
  compareDataVersion,
  formatDataVersion,
  parseDataVersion,
  planDataMigration,
  runHook,
  type PluginMigration,
} from "../src/index.ts";

/**
 * THE DATA CONTRACT, as a pure function.
 *
 * `planDataMigration` is the whole Home-Assistant asymmetry in one place: minor differences
 * pass both ways, a major bump forward needs a declared migration chain, a major downgrade
 * refuses, and an unversioned plugin is never made to think about any of it. It is tested
 * here rather than only through the host because these are the verdicts that decide whether a
 * server boots at all, and every one of them has to be reachable without a database.
 */

function migration(name: string, major: number, minor = 0): PluginMigration {
  return { name, to: { major, minor }, migrate: () => undefined };
}

describe("planDataMigration", () => {
  test("an unversioned plugin is never judged", () => {
    // A plugin that keeps no durable data has no version to compare, and inventing one for it
    // would mean every plugin author has to learn this mechanism before writing a manifest.
    expect(
      planDataMigration({
        pluginId: "core.chrome",
        declared: undefined,
        stored: { major: 9, minor: 9 },
        applied: new Set(),
        migrations: [],
      }),
    ).toEqual({ kind: "ok", stamp: null });
  });

  test("a fresh store and an equal version both pass with nothing to run", () => {
    const fresh = planDataMigration({
      pluginId: "core.store",
      declared: { major: 2, minor: 1 },
      stored: null,
      applied: new Set(),
      migrations: [],
    });
    expect(fresh).toEqual({ kind: "ok", stamp: { major: 2, minor: 1 } });

    const equal = planDataMigration({
      pluginId: "core.store",
      declared: { major: 2, minor: 1 },
      stored: { major: 2, minor: 1 },
      applied: new Set(),
      migrations: [],
    });
    expect(equal).toEqual({ kind: "ok", stamp: { major: 2, minor: 1 } });
  });

  test("minor differences pass in BOTH directions, migration or not", () => {
    for (const stored of [
      { major: 2, minor: 0 },
      { major: 2, minor: 7 },
    ]) {
      // "Minor" MEANS the old code can still read the new data. Enforcing it again here would
      // only forbid rollbacks that are safe by construction — and a rollback nobody can
      // perform is an outage nobody can end.
      expect(
        planDataMigration({
          pluginId: "core.store",
          declared: { major: 2, minor: 3 },
          stored,
          applied: new Set(),
          migrations: [],
        }),
      ).toEqual({ kind: "ok", stamp: { major: 2, minor: 3 } });
    }
  });

  test("a major bump forward plans the unapplied chain, in version then name order", () => {
    const plan = planDataMigration({
      pluginId: "core.store",
      declared: { major: 3, minor: 0 },
      stored: { major: 1, minor: 4 },
      applied: new Set(["to-2-old"]),
      migrations: [
        migration("to-3", 3),
        migration("b-to-2", 2),
        migration("a-to-2", 2),
        migration("to-2-old", 2),
        migration("already-past", 1, 2),
      ],
    });

    // Applied names are skipped (the ledger is what makes a migration at-most-once), anything
    // at or below the stored version has nothing to do, and the surviving chain is ordered by
    // the version it reaches with the NAME as the tiebreak — so the sequence is reproducible
    // across processes rather than dependent on declaration order.
    expect(plan.kind).toBe("migrate");
    expect(plan.kind === "migrate" ? plan.run.map((step) => step.name) : []).toEqual([
      "a-to-2",
      "b-to-2",
      "to-3",
    ]);
    expect(plan.kind === "migrate" ? plan.stamp : null).toEqual({ major: 3, minor: 0 });
  });

  test("a major bump with no chain reaching the declared major refuses", () => {
    const plan = planDataMigration({
      pluginId: "core.store",
      declared: { major: 3, minor: 0 },
      stored: { major: 1, minor: 0 },
      // The chain stops one major short, which is the interesting case: SOME migration exists,
      // so a check that only asked "are there any?" would run it and then read data at major 2
      // with code that declares 3.
      applied: new Set(),
      migrations: [migration("to-2", 2)],
    });

    expect(plan).toEqual({
      kind: "refused",
      reason: "data_migration_missing",
      detail:
        'plugin "core.store" stored data at 1.0 and its code declares 3.0, but no unapplied migration reaches major 3',
    });
  });

  test("an already-applied chain that left the version behind refuses rather than re-running", () => {
    const plan = planDataMigration({
      pluginId: "core.store",
      declared: { major: 2, minor: 0 },
      stored: { major: 1, minor: 0 },
      applied: new Set(["to-2"]),
      migrations: [migration("to-2", 2)],
    });

    // The ledger says the transformation ran but the stamp says otherwise — an inconsistency
    // only a bug or a hand-edited database produces. Re-running a migration over data it has
    // already transformed is exactly the corruption the ledger exists to prevent, so the
    // engine refuses and says so instead of guessing which record to believe.
    expect(plan.kind).toBe("refused");
    expect(plan.kind === "refused" ? plan.reason : null).toBe("data_migration_missing");
  });

  test("a major downgrade refuses, because no migration runs backwards", () => {
    const plan = planDataMigration({
      pluginId: "core.store",
      declared: { major: 1, minor: 9 },
      stored: { major: 2, minor: 0 },
      applied: new Set(),
      migrations: [migration("to-2", 2)],
    });

    expect(plan).toEqual({
      kind: "refused",
      reason: "data_downgrade",
      detail:
        'plugin "core.store" stored data at 2.0 but its code declares 1.9: a major downgrade is refused, no migration runs backwards',
    });
  });
});

describe("data version encoding", () => {
  test("round-trips through the stamped form and orders major before minor", () => {
    expect(formatDataVersion({ major: 12, minor: 3 })).toBe("12.3");
    expect(parseDataVersion("12.3")).toEqual({ major: 12, minor: 3 });
    // A stamp that cannot be read is treated as no stamp by callers, so garbage must parse to
    // null rather than to a plausible-looking zero.
    for (const bad of ["", "1", "1.2.3", "v1.2", "-1.0", "1.x"]) {
      expect(parseDataVersion(bad)).toBeNull();
    }
    expect(compareDataVersion({ major: 1, minor: 9 }, { major: 2, minor: 0 })).toBeLessThan(0);
    expect(compareDataVersion({ major: 2, minor: 1 }, { major: 2, minor: 0 })).toBeGreaterThan(0);
    expect(compareDataVersion({ major: 2, minor: 0 }, { major: 2, minor: 0 })).toBe(0);
  });
});

describe("storage keys", () => {
  test("the engine's reserved prefix is unforgeable, and keys are bounded ASCII", () => {
    // A plugin able to write `$version` could claim its data was already migrated and be
    // believed; one able to write `$migration:x` could suppress a migration entirely.
    expect(() => assertStorageKey("$version")).toThrow(/reserved/);
    expect(() => assertStorageKey("$migration:to-2")).toThrow(/reserved/);

    for (const bad of ["", " leading", "with space", "curly{}", "a".repeat(129)]) {
      expect(() => assertStorageKey(bad)).toThrow(/not a valid key/);
    }
    for (const good of ["row", "element:abc-123", "views/tree.state", "a".repeat(128)]) {
      expect(() => assertStorageKey(good)).not.toThrow();
    }
  });

  test("a value is bounded, so a plugin cannot turn the workspace into its object store", () => {
    expect(() => assertStorageValue("row", "x".repeat(64 * 1024))).not.toThrow();
    expect(() => assertStorageValue("row", "x".repeat(64 * 1024 + 1))).toThrow(/over the/);
    // Measured in BYTES, not characters: a limit that counted UTF-16 units would let a
    // multibyte payload past it.
    expect(() => assertStorageValue("row", "é".repeat(33 * 1024))).toThrow(/over the/);
  });
});

describe("runHook", () => {
  test("a settled hook reports success, and a throwing one reports its message", async () => {
    expect(await runHook(() => undefined)).toEqual({ ok: true });
    expect(
      await runHook(() => {
        throw new Error("no");
      }),
    ).toEqual({ ok: false, reason: "no" });
    expect(await runHook(() => Promise.reject(new Error("later")))).toEqual({
      ok: false,
      reason: "later",
    });
    // A non-Error rejection still has to produce a reportable reason: a plugin throwing a
    // string must not turn into "undefined" in the logs.
    expect(await runHook(() => Promise.reject("plain"))).toEqual({ ok: false, reason: "plain" });
  });

  test("a hook that never settles resolves at the bound instead of hanging", async () => {
    // Never resolved on purpose: this is the case the bound exists for, and the reason a
    // lifecycle hook has no vote — enablement is workspace-global, so a hook able to stall a
    // transition could freeze every principal's composition.
    const stuck = Promise.withResolvers<void>();

    const outcome = await runHook(() => stuck.promise, 5);

    expect(outcome).toEqual({ ok: false, reason: "did not settle within 5ms" });
  });
});
