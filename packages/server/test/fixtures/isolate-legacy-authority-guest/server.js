import { connect } from "node:net";
const protocol = connect({ fd: 3 });
const send = (frame) => protocol.write(`${JSON.stringify(frame)}\n`);
const waiting = new Map();
let count = 0;
const call = (id, method, args) => {
  const callId = `${id}:${++count}`;
  send({ t: "call", id: callId, method, args });
  return new Promise((resolve, reject) => waiting.set(callId, { resolve, reject }));
};
const legacyCaps = (caps) => {
  if (caps.includes("machines:shell"))
    throw new Error("strict legacy consumer rejected machines:shell");
};
async function receive(frame) {
  if (frame.t === "load") {
    send({
      t: "loaded",
      actions: [],
      hooks: { onEnable: false, onDisable: false, onAssemblyChanged: false, onJobSettled: false },
      harness: frame.manifest.contributes.harness,
    });
  } else if (frame.t === "harness") {
    try {
      legacyCaps(frame.ctx.caps);
      if (frame.request.method === "launch" || frame.request.method === "send") {
        const { run } = frame.request;
        legacyCaps(run.caps);
        legacyCaps(run.authorizationCredential.caps);
        if (
          Object.hasOwn(run, "authorityScope") ||
          Object.hasOwn(run.authorizationCredential, "authorityScope")
        )
          throw new Error("strict legacy Run rejected scoped fields");
        if (frame.request.method === "launch") {
          legacyCaps(frame.request.agent.grant.caps);
          if (Object.hasOwn(frame.request.agent.grant, "authorityScope"))
            throw new Error("strict legacy Agent rejected scoped fields");
        }
        await call(frame.id, "storage.set", ["legacy-received", JSON.stringify(frame.request)]);
      }
      send({
        t: "harnessed",
        id: frame.id,
        outcome: {
          ok: true,
          result:
            frame.request.method === "launch"
              ? {
                  runtime: frame.request.agent.context.runtime,
                  session: { harness: "legacy", machineId: "m1", sessionId: "s1" },
                  reviewDigest: "a".repeat(64),
                }
              : null,
          emits: [],
        },
      });
    } catch (error) {
      send({
        t: "harnessed",
        id: frame.id,
        outcome: { ok: false, rule: "refused", message: String(error) },
      });
    }
  } else if (frame.t === "reply") {
    const pending = waiting.get(frame.id);
    waiting.delete(frame.id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error));
  } else if (frame.t === "shutdown") globalThis.process.exit(0);
}
let carry = "";
protocol.setEncoding("utf8");
protocol.on("data", (chunk) => {
  carry += chunk;
  for (;;) {
    const newline = carry.indexOf("\n");
    if (newline < 0) return;
    const envelope = JSON.parse(carry.slice(0, newline));
    carry = carry.slice(newline + 1);
    send({ t: "received", receipt: envelope.receipt });
    void receive(envelope.frame);
  }
});
