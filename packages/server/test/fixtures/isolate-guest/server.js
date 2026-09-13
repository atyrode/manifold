/*
  THE CHILD SIDE OF THE ISOLATE PROTOCOL, BY HAND — no kit, so the supervisor is proved
  against the wire (`IsolateHostFrameSchema` / `IsolateChildFrameSchema`) rather than against
  another package's reading of it. One plugin, `test.guest`, with the doors the supervisor
  tests need: `echo` (an atomic storage increment through `call`, then the args back with one
  emission), `boom` (dies mid-dispatch), `hang` (never answers), `garble` (answers with a
  frame that is not a frame), `refuse` (a handler's own domain refusal). `onEnable` reads
  storage through its hook id and answers ok.
 */
import { connect } from "node:net";

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
  caps: [],
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
};

onFrame(async (frame) => {
  switch (frame.t) {
    case "load":
      send({
        t: "loaded",
        actions: Object.keys(handlers).map((name) => action(name)),
        hooks: {
          onEnable: true,
          onDisable: false,
          onAssemblyChanged: false,
          onJobSettled: false,
        },
      });
      return;
    case "dispatch": {
      if (
        frame.action === "echo" &&
        (typeof frame.args !== "object" || frame.args === null || typeof frame.args.text !== "string")
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
      const outcome = await handlers[frame.action](frame.id, frame.args);
      if (outcome !== null) send({ t: "dispatched", id: frame.id, outcome });
      return;
    }
    case "admitted":
      admissions.get(frame.id)?.(frame.allowed);
      admissions.delete(frame.id);
      return;
    case "hook": {
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
