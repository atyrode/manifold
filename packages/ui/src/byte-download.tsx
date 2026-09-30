import {
  ByteDownloadSourceSchema, ByteTransferError,
  type ByteDownloadSource, type ByteDownloadStatus,
} from "@manifold/protocol";
import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { useByteSurfaceServices, type ByteSurfaceDownload } from "./byte-surface.tsx";
import { frameElement, frameMeta, useFrameMode } from "./frame-mode.tsx";
import type { VocabularyMeta } from "./vocabulary.tsx";

export type { ByteDownloadStatus } from "@manifold/protocol";
export interface ByteDownloadProps extends VocabularyMeta {
  readonly label: string;
  readonly filename: string;
  readonly source: ByteDownloadSource;
  readonly disabled?: boolean | undefined;
  readonly onChange?: ((status: ByteDownloadStatus) => void) | undefined;
}

/** The same author component emits a host-owned control in page and packed Worker. */
export function ByteDownload({ label, filename, source, disabled, onChange, ...rest }: ByteDownloadProps): ReactElement {
  const inFrame = useFrameMode();
  const meta = frameMeta("ByteDownload", rest);
  const identity = JSON.stringify([source, filename, disabled === true]);
  // A source replacement also retires the Worker's named callback, fencing queued
  // progress/completion events from the previous transfer rather than retargeting them.
  if (inFrame) return frameElement("byteDownload", { key: identity, label, filename, source, disabled, onChange, ...meta });
  return <BrowserDownload key={identity}
    label={label} filename={filename} source={source} disabled={disabled} onChange={onChange} {...rest} />;
}

function BrowserDownload({ label, filename, source, disabled, onChange, ...meta }: ByteDownloadProps): ReactElement {
  const services = useByteSurfaceServices();
  const callback = useRef(onChange);
  callback.current = onChange;
  const current = useRef<ByteSurfaceDownload | null>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const [status, setStatus] = useState<ByteDownloadStatus | null>(null);
  useLayoutEffect(() => {
    active.current = true;
    setStatus(null);
    return () => {
      active.current = false;
      generation.current += 1;
      current.current?.close();
      current.current = null;
    };
  }, [services]);
  const unavailable = disabled === true || services === null;
  const start = (): void => {
    if (unavailable || services === null || !active.current || current.current !== null) return;
    const stamp = ++generation.current;
    const notify = (value: ByteDownloadStatus): void => {
      if (!active.current || generation.current !== stamp) return;
      if (value.state !== "downloading") current.current = null;
      setStatus(value);
      callback.current?.(value);
    };
    try {
      const checked = ByteDownloadSourceSchema.safeParse(source);
      if (!checked.success) throw new ByteTransferError("invalid");
      current.current = services.download(checked.data, filename, notify);
    } catch (error) {
      notify({ state: "unavailable", reason: error instanceof ByteTransferError ? error.reason : "invalid" });
    }
  };
  const downloading = status?.state === "downloading";
  return <fieldset className="mf-vocab-file" {...meta}>
    <legend>{label}</legend>
    <button type="button" className="mf-vocab-button" disabled={unavailable || downloading} onClick={start}>
      Download to browser
    </button>
    {downloading ? <button type="button" className="mf-vocab-button" onClick={() => current.current?.cancel()}>
      Cancel download
    </button> : null}
    <span className="mf-vocab-text" role="status">
      {status?.state === "downloading" ? `Downloading ${String(status.received)} of ${String(status.total)} bytes…`
        : status?.state === "complete" ? "Handed to the browser. Check your browser downloads; saving is not confirmed."
        : status?.state === "unavailable" ? `Download unavailable: ${status.reason}.`
        : unavailable ? "Browser download unavailable."
        : "Downloads an independent copy. Nothing is saved until you choose Download."}
    </span>
  </fieldset>;
}
