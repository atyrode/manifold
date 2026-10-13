/*
  THE CHILD SIDE OF THE ISOLATE PROTOCOL, BY HAND — no kit, so the supervisor is proved
  against the wire (`IsolateHostFrameSchema` / `IsolateChildFrameSchema`) rather than against
  another package's reading of it. One plugin, `test.guest`, with the doors the supervisor
  tests need: `echo` (an atomic storage increment through `call`, then the args back with one
  emission), `boom` (dies mid-dispatch), `hang` (never answers), `garble` (answers with a
  frame that is not a frame), `refuse` (a handler's own domain refusal), and `fenced` /
  `fencedEmit` (an effect, an authority question the test answers by changing authority, then
  another effect or an emission). `onEnable` reads storage through its hook id and answers ok.
 */
import { connect } from "node:net";
import { access, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

async function barrier(dir) {
  await writeFile(`${dir}/entered`, "");
  for (;;) {
    try {
      await access(`${dir}/release`);
      return;
    } catch {
      await setTimeout(5);
    }
  }
}

const protocol = connect({ fd: 3 });

function send(frame) {
  protocol.write(`${JSON.stringify(frame)}\n`);
}

function onFrame(receive) {
  let carry = "";
  protocol.setEncoding("utf8");
  protocol.on("data", (chunk) => {
    carry += chunk;
    let newline = carry.indexOf("\n");
    while (newline !== -1) {
      const envelope = JSON.parse(carry.slice(0, newline));
      send({ t: "received", receipt: envelope.receipt });
      receive(envelope.frame);
      carry = carry.slice(newline + 1);
      newline = carry.indexOf("\n");
    }
  });
}

let calls = 0;
let hardenedContract = 1;
const waiting = new Map();
const admissions = new Map();

function call(requestId, method, args) {
  calls += 1;
  const id = `${requestId}:${String(calls)}`;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    send({ t: "call", id, method, args });
  });
}

const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const action = (name, input = schema) => ({
  name: `test.guest.${name}`,
  title: name,
  caps: name === "inventory" ? ["containers:read"] : [],
  scope: "workspace",
  input,
  result: { type: "object" },
});

const handlers = {
  async echo(id, args) {
    let count;
    for (;;) {
      const seen = await call(id, "storage.get", ["count"]);
      count = seen === null ? 1 : Number(seen) + 1;
      if (await call(id, "storage.compareAndSet", ["count", seen, String(count)])) break;
    }
    const emits = [
      { ref: { kind: "plugin", pluginId: "test.guest" }, kind: "echoed", payload: { count } },
    ];
    return { ok: true, result: { text: args.text, count }, emits };
  },
  identify(_id, _args, ctx) {
    return {
      ok: true,
      result: {
        present: Object.hasOwn(ctx, "callerPlugin"),
        callerPlugin: ctx.callerPlugin ?? null,
      },
      emits: [],
    };
  },
  async inventory(id, args) {
    const nested = args.text.startsWith("list:");
    let inventory;
    if (nested) {
      inventory = await call(id, "actions.call", [
        { plugin: args.text.slice("list:".length), action: "list", input: {} },
      ]);
    } else {
      const answer = await call(id, "machines.inventory", []);
      if (!answer.ok) return { ok: false, rule: "refused", message: answer.message };
      inventory = answer.value;
    }
    // Frozen contract-9 strict inventory and machine-list row vocabularies. A newer field
    // is a real guest failure; contract 10's reader knows the one addition.
    const keys = [
      "id",
      "name",
      "online",
      "revoked",
      "draining",
      "terminalExecution",
      "lastRefusal",
    ];
    if (nested) keys.push("color");
    if (hardenedContract >= 10) keys.push("physicalCoreCount");
    for (const machine of inventory.machines) {
      if (Object.keys(machine).some((key) => !keys.includes(key))) {
        return { ok: false, rule: "refused", message: "unknown inventory field" };
      }
    }
    return { ok: true, result: inventory, emits: [] };
  },
  boom() {
    process.exit(1);
  },
  hang() {
    return new Promise(() => {});
  },
  garble(id) {
    send({ t: "dispatched", id, outcome: { ok: "yes" } });
    return null;
  },
  oversize() {
    return { ok: true, result: { value: "x".repeat(9 * 1024 * 1024) }, emits: [] };
  },
  backpressure(id) {
    protocol.removeAllListeners("data");
    protocol.pause();
    for (let index = 0; index < 256; index += 1) void call(id, "storage.get", ["bulk"]);
    globalThis.setInterval(() => {}, 1_000);
    return new Promise(() => {});
  },
  refuse() {
    return { ok: false, rule: "refused", message: "not today" };
  },
  async slice(id) {
    try {
      return { ok: true, result: await call(id, "newId", []), emits: [] };
    } catch (error) {
      return { ok: false, rule: "refused", message: error };
    }
  },
  async fenced(id, args) {
    await call(id, "storage.set", [`${args.text}:first`, "committed"]);
    await call(id, "auth.allows", ["scenes:write"]);
    try {
      await call(id, "storage.set", [`${args.text}:second`, "committed"]);
    } catch (error) {
      return { ok: false, rule: "refused", message: error };
    }
    return { ok: true, result: { second: true }, emits: [] };
  },
  async fencedEmit(id) {
    await call(id, "auth.allows", ["scenes:write"]);
    const emits = [
      { ref: { kind: "plugin", pluginId: "test.guest" }, kind: "echoed", payload: { count: 0 } },
    ];
    return { ok: true, result: {}, emits };
  },
};

onFrame(async (frame) => {
  switch (frame.t) {
    case "load":
      hardenedContract = frame.hardenedContract ?? 1;
      send({
        t: "loaded",
        actions: Object.keys(handlers)
          .filter((name) => name !== "inventory" || hardenedContract >= 9)
          .map((name) => action(name)),
        hooks: {
          onEnable: true,
          onDisable: false,
          onAssemblyChanged: false,
          onJobSettled: true,
        },
        ...(frame.hardenedContract >= 7 && frame.manifest.contributes.harness !== undefined
          ? { harness: frame.manifest.contributes.harness }
          : {}),
        // Harness id `eager` announces model resolution at any contract, `silent` never does;
        // every other harness follows the kit and announces only at contract 13 or later.
        ...(frame.manifest.contributes.harness !== undefined &&
        frame.manifest.contributes.harness.id !== "silent" &&
        (frame.hardenedContract >= 13 || frame.manifest.contributes.harness.id === "eager")
          ? { harnessResolvesModel: true }
          : {}),
      });
      return;
    case "dispatch": {
      if (!Object.hasOwn(frame.ctx, "traceId")) return;
      if (
        frame.action === "echo" &&
        (typeof frame.args !== "object" ||
          frame.args === null ||
          typeof frame.args.text !== "string")
      ) {
        send({
          t: "dispatched",
          id: frame.id,
          outcome: { ok: false, rule: "invalid_args", message: "text must be a string" },
        });
        return;
      }
      const admission = new Promise((resolve) => admissions.set(frame.id, resolve));
      send({ t: "prepared", id: frame.id, targets: [] });
      if (!(await admission)) return;
      const outcome = await handlers[frame.action](frame.id, frame.args, frame.ctx);
      if (outcome !== null) send({ t: "dispatched", id: frame.id, outcome });
      return;
    }
    case "harness": {
      const request = frame.request;
      const mode =
        request.method === "validateProfile" ? request.profile : request.target?.machineId;
      if (typeof mode === "string" && mode.startsWith("barrier:"))
        await barrier(mode.slice("barrier:".length));
      if (mode !== null && typeof mode === "object") {
        if (mode.barrier !== undefined) await barrier(mode.barrier);
        if (mode.disconnect) process.exit(1);
        for (const id of mode.rawIds ?? []) {
          for (const [method, args] of [
            ["storage.set", ["profile-leak", "bad"]],
            ["actions.call", [{ plugin: "test.guest", action: "echo", input: {} }]],
            ["streams.publish", ["p1", "bad"]],
            ["jobs.unfollow", ["j1"]],
          ]) {
            try {
              await call(id, method, args);
            } catch {
              // A hostile validator catches denials and still claims success.
            }
          }
        }
      }
      if (typeof mode === "string" && mode.startsWith("queue-and-answer:")) {
        void call(frame.id, "storage.set", ["queued", "value"]).catch(() => {});
        await barrier(mode.slice("queue-and-answer:".length));
        send({ t: "harnessed", id: frame.id, outcome: { ok: true, result: [], emits: [] } });
        return;
      }
      if (mode === "producer") {
        await call(frame.id, "streams.open", [
          "test.guest.stream",
          { kind: "plugin", pluginId: "test.guest" },
        ]);
        send({ t: "harnessed", id: frame.id, outcome: { ok: true, result: [], emits: [] } });
        return;
      }
      if (mode === "hang") return;
      if (mode === "boom") process.exit(1);
      if (mode === "wrong-kind") {
        send({ t: "hooked", id: frame.id, ok: true });
        return;
      }
      if (mode === "wrong-id") {
        send({
          t: "harnessed",
          id: "not-the-request",
          outcome: { ok: true, result: null, emits: [] },
        });
        return;
      }
      if (mode === "side-effect") {
        try {
          await call(frame.id, "storage.set", ["profile-leak", "bad"]);
        } catch {
          // Model a guest swallowing the refusal and claiming validation succeeded.
        }
      }
      if (mode === "emit") {
        send({
          t: "harnessed",
          id: frame.id,
          outcome: {
            ok: true,
            result: null,
            emits: [
              { ref: { kind: "plugin", pluginId: "test.guest" }, kind: "echoed", payload: {} },
            ],
          },
        });
        return;
      }
      if (mode === "invalid-result") {
        send({ t: "harnessed", id: frame.id, outcome: { ok: true, result: "invalid", emits: [] } });
        return;
      }
      let result = null;
      const emits = [];
      if (request.method === "sessions") {
        const permitted = await call(frame.id, "auth.allows", ["scenes:write"]);
        await call(frame.id, "storage.set", ["harness-caller", frame.ctx.principal.id]);
        result = permitted
          ? [{ harness: "test", machineId: request.target.machineId, sessionId: "s1" }]
          : [];
        emits.push({
          ref: { kind: "plugin", pluginId: "test.guest" },
          kind: "echoed",
          payload: { caller: frame.ctx.principal.id },
        });
      } else if (request.method === "resolveSession") result = request.ref;
      else if (request.method === "resolveModel") {
        // Serves every model but "unserved"; "emit" stages an event a resolver must not.
        result = request.model.model === "unserved" ? null : request.model;
        if (request.model.model === "emit")
          emits.push({
            ref: { kind: "plugin", pluginId: "test.guest" },
            kind: "echoed",
            payload: {},
          });
      }
      send({ t: "harnessed", id: frame.id, outcome: { ok: true, result, emits } });
      return;
    }
    case "admitted":
      admissions.get(frame.id)?.(frame.allowed);
      admissions.delete(frame.id);
      return;
    case "hook": {
      const keys = ["t", "id", "hook", "delta", "job", "jobs"];
      if (hardenedContract >= 11) keys.push("metadata");
      if (Object.keys(frame).some((key) => !keys.includes(key))) {
        send({
          t: "hooked",
          id: frame.id,
          ok: false,
          error: "strict legacy hook rejected a new field",
        });
        return;
      }
      if (await call(frame.id, "storage.get", ["metadataProbe"])) {
        const result = { announced: frame.metadata === true };
        for (const method of [
          "host.enabled",
          "services.listInstances",
          "services.invokeInstance",
          "machines.inventory",
          "machines.drain",
        ]) {
          try {
            await call(
              frame.id,
              method,
              method === "host.enabled"
                ? ["test.guest"]
                : method === "machines.inventory"
                  ? []
                  : [{}],
            );
            result[method] = "allowed";
          } catch (error) {
            result[method] = String(error);
          }
        }
        await call(frame.id, "storage.set", ["metadataProbeResult", JSON.stringify(result)]);
      }
      const marker = await call(frame.id, "storage.get", ["enabled"]);
      send({ t: "hooked", id: frame.id, ok: marker === null || marker === "yes" });
      return;
    }
    case "reply": {
      const pending = waiting.get(frame.id);
      waiting.delete(frame.id);
      if (frame.ok) pending.resolve(frame.result);
      else pending.reject(frame.error);
      return;
    }
    case "shutdown":
      process.exit(0);
  }
});
