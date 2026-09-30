import {
  ByteImageCropSchema,
  type ByteImageCrop,
  ByteImageSourceSchema,
  ByteTransferError,
  MAX_LOCAL_FILES,
  RasterMediaTypeSchema,
  type ByteDownloadSource,
  type ByteDownloadStatus,
  type ByteImageReason,
  type ByteImageSource,
  type ByteImageStatus,
  type LocalFileDescriptor,
} from "@manifold/protocol";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { frameElement, frameMeta, useFrameMode } from "./frame-mode.tsx";
import type { VocabularyMeta } from "./vocabulary.tsx";

export interface ByteRendererProjection {
  close(): void;
  recheck(): void;
  refuse(reason: ByteImageReason): void;
}

export interface ByteRendererDownload {
  close(): void;
  cancel(): void;
}

/** Host-only binding. Never serialized into a guest's tree or passed as plugin props. */
export interface ByteRendererServices {
  capture(files: readonly File[]): readonly LocalFileDescriptor[];
  project(
    source: ByteImageSource,
    observer: {
      loading(): void;
      ready(url: string, expiresAt: number): void;
      unavailable(reason: ByteImageReason): void;
    },
  ): ByteRendererProjection;
  download(
    source: ByteDownloadSource,
    filename: string,
    change: (status: ByteDownloadStatus) => void,
  ): ByteRendererDownload;
}
const ByteRenderer = createContext<ByteRendererServices | null>(null);
export function ByteRendererProvider({
  services,
  children,
}: {
  readonly services: ByteRendererServices;
  readonly children?: ReactNode;
}): ReactElement {
  return <ByteRenderer value={services}>{children}</ByteRenderer>;
}

/** Host binding used only by the page vocabulary implementation, never guest props. */
export function useByteRendererServices(): ByteRendererServices | null {
  return useContext(ByteRenderer);
}

export interface FileInputProps extends VocabularyMeta {
  readonly label: string;
  readonly accept?: "files" | "images" | undefined;
  readonly multiple?: boolean | undefined;
  readonly clipboard?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly onChange: (files: readonly LocalFileDescriptor[]) => void;
}
export function FileInput({
  label,
  accept,
  multiple,
  clipboard,
  disabled,
  onChange,
  ...rest
}: FileInputProps): ReactElement {
  const inFrame = useFrameMode();
  const meta = frameMeta("FileInput", rest);
  if (inFrame)
    return frameElement("fileInput", {
      label,
      accept,
      multiple,
      clipboard,
      disabled,
      onChange,
      ...meta,
    });
  return (
    <LocalFileInput
      label={label}
      accept={accept}
      multiple={multiple}
      clipboard={clipboard}
      disabled={disabled}
      onChange={onChange}
      {...rest}
    />
  );
}
function LocalFileInput({
  label,
  accept,
  multiple,
  clipboard,
  disabled,
  onChange,
  ...meta
}: FileInputProps): ReactElement {
  const services = useContext(ByteRenderer);
  const [status, setStatus] = useState("Choose or drop files. Nothing is saved until you confirm.");
  const [reading, setReading] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, [services, disabled, accept, multiple, clipboard]);
  const unavailable = disabled === true || services === null;
  const report = (error: unknown): void => {
    if (active.current)
      setStatus(
        error instanceof ByteTransferError
          ? `File selection unavailable: ${error.reason}. Release the previous selection or choose smaller files.`
          : "File selection unavailable. Check browser clipboard permissions or choose a file instead.",
      );
  };
  const selected = (files: readonly File[]): void => {
    if (!active.current || unavailable || services === null) return;
    if (files.length === 0) {
      setStatus("No files selected.");
      return;
    }
    if (files.length > (multiple === true ? MAX_LOCAL_FILES : 1))
      throw new ByteTransferError("busy");
    if (
      accept === "images" &&
      files.some((file) => !RasterMediaTypeSchema.safeParse(file.type).success)
    ) {
      throw new ByteTransferError("unsupported");
    }
    const descriptors = services.capture(files);
    setStatus(`${String(descriptors.length)} file(s) selected locally. Not saved or shared yet.`);
    onChange(descriptors);
  };
  const saveClipboard = async (): Promise<void> => {
    if (unavailable || busy.current) return;
    busy.current = true;
    setReading(true);
    const stamp = generation.current;
    try {
      const items = await navigator.clipboard.read();
      if (items.length > (multiple === true ? MAX_LOCAL_FILES : 1))
        throw new ByteTransferError("busy");
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((value) => RasterMediaTypeSchema.safeParse(value).success);
        if (type === undefined) continue;
        const blob = await item.getType(type);
        if (!active.current || generation.current !== stamp) return;
        const extension = type === "image/jpeg" ? "jpg" : type.slice(6);
        files.push(
          new File([blob], `clipboard-${String(files.length + 1)}.${extension}`, { type }),
        );
      }
      if (files.length === 0) throw new ByteTransferError("unsupported");
      if (active.current && generation.current === stamp) selected(files);
    } catch (error) {
      report(error);
    } finally {
      busy.current = false;
      if (active.current) setReading(false);
    }
  };
  return (
    <fieldset
      className="mf-vocab-file mf-vocab-fileInput"
      disabled={unavailable || reading}
      onDragOver={(event) => {
        if (!unavailable && event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        if (unavailable || busy.current) return;
        try {
          if (event.dataTransfer.files.length > MAX_LOCAL_FILES)
            throw new ByteTransferError("busy");
          selected(Array.from(event.dataTransfer.files));
        } catch (error) {
          report(error);
        }
      }}
      {...meta}
    >
      <legend>{label}</legend>
      <label className="mf-vocab-input__field">
        <span>Choose files or drop them here</span>
        <input
          type="file"
          aria-label={label}
          multiple={multiple}
          accept={accept === "images" ? "image/png,image/jpeg,image/webp,image/gif" : undefined}
          onChange={(event) => {
            try {
              if ((event.currentTarget.files?.length ?? 0) > MAX_LOCAL_FILES)
                throw new ByteTransferError("busy");
              selected(Array.from(event.currentTarget.files ?? []));
            } catch (error) {
              report(error);
            }
            event.currentTarget.value = "";
          }}
        />
      </label>
      {clipboard === true ? (
        <button
          type="button"
          className="mf-vocab-button"
          onClick={() => {
            void saveClipboard();
          }}
        >
          Save clipboard image
        </button>
      ) : null}
      <span className="mf-vocab-text" role="status">
        {reading
          ? "Reading clipboard image…"
          : services === null
            ? "File selection unavailable."
            : status}
      </span>
    </fieldset>
  );
}

export interface ByteImageProps extends VocabularyMeta {
  readonly label: string;
  readonly source: ByteImageSource;
  readonly crop?: ByteImageCrop | undefined;
  /** Fit the cropped raster within a mounted element's remaining layout space. */
  readonly fit?: "frame" | undefined;
  readonly onChange?: ((status: ByteImageStatus) => void) | undefined;
}
export function ByteImage({
  label,
  source,
  crop,
  fit,
  onChange,
  ...rest
}: ByteImageProps): ReactElement {
  const inFrame = useFrameMode();
  const meta = frameMeta("ByteImage", rest);
  if (inFrame) return frameElement("byteImage", { label, source, crop, fit, onChange, ...meta });
  if (crop !== undefined && !ByteImageCropSchema.safeParse(crop).success) {
    return <span role="status">{label} unavailable: invalid crop.</span>;
  }
  // Cropping is presentation only; it never acquires different bytes or a different lease.
  return (
    <RasterProjection
      key={JSON.stringify(source)}
      label={label}
      source={source}
      crop={crop}
      fit={fit}
      onChange={onChange}
      {...rest}
    />
  );
}
function RasterProjection({
  label,
  source,
  crop,
  fit,
  onChange,
  ...meta
}: ByteImageProps): ReactElement {
  const services = useContext(ByteRenderer);
  const renderer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const callback = useRef(onChange);
  callback.current = onChange;
  const [state, setState] = useState<ByteImageStatus>({ state: "loading" });
  const sourceKey = JSON.stringify(source);
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const present = (): void => {
    const container = renderer.current;
    const image = container?.querySelector("img");
    if (!container || !image) return;
    const value = cropRef.current ?? { x: 0, y: 0, width: 1, height: 1 };
    const ratio = (image.naturalWidth * value.width) / (image.naturalHeight * value.height);
    if (fitRef.current === "frame" && frame.current !== null) {
      const width = Math.min(frame.current.clientWidth, frame.current.clientHeight * ratio);
      Object.assign(container.style, {
        position: "absolute",
        width: `${width}px`,
        height: `${width / ratio}px`,
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        aspectRatio: "",
      });
    } else {
      Object.assign(container.style, {
        position: "relative",
        width: "100%",
        height: "auto",
        left: "",
        top: "",
        transform: "",
        aspectRatio: String(ratio),
      });
    }
    Object.assign(image.style, {
      position: "absolute",
      maxWidth: "none",
      maxHeight: "none",
      width: `${100 / value.width}%`,
      height: `${100 / value.height}%`,
      left: `${(-100 * value.x) / value.width}%`,
      top: `${(-100 * value.y) / value.height}%`,
    });
  };
  useLayoutEffect(present, [fit, crop?.x, crop?.y, crop?.width, crop?.height]);
  useLayoutEffect(() => {
    if (fit !== "frame" || frame.current === null) return;
    const observer = new ResizeObserver(present);
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [fit]);
  useLayoutEffect(() => {
    const container = renderer.current;
    if (container === null) return;
    let active = true;
    let generation = 0;
    let image: HTMLImageElement | null = null;
    let decodeTimer: ReturnType<typeof setTimeout> | undefined;
    const notify = (value: ByteImageStatus): void => {
      if (!active) return;
      setState(value);
      callback.current?.(value);
    };
    const clear = (): void => {
      generation += 1;
      clearTimeout(decodeTimer);
      if (image !== null) {
        image.removeAttribute("src");
        image.remove();
        image = null;
      }
      container.replaceChildren();
    };
    let handle: ByteRendererProjection | undefined;
    try {
      if (services === null) throw new ByteTransferError("unavailable");
      const checked = ByteImageSourceSchema.parse(JSON.parse(sourceKey));
      handle = services.project(checked, {
        loading() {
          clear();
          notify({ state: "loading" });
        },
        unavailable(reason) {
          clear();
          notify({ state: "unavailable", reason });
        },
        ready(url, expiresAt) {
          clear();
          const stamp = generation;
          const decoded = new Image();
          image = decoded;
          decoded.alt = label;
          decoded.className = "mf-vocab-image";
          decoded.src = url;
          decodeTimer = setTimeout(
            () => handle?.refuse("decode_failed"),
            Math.min(5000, Math.max(0, expiresAt - Date.now())),
          );
          void decoded
            .decode()
            .then(() => {
              if (!active || generation !== stamp) return;
              clearTimeout(decodeTimer);
              if (Date.now() >= expiresAt) {
                handle?.refuse("expired");
                return;
              }
              container.replaceChildren(decoded);
              present();
              notify({ state: "ready" });
            })
            .catch(() => {
              if (active && generation === stamp) handle?.refuse("decode_failed");
            });
        },
      });
    } catch (error) {
      notify({
        state: "unavailable",
        reason: error instanceof ByteTransferError ? error.reason : "invalid",
      });
    }
    const focus = (): void => {
      if (!document.hidden) handle?.recheck();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      active = false;
      clear();
      handle?.close();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [services, sourceKey, label]);
  return (
    <div
      ref={frame}
      className="mf-vocab-image__projection mf-vocab-byteImage"
      style={
        fit === "frame"
          ? { position: "relative", flex: "1 1 0", minHeight: 64, width: "100%" }
          : undefined
      }
      {...meta}
    >
      <div ref={renderer} style={{ position: "relative", overflow: "hidden", width: "100%" }} />
      {state.state === "ready" ? null : (
        <span className="mf-vocab-text" role="status">
          {state.state === "loading"
            ? `Loading ${label}…`
            : `${label} unavailable: ${state.reason}.`}
        </span>
      )}
    </div>
  );
}
