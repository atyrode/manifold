import { expect, test } from "bun:test";
import { argumentDigest } from "@manifold/plugin-kit/server";
import {
  formatManifoldUri,
  projectNativePreparationDemand,
  type TerminalRuntime,
} from "@manifold/protocol";
import { AuthoritySnapshotSchema } from "../src/authority-snapshot.ts";
import { ActionAuthorityFence } from "../src/action-authority-fence.ts";
import type { MachineChannel } from "../src/terminal-broker.ts";
import {
  nativePreparationFixture,
  type NativePreparationPrivateState,
} from "./native-demand-preparation-fixture.ts";

function expectPrivateRefusal(
  fixture: NativePreparationPrivateState,
  effect: () => unknown,
  reason?: string,
): void {
  let failure: unknown;
  try {
    effect();
  } catch (error) {
    failure = error;
  }
  // Boolean assertions deliberately never render an opaque value or an unsafe error body.
  expect(failure instanceof Error).toBe(true);
  if (!(failure instanceof Error)) return;
  for (const opaque of [
    fixture.privateValue,
    fixture.privateSession,
    argumentDigest(fixture.terminalRuntime),
  ])
    expect(failure.message.includes(opaque)).toBe(false);
  if (reason !== undefined) expect(failure.message === reason).toBe(true);
}

test.each([false, true])(
  "a packed null-input native preparer synthesizes private runtime with real host admission (hardened: %s)",
  async (hardened) => {
    const f = await nativePreparationFixture(hardened);
    try {
      const before = f.effects();
      const review = await f.review();
      expect(review).toMatchObject({
        ok: true,
        result: {
          targets: [],
          additionalRequirements: [{ cap: "machines:run", node: f.operationNode, reach: "node" }],
        },
      });
      expect(f.effects()).toEqual(before);
      const { fence, traceId } = await f.capture();
      const snapshot = fence.snapshot();
      const [binding] = AuthoritySnapshotSchema.shape.native
        .unwrap()
        .array()
        .parse(snapshot.nativeDemand);
      expect(binding).toMatchObject({
        machineId: f.terminalRuntime.machineId,
        containerId: f.terminal.containerId,
        pluginId: f.terminalRuntime.pluginId,
        operationId: f.terminalRuntime.operationId,
        installationRevision: "one",
        artifactSha256: f.terminalRuntime.artifactSha256,
        runtimeDigest: argumentDigest(f.terminalRuntime),
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        terminalHostId: f.terminal.terminalHostId,
      });
      expect(JSON.stringify([review, f.traces()]).includes(argumentDigest(f.terminalRuntime))).toBe(
        false,
      );
      const publicEvidence = JSON.stringify([review, f.preparation, snapshot, f.traces()]);
      expect(publicEvidence.includes(f.privateValue)).toBe(false);
      expect(publicEvidence.includes(f.privateSession)).toBe(false);
      expect(publicEvidence.includes('"input":')).toBe(false);
      expect(publicEvidence.includes('"session":{')).toBe(false);
      const command = f.service.admitTerminal(
        f.root,
        f.terminalRuntime,
        f.terminalRuntime.machineId,
        f.terminal,
        traceId,
        undefined,
        fence,
      );
      expect(command.type).toBe("start");
      expect(command.request.input.value === f.privateValue).toBe(true);
      expect(command.request.terminal).toEqual(f.terminal);
      expect(f.service.jobs.get(command.request.jobId)?.state).toBe("start-committed");
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])(
  "opaque literal validation is deferred equally in both realms and refuses before native effects (hardened: %s)",
  async (hardened) => {
    const f = await nativePreparationFixture(hardened, true);
    try {
      expect(await f.review()).toMatchObject({ ok: true });
      const { fence, traceId } = await f.capture();
      const before = f.effects();
      expectPrivateRefusal(
        f,
        () =>
          f.service.admitTerminal(
            f.root,
            f.terminalRuntime,
            f.terminalRuntime.machineId,
            f.terminal,
            traceId,
            undefined,
            fence,
          ),
        "invalid_input",
      );
      expect(f.effects()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

test("full runtime substitutions after packed-child preparation refuse before reservation or command", async () => {
  const f = await nativePreparationFixture();
  try {
    const runtime = f.terminalRuntime;
    const changes: Partial<TerminalRuntime>[] = [
      { machineId: "another-machine" },
      { pluginId: "test.other-provider" },
      { operationId: `${runtime.pluginId}.other` },
      { installationRevision: "two" },
      { artifactSha256: "d".repeat(64) },
      { resourceBindingDigest: "e".repeat(64) },
      { input: { value: "substituted" } },
      { session: { ...runtime.session!, machineId: "another-machine" } },
      { session: { ...runtime.session!, sessionId: "substituted" } },
    ];
    for (const change of changes) {
      const { fence, traceId } = await f.capture();
      const before = f.effects();
      expectPrivateRefusal(f, () =>
        f.service.admitTerminal(
          f.root,
          { ...runtime, ...change },
          runtime.machineId,
          f.terminal,
          traceId,
          undefined,
          fence,
        ),
      );
      expect(f.effects()).toEqual(before);
    }
    for (const change of [{ containerId: "another-home" }, { terminalHostId: "another-host" }]) {
      const { fence, traceId } = await f.capture();
      const before = f.effects();
      expectPrivateRefusal(f, () =>
        f.service.admitTerminal(
          f.root,
          runtime,
          runtime.machineId,
          { ...f.terminal, ...change },
          traceId,
          undefined,
          fence,
        ),
      );
      expect(f.effects()).toEqual(before);
    }
  } finally {
    await f.close();
  }
});

test("a core terminal can rebind its current native demand to its broker-owned element home", async () => {
  const f = await nativePreparationFixture();
  let fence: ActionAuthorityFence | undefined;
  try {
    const terminalChannel: MachineChannel = {
      machineId: f.terminalRuntime.machineId,
      terminalHostId: f.terminal.terminalHostId,
      terminalExecution: "governed",
      send: () => true,
    };
    f.broker.setMachineOnline(terminalChannel);
    const sourceContainerId = "native-preparation-canvas";
    f.store.createContainer({
      id: sourceContainerId,
      name: "Native preparation canvas",
      discipline: "canvas",
      createdAt: 0,
    });
    let prepared: { fence: ActionAuthorityFence; traceId: number } | undefined;
    const outcome = await f.host.dispatch(
      f.root,
      "core.terminals.open",
      {
        containerId: sourceContainerId,
        elementId: "broker-owned-element",
        machineId: f.terminalRuntime.machineId,
        cols: 80,
        rows: 24,
        runtime: f.terminalRuntime,
      },
      null,
      {
        onPrepared: (_args, captured, traceId) => {
          prepared = { fence: captured, traceId };
        },
      },
    );
    if (!outcome.ok) throw new Error(outcome.denial.message);
    if (prepared === undefined)
      throw new Error("core terminal preparation did not reach native admission");
    ({ fence } = prepared);
    const homeId = "broker-owned-element-home";
    fence.extend(
      (
        [
          "containers:write",
          "containers:read",
          "scenes:write",
          "terminals:spawn",
          "terminals:write",
        ] as const
      ).map((cap) => ({
        cap,
        node: formatManifoldUri({ kind: "container", containerId: homeId }),
        reach: "node" as const,
      })),
    );
    fence.bind({ ...fence.snapshot(), machineId: f.terminalRuntime.machineId });
    const terminal = { ...f.terminal, containerId: homeId };
    const command = f.service.admitTerminal(
      f.root,
      f.terminalRuntime,
      f.terminalRuntime.machineId,
      terminal,
      prepared.traceId,
      undefined,
      fence,
    );
    expect(command.type).toBe("start");
    expect(command.request.terminal).toEqual(terminal);
    const [rebound] = AuthoritySnapshotSchema.shape.native
      .unwrap()
      .array()
      .parse(fence.snapshot().nativeDemand);
    expect(rebound?.containerId).toBe(homeId);
  } finally {
    fence?.close();
    await f.close();
  }
});

test("a child-supplied digest cannot bind valid runtime to different selector authority", async () => {
  const f = await nativePreparationFixture();
  try {
    const { traceId } = await f.capture();
    const runtime = f.terminalRuntime;
    // These are hostile wire claims: the real runtime digest with different valid selectors.
    // No fake host supplies authority; the normal JobService planner resolves each request.
    for (const destination of ["home", "operation"] as const) {
      const demand = projectNativePreparationDemand(runtime, argumentDigest(runtime));
      if (destination === "operation") demand.operationId = `${runtime.pluginId}.other`;
      const planned = f.service.prepareTerminalDemandBinding(
        demand,
        runtime.machineId,
        destination === "home" ? "another-home" : f.terminal.containerId,
      );
      const fence = new ActionAuthorityFence(f.auth, f.root, () => true, null);
      try {
        fence.admit(planned.requirements);
        fence.bind({ nativeDemand: [planned] });
        const before = f.effects();
        expectPrivateRefusal(
          f,
          () =>
            f.service.admitTerminal(
              f.root,
              runtime,
              runtime.machineId,
              f.terminal,
              traceId,
              undefined,
              fence,
            ),
          "terminal_runtime_destination_changed",
        );
        expect(f.effects()).toEqual(before);
      } finally {
        fence.close();
      }
    }
  } finally {
    await f.close();
  }
});

test.each(["owner", "host", "installation", "artifact", "resource"] as const)(
  "a live %s change invalidates the actual packed-child handoff before native effects",
  async (change) => {
    const f = await nativePreparationFixture(true, false, change === "resource");
    try {
      const { fence, traceId } = await f.capture();
      if (change === "installation" || change === "artifact") {
        f.service.install(f.root, {
          machineId: f.terminalRuntime.machineId,
          pluginId: f.terminalRuntime.pluginId,
          installationRevision: "two",
          artifactSha256:
            change === "artifact"
              ? f.machine.artifacts["linux-arm64"]!.sha256
              : f.terminalRuntime.artifactSha256,
          machine: f.machine,
        });
      } else if (change === "resource") {
        f.service.event(f.channel, {
          type: "resources",
          resources: { ...f.owner.resources!, tools: { node: "f".repeat(64) } },
        });
      } else {
        f.owner.generation += 1;
        if (change === "host") f.owner.terminalHostId = "replacement-host";
        f.prove();
      }
      const before = f.effects();
      expectPrivateRefusal(f, () =>
        f.service.admitTerminal(
          f.root,
          f.terminalRuntime,
          f.terminalRuntime.machineId,
          f.terminal,
          traceId,
          undefined,
          fence,
        ),
      );
      expect(f.effects()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);
