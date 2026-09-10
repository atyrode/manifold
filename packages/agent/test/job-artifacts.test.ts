import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync, deflateRawSync } from "node:zlib";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync,
  writeSync,
  renameSync,
  mkdirSync,
  closeSync,
  readFileSync,
  constants,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineArtifact } from "@manifold/protocol";
import {
  acquireArtifact,
  artifactCacheKey,
  isPublicArtifactAddress,
  openCachedArtifact,
} from "../src/job-artifacts.ts";
import { HeldDirectory } from "../src/job-files.ts";
import { extractArtifact } from "@manifold/plugin-kit/artifacts";

const executable = Buffer.from("#!/bin/sh\nexit 0\n");
function specification(archive: Buffer, format: MachineArtifact["format"]): MachineArtifact {
  return {
    url: "https://example.com/tool",
    sha256: createHash("sha256").update(archive).digest("hex"),
    format,
    entry: ["bin", "tool"],
    entrySha256: createHash("sha256").update(executable).digest("hex"),
    maxBytes: 65536,
    maxExpandedBytes: 65536,
    maxMembers: 8,
  };
}
function tarMember(name = "bin/tool", kind = "0", contents = executable): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${contents.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write(kind, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, contents, Buffer.alloc((512 - (contents.length % 512)) % 512)]);
}
function zipMember(name = "bin/tool", mode = 0o100755, method = 8, unixMetadata = false): Buffer {
  const nameBytes = Buffer.from(name);
  const compressed = method === 8 ? deflateRawSync(executable) : executable;
  let crc = 0xffffffff;
  for (const byte of executable) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(executable.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const localExtra = Buffer.alloc(unixMetadata ? 16 : 0);
  const centralExtra = Buffer.alloc(unixMetadata ? 12 : 0);
  if (unixMetadata) {
    localExtra.writeUInt16LE(0x5855);
    localExtra.writeUInt16LE(12, 2);
    centralExtra.writeUInt16LE(0x5855);
    centralExtra.writeUInt16LE(8, 2);
  }
  local.writeUInt16LE(localExtra.length, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(0x314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(executable.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(centralExtra.length, 30);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length + centralExtra.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + localExtra.length + compressed.length, 16);
  return Buffer.concat([
    local,
    nameBytes,
    localExtra,
    compressed,
    central,
    nameBytes,
    centralExtra,
    end,
  ]);
}

test("extracts the exact hash-pinned executable from raw, tar.gz, stored and deflated zip", async () => {
  const fixtures: [Buffer, MachineArtifact["format"]][] = [
    [executable, "raw"],
    [gzipSync(Buffer.concat([tarMember(), Buffer.alloc(1024)])), "tar.gz"],
    [zipMember(), "zip"],
    [zipMember("bin/tool", 0o100755, 0), "zip"],
  ];
  for (const [archive, format] of fixtures)
    expect(
      (await extractArtifact(archive, specification(archive, format), new AbortController().signal))
        .executable,
    ).toEqual(executable);
});

test("rejects archive and executable digest mismatch independently", async () => {
  const spec = specification(executable, "raw");
  await expect(
    extractArtifact(Buffer.from("changed"), spec, new AbortController().signal),
  ).rejects.toThrow("artifact_archive_digest");
  await expect(
    extractArtifact(
      executable,
      { ...spec, entrySha256: "0".repeat(64) },
      new AbortController().signal,
    ),
  ).rejects.toThrow("artifact_entry_digest");
});

test("refuses tar links, traversal, duplicate entry and expansion or member overflow", async () => {
  for (const member of [
    tarMember("../tool"),
    tarMember("bin/tool", "2"),
    tarMember("bin/tool", "1"),
    Buffer.concat([tarMember(), tarMember()]),
  ]) {
    const archive = gzipSync(Buffer.concat([member, Buffer.alloc(1024)]));
    await expect(
      extractArtifact(archive, specification(archive, "tar.gz"), new AbortController().signal),
    ).rejects.toThrow();
  }
  const archive = gzipSync(Buffer.concat([tarMember("other"), tarMember(), Buffer.alloc(1024)]));
  await expect(
    extractArtifact(
      archive,
      { ...specification(archive, "tar.gz"), maxMembers: 1 },
      new AbortController().signal,
    ),
  ).rejects.toThrow("artifact_member_limit");
  await expect(
    extractArtifact(
      archive,
      { ...specification(archive, "tar.gz"), maxExpandedBytes: 32 },
      new AbortController().signal,
    ),
  ).rejects.toThrow("artifact_expanded_limit");
});

test("refuses zip symlinks, path traversal and mismatched local member identity", async () => {
  for (const archive of [zipMember("bin/tool", 0o120777), zipMember("../tool")])
    await expect(
      extractArtifact(archive, specification(archive, "zip"), new AbortController().signal),
    ).rejects.toThrow();
  const archive = zipMember();
  archive[30] = 120;
  await expect(
    extractArtifact(archive, specification(archive, "zip"), new AbortController().signal),
  ).rejects.toThrow("artifact_invalid_zip_local");
});

test("discards bounded ZIP Unix metadata without permitting identity extensions or malformed fields", async () => {
  const original = zipMember("bin/tool", 0o100755, 8, true);
  expect(
    (await extractArtifact(original, specification(original, "zip"), new AbortController().signal))
      .executable,
  ).toEqual(executable);
  const localExtra = 30 + Buffer.byteLength("bin/tool");
  const centralExtra =
    original.readUInt32LE(original.length - 6) + 46 + Buffer.byteLength("bin/tool");
  for (const [offset, value] of [
    [localExtra, 1],
    [centralExtra, 1],
    [localExtra + 2, 13],
    [centralExtra + 2, 9],
  ]) {
    const archive = Buffer.from(original);
    archive.writeUInt16LE(value!, offset!);
    await expect(
      extractArtifact(archive, specification(archive, "zip"), new AbortController().signal),
    ).rejects.toThrow();
  }
});

test("refuses nonpublic destination forms, including mapped and transition IPv6", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fe80::1",
    "2002:7f00:1::",
    "2001:db8::1",
  ])
    expect(isPublicArtifactAddress(address)).toBe(false);
  expect(isPublicArtifactAddress("8.8.8.8")).toBe(true);
  expect(isPublicArtifactAddress("2606:4700:4700::1111")).toBe(true);
});

test("acquisition refuses missing destination consent and private addresses before connection", async () => {
  const path = mkdtempSync(join(tmpdir(), "job-artifact-"));
  const cache = HeldDirectory.openAbsolute(path, { private: true });
  try {
    const authority = { origins: [], timeoutMs: 1000, maxRedirects: 0 };
    await expect(
      acquireArtifact(specification(executable, "raw"), cache, authority),
    ).rejects.toThrow("artifact_destination_not_approved");
    await expect(
      acquireArtifact(
        { ...specification(executable, "raw"), url: "https://127.0.0.1/tool" },
        cache,
        { ...authority, origins: ["https://127.0.0.1"] },
      ),
    ).rejects.toThrow("artifact_private_destination");
    expect(cache.names()).toEqual([]);
  } finally {
    cache.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("held descriptors reject symlinks and hardlinks and survive ancestor replacement", () => {
  const path = mkdtempSync(join(tmpdir(), "job-files-"));
  const root = HeldDirectory.openAbsolute(path, { private: true });
  try {
    root.atomicWrite("original", "pinned");
    symlinkSync("original", join(path, "symlink"));
    linkSync(join(path, "original"), join(path, "hardlink"));
    expect(() => root.openFile("symlink")).toThrow();
    expect(() => root.openFile("hardlink")).toThrow();
    expect(() => root.openChild("..")).toThrow();
    expect(() => root.openFile("original", constants.O_WRONLY | constants.O_TRUNC)).toThrow(
      "unsafe_open_truncation",
    );
    const child = root.openChild("child", { create: true });
    try {
      child.atomicWrite("value", "held");
      renameSync(join(path, "child"), join(path, "moved"));
      mkdirSync(join(path, "child"));
      writeFileSync(join(path, "child", "value"), "replacement");
      const fd = child.openFile("value");
      try {
        expect(readFileSync(fd, "utf8")).toBe("held");
      } finally {
        closeSync(fd);
      }
    } finally {
      child.close();
    }
  } finally {
    root.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("runtime file handles read shared storage without granting writes or following symlinks", () => {
  const path = mkdtempSync(join(tmpdir(), "runtime-files-"));
  const root = HeldDirectory.openAbsolute(path, { private: true });
  try {
    writeFileSync(join(path, "original"), "runtime bytes", { mode: 0o444 });
    linkSync(join(path, "original"), join(path, "shared"));
    symlinkSync("original", join(path, "symbolic"));
    const fd = root.openRuntimeFile("shared");
    try {
      expect(readFileSync(fd, "utf8")).toBe("runtime bytes");
      expect(() => writeSync(fd, "changed")).toThrow(/EBADF/);
    } finally {
      closeSync(fd);
    }
    expect(() => root.openRuntimeFile("symbolic")).toThrow(/ELOOP/);
  } finally {
    root.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("already cancelled acquisition extraction never returns executable bytes", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    extractArtifact(executable, specification(executable, "raw"), controller.signal),
  ).rejects.toThrow();
});

test("wall-clock deadline refuses synchronous extraction before publication", async () => {
  await expect(
    extractArtifact(executable, specification(executable, "raw"), new AbortController().signal, 0),
  ).rejects.toThrow("artifact_deadline");
});

test("held descendant resolution refuses procfs mount crossing", () => {
  const root = HeldDirectory.openAbsolute("/");
  try {
    expect(() => root.openChild("proc")).toThrow("mount_escape");
  } finally {
    root.close();
  }
});

test("a tar bundle verifies each exact runtime executable independently", async () => {
  const runtime = Buffer.from("#!/bin/sh\nprintf runtime\n");
  const archive = gzipSync(
    Buffer.concat([
      tarMember(),
      tarMember("runtime/engine", "0", runtime),
      tarMember("not-selected", "0", Buffer.from("ignored")),
      Buffer.alloc(1024),
    ]),
  );
  const spec: MachineArtifact = {
    ...specification(archive, "tar.gz"),
    files: {
      engine: {
        entry: ["runtime", "engine"],
        sha256: createHash("sha256").update(runtime).digest("hex"),
      },
    },
  };
  const extracted = await extractArtifact(archive, spec, new AbortController().signal);
  expect(extracted.executable).toEqual(executable);
  expect(Object.keys(extracted.files)).toEqual(["engine"]);
  expect(extracted.files.engine).toEqual(runtime);
  await expect(
    extractArtifact(
      archive,
      { ...spec, files: { engine: { entry: ["runtime", "engine"], sha256: "0".repeat(64) } } },
      new AbortController().signal,
    ),
  ).rejects.toThrow("artifact_entry_digest");
  await expect(
    extractArtifact(
      archive,
      {
        ...spec,
        files: { engine: { entry: ["runtime", "missing"], sha256: spec.files!.engine!.sha256 } },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("artifact_entry_digest");
});

test("all requested bundle entries reject links and duplicate members, not only primary", async () => {
  for (const members of [
    [tarMember("runtime/engine", "2")],
    [tarMember("runtime/engine"), tarMember("runtime/engine")],
  ]) {
    const archive = gzipSync(Buffer.concat([tarMember(), ...members, Buffer.alloc(1024)]));
    const spec: MachineArtifact = {
      ...specification(archive, "tar.gz"),
      files: {
        engine: {
          entry: ["runtime", "engine"],
          sha256: specification(executable, "raw").entrySha256,
        },
      },
    };
    await expect(extractArtifact(archive, spec, new AbortController().signal)).rejects.toThrow();
  }
});

test("zip bundle entries share one bounded archive scan and separate digest checks", async () => {
  const parts = [zipMember(), zipMember("runtime/engine")];
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const end = part.length - 22;
    const centralOffset = part.readUInt32LE(end + 16);
    const local = part.subarray(0, centralOffset);
    const central = Buffer.from(part.subarray(centralOffset, end));
    central.writeUInt32LE(offset, 42);
    offset += local.length;
    locals.push(local);
    directory.push(central);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(
    directory.reduce((size, bytes) => size + bytes.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...locals, ...directory, end]);
  const spec: MachineArtifact = {
    ...specification(archive, "zip"),
    files: {
      engine: {
        entry: ["runtime", "engine"],
        sha256: specification(executable, "raw").entrySha256,
      },
    },
  };
  const extracted = await extractArtifact(archive, spec, new AbortController().signal);
  expect(extracted.executable).toEqual(executable);
  expect(extracted.files.engine).toEqual(executable);
  await expect(
    extractArtifact(
      archive,
      { ...spec, maxExpandedBytes: executable.length },
      new AbortController().signal,
    ),
  ).rejects.toThrow("artifact_expanded_limit");
});

test("raw delivery cannot claim extra bundled executable entries", async () => {
  const spec: MachineArtifact = {
    ...specification(executable, "raw"),
    files: {
      engine: {
        entry: ["runtime", "engine"],
        sha256: specification(executable, "raw").entrySha256,
      },
    },
  };
  await expect(extractArtifact(executable, spec, new AbortController().signal)).rejects.toThrow();
});

test("cache recovery pins primary and runtime bytes and closes every descriptor idempotently", () => {
  const runtime = Buffer.from("runtime executable bytes");
  const runtimeHash = createHash("sha256").update(runtime).digest("hex");
  const spec: MachineArtifact = {
    ...specification(Buffer.from("archive"), "tar.gz"),
    files: { engine: { entry: ["runtime", "engine"], sha256: runtimeHash } },
  };
  const path = mkdtempSync(join(tmpdir(), "job-cache-"));
  const cache = HeldDirectory.openAbsolute(path, { private: true });
  try {
    cache.atomicWrite(artifactCacheKey(spec, spec.entrySha256), executable, 0o500);
    cache.atomicWrite(artifactCacheKey(spec, runtimeHash), runtime, 0o500);
    const pinned = openCachedArtifact(spec, cache);
    try {
      cache.atomicWrite(artifactCacheKey(spec, runtimeHash), Buffer.from("replacement"), 0o500);
      expect(readFileSync(pinned.fd)).toEqual(executable);
      expect(readFileSync(pinned.files.engine!.fd)).toEqual(runtime);
    } finally {
      pinned.close();
      pinned.close();
    }
    expect(() => readFileSync(pinned.fd)).toThrow();
    expect(() => readFileSync(pinned.files.engine!.fd)).toThrow();
    expect(() => openCachedArtifact(spec, cache)).toThrow("artifact_entry_digest");
  } finally {
    cache.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("cache recovery rejects writable executables and aggregate selected byte overflow", () => {
  const runtime = Buffer.from("another executable");
  const runtimeHash = createHash("sha256").update(runtime).digest("hex");
  const spec: MachineArtifact = {
    ...specification(Buffer.from("archive"), "tar.gz"),
    files: { engine: { entry: ["runtime", "engine"], sha256: runtimeHash } },
  };
  const path = mkdtempSync(join(tmpdir(), "job-cache-"));
  const cache = HeldDirectory.openAbsolute(path, { private: true });
  try {
    cache.atomicWrite(artifactCacheKey(spec, spec.entrySha256), executable, 0o500);
    cache.atomicWrite(artifactCacheKey(spec, runtimeHash), runtime, 0o700);
    expect(() => openCachedArtifact(spec, cache)).toThrow("artifact_cache_identity");
    cache.atomicWrite(artifactCacheKey(spec, runtimeHash), runtime, 0o500);
    expect(() =>
      openCachedArtifact(
        { ...spec, maxExpandedBytes: executable.length + runtime.length - 1 },
        cache,
      ),
    ).toThrow("artifact_expanded_limit");
  } finally {
    cache.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("fresh acquisition revalidates consent and pinned cache bytes without a network dependency", async () => {
  const spec: MachineArtifact = {
    ...specification(executable, "raw"),
    url: "https://custody.invalid/tool",
  };
  const authority = {
    origins: ["https://custody.invalid"],
    maxRedirects: 0,
    timeoutMs: 1000,
  };
  const path = mkdtempSync(join(tmpdir(), "job-cache-install-"));
  const cache = HeldDirectory.openAbsolute(path, { private: true });
  try {
    cache.atomicWrite(artifactCacheKey(spec, spec.entrySha256), executable, 0o500);
    const pinned = await acquireArtifact(spec, cache, authority);
    try {
      expect(readFileSync(pinned.fd)).toEqual(executable);
    } finally {
      pinned.close();
    }
    await expect(acquireArtifact(spec, cache, { ...authority, origins: [] })).rejects.toThrow(
      "artifact_destination_not_approved",
    );
    cache.atomicWrite(artifactCacheKey(spec, spec.entrySha256), Buffer.from("substitution"), 0o500);
    await expect(acquireArtifact(spec, cache, authority)).rejects.toThrow("artifact_entry_digest");
  } finally {
    cache.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("shared archive bytes never authorize a different cached entry layout", async () => {
  const archive = gzipSync(Buffer.concat([tarMember(), Buffer.alloc(1024)]));
  const spec = specification(archive, "tar.gz");
  delete spec.url;
  spec.bundleFile = "shared";
  const delivery = { bundleFile: "shared", data: archive.toString("base64") };
  const path = mkdtempSync(join(tmpdir(), "job-layout-"));
  const cache = HeldDirectory.openAbsolute(path, { private: true });
  const authority = { origins: [], maxRedirects: 0, timeoutMs: 1000 };
  const archives = new Map<string, Buffer>();
  try {
    const first = await acquireArtifact(spec, cache, authority, delivery, archives);
    first.close();
    const other = { ...spec, entry: ["missing"], entrySha256: spec.entrySha256 };
    expect(() => openCachedArtifact(other, cache)).toThrow();
    await expect(acquireArtifact(other, cache, authority, delivery, archives)).rejects.toThrow();
    const restored = openCachedArtifact(spec, cache);
    try {
      expect(readFileSync(restored.fd)).toEqual(executable);
    } finally {
      restored.close();
    }
  } finally {
    cache.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("bundled acquisition pins supplied bytes without network authority and refuses missing, extra, or substituted delivery even on cache hits", async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 1, 0x61);
  const spec: MachineArtifact = {
    ...specification(bytes, "raw"),
    url: undefined,
    bundleFile: "worker",
    maxBytes: bytes.length,
    maxExpandedBytes: bytes.length,
    entrySha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const delivery = { bundleFile: "worker", data: bytes.toString("base64") };
  const authority = { origins: [], maxRedirects: 0, timeoutMs: 5000 };
  const path = mkdtempSync(join(tmpdir(), "job-bundled-cache-"));
  const cache = HeldDirectory.openAbsolute(path, { private: true });
  try {
    await expect(acquireArtifact(spec, cache, authority)).rejects.toThrow();
    const acquired = await acquireArtifact(spec, cache, authority, delivery);
    try {
      expect(readFileSync(acquired.fd)).toEqual(bytes);
    } finally {
      acquired.close();
    }
    await expect(acquireArtifact(spec, cache, authority)).rejects.toThrow();
    await expect(
      acquireArtifact(spec, cache, authority, { ...delivery, bundleFile: "other" }),
    ).rejects.toThrow();
    await expect(
      acquireArtifact(spec, cache, authority, {
        ...delivery,
        data: Buffer.from("substitution").toString("base64"),
      }),
    ).rejects.toThrow();
    await expect(
      acquireArtifact(spec, cache, authority, {
        ...delivery,
        extra: "unrequested",
      } as typeof delivery),
    ).rejects.toThrow();
    const cached = await acquireArtifact(spec, cache, authority, delivery);
    try {
      expect(readFileSync(cached.fd)).toEqual(bytes);
    } finally {
      cached.close();
    }
    await expect(
      acquireArtifact(
        { ...spec, bundleFile: undefined, url: "https://example.com/worker" },
        cache,
        { ...authority, origins: ["https://example.com"] },
        delivery,
      ),
    ).rejects.toThrow();
  } finally {
    cache.close();
    rmSync(path, { recursive: true, force: true });
  }
});
