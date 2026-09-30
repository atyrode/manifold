import { describe, expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateByteFile, isSealedByteFile } from "../src/job-files.ts";
import { stableNativeSnapshot } from "../src/native-transfer-snapshot.ts";

const supported = process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64");
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

describe.skipIf(!supported)("native snapshot reservation boundary", () => {
  test("growth after reservation is rejected before the helper writes any private bytes", async () => {
    for (const initialBytes of [0, 3]) {
      const directory = mkdtempSync(join(tmpdir(), "native-reservation-"));
      let source = -1;
      let output = -1;
      try {
        const path = join(directory, "source");
        writeFileSync(path, Buffer.alloc(initialBytes), { mode: 0o600 });
        source = openSync(path, "r");
        const reservation = fstatSync(source).size;
        // The writable description is closed before the helper starts. A coherent lease on
        // this newer revision must not grant bytes that were absent from the reservation.
        writeFileSync(path, Buffer.alloc(256 * 1024 + 1, 7));
        output = createPrivateByteFile();
        const child = Bun.spawn([process.execPath, entry, "--native-transfer-snapshot", String(reservation)], {
          cwd: "/", env: {}, stdio: ["ignore", "ignore", "ignore", source, output],
        });
        expect(await child.exited).toBe(4);
        expect(fstatSync(output).size).toBe(0);
        await expect(stableNativeSnapshot(source, reservation, new AbortController().signal))
          .rejects.toThrow("native_source_changed");
      } finally {
        if (source >= 0) closeSync(source);
        if (output >= 0) closeSync(output);
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("an unchanged source uses exactly its reservation and produces sealed bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "native-reservation-"));
    let source = -1;
    let snapshot = -1;
    try {
      const path = join(directory, "source");
      const bytes = Buffer.from("reserved immutable bytes");
      writeFileSync(path, bytes, { mode: 0o600 });
      source = openSync(path, "r");
      snapshot = await stableNativeSnapshot(source, bytes.length, new AbortController().signal);
      expect(isSealedByteFile(snapshot)).toBe(true);
      expect(fstatSync(snapshot).size).toBe(bytes.length);
      expect(readFileSync(snapshot)).toEqual(bytes);
    } finally {
      if (source >= 0) closeSync(source);
      if (snapshot >= 0) closeSync(snapshot);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
