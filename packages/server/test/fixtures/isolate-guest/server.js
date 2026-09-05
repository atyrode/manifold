/*
  THE CHILD SIDE OF THE ISOLATE PROTOCOL, BY HAND — no kit, so the supervisor is proved
  against the wire (`IsolateHostFrameSchema` / `IsolateChildFrameSchema`) rather than against
  another package's reading of it. One plugin, `test.guest`, with the doors the supervisor
  tests need: `echo` (one storage round trip through `call`, then the args back with one
  emission), `boom` (dies mid-dispatch), `hang` (never answers), `garble` (answers with a
  frame that is not a frame), `refuse` (a handler's own domain refusal). `onEnable` reads
  storage through its hook id and answers ok.
 */
let calls = 0;
const waiting = new Map();

function call(requestId, method, args) {
  calls += 1;
  const id = `${requestId}:${String(calls)}`;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    process.send({ t: "call", id, method, args });
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
    if (typeof args !== "object" || args === null || typeof args.text !== "string") {
      return { ok: false, rule: "invalid_args", message: "text must be a string" };
    }
    const seen = await call(id, "storage.get", ["count"]);
    const count = seen === null ? 1 : Number(seen) + 1;
    await call(id, "storage.set", ["count", String(count)]);
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
    process.send({ t: "dispatched", id, outcome: { ok: "yes" } });
    return null;
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

process.on("message", async (frame) => {
  switch (frame.t) {
    case "load":
      process.send({
        t: "loaded",
        actions: Object.keys(handlers).map((name) => action(name)),
        hooks: { onEnable: true, onDisable: false, onAssemblyChanged: false },
      });
      return;
    case "dispatch": {
      const outcome = await handlers[frame.action](frame.id, frame.args);
      if (outcome !== null) process.send({ t: "dispatched", id: frame.id, outcome });
      return;
    }
    case "hook": {
      const marker = await call(frame.id, "storage.get", ["enabled"]);
      process.send({ t: "hooked", id: frame.id, ok: marker === null || marker === "yes" });
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
