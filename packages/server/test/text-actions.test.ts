import { describe, expect, test } from "bun:test";
import {
  LOCAL_ORIGIN,
  Y,
  createSceneDoc,
  elementsMap,
  readElement,
  readSharedText,
  sharedTextsMap,
} from "@manifold/scene";
import { AuthService } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { DOC_BYTES_LIMIT, RoomManager } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  FakeSocket,
  testPluginHost,
  testStore,
  testTileTrees,
} from "./helpers.ts";

describe("native Text creation capacity", () => {
  test("pending creations share current capacity and refusals leave body, reference and history untouched", async () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const key = "b".repeat(64);
    const auth = new AuthService(store, key, runtime);
    const owner = auth.authenticate(key);
    const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    const host = await testPluginHost(store, auth, rooms, broker, runtime);
    store.createContainer({ id: "home", name: "Home", createdAt: 0, discipline: "text-home" });
    const room = rooms.get("home")!;
    const socket = new FakeSocket();
    const peer = new SessionChannel("reader", socket, owner, room.containerId, "reader");
    const undo = new Y.UndoManager([sharedTextsMap(room.doc), elementsMap(room.doc)], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    });
    const observed: unknown[] = [];
    const observe = () => {
      observed.push({
        body: readSharedText(room.doc, "core.text", "fits"),
        reference: readElement(room.doc, "fits")?.["document"],
      });
    };
    const create = (documentId: string, reference: boolean, text = "x".repeat(20_000)) =>
      host.dispatch(owner, "core.text.create", {
        home: { kind: "container", containerId: room.containerId },
        documentId,
        reference,
        text,
      });
    try {
      room.doc.getMap("padding").set("bytes", new Uint8Array(DOC_BYTES_LIMIT - 25_000));
      room.flushSnapshot();
      expect(room.join(peer)).toBe(true);
      socket.clear();
      room.doc.on("update", observe);
      expect(await create("fits", true)).toEqual({
        ok: true,
        result: { containerId: "home", documentId: "fits", reference: '["home","fits"]' },
      });
      const body = {
        namespace: "core.text",
        id: "fits",
        text: "x".repeat(20_000),
        lastEditedBy: owner.principal.id,
        lastEditedAt: runtime.now(),
      };
      expect(observed).toEqual([{ body, reference: '["home","fits"]' }]);
      expect(readSharedText(room.doc, "core.text", "fits")).toEqual(body);
      undo.clear();
      socket.clear();
      const canonical = Y.encodeStateAsUpdate(room.doc);
      const rev = room.rev;
      const history = store.db.query("SELECT * FROM scene_docs ORDER BY rev").all();
      const timers = clock.pendingJobs;
      // No clock advance or flush: every call must account for the first pending creation.
      for (const reference of [false, true]) {
        const id = `refused-${reference}`;
        expect(await create(id, reference)).toMatchObject({
          ok: false,
          denial: { rule: "refused" },
        });
        expect(readSharedText(room.doc, "core.text", id)).toBeNull();
        expect(readElement(room.doc, id)).toBeNull();
      }
      expect(Y.encodeStateAsUpdate(room.doc)).toEqual(canonical);
      expect(room.rev).toBe(rev);
      expect(undo.undoStack).toEqual([]);
      expect(undo.redoStack).toEqual([]);
      expect(observed).toEqual([{ body, reference: '["home","fits"]' }]);
      expect(socket.messages()).toEqual([]);
      expect(clock.pendingJobs).toBe(timers);
      expect(store.db.query("SELECT * FROM scene_docs ORDER BY rev").all()).toEqual(history);
      expect(room.flushSnapshot()).toBe(true);
      expect(store.latestDoc(room.containerId)?.doc).toEqual(canonical);
      expect(room.flushSnapshot()).toBe(false);
      const newReader = new FakeSocket();
      expect(
        room.join(new SessionChannel("new-reader", newReader, owner, room.containerId, "new")),
      ).toBe(true);
      expect(newReader.messages()[0]?.type).toBe("init");

      // Missing-clock data changes capacity without an integrated Yjs update. The
      // cached init above must not let native preflight omit that retained data.
      const pending = createSceneDoc();
      try {
        pending.getMap("pending").set("a", 1);
        const vector = Y.encodeStateVector(pending);
        const remaining = DOC_BYTES_LIMIT - Y.encodeStateAsUpdate(room.doc).byteLength;
        pending.getMap("pending").set("b", new Uint8Array(remaining - 1_000));
        Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(pending, vector));
        const withPending = Y.encodeStateAsUpdate(room.doc);
        expect(withPending.byteLength).toBeLessThan(DOC_BYTES_LIMIT);
        const pendingHistory = store.db.query("SELECT * FROM scene_docs ORDER BY rev").all();
        socket.clear();
        for (const reference of [false, true]) {
          const id = `pending-refusal-${reference}`;
          expect(await create(id, reference, "x".repeat(2_000))).toMatchObject({
            ok: false,
            denial: { rule: "refused" },
          });
          expect(readSharedText(room.doc, "core.text", id)).toBeNull();
          expect(readElement(room.doc, id)).toBeNull();
        }
        expect(Y.encodeStateAsUpdate(room.doc)).toEqual(withPending);
        expect(room.rev).toBe(rev);
        expect(undo.undoStack).toEqual([]);
        expect(observed).toEqual([{ body, reference: '["home","fits"]' }]);
        expect(socket.messages()).toEqual([]);
        expect(store.db.query("SELECT * FROM scene_docs ORDER BY rev").all()).toEqual(
          pendingHistory,
        );
      } finally {
        pending.destroy();
      }

      // Existing socket/placement paths can cross the ceiling once. Native creation must
      // notice that unsaved state immediately, without waiting for the snapshot flag.
      room.doc.getMap("padding").set("pending", new Uint8Array(10_000));
      const overLimit = Y.encodeStateAsUpdate(room.doc);
      expect(overLimit.byteLength).toBeGreaterThan(DOC_BYTES_LIMIT);
      expect(await create("already-over", false, "small")).toMatchObject({
        ok: false,
        denial: { rule: "refused" },
      });
      expect(Y.encodeStateAsUpdate(room.doc)).toEqual(overLimit);
    } finally {
      room.doc.off("update", observe);
      undo.destroy();
      room.closeAll(1000, "test complete");
      room.doc.destroy();
      store.close();
    }
  });
});
