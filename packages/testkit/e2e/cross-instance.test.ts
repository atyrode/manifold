import { expect, test } from "bun:test";
import { ShareRecipientSchema, type Cap } from "@manifold/protocol";
import { ActionHttpError, discoverActions, invokeAction, type SessionClient } from "@manifold/sdk";
import {
  advanceServerTime,
  callAction,
  connect,
  createContainer,
  dialShare,
  enrollMachine,
  instanceOrigin,
  listShares,
  listShareRecipients,
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
 * This consumer walks host discovery and approval, refused guest identities and wider
 * requests, live narrowing/removal/reapproval, finite credential expiry, then per-share
 * revocation. No policy is administered behind the ordinary action door.
 */
test("host approval bounds each guest projection, and withdrawal, expiry and revocation enforce it", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  let pair: InstancePair | null = null;
  try {
    pair = await spawnInstancePair({ host: { controlledTime: true } });
    const { host, guest } = pair;
    servers.push(host, guest);
    expect(host.ownerKey).not.toBe(guest.ownerKey);
    const hostActions = await discoverActions({ origin: host.httpUrl, token: host.ownerKey });
    const recipientAction = async (
      name: "approveShareRecipient" | "removeShareRecipient",
      args: unknown,
    ) => {
      const action = hostActions.actions.find(
        (candidate) => candidate.name === `core.access.${name}`,
      );
      if (action === undefined) throw new Error(`host did not publish ${name}`);
      const invocation = await invokeAction(
        { origin: host.httpUrl, token: host.ownerKey },
        action.name,
        args,
      );
      if (!invocation.outcome.ok) throw new Error(invocation.outcome.denial.message);
      return ShareRecipientSchema.parse(invocation.outcome.result);
    };
    const approve = (shareId: string, guestPrincipalId: string, caps: readonly Cap[]) =>
      recipientAction("approveShareRecipient", { shareId, guestPrincipalId, caps });
    const refusedTicket = async (token: string, reason: "revoked" | "expired") => {
      try {
        await invokeAction({ origin: host.httpUrl, token }, "core.terminals.listByContainer", {});
        throw new Error(`a ${reason} ticket still authenticated at the action door`);
      } catch (error) {
        if (!(error instanceof ActionHttpError)) throw error;
        expect(error.status === 401 || error.status === 403).toBe(true);
      }
    };

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
    expect(grant.token).not.toBe(host.ownerKey);

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

    // Local containers:read only admits the door. It neither consents on the host's behalf
    // nor maps this guest's unrelated local capabilities onto the remote container.
    const visitor = await mintToken(guest, {
      principal: { kind: "human", name: "Guest Visitor", color: "#3355cc" },
      caps: ["containers:read"],
    });
    const unapproved = await callAction(guest, visitor.token, "core.access.openDial", {
      dialId: dial.id,
    });
    expect(unapproved.ok).toBe(false);
    if (!unapproved.ok) expect(unapproved.denial.message).toBe("recipient_unapproved");
    const pending = await listShareRecipients(host, grant.share.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.guestPrincipal.id).toBe(visitor.principal.id);
    expect(pending[0]?.origin).toBe(instanceOrigin(guest));
    expect(pending[0]?.requestedCaps).toEqual(grant.share.caps);
    expect(pending[0]?.caps).toEqual([]);
    expect(pending[0]?.approvedAt).toBeNull();
    expect((await listShares(host)).shares[0]?.tickets).toBe(0);

    const approved = await approve(grant.share.id, visitor.principal.id, [
      "containers:read",
      "scenes:write",
    ]);
    expect(approved.approvedBy).not.toBeNull();
    expect(approved.approvedAt).not.toBeNull();
    const ticket = await openDial(guest, visitor.token, dial.id);
    expect(ticket.origin).toBe(instanceOrigin(host));
    expect(ticket.ref).toEqual({ kind: "container", containerId: canvasContainer.id });
    expect(ticket.caps).toEqual(["containers:read", "scenes:write"]);
    expect(ticket.expiresAt).toBeGreaterThan(approved.approvedAt!);

    const deniedVisitor = await mintToken(guest, {
      principal: { kind: "human", name: "Unapproved Visitor", color: "#886633" },
      caps: ["containers:read", "scenes:write", "terminals:write"],
    });
    const denied = await callAction(guest, deniedVisitor.token, "core.access.openDial", {
      dialId: dial.id,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.denial.message).toBe("recipient_unapproved");
    const wider = await callAction(guest, visitor.token, "core.access.openDial", {
      dialId: dial.id,
      caps: grant.share.caps,
    });
    expect(wider.ok).toBe(false);
    if (!wider.ok) expect(wider.denial.message).toBe("recipient_caps_refused");
    expect(
      (await listShares(guest)).dials.find((candidate) => candidate.id === dial.id)?.status,
    ).toBe("live");
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
    await expect(openDial(guest, visitor.token, ptyDial.id)).rejects.toThrow(
      "recipient_unapproved",
    );
    await approve(ptyGrant.share.id, visitor.principal.id, ["containers:read", "terminals:write"]);
    const ptyTicket = await openDial(guest, visitor.token, ptyDial.id, ["containers:read"]);
    expect(ptyTicket.caps).toEqual(["containers:read"]);
    if (ptyTicket.ref.kind !== "container") throw new Error("ticket does not name a container");
    let remotePty = await connect(host, {
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
    // principal that acquired an origin field would break docs/CONTRACTS.md §Producer-neutral behavior's premise.
    const hostSelf = canvas.self;
    if (hostSelf === null) throw new Error("the host viewer has no self");
    expect(hostSelf.origin).toBeUndefined();

    // Each share counts the identities it let in, separately: two grants to one origin are
    // two relationships, and the host's own book says so.
    const withTickets = await listShares(host);
    expect(withTickets.shares).toHaveLength(2);
    for (const share of withTickets.shares) expect(share.tickets).toBe(1);

    // ---------------------------------------------------------------- 5. live recipient policy
    const narrowed = await approve(grant.share.id, visitor.principal.id, ["containers:read"]);
    await waitFor(() => !canvas.attendance.has(remoteSelf.id), 2_000, 20);
    await refusedTicket(ticket.token, "revoked");
    await expect(
      connect(host, {
        containerId: canvasContainer.id,
        token: ticket.token,
        reconnect: false,
      }),
    ).rejects.toBeInstanceOf(Error);
    const narrowTicket = await openDial(guest, visitor.token, dial.id);
    expect(narrowTicket.caps).toEqual(["containers:read"]);
    const narrowRemote = await connect(host, {
      containerId: canvasContainer.id,
      token: narrowTicket.token,
      reconnect: false,
    });
    clients.push(narrowRemote);
    if (narrowRemote.self === null) throw new Error("narrowed viewer has no self");
    const narrowSelf = narrowRemote.self;
    canvas.transact((tx) => tx.create(textElement("el-after-narrowing", "still readable")));
    await waitFor(() => narrowRemote.elements.has("el-after-narrowing"), 10_000, 20);
    expect(remotePty.self?.origin).toBe(instanceOrigin(guest));
    const independentAfterNarrowing = await remotePty.terminalsByContainer();
    expect(
      independentAfterNarrowing.find((candidate) => candidate.id === terminal.id)?.status,
    ).toBe("running");

    const removed = await recipientAction("removeShareRecipient", {
      shareId: grant.share.id,
      guestPrincipalId: visitor.principal.id,
    });
    expect(removed.removedAt).not.toBeNull();
    expect(removed.approvedAt).toBe(narrowed.approvedAt);
    expect(removed.approvedBy).toBe(narrowed.approvedBy);
    await waitFor(() => !canvas.attendance.has(narrowSelf.id), 2_000, 20);
    await refusedTicket(narrowTicket.token, "revoked");
    await expect(openDial(guest, visitor.token, dial.id)).rejects.toThrow("recipient_unapproved");
    await expect(
      connect(host, {
        containerId: canvasContainer.id,
        token: narrowTicket.token,
        reconnect: false,
      }),
    ).rejects.toBeInstanceOf(Error);

    const reapproved = await approve(grant.share.id, visitor.principal.id, [
      "containers:read",
      "scenes:write",
    ]);
    expect(reapproved.removedAt).toBeNull();
    const restoredTicket = await openDial(guest, visitor.token, dial.id);
    const restored = await connect(host, {
      containerId: canvasContainer.id,
      token: restoredTicket.token,
      reconnect: false,
    });
    clients.push(restored);
    restored.transact((tx) => tx.create(textElement("el-reapproved", "explicitly reapproved")));
    await waitFor(() => canvas.elements.has("el-reapproved"), 10_000, 20);
    await expect(openDial(guest, deniedVisitor.token, dial.id)).rejects.toThrow(
      "recipient_unapproved",
    );

    // ---------------------------------------------------------------- 6. finite expiry
    // Advance only the child's actual RuntimeDeps.now, not timers or auth callbacks. The
    // existing bearer/action and fresh session admission paths must enforce the exact bound.
    await advanceServerTime(host, restoredTicket.expiresAt - 1);
    const beforeExpiry = await restored.action("core.terminals.listByContainer", {});
    expect(beforeExpiry.ok).toBe(true);
    await advanceServerTime(host, restoredTicket.expiresAt);
    await refusedTicket(restoredTicket.token, "expired");
    await expect(
      connect(host, {
        containerId: canvasContainer.id,
        token: restoredTicket.token,
        reconnect: false,
      }),
    ).rejects.toBeInstanceOf(Error);
    const renewedTicket = await openDial(guest, visitor.token, dial.id);
    expect(renewedTicket.caps).toEqual(["containers:read", "scenes:write"]);
    expect(renewedTicket.expiresAt).toBeGreaterThan(restoredTicket.expiresAt);
    const renewed = await connect(host, {
      containerId: canvasContainer.id,
      token: renewedTicket.token,
      reconnect: false,
    });
    clients.push(renewed);
    if (renewed.self === null) throw new Error("renewed viewer has no self");
    const renewedSelf = renewed.self;
    await waitFor(() => canvas.attendance.has(renewedSelf.id), 10_000, 20);
    const renewedPtyTicket = await openDial(guest, visitor.token, ptyDial.id, ["containers:read"]);
    remotePty.close();
    remotePty = await connect(host, {
      containerId: terminal.containerId,
      token: renewedPtyTicket.token,
      reconnect: false,
    });
    clients.push(remotePty);
    await waitFor(() => remotePty.terminals.get(terminal.id)?.status === "running", 10_000, 20);

    // ---------------------------------------------------------------- 7. whole-share revocation
    const severedAt = Date.now();
    const severed = await revokeShare(host, grant.share.id);
    expect(severed).toBe(1);

    // "When an owner cuts the pipe, the projection dies everywhere" (A4). The observable is
    // the host's OWN roster losing the remote principal, because that is the fact a local
    // human would see — and it must happen through the ordinary revocation fence rather
    // than through anything cross-instance sharing added.
    await waitFor(() => !canvas.attendance.has(renewedSelf.id), 2_000, 20);
    expect(Date.now() - severedAt).toBeLessThan(2_000);
    await refusedTicket(renewedTicket.token, "revoked");
    await expect(
      connect(host, {
        containerId: canvasContainer.id,
        token: renewedTicket.token,
        reconnect: false,
      }),
    ).rejects.toBeInstanceOf(Error);

    // And it is PER SHARE. The PTY projection through the other grant is untouched, because
    // revoking cuts the identities one share minted and not every identity from that origin
    // — a blanket cut would make a share an all-or-nothing relationship with an instance
    // rather than a grant on a node.
    const independentAfterRevocation = await remotePty.terminalsByContainer();
    expect(
      independentAfterRevocation.find((candidate) => candidate.id === terminal.id)?.status,
    ).toBe("running");

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
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses(agents);
    if (pair !== null) await pair.stop();
  }
}, 90_000);
