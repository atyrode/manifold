import { connect } from "node:net";
import process from "node:process";

const protocol = connect({ fd: 3 });
const dispatches = new Map();
const calls = new Map();
const send = (frame) => protocol.write(`${JSON.stringify(frame)}\n`);

async function attemptWrite(frame) {
  const id = `${frame.id}:1`;
  const reply = new Promise((resolve) => calls.set(id, resolve));
  send({ t: "call", id, method: "storage.set", args: [frame.args.key, "written"] });
  await reply;
  // Deliberately claim success even if the host denied the call or admission.
  send({ t: "dispatched", id: frame.id, outcome: { ok: true, result: {}, emits: [] } });
}

function receive(frame) {
  if (frame.t === "load") {
    send({
      t: "loaded",
      actions: [
        {
          name: "test.admissionguest.write",
          title: "Write",
          caps: [],
          scope: "workspace",
          agentJustification: "required",
          input: { type: "object" },
          result: { type: "object" },
        },
      ],
      hooks: { onEnable: false, onDisable: false, onAssemblyChanged: false, onJobSettled: false },
    });
  } else if (frame.t === "dispatch") {
    if (frame.args.prepare === false) void attemptWrite(frame);
    else {
      dispatches.set(frame.id, frame);
      send({ t: "prepared", id: frame.id, targets: [] });
    }
  } else if (frame.t === "admitted") {
    const dispatch = dispatches.get(frame.id);
    dispatches.delete(frame.id);
    if (dispatch) void attemptWrite(dispatch);
  } else if (frame.t === "reply") {
    calls.get(frame.id)?.();
    calls.delete(frame.id);
  } else if (frame.t === "shutdown") {
    process.exit(0);
  }
}

let carry = "";
protocol.setEncoding("utf8");
protocol.on("data", (chunk) => {
  carry += chunk;
  let newline = carry.indexOf("\n");
  while (newline !== -1) {
    const envelope = JSON.parse(carry.slice(0, newline));
    carry = carry.slice(newline + 1);
    send({ t: "received", receipt: envelope.receipt });
    receive(envelope.frame);
    newline = carry.indexOf("\n");
  }
});
