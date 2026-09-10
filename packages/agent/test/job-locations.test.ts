import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  linkSync,
  rmSync,
  renameSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeldDirectory } from "../src/job-files.ts";
import {
  DirectoryExclusions,
  resolveJobLocation,
  resolveManagedJobLocation,
  type JobLocation,
} from "../src/job-locations.ts";
import { JobOutputStore } from "../src/job-outputs.ts";

describe.skipIf(process.platform !== "linux")("named location descriptor boundaries", () => {
  test("managed state persists across concurrent opens and recovery without adopting another plugin's files", () => {
    const path = mkdtempSync(join(tmpdir(), "job-managed-state-"));
    let root = HeldDirectory.openAbsolute(path, { private: true });
    const declaration = {
      anchor: "state" as const,
      components: ["accounts"],
      revision: "one",
      kind: "directory" as const,
      managed: true as const,
    };
    const outputDirectory = root.openChild("output-control", { create: true });
    const outputs = JobOutputStore.open(outputDirectory);
    const beforeCreate = (fd: number) => outputs.assertCreateAllowed(fd);
    const opened: JobLocation[] = [];
    let release: (() => void) | undefined;
    try {
      const first = resolveManagedJobLocation(
        root,
        "plugin-a",
        "accounts",
        declaration,
        "write",
        beforeCreate,
      );
      opened.push(first);
      release = outputs.retainWriter(first.fd);
      const signIn = resolveManagedJobLocation(
        root,
        "plugin-a",
        "accounts",
        declaration,
        "write",
        beforeCreate,
      );
      opened.push(signIn);
      writeFileSync(`${signIn.directory!.procPath}/account`, "owned by the runtime", {
        mode: 0o600,
      });
      expect(readFileSync(`${first.directory!.procPath}/account`, "utf8")).toBe(
        "owned by the runtime",
      );
      expect(() =>
        resolveManagedJobLocation(root, "plugin-b", "accounts", declaration, "read", beforeCreate),
      ).toThrow();
      const other = resolveManagedJobLocation(
        root,
        "plugin-b",
        "accounts",
        declaration,
        "write",
        beforeCreate,
      );
      opened.push(other);
      expect(existsSync(`${other.directory!.procPath}/account`)).toBe(false);
      release();
      release = undefined;
      for (const location of opened.splice(0)) location.close();
      root.close();
      root = HeldDirectory.openAbsolute(path, { private: true });
      const recovered = resolveManagedJobLocation(
        root,
        "plugin-a",
        "accounts",
        declaration,
        "read",
        beforeCreate,
      );
      opened.push(recovered);
      expect(readFileSync(`${recovered.directory!.procPath}/account`, "utf8")).toBe(
        "owned by the runtime",
      );
      expect(() => resolveJobLocation(root, "accounts", declaration, "write")).toThrow(
        "managed_location_requires_native_store",
      );
      const exclusions = new DirectoryExclusions([root]);
      expect(() =>
        resolveJobLocation(
          root,
          "accounts",
          {
            anchor: "state",
            components: ["plugin-a", "accounts"],
            revision: "one",
          },
          "write",
          exclusions,
        ),
      ).toThrow("private_owner_source_overlap");
    } finally {
      release?.();
      for (const location of opened) location.close();
      outputs.close();
      outputDirectory.close();
      root.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("private owner ancestors, descendants and files stay denied despite declared access", () => {
    const root = mkdtempSync(join(tmpdir(), "job-private-"));
    mkdirSync(join(root, "state"));
    mkdirSync(join(root, "state", "owner"), { mode: 0o700 });
    writeFileSync(join(root, "state", "owner", "key"), "private", { mode: 0o600 });
    const anchor = HeldDirectory.openAbsolute(root);
    const privateRoot = HeldDirectory.openAbsolute(join(root, "state", "owner"));
    const exclusions = new DirectoryExclusions([privateRoot]);
    try {
      for (const components of [["state"], ["state", "owner"], ["state", "owner", "created"]]) {
        expect(() =>
          resolveJobLocation(
            anchor,
            "fixture.resource",
            { anchor: "state", components, revision: "one" },
            "create",
            exclusions,
          ),
        ).toThrow();
      }
      expect(existsSync(join(root, "state", "owner", "created"))).toBe(false);
      expect(() =>
        resolveJobLocation(
          anchor,
          "fixture.key",
          { anchor: "state", components: ["state", "owner", "key"], revision: "one", kind: "file" },
          "read",
          exclusions,
        ),
      ).toThrow("private_owner_source_overlap");
    } finally {
      privateRoot.close();
      anchor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("create cannot reuse an existing file or directory, while write requires one", () => {
    const root = mkdtempSync(join(tmpdir(), "job-create-"));
    mkdirSync(join(root, "existing-directory"));
    writeFileSync(join(root, "existing-file"), "keep");
    const anchor = HeldDirectory.openAbsolute(root);
    try {
      for (const kind of ["file", "directory"] as const) {
        const declaration = {
          anchor: "state" as const,
          components: [`existing-${kind}`],
          revision: "one",
          ...(kind === "file" ? { kind: "file" as const } : {}),
        };
        expect(() => resolveJobLocation(anchor, "fixture.create", declaration, "create")).toThrow();
        const writable = resolveJobLocation(anchor, "fixture.write", declaration, "write");
        writable.close();
        const fresh = { ...declaration, components: ["existing-directory", `fresh-${kind}`] };
        expect(() => resolveJobLocation(anchor, "fixture.write", fresh, "write")).toThrow();
        const created = resolveJobLocation(anchor, "fixture.create", fresh, "create");
        expect(created.writable).toBe(true);
        created.close();
        expect(() => resolveJobLocation(anchor, "fixture.create", fresh, "create")).toThrow();
      }
      expect(readFileSync(join(root, "existing-file"), "utf8")).toBe("keep");
    } finally {
      anchor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preparing writable ancestors and create descendants is declaration-order independent", () => {
    const root = mkdtempSync(join(tmpdir(), "job-create-order-"));
    const anchor = HeldDirectory.openAbsolute(root);
    const privateDirectory = anchor.openChild("private", { create: true });
    const outputs = JobOutputStore.open(privateDirectory);
    try {
      for (const ancestorFirst of [true, false]) {
        const parent = `parent-${ancestorFirst}`;
        mkdirSync(join(root, parent));
        const preparation = {};
        const locations: JobLocation[] = [];
        const releases: (() => void)[] = [];
        try {
          const declarations = [
            { components: [parent], access: "write" as const },
            { components: [parent, "fresh"], access: "create" as const },
          ];
          if (!ancestorFirst) declarations.reverse();
          for (const declaration of declarations) {
            const location = resolveJobLocation(
              anchor,
              "fixture.location",
              { anchor: "state", components: declaration.components, revision: "one" },
              declaration.access,
              undefined,
              (fd) => outputs.assertCreateAllowed(fd, preparation),
            );
            locations.push(location);
            releases.push(outputs.retainWriter(location.fd, location.parentFd, preparation));
          }
          expect(existsSync(join(root, parent, "fresh"))).toBe(true);
          // A different preparation cannot bypass a writer from this now-live job.
          expect(() =>
            resolveJobLocation(
              anchor,
              "fixture.unrelated",
              { anchor: "state", components: [parent, "other"], revision: "one" },
              "create",
              undefined,
              (fd) => outputs.assertCreateAllowed(fd, {}),
            ),
          ).toThrow("create_location_writer_active");
          expect(existsSync(join(root, parent, "other"))).toBe(false);
        } finally {
          for (const release of releases) release();
          for (const location of locations) location.close();
        }
      }
    } finally {
      outputs.close();
      privateDirectory.close();
      anchor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exact file does not grant its parent and remains pinned after a pathname replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "job-location-"));
    mkdirSync(join(root, "plugin"));
    writeFileSync(join(root, "plugin", "selected"), "admitted");
    writeFileSync(join(root, "plugin", "secret"), "unadmitted");
    const anchor = HeldDirectory.openAbsolute(root);
    try {
      const resource = resolveJobLocation(
        anchor,
        "fixture.selected",
        {
          anchor: "config",
          components: ["plugin", "selected"],
          revision: "one",
          kind: "file",
          guestPath: "/home/job/.config/plugin/selected",
        },
        "read",
      );
      try {
        expect(resource.directory).toBeNull();
        expect(resource.writable).toBe(false);
        renameSync(join(root, "plugin", "selected"), join(root, "plugin", "old"));
        writeFileSync(join(root, "plugin", "selected"), "replacement");
        expect(readFileSync(resource.fd, "utf8")).toBe("admitted");
      } finally {
        resource.close();
      }
    } finally {
      anchor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlinks, hardlinks and guest traversal refuse before a resource is mounted", () => {
    const root = mkdtempSync(join(tmpdir(), "job-location-"));
    writeFileSync(join(root, "source"), "private");
    symlinkSync("source", join(root, "symbolic"));
    linkSync(join(root, "source"), join(root, "hard"));
    const anchor = HeldDirectory.openAbsolute(root);
    try {
      for (const name of ["symbolic", "hard"])
        expect(() =>
          resolveJobLocation(
            anchor,
            "fixture.file",
            { anchor: "config", components: [name], revision: "one", kind: "file" },
            "read",
          ),
        ).toThrow();
      expect(() =>
        resolveJobLocation(
          anchor,
          "fixture.file",
          {
            anchor: "config",
            components: ["source"],
            revision: "one",
            kind: "file",
            guestPath: "/home/job/../escape",
          },
          "read",
        ),
      ).toThrow("invalid_guest_location");
    } finally {
      anchor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
