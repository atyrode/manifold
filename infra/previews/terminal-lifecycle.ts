// Runs inside the selected PR artifact; credentials never leave its /data boundary.
export {};
// The module belongs to the selected PR artifact, not the stable tooling checkout.
const {
  ActionOutcomeSchema,
  ContainerResponseSchema,
  MachineDrainStatusSchema,
  MachinesResponseSchema,
} = await import(Bun.resolveSync("@manifold/protocol", "/app/packages/server"));
const { SessionClient, base64ToText } = await import(
  Bun.resolveSync("@manifold/sdk", "/app/packages/server")
);
const mode = process.argv[2];
if (mode !== "prepare" && mode !== "verify" && mode !== "reopen")
  throw new Error("expected prepare, verify or reopen");
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
  if (!result.ok) throw new Error(`preview: ${name} refused: ${result.denial.message}`);
  return result.result;
}
async function machines() {
  return MachinesResponseSchema.parse(await action("core.machines.list", {})).machines;
}
async function drainMachine(machineId: string, draining: boolean) {
  return MachineDrainStatusSchema.parse(
    await action("core.machines.drain", { machineId, draining }),
  );
}
const machineName = process.env.MANIFOLD_MACHINE_NAME;
if (machineName === undefined || machineName.length === 0)
  throw new Error("preview: MANIFOLD_MACHINE_NAME is required");

if (mode === "prepare" || mode === "reopen") {
  const machine = (await machines()).find((row: { name: string }) => row.name === machineName);
  if (machine === undefined)
    throw new Error(`HOLD: preview node ${machineName} is absent; refusing replacement`);
  if (mode === "reopen") {
    await drainMachine(machine.id, false);
    console.log(`preview: reopened terminal admission on ${machine.name}`);
  } else {
    let drained: Awaited<ReturnType<typeof drainMachine>>;
    try {
      drained = await drainMachine(machine.id, true);
    } catch (error) {
      try {
        await drainMachine(machine.id, false);
      } catch {
        // Cancellation still reopens the hub latch even if the owner cannot acknowledge it.
      }
      throw error;
    }
    if (drained.terminalIds.length !== 0) {
      await drainMachine(machine.id, false);
      throw new Error(
        `HOLD: preview node ${machine.name} retains ${drained.terminalIds.length} terminal(s); close or migrate them before changing this preview`,
      );
    }
    console.log(`preview: ${machine.name} is drained and empty for replacement`);
  }
} else {
  const deadline = Date.now() + 30_000;
  let machine: Awaited<ReturnType<typeof machines>>[number] | undefined;
  while (Date.now() < deadline) {
    machine = (await machines()).find((row: { name: string }) => row.name === machineName);
    if (machine?.online === true) break;
    await Bun.sleep(200);
  }
  if (machine?.online !== true) {
    const refusal =
      machine?.lastRefusal === undefined
        ? ""
        : `; last admission refusal ${machine.lastRefusal.code} at ${new Date(machine.lastRefusal.at).toISOString()}`;
    throw new Error(`preview: replacement node ${machineName} did not connect${refusal}`);
  }
  await action("core.machines.drain", { machineId: machine.id, draining: false });

  let canvasId: string | undefined;
  let terminalId: string | undefined;
  let canvas: InstanceType<typeof SessionClient> | undefined;
  let terminal: InstanceType<typeof SessionClient> | undefined;
  try {
    canvasId = ContainerResponseSchema.parse(
      await action("core.index.createContainer", {
        name: `preview-deployment-probe-${crypto.randomUUID()}`,
      }),
    ).container.id;
    canvas = new SessionClient({
      url: "ws://127.0.0.1:7777/ws/session",
      containerId: canvasId,
      token: owner,
    });
    await canvas.connect();
    const opened = await canvas.openTerminal({
      elementId: crypto.randomUUID(),
      machineId: machine.id,
      cols: 80,
      rows: 24,
    });
    terminalId = opened.id;
    terminal = new SessionClient({
      url: "ws://127.0.0.1:7777/ws/session",
      containerId: opened.containerId,
      token: owner,
    });
    let output = "";
    const observe = (message: { data: string }): void => {
      output = (output + base64ToText(message.data)).slice(-32_000);
    };
    terminal.on("terminal_output", observe);
    terminal.on("terminal_snapshot", observe);
    await terminal.connect();
    terminal.attachTerminal(opened.id);
    terminal.takeTerminal(opened.id);
    await Bun.sleep(300);
    const marker = `preview-terminal-${crypto.randomUUID()}`;
    terminal.sendTerminalInput(opened.id, `printf '%s\\n' '${marker}'\r`);
    const outputDeadline = Date.now() + 15_000;
    while (!output.includes(marker) && Date.now() < outputDeadline) await Bun.sleep(100);
    if (!output.includes(marker))
      throw new Error(`preview: ${machine.name} terminal did not return command output`);
    console.log(`preview: ${machine.name} admitted and passed disposable terminal I/O`);
  } finally {
    terminal?.close();
    canvas?.close();
    if (terminalId !== undefined) {
      try {
        await action("core.terminals.kill", { terminalId });
      } catch {
        // A clean shell exit can race cleanup; the disposable container deletion below is final.
      }
    }
    if (canvasId !== undefined) {
      try {
        await action("core.index.deleteContainer", { containerId: canvasId });
      } catch {
        // Preserve the primary verification failure; the real environment verifier checks cleanup.
      }
    }
  }
}
