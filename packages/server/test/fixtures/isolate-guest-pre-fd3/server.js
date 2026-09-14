/* A real pre-#536 transport shape: the child waits for Bun IPC and never reads fd 3. */
process.on("message", (frame) => {
  if (frame?.t !== "load" || typeof process.send !== "function") return;
  process.send({
    t: "loaded",
    actions: [],
    hooks: { onEnable: false, onDisable: false, onAssemblyChanged: false },
  });
});

// Historical children waited on the IPC channel; keep that wait observable when no channel exists.
globalThis.setInterval(() => {}, 1_000);
