import { describe, expect, test } from "bun:test";
import { MAX_STORAGE_VALUE_BYTES, type EmitEvent } from "@manifold/plugin";
import type { MachineInventoryEntry } from "@manifold/protocol";
import {
  SetHostViewRequestSchema,
  type HostView,
  type HostViews,
} from "../src/host-views.ts";
import { machinesHandlers } from "../src/server.ts";

type MachinesCtx = Parameters<typeof machinesHandlers.setHostView>[0];

function host(index: number, members = [`machine-${index}`], label = "shell"): HostView {
  return {
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    name: "Host",
    members: members.map((machineId) => ({ machineId, accountLabel: label })),
  };
}

/** A stateful CAS seam, with the same exact-string comparison as public plugin storage. */
function fixture(initial?: HostViews | string) {
  let stored = initial === undefined ? null : typeof initial === "string" ? initial : JSON.stringify(initial);
  const inventory = new Map<string, MachineInventoryEntry>();
  const events: Parameters<EmitEvent>[] = [];
  const writes: { expected: string | null; value: string }[] = [];
  let inventoryReads = 0;
  const unexpected = () => {
    throw new Error("unexpected machine administration");
  };
  const ctx: MachinesCtx = {
    storage: {
      get: async (key) => {
        if (key !== "host-views") throw new Error(`unexpected key: ${key}`);
        return stored;
      },
      compareAndSet: async (key, expected, value) => {
        if (key !== "host-views") throw new Error(`unexpected key: ${key}`);
        writes.push({ expected, value });
        if (stored !== expected) return false;
        stored = value;
        return true;
      },
    },
    machines: {
      inventory: () => {
        inventoryReads += 1;
        return { ok: true, value: { machines: [...inventory.values()] } };
      },
      drain: unexpected,
    },
    identity: {
      enrollMachine: unexpected,
      rotateMachineToken: unexpected,
      revokeMachine: unexpected,
      forgetMachine: unexpected,
    },
    emit: (...args) => events.push(args),
  };
  return {
    ctx,
    events,
    writes,
    inventory,
    stored: () => stored,
    inventoryReads: () => inventoryReads,
    enroll(machineId: string, state: Partial<MachineInventoryEntry> = {}) {
      inventory.set(machineId, {
        id: machineId,
        name: machineId,
        online: false,
        revoked: false,
        draining: false,
        terminalExecution: null,
        lastRefusal: null,
        ...state,
      });
    },
  };
}

function set(ctx: MachinesCtx, expectedRevision: number, view: HostView) {
  return machinesHandlers.setHostView(
    ctx,
    SetHostViewRequestSchema.parse({ expectedRevision, host: view }),
  );
}

describe("host-view registry", () => {
  test("absent storage reads as revision zero without creating data", async () => {
    const fix = fixture();
    expect(await machinesHandlers.listHostViews(fix.ctx, {})).toEqual({ revision: 0, hosts: [] });
    expect(fix.stored()).toBeNull();
    expect(fix.writes).toEqual([]);
  });

  test("normalizes labels and checks stale revision before identical content or unavailable members", async () => {
    const fix = fixture();
    fix.enroll("machine-1");
    const view = host(1);
    expect(await set(fix.ctx, 0, { ...view, name: "  Host  ", members: [{ machineId: "machine-1", accountLabel: " shell " }] })).toEqual({ revision: 1, hosts: [view] });
    fix.inventory.clear();
    expect(await set(fix.ctx, 1, view)).toEqual({ revision: 1, hosts: [view] });
    expect(await set(fix.ctx, 0, view)).toEqual({ refused: "host_views_changed" });
    expect(await set(fix.ctx, 0, host(2, ["missing"]))).toEqual({ refused: "host_views_changed" });
    expect(fix.inventoryReads()).toBe(1);
    expect(fix.writes).toHaveLength(1);
    expect(fix.events).toEqual([[{ kind: "plugin", pluginId: "core.machines" }, "host_views_changed", { revision: 1 }]]);
  });

  test("concurrent registry edits have one CAS winner and cannot split global membership", async () => {
    const fix = fixture();
    fix.enroll("shared-account");
    const left = host(1, ["shared-account"]);
    const right = host(2, ["shared-account"]);
    const outcomes = await Promise.all([set(fix.ctx, 0, left), set(fix.ctx, 0, right)]);
    expect(outcomes).toEqual([{ revision: 1, hosts: [left] }, { refused: "host_views_changed" }]);
    expect(fix.writes.map((write) => write.expected)).toEqual([null, null]);
    expect(await set(fix.ctx, 1, right)).toEqual({ refused: "host_view_member_already_grouped" });
    expect(await machinesHandlers.listHostViews(fix.ctx, {})).toEqual({ revision: 1, hosts: [left] });
    expect(fix.events).toEqual([[{ kind: "plugin", pluginId: "core.machines" }, "host_views_changed", { revision: 1 }]]);
  });

  test("new and label-changed members resolve exact IDs, while unchanged forgotten members survive", async () => {
    const view = host(1, ["forgotten", "revoked"]);
    const fix = fixture({ revision: 7, hosts: [view] });
    fix.enroll("revoked", { revoked: true, draining: true });
    fix.enroll("replacement", { name: "forgotten" });
    expect(await set(fix.ctx, 7, host(2, ["unknown"]))).toEqual({ refused: "machine_unavailable" });
    expect(await set(fix.ctx, 7, { ...view, members: [{ machineId: "forgotten", accountLabel: "renamed" }] })).toEqual({ refused: "machine_unavailable" });
    const renamed = { ...view, name: "Renamed physical host" };
    expect(await set(fix.ctx, 7, renamed)).toEqual({ revision: 8, hosts: [renamed] });
    expect(await set(fix.ctx, 8, { ...renamed, members: [view.members[0]!, { machineId: "revoked", accountLabel: "governed" }] })).toEqual({ revision: 9, hosts: [{ ...renamed, members: [view.members[0]!, { machineId: "revoked", accountLabel: "governed" }] }] });
    expect(fix.inventory.has("replacement")).toBe(true);
    expect(fix.inventory.has("forgotten")).toBe(false);
  });

  test("removing metadata neither resolves nor administers endpoints and observes revision precedence", async () => {
    const view = host(1, ["forgotten"]);
    const fix = fixture({ revision: 2, hosts: [view] });
    expect(await machinesHandlers.removeHostView(fix.ctx, { expectedRevision: 1, hostId: view.id })).toEqual({ refused: "host_views_changed" });
    expect(await machinesHandlers.removeHostView(fix.ctx, { expectedRevision: 2, hostId: view.id })).toEqual({ revision: 3, hosts: [] });
    expect(await machinesHandlers.removeHostView(fix.ctx, { expectedRevision: 3, hostId: view.id })).toEqual({ revision: 3, hosts: [] });
    expect(await machinesHandlers.removeHostView(fix.ctx, { expectedRevision: 2, hostId: view.id })).toEqual({ refused: "host_views_changed" });
    expect(fix.inventoryReads()).toBe(0);
    expect(fix.writes).toHaveLength(1);
    expect(fix.events).toEqual([[{ kind: "plugin", pluginId: "core.machines" }, "host_views_changed", { revision: 3 }]]);
  });

  test("CAS compares the exact stored string, not a normalized reconstruction", async () => {
    const stored = JSON.stringify({ hosts: [host(1)], revision: 1 }, null, 2);
    const fix = fixture(stored);
    expect(await set(fix.ctx, 1, { ...host(1), name: "Updated" })).toEqual({ revision: 2, hosts: [{ ...host(1), name: "Updated" }] });
    expect(fix.writes[0]?.expected).toBe(stored);
  });

  test("UTF-8 capacity refuses multibyte metadata without a write or event", async () => {
    const label = "界".repeat(64);
    const views = Array.from({ length: 5 }, (_, index) => host(index, Array.from({ length: 64 }, (_, member) => `machine-${index}-${member}`), label));
    const initial = { revision: 4, hosts: views.slice(0, 4) };
    const candidate = { revision: 5, hosts: views };
    expect(new TextEncoder().encode(JSON.stringify(initial)).byteLength).toBeLessThan(MAX_STORAGE_VALUE_BYTES);
    expect(JSON.stringify(candidate).length).toBeLessThan(MAX_STORAGE_VALUE_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(candidate)).byteLength).toBeGreaterThan(MAX_STORAGE_VALUE_BYTES);
    const fix = fixture(initial);
    for (const member of views[4]!.members) fix.enroll(member.machineId);
    const stored = fix.stored();
    expect(await set(fix.ctx, 4, views[4]!)).toEqual({ refused: "host_view_capacity_exceeded" });
    expect(fix.stored()).toBe(stored);
    expect(fix.writes).toEqual([]);
    expect(fix.events).toEqual([]);
  });

  test("128 host limit permits an edit but refuses a new grouping", async () => {
    const hosts = Array.from({ length: 128 }, (_, index) => host(index));
    const fix = fixture({ revision: 128, hosts });
    expect(await set(fix.ctx, 128, host(128))).toEqual({ refused: "host_view_capacity_exceeded" });
    expect(fix.inventoryReads()).toBe(0);
    const edited = { ...hosts[0]!, name: "Edited" };
    expect(await set(fix.ctx, 128, edited)).toEqual({ revision: 129, hosts: [edited, ...hosts.slice(1)] });
  });
});
