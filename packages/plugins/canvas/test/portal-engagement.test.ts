import { expect, test } from "bun:test";
import {
  createPortalSocketSwitch,
  type EngageableSocket,
  type ChannelRole,
  type PortalSlot,
} from "../src/portal-engagement.ts";

interface FakeSocket extends EngageableSocket {
  readonly role: ChannelRole;
  readonly settle: () => void;
  readonly fail: (reason: Error) => void;
  closed: boolean;
}

function harness(): {
  readonly opened: FakeSocket[];
  readonly slots: (PortalSlot<FakeSocket> | null)[];
  readonly failures: { readonly role: ChannelRole; readonly reason: unknown }[];
  readonly painted: () => FakeSocket | null;
  readonly request: (role: ChannelRole) => void;
  readonly dispose: () => void;
} {
  const opened: FakeSocket[] = [];
  const slots: (PortalSlot<FakeSocket> | null)[] = [];
  const failures: { readonly role: ChannelRole; readonly reason: unknown }[] = [];
  const open = (role: ChannelRole): FakeSocket => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket: FakeSocket = {
      role,
      closed: false,
      connect: () => promise,
      close: () => {
        socket.closed = true;
      },
      settle: () => {
        resolve();
      },
      fail: (reason) => {
        reject(reason);
      },
    };
    opened.push(socket);
    return socket;
  };
  const { request, dispose } = createPortalSocketSwitch(
    open,
    (slot) => {
      slots.push(slot);
    },
    (role, reason) => {
      failures.push({ role, reason });
    },
  );
  return {
    opened,
    slots,
    failures,
    painted: () => slots.at(-1)?.client ?? null,
    request,
    dispose,
  };
}

/** Awaiting twice lets a `then` chained onto an already-settled promise run. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

test("paints nothing until the first socket's init lands", async () => {
  const h = harness();
  h.request("spectator");
  expect(h.opened).toHaveLength(1);
  expect(h.slots).toEqual([]);
  h.opened[0]?.settle();
  await flush();
  expect(h.slots.at(-1)?.role).toBe("spectator");
});

test("escalation keeps painting the spectator until the occupant is open", async () => {
  const h = harness();
  h.request("spectator");
  h.opened[0]?.settle();
  await flush();
  h.request("occupant");
  await flush();
  const spectator = h.opened[0];
  const occupant = h.opened[1];
  expect(occupant?.role).toBe("occupant");
  // Mid-swap: the portal still paints the spectator and nothing has been closed.
  expect(h.painted()).toBe(spectator ?? null);
  expect(spectator?.closed).toBe(false);
  occupant?.settle();
  await flush();
  expect(h.painted()).toBe(occupant ?? null);
  expect(spectator?.closed).toBe(true);
});

test("requesting the painted or in-flight discipline opens no second socket", async () => {
  const h = harness();
  h.request("spectator");
  h.request("spectator");
  h.opened[0]?.settle();
  await flush();
  h.request("spectator");
  expect(h.opened).toHaveLength(1);
});

test("a reversal mid-flight abandons the unseen socket and keeps the painted one", async () => {
  const h = harness();
  h.request("spectator");
  h.opened[0]?.settle();
  await flush();
  h.request("occupant");
  h.request("spectator");
  await flush();
  expect(h.opened).toHaveLength(2);
  expect(h.opened[1]?.closed).toBe(true);
  expect(h.painted()).toBe(h.opened[0] ?? null);
  // The abandoned socket resolving later must not promote it.
  h.opened[1]?.settle();
  await flush();
  expect(h.painted()).toBe(h.opened[0] ?? null);
});

test("a failed escalation closes its socket and leaves the painted one alone", async () => {
  const h = harness();
  h.request("spectator");
  h.opened[0]?.settle();
  await flush();
  h.request("occupant");
  h.opened[1]?.fail(new Error("refused"));
  await flush();
  expect(h.opened[1]?.closed).toBe(true);
  expect(h.painted()).toBe(h.opened[0] ?? null);
  // Reported, never swallowed: engaging is a direct user action, and a silent failure
  // leaves the viewer typing into a tile that refuses every key.
  expect(h.failures).toHaveLength(1);
  expect(h.failures[0]?.role).toBe("occupant");
  expect((h.failures[0]?.reason as Error).message).toBe("refused");
  // The failure is not sticky: engaging again opens a fresh socket.
  h.request("occupant");
  expect(h.opened).toHaveLength(3);
});

test("dispose closes both sockets, empties the slot, and ignores later requests", async () => {
  const h = harness();
  h.request("spectator");
  h.opened[0]?.settle();
  await flush();
  h.request("occupant");
  h.dispose();
  expect(h.opened.every((socket) => socket.closed)).toBe(true);
  expect(h.slots.at(-1)).toBeNull();
  h.request("occupant");
  expect(h.opened).toHaveLength(2);
});
