import type { SessionHandle, SessionStatus } from "@manifold/plugin";
import type { RoomPipe, RoomPipeRegistration } from "@manifold/plugin/hooks";

/**
 * THE OCCUPANT PIPES THIS TAB HOLDS, by container (issue #196).
 *
 * The host's own session client is a SPECTATOR on the routed room — it watches, it never
 * occupies, so the room's renderer stays the one occupant avatar — and the server refuses
 * every terminal mutation on a spectator channel: a terminal is born on the channel that asks,
 * and its input, geometry and lease are judged in its HOME room. The channels that may do
 * those things are the renderers' own room pipes, which they publish here on mount
 * (`useRoomPipeRegistration`). One registry per host gate, read at call time rather than
 * held in React state: a pipe arriving or leaving is not a reason for any panel to re-render.
 */
export interface RoomPipeRegistry {
  /** Publishes a container's occupant pipe; the release forgets it unless a newer one replaced it. */
  readonly register: RoomPipeRegistration;
  /**
   * The occupant pipe of a container — where a terminal asked for by a panel is born. Throws
   * the named refusal when nothing occupies it, so a caller renders "no view of this
   * container is open" instead of waiting on a frame the server would refuse.
   */
  pipeOf(containerId: string | null): RoomPipe;
  /**
   * The occupant pipe of the room a terminal LIVES in: every room pipe carries its own
   * terminal table, so the table that holds the id names the home. Throws the named refusal
   * when no mounted view holds it.
   */
  pipeHolding(terminalId: string): RoomPipe;
}

export function createRoomPipeRegistry(): RoomPipeRegistry {
  const pipes = new Map<string, RoomPipe>();
  return {
    register: (containerId, pipe) => {
      pipes.set(containerId, pipe);
      return () => {
        // A remount registers before the old mount releases (React runs the new effect,
        // then the old cleanup, on a keyed swap), so a stale release must not evict it.
        if (pipes.get(containerId) === pipe) pipes.delete(containerId);
      };
    },
    pipeOf: (containerId) => {
      if (containerId === null) throw new Error("no container is open");
      const pipe = pipes.get(containerId);
      if (pipe === undefined) {
        throw new Error(`no occupant view of container ${containerId} is mounted`);
      }
      return pipe;
    },
    pipeHolding: (terminalId) => {
      for (const pipe of pipes.values()) if (pipe.terminals.has(terminalId)) return pipe;
      throw new Error(`no occupant view holds terminal ${terminalId}`);
    },
  };
}

/**
 * THE HANDLE A PANEL HOLDS: the host's watching client for every read — the doors, the
 * subscriptions, the terminal table, attach/detach — and the registry's occupant pipes for
 * the five terminal mutations. `openTerminal` is born in the container the viewer is looking
 * at (`HostServices.containerId`), and a terminal-keyed verb rides the pipe of the room whose
 * table holds it. Exactly the {@link SessionHandle} surface and nothing more: the object a
 * plugin receives no longer IS the SDK client, so what the contract omits is now absent at
 * runtime as well (the sandbox shape ADR 0010 names).
 */
export function panelSessionHandle(
  watch: SessionHandle,
  pipes: RoomPipeRegistry,
  containerId: string | null,
): SessionHandle {
  return {
    action: (name, args) => watch.action(name, args),
    place: (ref, destination) => watch.place(ref, destination),
    selfCaps: () => watch.selfCaps(),
    machines: () => watch.machines(),
    index: () => watch.index(),
    attendanceByContainer: () => watch.attendanceByContainer(),
    terminalsByContainer: () => watch.terminalsByContainer(),
    resolve: (uri) => watch.resolve(uri),
    allTerminals: () => watch.allTerminals(),
    renameContainer: (id, name) => watch.renameContainer(id, name),
    deleteContainer: (id) => watch.deleteContainer(id),
    createFolder: (name, parentId) => watch.createFolder(name, parentId),
    renameFolder: (folderId, name) => watch.renameFolder(folderId, name),
    deleteFolder: (folderId) => watch.deleteFolder(folderId),
    moveIndexEntry: (item, parentId, index) => watch.moveIndexEntry(item, parentId, index),
    getContainer: (id) => watch.getContainer(id),
    removeContainerTile: (id, tileId) => watch.removeContainerTile(id, tileId),
    subscribe: (topics, handler) => watch.subscribe(topics, handler),
    get status() {
      return watch.status;
    },
    // Every overload of `on` forwards to the same listener table; the cast names one of them
    // because a union of event names resolves no overload, and the handle's own declaration
    // is what keeps every caller typed.
    on: (event: string, fn: (...args: never[]) => void) =>
      watch.on(event as "status", fn as (status: SessionStatus) => void),
    // terminals
    get terminals() {
      return watch.terminals;
    },
    openTerminal: async (opts) => pipes.pipeOf(containerId).openTerminal(opts),
    attachTerminal: (terminalId) => watch.attachTerminal(terminalId),
    detachTerminal: (terminalId) => watch.detachTerminal(terminalId),
    sendTerminalInput: (terminalId, data) =>
      pipes.pipeHolding(terminalId).sendTerminalInput(terminalId, data),
    resizeTerminal: (terminalId, cols, rows) =>
      pipes.pipeHolding(terminalId).resizeTerminal(terminalId, cols, rows),
    takeTerminal: (terminalId) => pipes.pipeHolding(terminalId).takeTerminal(terminalId),
    killTerminal: (terminalId) => pipes.pipeHolding(terminalId).killTerminal(terminalId),
  };
}
