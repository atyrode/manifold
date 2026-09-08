import { expect, test } from "bun:test";
import {
  closeSync,
  chmodSync,
  constants,
  ftruncateSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HeldDirectory } from "../src/job-files.ts";
import { resolveJobLocation } from "../src/job-locations.ts";
import { JobOutputStore, type JobOutputLease } from "../src/job-outputs.ts";

const proof = { workloadEmpty: true, writersReleased: true } as const;
function fixture(
  run: (context: {
    root: string;
    admitted: HeldDirectory;
    privateDirectory: HeldDirectory;
    store: JobOutputStore;
    create: (name?: string, maxBytes?: number) => JobOutputLease;
  }) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "job-outputs-"));
  mkdirSync(join(root, "admitted"), { mode: 0o700 });
  mkdirSync(join(root, "private"), { mode: 0o700 });
  const admitted = HeldDirectory.openAbsolute(join(root, "admitted"));
  const privateDirectory = HeldDirectory.openAbsolute(join(root, "private"), { private: true });
  const store = JobOutputStore.open(privateDirectory);
  const leases: JobOutputLease[] = [];
  try {
    run({
      root,
      admitted,
      privateDirectory,
      store,
      create: (name = "result", maxBytes = 65536) => {
        const lease = store.create(
          "job-1",
          { name, locationId: "plugin:output", components: [name] },
          admitted,
          maxBytes,
        );
        leases.push(lease);
        return lease;
      },
    });
  } finally {
    for (const lease of leases) {
      try {
        store.abort(lease);
      } catch {
        /* Already sealed or aborted. */
      }
    }
    store.close();
    admitted.close();
    privateDirectory.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const linuxTest = process.platform === "linux" ? test : test.skip;
linuxTest("sealing requires both explicit empty proof and release of every retained writer", () => {
  fixture(({ store, create }) => {
    const lease = create();
    const release = lease.retainWriter();
    writeFileSync(`${lease.directory.procPath}/answer`, "retained");
    expect(() => store.seal(lease, proof)).toThrow("output_writers_active");
    expect(() => store.release("job-1", lease.outputId)).toThrow("output_lease_active");
    release();
    release();
    expect(() =>
      store.seal(lease, { workloadEmpty: false, writersReleased: true } as unknown as typeof proof),
    ).toThrow("output_writers_active");
    const output = store.seal(lease, proof);
    expect(output.files).toBe(1);
    expect(() => lease.retainWriter()).toThrow("output_lease_inactive");
  });
});

linuxTest(
  "global writers retain overlapping leases regardless of job or registration order",
  () => {
    fixture(({ store, admitted, root, create }) => {
      const releaseParent = store.retainWriter(admitted.fd);
      expect(() =>
        resolveJobLocation(
          admitted,
          "fixture.create",
          { anchor: "state", components: ["new"], revision: "one" },
          "create",
          undefined,
          (fd) => store.assertCreateAllowed(fd),
        ),
      ).toThrow("create_location_writer_active");
      const lease = create();
      mkdirSync(`${lease.directory.procPath}/nested`);
      writeFileSync(`${lease.directory.procPath}/nested/answer`, "all writers released");
      const nested = lease.directory.openChild("nested");
      const file = nested.openFile("answer");
      mkdirSync(join(root, "unrelated"));
      const unrelated = HeldDirectory.openAbsolute(join(root, "unrelated"));
      const releaseOther = store.retainWriter(unrelated.fd);
      const releaseDirectory = store.retainWriter(nested.fd);
      const releaseFile = store.retainWriter(file, nested.fd);
      try {
        expect(() => store.seal(lease, proof)).toThrow("output_writers_active");
        releaseParent();
        expect(() => store.seal(lease, proof)).toThrow("output_writers_active");
        releaseDirectory();
        expect(() => store.seal(lease, proof)).toThrow("output_writers_active");
        releaseFile();
        // Disjoint jobs do not prevent immutable publication.
        const output = store.seal(lease, proof);
        expect(store.read("job-1", output.outputId, 512, 20).data.toString()).toBe(
          "all writers released",
        );
      } finally {
        releaseParent();
        releaseDirectory();
        releaseFile();
        releaseOther();
        closeSync(file);
        nested.close();
        unrelated.close();
      }
    });
  },
);

linuxTest(
  "sealing rechecks held ancestry after another writer moves a live tree into output",
  () => {
    fixture(({ store, admitted, root, create }) => {
      const releaseParent = store.retainWriter(admitted.fd);
      const lease = create();
      mkdirSync(join(root, "admitted", "moving"));
      const moving = admitted.openChild("moving");
      const releaseMoving = store.retainWriter(moving.fd);
      try {
        writeFileSync(`${moving.procPath}/answer`, "moved");
        renameSync(join(root, "admitted", "moving"), `${lease.directory.procPath}/nested`);
        releaseParent();
        expect(() => store.seal(lease, proof)).toThrow("output_writers_active");
        releaseMoving();
        const output = store.seal(lease, proof);
        expect(store.read("job-1", output.outputId, 512, 5).data.toString()).toBe("moved");
      } finally {
        releaseParent();
        releaseMoving();
        moving.close();
      }
    });
  },
);

linuxTest(
  "an exact-file writer follows its inode into output and stays retained until release",
  () => {
    fixture(({ store, admitted, root, create }) => {
      const lease = create();
      mkdirSync(join(root, "admitted", "source"));
      const source = admitted.openChild("source");
      const file = source.createFile("answer");
      const release = store.retainWriter(file, source.fd);
      const other = source.createFile("unrelated");
      const releaseOther = store.retainWriter(other, source.fd);
      try {
        writeSync(file, Buffer.from("before"), 0, 6, 0);
        renameSync(`${source.procPath}/answer`, `${lease.directory.procPath}/answer`);
        // The writer's held parent is unchanged and outside the output subtree.
        expect(() => store.seal(lease, proof)).toThrow("output_writers_active");
        renameSync(`${lease.directory.procPath}/answer`, `${source.procPath}/returned`);
        expect(() => store.seal(lease, proof)).toThrow("output_writers_active");
        writeSync(file, Buffer.from("latest"), 0, 6, 0);
        renameSync(`${source.procPath}/returned`, `${lease.directory.procPath}/answer`);
        release();
        // A live exact-file writer outside this subtree must not become a global cohort.
        const output = store.seal(lease, proof);
        expect(store.read("job-1", output.outputId, 512, 6).data.toString()).toBe("latest");
      } finally {
        release();
        releaseOther();
        closeSync(other);
        closeSync(file);
        source.close();
      }
    });
  },
);

linuxTest(
  "writer refresh retains an exact file moved into a lease until its actual release",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "job-writer-refresh-"));
    const admitted = HeldDirectory.openAbsolute(root);
    const privateDirectory = admitted.openChild("private", { create: true });
    const store = JobOutputStore.open(privateDirectory);
    const file = admitted.createFile("moving");
    const lease = store.create(
      "job-1",
      { name: "result", locationId: "fixture.output", components: ["result"] },
      admitted,
      4096,
    );
    const release = store.retainWriter(file, admitted.fd);
    try {
      renameSync(`${admitted.procPath}/moving`, `${lease.directory.procPath}/answer`);
      let released = false;
      const waiting = store.waitForWriters([lease]).then(() => {
        released = true;
      });
      await Promise.resolve();
      expect(released).toBe(false);
      writeSync(file, Buffer.from("final"));
      release();
      await waiting;
      const output = store.seal(lease, proof);
      expect(store.read("job-1", output.outputId, 512, 5).data.toString()).toBe("final");
    } finally {
      release();
      closeSync(file);
      try {
        store.abort(lease);
      } catch {
        /* Already sealed. */
      }
      store.close();
      privateDirectory.close();
      admitted.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

linuxTest(
  "sealed tar bytes survive source mutation and recover with job-bound bounded reads",
  () => {
    fixture(({ root, store, privateDirectory, create }) => {
      const lease = create();
      writeFileSync(`${lease.directory.procPath}/z`, "last");
      writeFileSync(`${lease.directory.procPath}/a`, "first");
      const output = store.seal(lease, proof);
      const archive = store.read("job-1", output.outputId, 0, 65536);
      expect(archive.eof).toBe(true);
      expect(archive.data.subarray(0, 1).toString()).toBe("a");
      expect(archive.data.subarray(512, 517).toString()).toBe("first");
      expect(archive.data.subarray(1024, 1025).toString()).toBe("z");
      expect(output.sha256).toBe(createHash("sha256").update(archive.data).digest("hex"));
      writeFileSync(join(root, "admitted/result/a"), "changed");
      expect(store.read("job-1", output.outputId, 512, 5).data.toString()).toBe("first");
      expect(() => store.read("other-job", output.outputId, 0, 10)).toThrow("unknown_job_output");
      expect(() => store.read("job-1", output.outputId, -1, 10)).toThrow("invalid_output_read");
      expect(() => store.read("job-1", output.outputId, 0, 65537)).toThrow("invalid_output_read");
      expect(() => store.read("job-1", output.outputId, output.bytes + 1, 1)).toThrow(
        "invalid_output_read",
      );
      expect(store.read("job-1", output.outputId, output.bytes, 1)).toEqual({
        data: Buffer.alloc(0),
        eof: true,
      });
      store.close();
      const recovered = JobOutputStore.open(privateDirectory);
      try {
        expect(recovered.recovered("job-1")).toEqual([output]);
        expect(recovered.recovered("other-job")).toEqual([]);
        expect(recovered.read("job-1", output.outputId, 0, 65536).data).toEqual(archive.data);
        recovered.release("job-1", output.outputId);
        expect(() => recovered.read("job-1", output.outputId, 0, 1)).toThrow("unknown_job_output");
      } finally {
        recovered.close();
      }
      const released = JobOutputStore.open(privateDirectory);
      try {
        expect(released.recovered("job-1")).toEqual([]);
      } finally {
        released.close();
      }
    });
  },
);

linuxTest("collection rejects symbolic links and multiply linked regular files", () => {
  fixture(({ root, store, create }) => {
    const secret = join(root, "secret");
    writeFileSync(secret, "not-an-output");
    const symbolic = create("symbolic");
    symlinkSync(secret, `${symbolic.directory.procPath}/stolen`);
    expect(() => store.seal(symbolic, proof)).toThrow("unsafe_output_entry");
    const hard = create("hard");
    linkSync(secret, `${hard.directory.procPath}/stolen`);
    expect(() => store.seal(hard, proof)).toThrow("unsafe_output_entry");
    const directoryLink = create("directory-link");
    symlinkSync(root, `${directoryLink.directory.procPath}/outside`);
    expect(() => store.seal(directoryLink, proof)).toThrow("unsafe_output_entry");
    expect(store.recovered("job-1")).toEqual([]);
  });
});

linuxTest("output lease pins the exact directory despite replacement of its host name", () => {
  fixture(({ root, store, create }) => {
    const lease = create();
    writeFileSync(`${lease.directory.procPath}/answer`, "original");
    renameSync(join(root, "admitted/result"), join(root, "admitted/moved"));
    mkdirSync(join(root, "admitted/result"));
    writeFileSync(join(root, "admitted/result/answer"), "substitute");
    const output = store.seal(lease, proof);
    expect(store.read("job-1", output.outputId, 512, 8).data.toString()).toBe("original");
  });
});

linuxTest(
  "binding resolution refuses existing leaf, traversal and symbolic intermediate directories",
  () => {
    fixture(({ root, store, admitted, create }) => {
      create();
      expect(() => create()).toThrow();
      symlinkSync(root, join(root, "admitted/escape"));
      expect(() =>
        store.create(
          "job-1",
          { name: "x", locationId: "plugin:output", components: ["escape", "x"] },
          admitted,
          65536,
        ),
      ).toThrow();
      expect(() =>
        store.create(
          "job-1",
          { name: "x", locationId: "plugin:output", components: ["..", "x"] },
          admitted,
          65536,
        ),
      ).toThrow("invalid_output_component");
    });
  },
);

linuxTest("wire budget includes tar framing and failed collection publishes no output", () => {
  fixture(({ store, create }) => {
    const lease = create("bounded", 2048);
    writeFileSync(`${lease.directory.procPath}/payload`, Buffer.alloc(513));
    expect(() => store.seal(lease, proof)).toThrow("output_byte_limit");
    expect(store.recovered("job-1")).toEqual([]);
    expect(() => store.read("job-1", lease.outputId, 0, 1)).toThrow("unknown_job_output");
  });
});

linuxTest(
  "remaining aggregate budget rejects sparse payloads before materializing their holes",
  () => {
    fixture(({ store, privateDirectory, create }) => {
      const aggregateBytes = 65536;
      const stdio = store.createByteStream("job-1", "stdout", aggregateBytes);
      stdio.write(Buffer.alloc(1024));
      const stdout = stdio.seal(proof);
      let remainingBytes = aggregateBytes - stdout.bytes;
      const leases = Array.from({ length: 30 }, (_, index) =>
        create(`sparse-${index}`, aggregateBytes),
      );
      for (const lease of leases) {
        const file = lease.directory.openFile("hole", constants.O_CREAT | constants.O_RDWR);
        try {
          ftruncateSync(file, 32768);
        } finally {
          closeSync(file);
        }
      }
      const first = store.seal(leases[0]!, proof, remainingBytes);
      remainingBytes -= first.bytes;
      const removedStageSizes: number[] = [];
      const unlink = privateDirectory.unlink.bind(privateDirectory);
      privateDirectory.unlink = (name) => {
        if (name.startsWith(".stage-"))
          removedStageSizes.push(lstatSync(`${privateDirectory.procPath}/${name}`).size);
        unlink(name);
      };
      expect(() => store.seal(leases[1]!, proof, remainingBytes)).toThrow("output_byte_limit");
      expect(removedStageSizes).toEqual([0]);
      expect(store.recovered("job-1")).toEqual([stdout, first]);
      store.release("job-1", stdout.outputId);
      store.release("job-1", first.outputId);
      expect(privateDirectory.names()).toEqual([]);
    });
  },
);

linuxTest("remaining budget includes padded tar payload and end records", () => {
  fixture(({ store, privateDirectory, create }) => {
    const lease = create();
    writeFileSync(`${lease.directory.procPath}/payload`, Buffer.alloc(513));
    expect(() => store.seal(lease, proof, 2049)).toThrow("output_byte_limit");
    expect(privateDirectory.names()).toEqual([]);
    expect(() => store.seal(lease, proof, 1023)).toThrow("output_byte_limit");
    expect(privateDirectory.names()).toEqual([]);
    expect(store.seal(lease, proof, 2560).bytes).toBe(2560);
  });
});

linuxTest("recovery refuses tampered immutable bytes rather than serving a stale digest", () => {
  fixture(({ root, store, privateDirectory, create }) => {
    const lease = create();
    const output = store.seal(lease, proof);
    store.close();
    const path = join(root, "private", `${output.outputId}.tar`);
    chmodSync(path, 0o600);
    writeFileSync(path, Buffer.alloc(output.bytes, 1));
    chmodSync(path, 0o400);
    expect(() => JobOutputStore.open(privateDirectory)).toThrow("sealed_output_corrupt");
  });
});

linuxTest("stdio seals exact raw binary bytes and recovers without archive framing", () => {
  fixture(({ store, privateDirectory }) => {
    const stream = store.createByteStream("job-1", "stdout", 8);
    let output;
    try {
      stream.write(new Uint8Array([0, 255, 10]));
      stream.write(Buffer.from("done"));
      expect(() => store.release("job-1", stream.outputId)).toThrow("output_lease_active");
      expect(() =>
        stream.seal({ workloadEmpty: true, writersReleased: false } as unknown as typeof proof),
      ).toThrow("output_writers_active");
      output = stream.seal(proof);
      expect(output.bytes).toBe(7);
      expect(output.files).toBe(1);
      expect(store.read("job-1", output.outputId, 0, 8).data).toEqual(
        Buffer.from([0, 255, 10, 100, 111, 110, 101]),
      );
      expect(() => stream.write(Buffer.from("x"))).toThrow("output_stream_inactive");
      expect(() => store.createByteStream("job-1", "stdout", 8)).toThrow("output_name_collision");
    } finally {
      stream.abort();
    }
    store.close();
    const recovered = JobOutputStore.open(privateDirectory);
    try {
      expect(recovered.recovered("job-1")).toEqual([output]);
      expect(recovered.read("job-1", output.outputId, 3, 4)).toEqual({
        data: Buffer.from("done"),
        eof: true,
      });
      recovered.release("job-1", output.outputId);
      expect(recovered.recovered("job-1")).toEqual([]);
    } finally {
      recovered.close();
    }
  });
});

linuxTest(
  "stdio overflow poisons sealing instead of publishing a silently truncated prefix",
  () => {
    fixture(({ store, create }) => {
      const stream = store.createByteStream("job-1", "stderr", 3);
      try {
        expect(() => create("stderr")).toThrow("output_name_collision");
        expect(() => store.createByteStream("job-1", "stderr", 3)).toThrow("output_name_collision");
        stream.write(Buffer.from("abc"));
        expect(() => stream.write(Buffer.from("d"))).toThrow("output_byte_limit");
        expect(() => stream.seal(proof)).toThrow("output_stream_inactive");
        expect(store.recovered("job-1")).toEqual([]);
      } finally {
        stream.abort();
      }
      expect(() => store.read("job-1", stream.outputId, 0, 1)).toThrow("unknown_job_output");
    });
  },
);

linuxTest("empty stdio remains an authenticated recoverable zero-byte output", () => {
  fixture(({ store, privateDirectory }) => {
    const stream = store.createByteStream("job-1", "stdout", 1);
    let output;
    try {
      output = stream.seal(proof);
      expect(output.bytes).toBe(0);
      expect(output.sha256).toBe(createHash("sha256").digest("hex"));
      expect(store.read("job-1", output.outputId, 0, 1)).toEqual({
        data: Buffer.alloc(0),
        eof: true,
      });
    } finally {
      stream.abort();
    }
    store.close();
    const recovered = JobOutputStore.open(privateDirectory);
    try {
      expect(recovered.recovered("job-1")).toEqual([output]);
      expect(recovered.read("job-1", output.outputId, 0, 1)).toEqual({
        data: Buffer.alloc(0),
        eof: true,
      });
    } finally {
      recovered.close();
    }
  });
});
