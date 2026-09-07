// Runs inside the selected PR artifact; credentials never leave its /data boundary.
export {};
// The module belongs to the selected PR artifact, not the stable tooling checkout.
const {
  ActionOutcomeSchema,
  MachinesResponseSchema,
  MachineDrainStatusSchema,
  TerminalsResponseSchema,
} = await import(Bun.resolveSync("@manifold/protocol", "/app/packages/server"));
const mode = process.argv[2];
if (mode !== "retire" && mode !== "resume") throw new Error("expected retire or resume");
const owner = (await Bun.file("/data/owner.key").text()).trim();
async function action(name: string, args: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:7777/api/actions/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`preview: ${name} returned HTTP ${response.status}`);
  const result = ActionOutcomeSchema.parse(await response.json());
  if (!result.ok) throw new Error(`preview: ${name} refused terminal lifecycle transition`);
  return result.result;
}
const machines = MachinesResponseSchema.parse(await action("core.machines.list", {})).machines;
const machine = machines.find(
  (row: { name: string }) => row.name === process.env.MANIFOLD_MACHINE_NAME,
);
if (machine) {
  if (mode === "retire") {
    const drained = MachineDrainStatusSchema.parse(
      await action("core.machines.drain", { machineId: machine.id, draining: true }),
    );
    for (const terminalId of drained.terminalIds) {
      try {
        await action("core.terminals.kill", { terminalId });
      } catch (error) {
        const current = TerminalsResponseSchema.parse(await action("core.terminals.listAll", {}));
        if (current.terminals.some((terminal: { id: string }) => terminal.id === terminalId))
          throw error;
      }
    }
    const deadline = Date.now() + 10_000;
    while (true) {
      const status = MachineDrainStatusSchema.parse(
        await action("core.machines.drain", { machineId: machine.id, draining: true }),
      );
      if (status.terminalIds.length === 0) break;
      if (Date.now() >= deadline)
        throw new Error("preview: terminal owner did not finish retiring its PTYs");
      await Bun.sleep(200);
    }
    console.log(`preview: retired ${drained.terminalIds.length} terminal(s) on ${machine.name}`);
  } else {
    const deadline = Date.now() + 30_000;
    let online = machine.online;
    while (!online && Date.now() < deadline) {
      await Bun.sleep(200);
      online = MachinesResponseSchema.parse(await action("core.machines.list", {})).machines.some(
        (row: { id: string; online: boolean }) => row.id === machine.id && row.online,
      );
    }
    if (!online) throw new Error("preview: replacement terminal owner did not connect");
    await action("core.machines.drain", { machineId: machine.id, draining: false });
  }
}
