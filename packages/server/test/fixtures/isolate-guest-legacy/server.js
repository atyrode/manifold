/* A real pre-ctxExtensions child: its strict dispatch ctx accepts only the legacy baseline. */
import { connect } from "node:net";

const protocol = connect({ fd: 3 });

function send(frame) {
  protocol.write(`${JSON.stringify(frame)}\n`);
}

let carry = "";
protocol.setEncoding("utf8");
protocol.on("data", (chunk) => {
  carry += chunk;
  let newline = carry.indexOf("\n");
  while (newline !== -1) {
    const envelope = JSON.parse(carry.slice(0, newline));
    send({ t: "received", receipt: envelope.receipt });
    const frame = envelope.frame;
    if (frame.t === "load") {
      send({
        t: "loaded",
        actions: [
          {
            name: "test.guest.compatible",
            title: "compatible",
            caps: [],
            scope: "workspace",
            input: { type: "object" },
            result: { type: "object" },
          },
        ],
        hooks: {
          onEnable: false,
          onDisable: false,
          onAssemblyChanged: false,
          onJobSettled: false,
        },
      });
    } else if (frame.t === "dispatch") {
      if (Object.hasOwn(frame.ctx, "traceId")) {
        // A pre-extension strict parser rejects this frame and therefore never dispatches it.
      } else {
        send({
          t: "dispatched",
          id: frame.id,
          outcome: { ok: true, result: { compatible: true }, emits: [] },
        });
      }
    } else if (frame.t === "shutdown") {
      process.exit(0);
    }
    carry = carry.slice(newline + 1);
    newline = carry.indexOf("\n");
  }
});
