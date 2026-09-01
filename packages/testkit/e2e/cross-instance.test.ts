import { expect, test } from "bun:test";
import type { SessionClient } from "@manifold/sdk";
import {
  callAction,
  connect,
  createContainer,
  dialShare,
  enrollMachine,
  instanceOrigin,
  listShares,
  mintShare,
  mintToken,
  openDial,
  revokeShare,
  spawnInstancePair,
  startAgent,
  waitFor,
  type InstancePair,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import {
  captureTerminal,
  closeClients,
  e2eFailure,
  openTerminalAt,
  stopProcesses,
  textElement,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

/**
 * THE WAVE-3 CLAIM, end to end and across two real operating-system processes: that a share
 * is a reference and a pipe (A4), that the pipe is the one the engine already had, and that
 * cutting it kills the projection everywhere.
 *
 * Two processes is the whole point and it is why this suite cannot be a unit test. A single
 * server can be made to answer every question here and prove none of them: the interesting
 * failures are a guest that authenticates because it happens to share an owner key, a
 * "remote" principal that is really local, and a revocation that severs a socket the same
 * process happens to hold. `spawnInstancePair` gives the two instances DIFFERENT owner keys
 * for exactly that reason.
 *
 * What it asserts, in order:
 *   1. a share names a container and is addressed to a named guest origin;
 *   2. the guest's own door turns that instance-level grant into a per-principal ticket;
 *   3. the projection is an ORDINARY session on the host — same room, same Yjs document,
 *      same attendance roster, same PTY broker — so the scene converges both ways and a
 *      terminal inside it renders to the remote viewer;
 *   4. the remote principal carries its origin as data, visible to the host's local viewers;
 *   5. revoking severs the live projection in under two seconds, and the grant is dead on
 *      both ends afterwards.
 */
test("a share projects a host container into a guest instance, and revoking it severs the pipe", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  let pair: InstancePair | null = null;
  try {
    pair = await spawnInstancePair();
    const { host, guest } = pair;
    servers.push(host, guest);
    expect(host.ownerKey).not.toBe(guest.ownerKey);

    const enrolled = await enrollMachine(host, "share-agent");
    const agent = await startAgent({
      serverUrl: host.url,
      machineToken: enrolled.machineToken,
      name: "share-agent",
    });
    agents.push(agent);

    // The host's own workspace, with a real PTY in it. The shared node is the composition
    // the terminal was born into, because that is where a terminal actually lives and
    // "somebody else's terminal, live" is the hardest thing a projection has to carry.
    const canvasContainer = await createContainer(host, "host canvas");
    const owner = await mintToken(host, {
      principal: { kind: "human", name: "Host Owner", color: "#aa3344" },
      caps: ["containers:read", "scenes:write", "terminals:spawn", "terminals:write"],
    });
    const canvas = await connect(host, { containerId: canvasContainer.id, token: owner.token });
    clients.push(canvas);
    const { terminal, homeClient } = await openTerminalAt(canvas, host, {
      elementId: "el-shared-term",
      token: owner.token,
      portalAt: { x: 60, y: 40 },
    });
    clients.push(homeClient);

    /*
      ---------------------------------------------------------------- 1. minting shares

      TWO shares, to the same guest, because the wave's claim has two halves and they live in
      two nodes: the CANVAS carries the scene a viewer edits, and the COMPOSITION the
      terminal was born into carries the PTY. Sharing both is also the honest exercise of
      "one dial is one share" — a second grant to the same origin is a second dial, not a
      widening of the first — and it lets revocation prove it is per-share rather than a
      blanket cut of everything that origin holds.
    */
    const grant = await mintShare(host, guest, canvasContainer.id, [
      "containers:read",
      "scenes:write",
      "terminals:write",
    ]);
    expect(grant.share.ref).toEqual({ kind: "container", containerId: canvasContainer.id });
    expect(grant.share.origin).toBe(instanceOrigin(guest));
    expect(grant.share.revokedAt).toBeNull();
    expect(grant.share.tickets).toBe(0);
    expect(grant.token.length).toBeGreaterThan(0);

    // The record the host keeps carries no secret. This is the assertion that makes the
    // "hashed at rest" claim falsifiable rather than a comment in a migration.
    const hostInventory = await listShares(host);
    expect(hostInventory.shares).toHaveLength(1);
    expect(JSON.stringify(hostInventory.shares[0])).not.toContain(grant.token);

    // ---------------------------------------------------------------- 2. dialling and the ticket hop
    const dial = await dialShare(guest, host, grant.token);
    expect(dial.origin).toBe(instanceOrigin(host));
    expect(dial.ref).toEqual({ kind: "container", containerId: canvasContainer.id });
    expect(dial.status).toBe("live");
    // The host's welcome is what taught the guest the node's name, so a title the guest
    // never chose proves the handshake carried the host's own word rather than an echo.
    expect(dial.title).not.toBeNull();

    // A principal of the GUEST's, who has never heard of the host and holds none of its
    // authority. The guest's own door is what decides this principal may use the grant.
    const visitor = await mintToken(guest, {
      principal: { kind: "human", name: "Guest Visitor", color: "#3355cc" },
      caps: ["containers:read", "scenes:write", "terminals:write"],
    });
    const ticket = await openDial(guest, visitor.token, dial.id);
    expect(ticket.origin).toBe(instanceOrigin(host));
    expect(ticket.ref).toEqual({ kind: "container", containerId: canvasContainer.id });
    expect(ticket.caps).toEqual(["containers:read", "scenes:write", "terminals:write"]);
    // The share's own secret never leaves the guest instance; what a principal gets is a
    // ticket minted for it alone.
    expect(ticket.token).not.toBe(grant.token);

    // ---------------------------------------------------------------- 3. the projection
    /*
      THE WHOLE DESIGN, in one statement: the guest's lens points at the HOST's session
      endpoint with its ticket. No relay, no second sync path, no second renderer — the
      remote viewer is an ordinary participant in the host's room, which is why everything
      below is asserted with the same client surface a local viewer uses.
    */
    if (ticket.ref.kind !== "container") throw new Error("ticket does not name a container");
    const remote = await connect(host, {
      containerId: ticket.ref.containerId,
      token: ticket.token,
      reconnect: false,
    });
    clients.push(remote);
    if (remote.self === null) throw new Error("the remote viewer has no self");

    // Both ways, through the one Yjs document the host already owned.
    canvas.transact((tx) => {
      tx.create(textElement("el-from-host", "written on the host"));
    });
    await waitFor(() => remote.elements.get("el-from-host")?.id === "el-from-host", 10_000, 20);
    remote.transact((tx) => {
      tx.create(textElement("el-from-guest", "written from the guest instance"));
    });
    await waitFor(() => canvas.elements.get("el-from-guest")?.id === "el-from-guest", 10_000, 20);
    // The portal the host authored onto the terminal's home is in the remote's scene too: a
    // reference crosses the pipe as data, which is what makes the second share meaningful
    // rather than incidental.
    expect(remote.elements.get("el-shared-term")?.type).toBe("portal");

    /*
      THE SECOND SHARE, and the harder half: a live PTY. The terminal lives in a composition
      of its own, so projecting it is a second reference through a second pipe — and once
      through, it is the ordinary broker, the ordinary attach state machine and the ordinary
      snapshot-then-output contiguity a local tab gets.
    */
    const ptyGrant = await mintShare(host, guest, terminal.containerId, [
      "containers:read",
      "scenes:write",
      "terminals:spawn",
      "terminals:write",
    ]);
    const ptyDial = await dialShare(guest, host, ptyGrant.token);
    expect(ptyDial.id).not.toBe(dial.id);
    const ptyTicket = await openDial(guest, visitor.token, ptyDial.id);
    if (ptyTicket.ref.kind !== "container") throw new Error("ticket does not name a container");
    const remotePty = await connect(host, {
      containerId: ptyTicket.ref.containerId,
      token: ptyTicket.token,
      reconnect: false,
    });
    clients.push(remotePty);
    const capture = captureTerminal(remotePty, terminal.id);
    captures.push(capture);
    await waitFor(() => remotePty.terminals.get(terminal.id)?.status === "running", 10_000, 20);
    remotePty.attachTerminal(terminal.id);
    /*
      The HOST drives the PTY and the REMOTE has to see it. That direction is the claim:
      "renders" means the guest's viewer receives the same snapshot-then-output stream a
      local tab receives, through the same broker. Driving from the remote instead would be
      testing controller authority, which is the terminal suite's job and is unchanged by
      sharing — a ticket is an ordinary token, so it wins or loses the controller exactly as
      any other principal does.
    */
    homeClient.attachTerminal(terminal.id);
    homeClient.sendTerminalInput(terminal.id, "printf 'HELLO-FROM-THE-HOST\\n'\n");
    await waitForTerminalText(capture, "HELLO-FROM-THE-HOST");

    // ---------------------------------------------------------------- 4. origin as data
    /*
      The host's LOCAL viewer sees the visitor in the ordinary attendance roster, and the
      entry carries an origin. Nothing here is a cross-instance code path: attendance is the
      same map, painted by the same frames, and the origin is a field on a Principal —
      which is the whole of "a remote principal carries its origin as data".
    */
    const remoteSelf = remote.self;
    await waitFor(() => canvas.attendance.has(remoteSelf.id), 10_000, 20);
    const seen = canvas.attendance.get(remoteSelf.id);
    if (seen === undefined) throw new Error("the host never saw the remote principal");
    expect(seen.principal.origin).toBe(instanceOrigin(guest));
    expect(seen.principal.name).toBe("Guest Visitor");
    // The host's own viewer has NO origin: absence is how "local" is spelled, and a local
    // principal that acquired an origin field would break invariant 11's premise.
    const hostSelf = canvas.self;
    if (hostSelf === null) throw new Error("the host viewer has no self");
    expect(hostSelf.origin).toBeUndefined();

    // Each share counts the identities it let in, separately: two grants to one origin are
    // two relationships, and the host's own book says so.
    const withTickets = await listShares(host);
    expect(withTickets.shares).toHaveLength(2);
    for (const share of withTickets.shares) expect(share.tickets).toBe(1);

    // ---------------------------------------------------------------- 5. revocation severs
    const severedAt = Date.now();
    const severed = await revokeShare(host, grant.share.id);
    expect(severed).toBe(1);

    // "When an owner cuts the pipe, the projection dies everywhere" (A4). The observable is
    // the host's OWN roster losing the remote principal, because that is the fact a local
    // human would see — and it must happen through the ordinary revocation fence rather
    // than through anything cross-instance sharing added.
    await waitFor(() => !canvas.attendance.has(remoteSelf.id), 2_000, 20);
    expect(Date.now() - severedAt).toBeLessThan(2_000);

    // And it is PER SHARE. The PTY projection through the other grant is untouched, because
    // revoking cuts the identities one share minted and not every identity from that origin
    // — a blanket cut would make a share an all-or-nothing relationship with an instance
    // rather than a grant on a node.
    expect(remotePty.terminals.get(terminal.id)?.status).toBe("running");

    // The guest learns it was cut over the control link, without asking.
    await waitFor(
      async () => {
        const { dials } = await listShares(guest);
        return dials.find((candidate) => candidate.id === dial.id)?.status === "revoked";
      },
      5_000,
      50,
    );

    // Re-dialling is refused, and the refusal is the GUEST's own row: one dial is one share,
    // so a partnership that was cut is not silently re-established by asking again.
    await expect(dialShare(guest, host, grant.token)).rejects.toThrow(/revoked/);

    // And the HOST refuses a revoked secret it has never seen dialled, which is the half the
    // guest's own bookkeeping cannot prove: a second share, revoked before it is ever used.
    // Zero severed identities is a SUCCESS — nobody had come through it yet.
    const doomed = await mintShare(host, guest, terminal.containerId, ["containers:read"]);
    expect(await revokeShare(host, doomed.share.id)).toBe(0);
    await expect(dialShare(guest, host, doomed.token)).rejects.toThrow(/revoked/);

    // A share names a NODE, and this wave shares exactly one kind of node. The refusal is by
    // name rather than by schema rejection, so a caller learns what is shareable.
    const wrongNode = await callAction(host, host.ownerKey, "core.access.mintShare", {
      node: { kind: "terminal", terminalId: terminal.id },
      caps: ["containers:read"],
      origin: instanceOrigin(guest),
    });
    expect(wrongNode.ok).toBe(false);
    if (!wrongNode.ok) expect(wrongNode.denial.message).toBe("only a container can be shared");
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses(agents);
    if (pair !== null) await pair.stop();
  }
}, 90_000);
