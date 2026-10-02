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
  test("missing-leaf enrollment through an alias follows the held parent and switches every live view", async () => {
    const root = mkdtempSync(join(tmpdir(), "held-credential-"));
    const path = join(root, "source");
    mkdirSync(path, { mode: 0o700 });
    const parent = HeldDirectory.openAbsolute(path, { private: true });
    const sources = new HeldServiceCredentialRegistry();
    sources.declare("key", parent, "key", [origin]);
    const aliasParent = parent.reopen();
    sources.declare("alias", aliasParent, "key", [origin]);
    const current = (ref: string) => sources.currentDescriptor(ref);
    const direct = heldServiceCredentialResolver(current);
    const proxy = heldServiceCredentialResolver(current);
    try {
      expect(sources.references()).toEqual([
        { ref: "key", origins: [origin], available: false },
        { ref: "alias", origins: [origin], available: false },
      ]);
      await expect(direct("key", signal)).rejects.toThrow("service_credential_unavailable");
      await expect(proxy("alias", signal)).rejects.toThrow("service_credential_unavailable");
      const missing = sources.prepare("key", origin, false);
      expect(missing).toBeNull();
      // Changing the ambient pathname never redirects the retained directory capability.
      renameSync(path, join(root, "held-source"));
      mkdirSync(path, { mode: 0o700 });
      const initial = sources.publish(
        "alias",
        origin,
        false,
        missing,
        Buffer.from("synthetic-one\n"),
      );
      expect(initial).toMatchObject({ replaced: false, durable: true });
      expect(existsSync(join(path, "key"))).toBe(false);
      expect(readFileSync(join(root, "held-source", "key"), "utf8")).toBe("synthetic-one\n");
      expect(await direct("key", signal)).toBe("synthetic-one");
      expect(await proxy("alias", signal)).toBe("synthetic-one");
      expect(sources.references()).toEqual([
        { ref: "key", origins: [origin], available: true },
        { ref: "alias", origins: [origin], available: true },
      ]);
      expect(() => sources.prepare("key", origin, false)).toThrow("credential_already_held");
      expect(() => sources.prepare("alias", origin, false)).toThrow("credential_already_held");
      expect(() =>
        sources.publish("key", origin, false, missing, Buffer.from("stale-initial")),
      ).toThrow("credential_source_changed");
      const oldFd = sources.currentDescriptor("alias")!;
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
      expect(() => fstatSync(oldFd)).toThrow("EBADF");
      expect(await direct("key", signal)).toBe("synthetic-two");
      expect(await proxy("alias", signal)).toBe("synthetic-two");
      const finalFd = sources.currentDescriptor("key")!;
      sources.close();
      expect(() => fstatSync(finalFd)).toThrow("EBADF");
      expect(() => parent.stat()).toThrow("EBADF");
      expect(() => aliasParent.stat()).toThrow("EBADF");
      await expect(direct("key", signal)).rejects.toThrow("service_credential_unavailable");
      await expect(proxy("alias", signal)).rejects.toThrow("service_credential_unavailable");
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

  test.each(["key", "alias"])(
    "replacement through %s preserves both aliases, shared revisions and per-ref origins",
    async (ref) => {
      const root = mkdtempSync(join(tmpdir(), "credential-alias-"));
      writeFileSync(join(root, "key"), "before", { mode: 0o600 });
      const parent = HeldDirectory.openAbsolute(root, { private: true });
      const aliasParent = HeldDirectory.openAbsolute(root, { private: true });
      const aliasOrigin = "https://alias.invalid";
      const sources = new HeldServiceCredentialRegistry();
      sources.declare("key", parent, "key", [origin]);
      sources.declare("alias", aliasParent, "key", [aliasOrigin]);
      const direct = heldServiceCredentialResolver((name) => sources.currentDescriptor(name));
      const proxy = heldServiceCredentialResolver((name) => sources.currentDescriptor(name));
      const otherRef = ref === "key" ? "alias" : "key";
      const refOrigin = ref === "key" ? origin : aliasOrigin;
      const otherOrigin = ref === "key" ? aliasOrigin : origin;
      const value = `after-${ref}`;
      try {
        expect(await direct("key", signal)).toBe("before");
        expect(await proxy("alias", signal)).toBe("before");
        const revision = sources.prepare(otherRef, otherOrigin, true);
        const retiredFd = sources.currentDescriptor(otherRef)!;
        const replacement = sources.publish(ref, refOrigin, true, revision, Buffer.from(value));
        expect(replacement).toMatchObject({ replaced: true, durable: true });
        expect(() => fstatSync(retiredFd)).toThrow("EBADF");
        expect(() =>
          sources.publish(otherRef, otherOrigin, true, revision, Buffer.from("stale")),
        ).toThrow("credential_source_changed");
        expect(await direct("key", signal)).toBe(value);
        expect(await proxy("alias", signal)).toBe(value);
        expect(readFileSync(join(root, "key"), "utf8")).toBe(value);
        expect(sources.references()).toEqual([
          { ref: "key", origins: [origin], available: true },
          { ref: "alias", origins: [aliasOrigin], available: true },
        ]);
        expect(sources.prepare("key", origin, true)).toBe(replacement.sourceRevision);
        expect(sources.prepare("alias", aliasOrigin, true)).toBe(replacement.sourceRevision);
        expect(() => sources.prepare("key", aliasOrigin, true)).toThrow(
          "credential_origin_disallowed",
        );
        expect(() => sources.prepare("alias", origin, true)).toThrow(
          "credential_origin_disallowed",
        );
        expect(() =>
          sources.publish(ref, otherOrigin, true, replacement.sourceRevision, Buffer.from("wrong")),
        ).toThrow("credential_origin_disallowed");
        const finalFd = sources.currentDescriptor(ref)!;
        expect(() => writeSync(finalFd, Buffer.from("x"), 0, 1, 0)).toThrow("EBADF");
        sources.close();
        expect(() => fstatSync(finalFd)).toThrow("EBADF");
        expect(() => parent.stat()).toThrow("EBADF");
        expect(() => aliasParent.stat()).toThrow("EBADF");
        await expect(direct("key", signal)).rejects.toThrow("service_credential_unavailable");
        await expect(proxy("alias", signal)).rejects.toThrow("service_credential_unavailable");
      } finally {
        sources.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("reused ambient parent paths with the same leaf keep distinct held sources", async () => {
    const root = mkdtempSync(join(tmpdir(), "credential-parent-identity-"));
    const path = join(root, "source");
    const heldPath = join(root, "held-source");
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "key"), "held-before", { mode: 0o600 });
    const parent = HeldDirectory.openAbsolute(path, { private: true });
    const sources = new HeldServiceCredentialRegistry();
    sources.declare("held", parent, "key", [origin]);
    renameSync(path, heldPath);
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "key"), "new-before", { mode: 0o600 });
    const newParent = HeldDirectory.openAbsolute(path, { private: true });
    sources.declare("new", newParent, "key", [origin]);
    const resolve = heldServiceCredentialResolver((ref) => sources.currentDescriptor(ref));
    try {
      const heldRevision = sources.prepare("held", origin, true);
      const newRevision = sources.prepare("new", origin, true);
      sources.publish("held", origin, true, heldRevision, Buffer.from("held-after"));
      expect(await resolve("held", signal)).toBe("held-after");
      expect(await resolve("new", signal)).toBe("new-before");
      sources.publish("new", origin, true, newRevision, Buffer.from("new-after"));
      expect(await resolve("held", signal)).toBe("held-after");
      expect(await resolve("new", signal)).toBe("new-after");
      expect(readFileSync(join(heldPath, "key"), "utf8")).toBe("held-after");
      expect(readFileSync(join(path, "key"), "utf8")).toBe("new-after");
      expect(sources.references()).toEqual([
        { ref: "held", origins: [origin], available: true },
        { ref: "new", origins: [origin], available: true },
      ]);
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
      sources.declare("alias", HeldDirectory.openAbsolute(root), "key", [origin]);
      try {
        expect(sources.references()).toEqual([
          { ref: "key", origins: [origin], available: true },
          { ref: "alias", origins: [origin], available: true },
        ]);
        expect(() => sources.prepare("key", origin, true)).toThrow("credential_source_read_only");
        expect(() => sources.prepare("alias", origin, true)).toThrow("credential_source_read_only");
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
