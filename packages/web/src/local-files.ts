import {
  ByteTransferError,
  MAX_BYTE_CHUNK_BYTES,
  MAX_LOCAL_FILE_BYTES,
  MAX_LOCAL_FILES,
  type LocalFileDescriptor,
} from "@manifold/protocol";

/** One mounted contribution's browser-selected files. capture() is host-only. */
export class LocalFileStore {
  private readonly files = new Map<string, Blob>();
  private readonly reads = new Map<AbortController, string>();
  private closed = false;

  capture(files: readonly File[]): readonly LocalFileDescriptor[] {
    if (this.closed) throw new ByteTransferError("unavailable");
    if (files.length === 0 || files.length + this.files.size > MAX_LOCAL_FILES) {
      throw new ByteTransferError("busy");
    }
    if (files.some((file) => file.size > MAX_LOCAL_FILE_BYTES)) {
      throw new ByteTransferError("invalid");
    }
    // Admission is all-or-none, including the metadata that crosses the guest boundary.
    return files.map((file) => {
      const handle = crypto.randomUUID();
      const sourceName = file.name;
      let name = "";
      for (let index = 0; index < sourceName.length && name.length < 255; index++) {
        const code = sourceName.charCodeAt(index);
        if (code > 0x1f && code !== 0x7f) name += sourceName[index];
      }
      this.files.set(handle, file);
      return {
        handle,
        name,
        mediaType: file.type.slice(0, 128),
        bytes: file.size,
      };
    });
  }

  async read(
    handle: string,
    offset: number,
    length: number,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<Uint8Array> {
    const file = this.files.get(handle);
    if (this.closed || file === undefined) throw new ByteTransferError("unavailable");
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > MAX_BYTE_CHUNK_BYTES ||
      offset + length > file.size
    ) {
      throw new ByteTransferError("invalid");
    }
    if (options?.signal?.aborted) throw new ByteTransferError("cancelled");
    if (this.reads.size >= MAX_LOCAL_FILES) throw new ByteTransferError("busy");
    if (typeof FileReader === "undefined") throw new ByteTransferError("unsupported");
    const controller = new AbortController();
    this.reads.set(controller, handle);
    const cancel = (): void => controller.abort();
    options?.signal?.addEventListener("abort", cancel, { once: true });
    // FileReader has a real abort (Blob.arrayBuffer() does not). A sliced read owns exactly
    // this chunk's backing buffer; it is safe to transfer it across the worker bridge.
    const reader = new FileReader();
    const abort = (): void => reader.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    try {
      const completion = Promise.withResolvers<ArrayBuffer>();
      reader.onload = () =>
        reader.result instanceof ArrayBuffer
          ? completion.resolve(reader.result)
          : completion.reject(new ByteTransferError("unavailable"));
      reader.onerror = () => completion.reject(new ByteTransferError("unavailable"));
      reader.onabort = () => completion.reject(new ByteTransferError("cancelled"));
      reader.readAsArrayBuffer(file.slice(offset, offset + length));
      const data = await completion.promise;
      if (controller.signal.aborted || options?.signal?.aborted)
        throw new ByteTransferError("cancelled");
      if (this.closed || this.files.get(handle) !== file)
        throw new ByteTransferError("unavailable");
      if (data.byteLength !== length) throw new ByteTransferError("invalid");
      return new Uint8Array(data);
    } finally {
      options?.signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", abort);
      reader.onload = reader.onerror = reader.onabort = null;
      this.reads.delete(controller);
    }
  }

  async release(handle: string): Promise<void> {
    this.files.delete(handle);
    for (const [reader, owner] of this.reads) {
      if (owner === handle) reader.abort();
    }
  }

  close(): void {
    this.closed = true;
    this.files.clear();
    for (const reader of this.reads.keys()) reader.abort();
    this.reads.clear();
  }
}
