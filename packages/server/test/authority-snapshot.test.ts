import "../src/shared-modules.ts";
import { expect, test } from "bun:test";
import { formatManifoldUri, type AuthorityScope } from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import {
  captureAuthoritySnapshot,
  cloneAuthoritySnapshot,
  projectJobCredential,
  restoreAuthoritySnapshot,
} from "../src/authority-snapshot.ts";
import { openDatabase } from "../src/db.ts";
import { ServerStore } from "../src/stores.ts";
import { FakeRuntime } from "./helpers.ts";

function fixture() {
  const store = new ServerStore(openDatabase(":memory:"));
  const runtime = new FakeRuntime();
  const auth = new AuthService(store, "snapshot-owner", runtime);
  const owner = auth.authenticate("snapshot-owner");
  for (const id of ["approved", "other"])
    store.createContainer({ id, name: id, discipline: "composition", createdAt: runtime.now() });
  const machine = auth.enrollMachine("approved-account", owner).machine.id;
  const other = auth.enrollMachine("other-account", owner).machine.id;
  const containerNode = formatManifoldUri({ kind: "container", containerId: "approved" });
  const machineNode = formatManifoldUri({ kind: "machine", machineId: machine });
  const scope: AuthorityScope = [
    { target: containerNode, reach: "subtree", caps: ["containers:write"] },
    { target: machineNode, reach: "node", caps: ["machines:shell"] },
  ];
  const minted = auth.mintTokenV2(
    {
      principal: { name: "correlated-native-caller", kind: "human" },
      containerId: "approved",
      scope,
      expiresAt: runtime.now() + 60_000,
    },
    owner,
  );
  return {
    store,
    runtime,
    auth,
    owner,
    machine,
    other,
    containerNode,
    machineNode,
    caller: auth.authenticate(minted.token),
  };
}

test("hub snapshots preserve correlated C-plus-M authority while the native credential omits shell", () => {
  const f = fixture();
  try {
    const snapshot = captureAuthoritySnapshot(f.auth, f.caller);
    const durable = cloneAuthoritySnapshot(JSON.parse(JSON.stringify(snapshot)));
    const wire = projectJobCredential(snapshot.credential);
    expect(wire.caps).toEqual(["containers:write"]);
    expect(wire).not.toHaveProperty("authorityScope");
    expect(wire.containerScope).toBe("approved");
    const restored = restoreAuthoritySnapshot(f.auth, durable)!;
    expect(restored.containerScope).toBe("approved");
    expect(restored.authorityScope).toEqual(f.caller.authorityScope);
    expect(f.auth.allowsNode(restored, "containers:write", f.containerNode, "subtree")).toBe(true);
    expect(f.auth.allowsNode(restored, "machines:shell", f.machineNode)).toBe(true);
    expect(f.auth.allowsNode(restored, "containers:write", f.machineNode)).toBe(false);
    expect(f.auth.allowsNode(restored, "machines:shell", f.containerNode)).toBe(false);
    expect(
      f.auth.allowsNode(
        restored,
        "machines:shell",
        formatManifoldUri({ kind: "machine", machineId: f.other }),
      ),
    ).toBe(false);
  } finally {
    f.store.close();
  }
});

test("a persisted action demand rechecks exact node, subtree reach and live denies", () => {
  const f = fixture();
  try {
    const snapshot = captureAuthoritySnapshot(f.auth, f.caller, {
      action: {
        contextScope: "approved",
        requirements: [
          { cap: "containers:write", node: f.containerNode, reach: "subtree" },
          { cap: "machines:shell", node: f.machineNode, reach: "node" },
        ],
      },
    });
    expect(restoreAuthoritySnapshot(f.auth, snapshot)).not.toBeNull();
    const subtreeMachine = cloneAuthoritySnapshot({
      ...snapshot,
      action: {
        ...snapshot.action!,
        requirements: [{ cap: "machines:shell", node: f.machineNode, reach: "subtree" }],
      },
    });
    expect(restoreAuthoritySnapshot(f.auth, subtreeMachine)).toBeNull();
    f.auth.grant(
      {
        principal: { kind: "principal", id: f.caller.principal.id },
        node: f.machineNode,
        reach: "node",
        caps: ["machines:shell"],
        effect: "deny",
      },
      f.owner,
    );
    expect(restoreAuthoritySnapshot(f.auth, snapshot)).toBeNull();
  } finally {
    f.store.close();
  }
});

test("a fingerprint-bound continuation refuses unavailable installation binding and expires faithfully", () => {
  const f = fixture();
  try {
    const snapshot = captureAuthoritySnapshot(f.auth, f.caller, {
      action: {
        contextScope: "approved",
        fingerprint: "installed-action",
        requirements: [{ cap: "machines:shell", node: f.machineNode, reach: "node" }],
      },
    });
    expect(restoreAuthoritySnapshot(f.auth, snapshot)).toBeNull();
    let installed = true;
    const current = () => installed;
    expect(restoreAuthoritySnapshot(f.auth, snapshot, current)).not.toBeNull();
    installed = false;
    expect(restoreAuthoritySnapshot(f.auth, snapshot, current)).toBeNull();
    installed = true;
    f.runtime.time = snapshot.credential.expiresAt! + 1;
    expect(restoreAuthoritySnapshot(f.auth, snapshot, current)).toBeNull();
  } finally {
    f.store.close();
  }
});

test("explicit empty scoped authority cannot regain permissions from its coarse native summary", () => {
  const f = fixture();
  try {
    const empty = captureAuthoritySnapshot(f.auth, { ...f.caller, authorityScope: [] });
    const restored = restoreAuthoritySnapshot(f.auth, empty)!;
    expect(restored.authorityScope).toEqual([]);
    expect(f.auth.allowsNode(restored, "machines:shell", f.machineNode)).toBe(false);
    expect(f.auth.allowsNode(restored, "containers:write", f.containerNode)).toBe(false);
  } finally {
    f.store.close();
  }
});

test("action evidence uses the original credential without widening the native effect credential", () => {
  const f = fixture();
  try {
    const native = { ...f.caller, caps: ["containers:write" as const] };
    const snapshot = captureAuthoritySnapshot(f.auth, native, {
      actionCredential: f.auth.credentialReference(f.caller),
      action: {
        contextScope: "approved",
        requirements: [{ cap: "machines:shell", node: f.machineNode, reach: "node" }],
      },
    });
    const restored = restoreAuthoritySnapshot(f.auth, cloneAuthoritySnapshot(snapshot))!;
    expect(restored.caps).toEqual(["containers:write"]);
    expect(f.auth.allowsNode(restored, "machines:shell", f.machineNode)).toBe(false);
    f.auth.grant(
      {
        principal: { kind: "principal", id: f.caller.principal.id },
        node: f.machineNode,
        reach: "node",
        caps: ["machines:shell"],
        effect: "deny",
      },
      f.owner,
    );
    expect(restoreAuthoritySnapshot(f.auth, snapshot)).toBeNull();
  } finally {
    f.store.close();
  }
});
