import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeldServiceCredentialRegistry } from "../src/job-credentials.ts";
import { HeldDirectory } from "../src/job-files.ts";
import { heldServiceCredentialResolver } from "../src/job-services.ts";

const origin = "https://service.invalid";
const signal = new AbortController().signal;

describe.skipIf(process.platform !== "linux")("declared credential custody", () => {
  test("missing-leaf enrollment follows the held parent, switches every live view and closes old slots", async () => {
    const root = mkdtempSync(join(tmpdir(), "held-credential-"));
    const path = join(root, "source");
    mkdirSync(path, { mode: 0o700 });
    const parent = HeldDirectory.openAbsolute(path, { private: true });
    const sources = new HeldServiceCredentialRegistry();
    sources.declare("key", parent, "key", [origin]);
    const current = (ref: string) => sources.currentDescriptor(ref);
    const direct = heldServiceCredentialResolver(current);
    const proxy = heldServiceCredentialResolver(current);
    try {
      expect(sources.references()).toEqual([{ ref: "key", origins: [origin], available: false }]);
      await expect(direct("key", signal)).rejects.toThrow("service_credential_unavailable");
      const missing = sources.prepare("key", origin, false);
      expect(missing).toBeNull();
      // Changing the ambient pathname never redirects the retained directory capability.
      renameSync(path, join(root, "held-source"));
      mkdirSync(path, { mode: 0o700 });
      const initial = sources.publish(
        "key",
        origin,
        false,
        missing,
        Buffer.from("synthetic-one\n"),
      );
      expect(initial).toMatchObject({ replaced: false, durable: true });
      expect(existsSync(join(path, "key"))).toBe(false);
      expect(readFileSync(join(root, "held-source", "key"), "utf8")).toBe("synthetic-one\n");
      expect(await direct("key", signal)).toBe("synthetic-one");
      expect(sources.references()).toEqual([{ ref: "key", origins: [origin], available: true }]);
      expect(() => sources.prepare("key", origin, false)).toThrow("credential_already_held");
      const oldFd = sources.currentDescriptor("key")!;
      const revision = sources.prepare("key", origin, true);
      const replacement = sources.publish(
        "key",
        origin,
        true,
        revision,
        Buffer.from("synthetic-two"),
      );
      expect(replacement).toMatchObject({ replaced: true, durable: true });
      expect(replacement.sourceRevision).not.toBe(initial.sourceRevision);
      expect(() => fstatSync(oldFd)).toThrow();
      expect(await direct("key", signal)).toBe("synthetic-two");
      expect(await proxy("key", signal)).toBe("synthetic-two");
      const finalFd = sources.currentDescriptor("key")!;
      sources.close();
      expect(() => fstatSync(finalFd)).toThrow();
      expect(() => parent.stat()).toThrow();
      await expect(proxy("key", signal)).rejects.toThrow("service_credential_unavailable");
    } finally {
      sources.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("initial publication is exclusive and never adopts a source that appeared after prepare", () => {
    const root = mkdtempSync(join(tmpdir(), "credential-exclusive-"));
    const sources = new HeldServiceCredentialRegistry();
    sources.declare("key", HeldDirectory.openAbsolute(root, { private: true }), "key", [origin]);
    try {
      const revision = sources.prepare("key", origin, false);
      writeFileSync(join(root, "key"), "another-writer", { mode: 0o600 });
      expect(() =>
        sources.publish("key", origin, false, revision, Buffer.from("new-value")),
      ).toThrow("credential_source_changed");
      expect(readFileSync(join(root, "key"), "utf8")).toBe("another-writer");
      expect(sources.currentDescriptor("key")).toBeUndefined();
      expect(sources.references()).toEqual([{ ref: "key", origins: [origin], available: false }]);
      expect(readdirSync(root)).toEqual(["key"]);
    } finally {
      sources.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two replacement offers cannot silently overwrite each other's owner-local revisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "credential-cas-"));
    writeFileSync(join(root, "key"), "before", { mode: 0o600 });
    const sources = new HeldServiceCredentialRegistry();
    sources.declare("key", HeldDirectory.openAbsolute(root, { private: true }), "key", [origin]);
    const resolve = heldServiceCredentialResolver((ref) => sources.currentDescriptor(ref));
    try {
      const revision = sources.prepare("key", origin, true);
      sources.publish("key", origin, true, revision, Buffer.from("winner"));
      expect(() => sources.publish("key", origin, true, revision, Buffer.from("loser"))).toThrow(
        "credential_source_changed",
      );
      expect(await resolve("key", signal)).toBe("winner");
      expect(readFileSync(join(root, "key"), "utf8")).toBe("winner");
      expect(readdirSync(root)).toEqual(["key"]);
    } finally {
      sources.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([0o755, 0o500])(
    "readable mode %o parents never gain an enrollment fallback",
    (mode) => {
      const root = mkdtempSync(join(tmpdir(), "credential-readonly-parent-"));
      writeFileSync(join(root, "key"), "private-current", { mode: 0o600 });
      chmodSync(root, mode);
      const sources = new HeldServiceCredentialRegistry();
      sources.declare("key", HeldDirectory.openAbsolute(root), "key", [origin]);
      try {
        expect(sources.references()).toEqual([{ ref: "key", origins: [origin], available: true }]);
        expect(() => sources.prepare("key", origin, true)).toThrow("credential_source_read_only");
        expect(readFileSync(join(root, "key"), "utf8")).toBe("private-current");
        expect(readdirSync(root)).toEqual(["key"]);
      } finally {
        sources.close();
        chmodSync(root, 0o700);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("a declared read-only file, unknown ref and unadvertised origin are closed", () => {
    const root = mkdtempSync(join(tmpdir(), "credential-closed-target-"));
    writeFileSync(join(root, "key"), "private-current", { mode: 0o400 });
    const sources = new HeldServiceCredentialRegistry();
    sources.declare("key", HeldDirectory.openAbsolute(root, { private: true }), "key", [origin]);
    try {
      expect(() => sources.prepare("key", origin, true)).toThrow("credential_source_read_only");
      expect(() => sources.prepare("absent", origin, false)).toThrow(
        "credential_reference_unknown",
      );
      expect(() => sources.prepare("key", "https://other.invalid", true)).toThrow(
        "credential_origin_disallowed",
      );
    } finally {
      sources.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("staging is read-only and validated before a destination exists, with complete refusal cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "credential-stage-"));
    const parent = HeldDirectory.openAbsolute(root, { private: true });
    let readFd: number | undefined;
    try {
      expect(() =>
        parent.atomicWriteHeld(
          "key",
          Buffer.from("synthetic-stage"),
          (fd) => {
            readFd = fd;
            expect(existsSync(join(root, "key"))).toBe(false);
            expect(() => writeSync(fd, Buffer.from("changed"))).toThrow();
            throw new Error("credential_source_invalid");
          },
          () => {
            throw new Error("must_not_publish");
          },
          0o600,
          true,
        ),
      ).toThrow("credential_source_invalid");
      expect(() => fstatSync(readFd!)).toThrow();
      expect(readdirSync(root)).toEqual([]);
      parent.atomicWriteHeld(
        "key",
        Buffer.from("published-stage"),
        (fd) => {
          expect(fstatSync(fd).nlink).toBe(1);
        },
        (fd) => {
          readFd = fd;
        },
        0o600,
        true,
      );
      expect(readFileSync(readFd!, "utf8")).toBe("published-stage");
      expect(readFileSync(join(root, "key"), "utf8")).toBe("published-stage");
      expect(readdirSync(root)).toEqual(["key"]);
      closeSync(readFd!);
      readFd = undefined;
    } finally {
      if (readFd !== undefined) {
        try {
          closeSync(readFd);
        } catch {
          // Refused staging already closed it.
        }
      }
      parent.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
