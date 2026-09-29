import { strict as assert } from "node:assert";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  ClientMessageSchema,
  ContainerResponseSchema,
  PlaceResponseSchema,
  TokenGrantSchema,
} from "../packages/protocol/src/index.ts";
import { SessionClient } from "../packages/sdk/src/index.ts";
import { CreateTextResultSchema, TEXT_NAMESPACE } from "../packages/plugins/text/src/index.ts";
import { Browser } from "./cdp.ts";
import { sleep, until } from "./gate-lib.ts";

/** F13's element-consumer path: a real nested canvas, not only a Text home renderer. */
export async function verifyMountedCanvasDocuments(
  browser: Browser,
  origin: string,
  ownerKey: string,
): Promise<void> {
  const clients: SessionClient[] = [];
  const reader = new Browser();
  const channels = new Map<string, { home: string; spectator: boolean }>();
  const joins: { home: string; spectator: boolean }[] = [];
  const offFrames = browser.on("Network.webSocketFrameSent", (params) => {
    const response = params["response"];
    if (typeof response !== "object" || response === null || !("payloadData" in response)) return;
    if (typeof response.payloadData !== "string" || response.payloadData[0] !== "{") return;
    const parsed = ClientMessageSchema.safeParse(JSON.parse(response.payloadData));
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.type !== "join" && frame.type !== "leave") return;
    const key = `${String(params["requestId"])}:${frame.ch}`;
    if (frame.type === "join") {
      const channel = { home: frame.containerId, spectator: frame.spectator === true };
      channels.set(key, channel);
      joins.push(channel);
    } else channels.delete(key);
  });
  const offClosed = browser.on("Network.webSocketClosed", (params) => {
    const prefix = `${String(params["requestId"])}:`;
    for (const key of channels.keys()) if (key.startsWith(prefix)) channels.delete(key);
  });
  const action = async (name: string, args: unknown): Promise<unknown> => {
    const response = await fetch(`${origin}/api/actions/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const outcome = ActionOutcomeSchema.parse(await response.json());
    if (!outcome.ok) throw new Error(`${name}: ${outcome.denial.message}`);
    return outcome.result;
  };
  const createContainer = async (
    name: string,
    discipline: "canvas" | "composition" | "text-home",
  ) =>
    ContainerResponseSchema.parse(await action("core.index.createContainer", { name, discipline }))
      .container;
  const connect = async (home: string, spectator = true): Promise<SessionClient> => {
    const client = new SessionClient({
      url: `${origin.replace(/^http/, "ws")}/ws/session`,
      token: ownerKey,
      containerId: home,
      spectator,
    });
    clients.push(client);
    await client.connect();
    return client;
  };
  const point = async (target: Browser, selector: string, x = 0.5, y = 0.5) =>
    target.evaluate<{ x: number; y: number }>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error("Missing target: " + ${JSON.stringify(selector)});
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width * ${String(x)}, y: box.y + box.height * ${String(y)} };
    })()`);
  const click = async (target: Browser, selector: string, count = 1): Promise<void> => {
    const position = await point(target, selector);
    await target.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...position });
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      await target.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...position,
        button: "left",
        buttons: 1,
        clickCount,
      });
      await target.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...position,
        button: "left",
        clickCount,
      });
    }
  };
  const key = async (target: Browser, key: string, code: string, modifiers = 0): Promise<void> => {
    await target.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
    await target.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
  };
  const capture = async (target: Browser, name: string): Promise<void> => {
    const directory = process.env["MANIFOLD_RUNTIME_PROOF_DIR"];
    if (directory === undefined) return;
    const frame = await target.send("Page.captureScreenshot", { format: "png" });
    const data = frame.result?.["data"];
    assert.equal(typeof data, "string");
    await Bun.write(join(directory, `${name}.png`), Buffer.from(String(data), "base64"));
  };
  const active = (home: string) => [...channels.values()].filter((entry) => entry.home === home);
  const attendance = (client: SessionClient) =>
    [...client.attendance.values()].reduce((total, row) => total + row.connections, 0);
  const nestedCanvas = ".portal__surface .canvas";
  const editor = `${nestedCanvas} .canvas-note .cm-content`;
  const outerPane = ".canvas > .react-flow > .react-flow__renderer > .react-flow__pane";
  const rendered = (target: Browser, selector: string, text: string, readOnly: boolean) =>
    target.evaluate<boolean>(`(() => {
      const editor = document.querySelector(${JSON.stringify(selector)});
      return editor?.textContent === ${JSON.stringify(text)} &&
        editor.getAttribute("aria-readonly") === ${JSON.stringify(String(readOnly))};
    })()`);
  try {
    await browser.send("Network.enable", {});
    const outer = await createContainer("F13 outer canvas", "canvas");
    const inner = await createContainer("F13 notes canvas", "canvas");
    const documentId = "nested-note";
    const initialBody = "Retained nested note";
    const note = CreateTextResultSchema.parse(
      await action("core.text.create", {
        home: { kind: "container", containerId: inner.id },
        documentId,
        text: initialBody,
        reference: false,
      }),
    );
    const author = await connect(inner.id, false);
    author.transact((tx) =>
      tx.create({
        id: documentId,
        type: "canvas_note",
        document: note.reference,
        x: 20,
        y: 20,
        width: 360,
        height: 48,
        zIndex: tx.nextZIndex(),
        fontSize: 20,
        color: "#f8f9fa",
      }),
    );
    const placeInner = () =>
      action("core.space.place", {
        ref: { kind: "container", containerId: inner.id },
        destination: { kind: "canvas", containerId: outer.id, x: 80, y: 80 },
      });
    await placeInner();
    const home = await connect(inner.id);
    await until(() => home.elements.has(documentId), 5_000, "native canvas note committed");
    author.close();
    const outerHome = await connect(outer.id);
    const retainedBody = home.sharedText(TEXT_NAMESPACE, documentId);
    assert.ok(retainedBody);
    const waitRole = async (spectator: boolean, body: string, editing = true) => {
      try {
        await until(
          async () =>
            active(inner.id).length === 1 &&
            active(inner.id)[0]?.spectator === spectator &&
            attendance(home) === (spectator ? 0 : 1) &&
            (await rendered(browser, editor, body, spectator || !editing)),
          10_000,
          `nested note: one ${spectator ? "spectator" : "occupant"}, body and attendance`,
        );
      } catch (error) {
        const painted = await browser.evaluate(
          `[...document.querySelectorAll('.cm-content')].map(e => ({text:e.textContent,readOnly:e.getAttribute('aria-readonly')}))`,
        );
        throw new Error(
          JSON.stringify({ channels: active(inner.id), attendance: attendance(home), painted }),
          { cause: error },
        );
      }
    };
    const disengage = async () => {
      const position = await point(browser, outerPane, 0.96, 0.9);
      await browser.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...position,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...position,
        button: "left",
        clickCount: 1,
      });
    };
    await browser.goto(`${origin}/p/${outer.id}`);
    await waitRole(true, initialBody);
    const baselineJoins = joins.filter((entry) => entry.home === inner.id).length;
    await capture(browser, "F13-nested-spectator");
    await click(browser, editor);
    await waitRole(false, initialBody);
    await click(browser, editor, 2);
    await waitRole(false, initialBody, true);
    await key(browser, "End", "End", 2);
    await browser.typeText(" — edited inside");
    const editedBody = `${initialBody} — edited inside`;
    await until(
      () => retainedBody.toString() === editedBody,
      5_000,
      "nested note edits its retained home body",
    );
    await waitRole(false, editedBody, true);
    await capture(browser, "F13-nested-occupant");
    await disengage();
    await waitRole(true, editedBody);
    assert.deepEqual(
      joins.filter((entry) => entry.home === inner.id).slice(baselineJoins),
      [
        { home: inner.id, spectator: false },
        { home: inner.id, spectator: true },
      ],
      "engagement and focus must not reopen a separate home lease",
    );
    await capture(browser, "F13-nested-disengaged");
    await click(browser, '[aria-label="Put away canvas F13 notes canvas"]');
    await until(
      () => active(inner.id).length === 0 && attendance(home) === 0,
      10_000,
      "unplace retires the mounted note's only session",
    );
    assert.equal(home.sharedText(TEXT_NAMESPACE, documentId), retainedBody);
    assert.equal(retainedBody.toString(), editedBody);
    assert.equal(home.sharedTexts(TEXT_NAMESPACE).size, 1);
    console.log(
      "PASS  F13 nested note: spectator1 -> occupant1 -> spectator1 -> 0, no reopen or false presence, retained body",
    );

    // Different scene histories and simultaneous selections make key bubbling observable.
    await placeInner();
    await waitRole(true, editedBody);
    const draw = async (
      selector: string,
      client: SessionClient,
      x: number,
      y: number,
    ): Promise<string> => {
      const before = new Set(client.elements.keys());
      await click(browser, `${selector} .canvas-toolbar [title="Draw (D)"]`);
      const from = await point(browser, `${selector} .react-flow__pane`, x, y);
      await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
      await browser.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...from,
        button: "left",
        buttons: 1,
      });
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x + 65,
        y: from.y + 45,
        button: "left",
        buttons: 1,
      });
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: from.x + 65,
        y: from.y + 45,
        button: "left",
      });
      let id = "";
      await until(
        () => {
          id =
            [...client.elements.values()].find(
              (element) => element.type === "draw" && !before.has(element.id),
            )?.id ?? "";
          return id !== "";
        },
        5_000,
        "a real pointer stroke committed to the correct canvas",
      );
      return id;
    };
    const outerStroke = await draw(".canvas", outerHome, 0.82, 0.72);
    await sleep(600); // Separate the outer stroke's undo capture from its next edit.
    const outerRedo = await draw(".canvas", outerHome, 0.82, 0.5);
    await browser.evaluate("document.querySelector('.canvas').focus()");
    await key(browser, "z", "KeyZ", 2);
    await until(
      () => !outerHome.elements.has(outerRedo),
      5_000,
      "outer edit waits in its redo history",
    );
    assert.ok(outerHome.elements.has(outerStroke));
    await click(browser, editor);
    await waitRole(false, editedBody);
    const innerStroke = await draw(nestedCanvas, home, 0.35, 0.52);
    await browser.evaluate(`document.querySelector(${JSON.stringify(nestedCanvas)}).focus()`);
    await key(browser, "z", "KeyZ", 2);
    await until(
      () => !home.elements.has(innerStroke),
      5_000,
      "inner undo removes only inner stroke",
    );
    assert.ok(outerHome.elements.has(outerStroke), "inner undo must not undo the outer edit");
    await key(browser, "z", "KeyZ", 10);
    await until(
      () => home.elements.has(innerStroke),
      5_000,
      "inner redo restores only inner stroke",
    );
    assert.ok(outerHome.elements.has(outerStroke));
    assert.equal(
      outerHome.elements.has(outerRedo),
      false,
      "inner redo must not replay the outer redo history",
    );
    await key(browser, "v", "KeyV");
    const outerNode = `.react-flow__node[data-id="${outerStroke}"]`;
    const innerNode = `.react-flow__node[data-id="${innerStroke}"]`;
    await click(browser, '.canvas-toolbar [title="Select (V)"]');
    await click(browser, outerNode);
    await browser.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Shift",
      code: "ShiftLeft",
      modifiers: 8,
    });
    await click(browser, innerNode);
    await until(
      () => active(inner.id)[0]?.spectator === false,
      5_000,
      "inner canvas re-engaged for selection",
    );
    await click(browser, innerNode);
    await browser.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Shift",
      code: "ShiftLeft",
    });
    await until(
      () =>
        browser.evaluate<boolean>(
          `document.querySelector(${JSON.stringify(outerNode)})?.classList.contains("selected") && document.querySelector(${JSON.stringify(innerNode)})?.classList.contains("selected")`,
        ),
      5_000,
      "distinct outer and inner selections are active",
    );
    await browser.evaluate(`document.querySelector(${JSON.stringify(nestedCanvas)}).focus()`);
    await key(browser, "d", "KeyD");
    await until(
      () =>
        browser.evaluate<boolean>(
          `document.querySelector(${JSON.stringify(`${nestedCanvas} > .canvas-toolbar [data-testid="toolbar-draw"]`)})?.getAttribute("aria-pressed") === "true" &&
        document.querySelector('.canvas > .canvas-toolbar [data-testid="toolbar-select"]')?.getAttribute("aria-pressed") === "true"`,
        ),
      5_000,
      "inner tool shortcut must not change the outer tool",
    );
    await key(browser, "v", "KeyV");
    await key(browser, "Delete", "Delete");
    await until(
      () => !home.elements.has(innerStroke),
      5_000,
      "inner Delete removes selected inner stroke",
    );
    assert.ok(outerHome.elements.has(outerStroke), "inner Delete must not remove outer selection");
    await until(
      () =>
        browser.evaluate<boolean>(
          `document.querySelector(${JSON.stringify(`${nestedCanvas} .react-flow__node.selected`)}) === null &&
        document.querySelector(${JSON.stringify(outerNode)})?.classList.contains("selected")`,
        ),
      5_000,
      "the second Delete starts with only an outer selection",
    );
    await key(browser, "Delete", "Delete");
    await sleep(250);
    assert.ok(outerHome.elements.has(outerStroke), "empty inner Delete must still claim the key");
    await capture(browser, "F13-keyboard-isolation");
    console.log(
      "PASS  F13 nested keys: distinct undo/redo histories and Delete with selected/empty inner scene leave outer edit and selection intact",
    );

    // A foreign reference keeps its own authority and lease, never the canvas's body map.
    const foreign = await createContainer("F13 foreign documents", "text-home");
    const foreignDocument = CreateTextResultSchema.parse(
      await action("core.text.create", {
        home: { kind: "container", containerId: foreign.id },
        documentId: "foreign-note",
        text: "Foreign retained body",
        reference: false,
      }),
    );
    const foreignHome = await connect(foreign.id);
    const seed = await connect(inner.id, false);
    seed.transact((tx) =>
      tx.create({
        id: "foreign-reference",
        type: "canvas_note",
        document: foreignDocument.reference,
        x: 20,
        y: 100,
        width: 300,
        height: 48,
        zIndex: tx.nextZIndex(),
        fontSize: 20,
        color: "#f8f9fa",
      }),
    );
    await until(() => home.elements.has("foreign-reference"), 5_000, "foreign reference seeded");
    seed.close();
    const foreignEditor = `${nestedCanvas} .react-flow__node[data-id="foreign-reference"] .cm-content`;
    await until(
      () => rendered(browser, foreignEditor, "Foreign retained body", true),
      10_000,
      "foreign home preview remains available",
    );
    await click(browser, foreignEditor, 2);
    await until(
      async () =>
        active(foreign.id)[0]?.spectator === false &&
        (await browser.evaluate<boolean>(
          `document.querySelector(${JSON.stringify(foreignEditor)})?.textContent === "Foreign retained body"`,
        )),
      10_000,
      "foreign occupant lease has loaded its original body",
    );
    await click(browser, foreignEditor, 2);
    await until(
      () => rendered(browser, foreignEditor, "Foreign retained body", false),
      10_000,
      "foreign home obtains its independent edit lease",
    );
    await key(browser, "End", "End", 2);
    await browser.typeText(" — foreign edit");
    await until(
      () =>
        foreignHome.sharedText(TEXT_NAMESPACE, "foreign-note")?.toString() ===
        "Foreign retained body — foreign edit",
      5_000,
      "foreign edit commits only at the foreign home",
    );
    assert.equal(home.sharedTexts(TEXT_NAMESPACE).size, 1);
    assert.equal(retainedBody.toString(), editedBody);
    await disengage();
    await until(
      () =>
        active(inner.id).length === 1 &&
        active(inner.id)[0]?.spectator === true &&
        active(foreign.id).length === 1 &&
        active(foreign.id)[0]?.spectator === false &&
        attendance(home) === 0 &&
        attendance(foreignHome) === 1,
      10_000,
      "foreign lease remains independent of the disengaged mount",
    );
    await capture(browser, "F13-foreign-authority");
    await click(browser, '[aria-label="Put away canvas F13 notes canvas"]');
    await until(
      () =>
        active(inner.id).length === 0 &&
        active(foreign.id).length === 0 &&
        attendance(home) === 0 &&
        attendance(foreignHome) === 0,
      10_000,
      "unmount releases same-home and foreign-home consumers",
    );
    console.log(
      "PASS  F13 foreign reference: own home edits, independent lease, no body transfer, released on unmount",
    );

    await placeInner();
    const grant = TokenGrantSchema.parse(
      await action("core.access.mint", {
        principal: { name: "F13 read-only actor", kind: "human" },
        caps: ["containers:read"],
      }),
    );
    await reader.launch({ incognito: true });
    await reader.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `if(location.origin===${JSON.stringify(origin)}) localStorage.setItem("manifold.identity",${JSON.stringify(JSON.stringify({ token: grant.token, principal: grant.principal }))});`,
    });
    await reader.goto(`${origin}/p/${outer.id}`);
    await until(
      () => rendered(reader, editor, editedBody, true),
      10_000,
      "read-only actor sees same retained body",
    );
    await click(reader, editor);
    await click(reader, editor, 2);
    await reader.typeText("ILLEGAL EDIT");
    await sleep(250);
    assert.ok(
      await rendered(reader, editor, editedBody, true),
      "read-only mounted actor must not enable editing",
    );
    assert.equal(retainedBody.toString(), editedBody);
    await capture(reader, "F13-read-only");
    await reader.close();
    await action("core.access.revoke", { principalId: grant.principal.id });
    console.log(
      "PASS  F13 read-only actor: engagement and typing cannot edit the nested retained body",
    );

    // The composition portal's container leaf takes PortalContainerTile, not CanvasProviders.
    const composition = await createContainer("F13 composition portal", "composition");
    const leaf = PlaceResponseSchema.parse(
      await action("core.space.place", {
        ref: { kind: "container", containerId: foreign.id },
        destination: { kind: "tile", containerId: composition.id, targetTileId: null, edge: null },
      }),
    );
    assert.ok(leaf.op === "add_tile", "container placement creates a tile");
    await action("core.space.place", {
      ref: { kind: "container", containerId: inner.id },
      destination: {
        kind: "tile",
        containerId: composition.id,
        targetTileId: leaf.tileId,
        edge: "right",
      },
    });
    const leafCanvas = await createContainer("F13 composition surface", "canvas");
    await action("core.space.place", {
      ref: { kind: "container", containerId: composition.id },
      destination: { kind: "canvas", containerId: leafCanvas.id, x: 80, y: 80 },
    });
    const joinsBeforeCard = joins.length;
    await browser.goto(`${origin}/p/${leafCanvas.id}`);
    await until(
      () =>
        browser.evaluate<boolean>(
          'document.querySelector(".portal__container-card strong")?.textContent === "F13 foreign documents"',
        ),
      10_000,
      "composition portal renders its container leaf metadata",
    );
    assert.equal(
      joins.slice(joinsBeforeCard).some((entry) => entry.home === foreign.id),
      false,
      "depth-limited container card must not open the foreign document home",
    );
    await capture(browser, "F13-composition-container-leaf");
    await click(browser, ".portal__container-card .portal__enter");
    await until(
      () =>
        browser.evaluate<boolean>(
          `location.pathname === ${JSON.stringify(`/p/${foreign.id}`)} && document.querySelector('.text-documents .cm-content')?.textContent === "Foreign retained body — foreign edit"`,
        ),
      10_000,
      "container leaf opens its actual document discipline",
    );
    console.log(
      "PASS  F13 composition container leaf: metadata card renders and opens the Text home with its retained body",
    );
  } finally {
    offFrames();
    offClosed();
    await reader.close();
    for (const client of clients) client.close();
  }
}
