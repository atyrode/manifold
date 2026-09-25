import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { fstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJobJson } from "@manifold/protocol";
import * as files from "../src/job-files.ts";
import { HeldDirectory } from "../src/job-files.ts";
import { JobResources } from "../src/job-resources.ts";

// Computed independently of the implementation: the pin a hub already promoted for a
// built-in anchor must keep its exact bytes.
const sha256 = (value: unknown) =>
  createHash("sha256").update(canonicalJobJson(value)).digest("hex");
const identity = (anchor: HeldDirectory) => {
  const stat = fstatSync(anchor.fd, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
};
const view = { path: "/run/manifold-anchors/sessions", source: "/home/alice/sessions" };

describe.skipIf(process.platform !== "linux")("anchor resource pins", () => {
  test("built-in anchors keep their device, inode and mount pin and no definitions", () => {
    const root = mkdtempSync(join(tmpdir(), "job-anchor-pin-"));
    const held = HeldDirectory.openAbsolute(root);
    try {
      const inventory = new JobResources({
        anchors: { runtime: held },
        runtimeTools: {},
      }).snapshot();
      expect(inventory.anchors).toEqual({
        runtime: sha256({ ...identity(held), mount: held.mountId }),
      });
      expect(Object.hasOwn(inventory, "anchorDefinitions")).toBe(false);
    } finally {
      held.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an operator anchor pins what it presents and its identity, never its re-created mount", () => {
    const root = mkdtempSync(join(tmpdir(), "job-anchor-pin-"));
    mkdirSync(join(root, "sessions"));
    let held = HeldDirectory.openAbsolute(join(root, "sessions"));
    // The fixture directory is not a read-only mount; the real check is exercised separately.
    const readOnly = spyOn(files, "fdMountReadOnly").mockReturnValue(true);
    const inventory = (anchor: HeldDirectory, definition = view) =>
      new JobResources({
        anchors: { "operator.sessions": anchor },
        operatorAnchors: { "operator.sessions": definition },
        runtimeTools: {},
      }).snapshot();
    try {
      const first = inventory(held);
      const pin = first.anchors["operator.sessions"];
      expect(pin).toBe(sha256({ ...identity(held), ...view, readOnly: true }));
      expect(first.anchorDefinitions).toEqual({
        "operator.sessions": { source: view.source, readOnly: true },
      });
      // A view is re-created every boot: only its mount id changes, so its pin does not.
      const remounted = { fd: held.fd, mountId: held.mountId + 1 } as HeldDirectory;
      expect(inventory(remounted).anchors["operator.sessions"]).toBe(pin);
      // Changing what the anchor presents, or where the owner holds it, needs a new review.
      expect(
        inventory(held, { ...view, source: "/home/alice/other" }).anchors["operator.sessions"],
      ).not.toBe(pin);
      expect(
        inventory(held, { ...view, path: "/run/manifold-anchors/other" }).anchors[
          "operator.sessions"
        ],
      ).not.toBe(pin);
      // A recreated source directory is a new identity even at the same path.
      held.close();
      renameSync(join(root, "sessions"), join(root, "retired"));
      mkdirSync(join(root, "sessions"));
      held = HeldDirectory.openAbsolute(join(root, "sessions"));
      expect(inventory(held).anchors["operator.sessions"]).not.toBe(pin);
    } finally {
      readOnly.mockRestore();
      held.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an operator anchor on a writable mount is neither pinned nor defined", () => {
    const root = mkdtempSync(join(tmpdir(), "job-anchor-pin-"));
    const held = HeldDirectory.openAbsolute(root);
    try {
      expect(files.fdMountReadOnly(held.fd)).toBe(false);
      const inventory = new JobResources({
        anchors: { "operator.sessions": held },
        operatorAnchors: { "operator.sessions": view },
        runtimeTools: {},
      }).snapshot();
      expect(inventory.anchors).toEqual({});
      expect(inventory.anchorDefinitions).toEqual({});
    } finally {
      held.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
