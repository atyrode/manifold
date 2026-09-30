import type {
  PortableElementEdit,
  PortableElementProps,
  PortableHostServices,
  PortablePanelProps,
} from "@manifold/plugin";
import {
  createFileRequestId,
  FILES_ID,
  FileIntakeResultSchema,
  OpenFileReadResultSchema,
  FileTransferSchema,
} from "@manifold-plugin/files/contract";
import {
  ByteImageCropSchema,
  canonicalJobJson,
  formatManifoldUri,
  parseManifoldUri,
  type ByteImageCrop,
  type ByteImageSource,
  type PluginOwnedRef,
} from "@manifold/protocol";
import { BorrowedPanel, Button, ByteImage, Cluster, Empty, Input, Stack, Text } from "@manifold/ui";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { z } from "zod";
import {
  FileImageElementSchema,
  FILES_IMAGES_ID,
  FULL_IMAGE_CROP,
  imageCrop,
  imageCropPatch,
} from "./index.ts";
import { ImageAttachmentController, imageAction } from "./attachment.ts";

const PointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const IMAGE_INTAKE = { flow: "save", purpose: "image" } as const;

/** One vocabulary source for page and packed Worker, including picker, drop and clipboard. */
export function ImageInsertPanel({ host, arg }: PortablePanelProps): ReactElement {
  const [scope, setScope] = useState({
    client: host.client,
    localFiles: host.localFiles,
    principal: host.principal.id,
    container: host.containerId,
    generation: 0,
  });
  if (
    scope.client !== host.client ||
    scope.localFiles !== host.localFiles ||
    scope.principal !== host.principal.id ||
    scope.container !== host.containerId
  ) {
    setScope({
      client: host.client,
      localFiles: host.localFiles,
      principal: host.principal.id,
      container: host.containerId,
      generation: scope.generation + 1,
    });
    return <Text>Closing the previous canvas intake. Published files remain in Files.</Text>;
  }
  const point = PointSchema.safeParse(
    typeof arg === "object" && arg !== null && !Array.isArray(arg) ? arg["point"] : null,
  );
  return (
    <ImageIntake
      key={scope.generation}
      host={host}
      point={point.success ? point.data : { x: 0, y: 0 }}
    />
  );
}

function ImageIntake({
  host,
  point,
}: {
  host: PortableHostServices;
  point: Readonly<{ x: number; y: number }>;
}): ReactElement {
  const [pending, setPending] = useState<ImageAttachmentController | null>(null);
  const [existing, setExisting] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [intake, setIntake] = useState(0);
  useLayoutEffect(() => () => pending?.dispose(), [pending]);
  if (host.containerId === null)
    return <Empty>Open a canvas and select the Image tool to save or attach an image.</Empty>;
  const containerId = host.containerId;
  const retain = (ref: PluginOwnedRef, published = false): void => {
    setPending(new ImageAttachmentController(host, ref, containerId, point, published));
    setFailure(null);
  };
  return (
    <Stack gap="0.6rem">
      <Text strong>Insert image</Text>
      <Text wrap tone="muted">
        New files are creator-only until deliberate named sharing in Files. Canvas viewers do not
        inherit image read access. Removing a reference never deletes its file.
      </Text>
      {pending ? (
        <AttachmentReceipt controller={pending} onClear={() => setPending(null)} />
      ) : (
        <>
          <Text wrap>
            Click the canvas to choose placement. Current point: {point.x.toFixed(0)},{" "}
            {point.y.toFixed(0)}. This point is retained when a file is published or selected.
          </Text>
          <BorrowedPanel
            key={intake}
            panelId={`${FILES_ID}.intake`}
            input={IMAGE_INTAKE}
            onResult={(value) => {
              const result = FileIntakeResultSchema.safeParse(value);
              if (!result.success || result.data.state === "delivered") {
                setFailure("File intake returned an unverified result. No image was attached.");
              } else if (result.data.state === "saved") retain(result.data.ref, true);
              else if (result.data.savedRef) retain(result.data.savedRef, true);
              else {
                setIntake((current) => current + 1);
                setFailure(
                  "File review closed without a confirmed publication. If Save was pending, check Files before starting another upload.",
                );
              }
            }}
          />
          <Text strong>Or attach an existing saved image</Text>
          <Input
            label="Canonical file reference"
            mono
            value={existing}
            onChange={setExisting}
            placeholder="manifold://file/…"
          />
          <Button
            data-action={`${FILES_IMAGES_ID}.attach`}
            onClick={() => {
              const ref = parseManifoldUri(existing);
              if (ref?.kind !== "file" || formatManifoldUri(ref) !== existing) {
                setFailure(
                  "Enter a canonical file reference from Files. Existing file read access is still required.",
                );
                return;
              }
              retain(ref);
            }}
          >
            Review existing image attachment
          </Button>
        </>
      )}
      {failure ? (
        <Text wrap tone="danger" role="alert">
          {failure}
        </Text>
      ) : null}
    </Stack>
  );
}

function AttachmentReceipt({
  controller,
  onClear,
}: {
  controller: ImageAttachmentController;
  onClear: () => void;
}): ReactElement {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return (
    <Stack gap="0.4rem">
      <Text strong role="status">
        {state.phase === "attached"
          ? "Image reference attached"
          : state.phase === "attaching"
            ? "Attaching image…"
            : controller.published
              ? "Saved, not attached"
              : "Existing reference, not attached"}
      </Text>
      <Text wrap mono>
        {formatManifoldUri(controller.ref)}
      </Text>
      <Text wrap tone="muted">
        {controller.published
          ? "The independent file remains in Files, including if metadata access is lost. "
          : "The existing reference must identify a readable, validated image. "}
        No retry below uploads bytes, deletes a file, or changes its audience. If an acknowledgement
        was lost, the same element is reconciled.
      </Text>
      <Text wrap>
        Canvas {controller.target} · element {controller.elementId} · point{" "}
        {controller.point.x.toFixed(0)}, {controller.point.y.toFixed(0)}
      </Text>
      {state.reason ? (
        <Text wrap tone="danger" role="alert">
          {state.reason}
        </Text>
      ) : null}
      <Cluster gap="0.4rem">
        {state.phase !== "attached" ? (
          <Button
            disabled={state.phase === "attaching"}
            data-action={`${FILES_IMAGES_ID}.attach`}
            onClick={() => {
              void controller.attach();
            }}
          >
            {state.phase === "refused"
              ? "Retry attachment — same file and element"
              : "Attach this saved image"}
          </Button>
        ) : null}
        <Button disabled={state.phase === "attaching"} onClick={onClear}>
          {state.phase === "attached"
            ? "Insert another image"
            : "Keep file in Files and choose another"}
        </Button>
      </Cluster>
    </Stack>
  );
}

export function FileImage({ data, host, edit }: PortableElementProps): ReactElement {
  const [scope, setScope] = useState({
    client: host.client,
    localFiles: host.localFiles,
    principal: host.principal.id,
    container: host.containerId,
    generation: 0,
  });
  if (
    scope.client !== host.client ||
    scope.localFiles !== host.localFiles ||
    scope.principal !== host.principal.id ||
    scope.container !== host.containerId
  ) {
    setScope({
      client: host.client,
      localFiles: host.localFiles,
      principal: host.principal.id,
      container: host.containerId,
      generation: scope.generation + 1,
    });
    return <Empty>Opening the current image source…</Empty>;
  }
  const checked = FileImageElementSchema.safeParse(data);
  if (!checked.success) return <Empty>Image source unavailable: invalid reference or crop.</Empty>;
  return (
    <ImageProjection
      key={`${scope.generation}:${checked.data.file}`}
      host={host}
      file={checked.data.file}
      crop={imageCrop(checked.data)}
      edit={edit}
    />
  );
}

function ImageProjection({
  host,
  file,
  crop,
  edit,
}: {
  host: PortableHostServices;
  file: string;
  crop: ByteImageCrop;
  edit: PortableElementEdit;
}): ReactElement {
  const [projection, setProjection] = useState<{
    host: PortableHostServices;
    retry: number;
    source: ByteImageSource | null;
    reason: string | null;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [cropping, setCropping] = useState(false);
  const current = projection?.host === host && projection.retry === retry ? projection : null;
  const source = current?.source;
  const reason = current?.reason;
  const retired = useRef(Promise.resolve());
  useEffect(() => {
    let live = true;
    const ref = parseManifoldUri(file);
    if (ref?.kind !== "file") return;
    // A replacement waits for its predecessor's release: neither cancellation nor
    // the bounded concurrent-read allowance may leak across effect lifetimes.
    const opening = retired.current.then(() => {
      if (!live) return null;
      return imageAction(
        host,
        `${FILES_ID}.openRead`,
        { ref, requestId: createFileRequestId() },
        OpenFileReadResultSchema,
      );
    });
    void opening
      .then((value) => {
        if (!live || !value) return;
        const transferId = value.transfer.transferId;
        if (!value.file.image) {
          setProjection({ host, retry, source: null, reason: "unsupported_image" });
          return;
        }
        if (value.transfer.state !== "reading") {
          setProjection({
            host,
            retry,
            source: null,
            reason: value.transfer.reason ?? value.transfer.state,
          });
          return;
        }
        setProjection({
          host,
          retry,
          reason: null,
          source: {
            pluginId: FILES_ID,
            carrierId: "read",
            transferId,
            ref: value.file.ref,
            bytes: value.file.bytes,
            sha256: value.file.sha256,
            mediaType: value.file.image.mediaType,
          },
        });
      })
      .catch((error: unknown) => {
        if (live)
          setProjection({
            host,
            retry,
            source: null,
            reason: error instanceof Error ? error.message : "unavailable",
          });
      });
    return () => {
      live = false;
      retired.current = opening
        .then(
          (value) =>
            value
              ? imageAction(
                  host,
                  `${FILES_ID}.cancelRead`,
                  { ref, transferId: value.transfer.transferId },
                  FileTransferSchema,
                ).then(() => undefined)
              : undefined,
          () => undefined,
        )
        .catch(() => {
          console.warn("Image read release unconfirmed; its bounded lease will expire.");
        });
    };
  }, [host, file, retry]);
  return (
    <Stack gap="0.25rem">
      {!cropping ? (
        source ? (
          <ByteImage label="Image" source={source} crop={crop} fit="frame" />
        ) : (
          <Text wrap role="status">
            {reason ? `Image source unavailable: ${reason}` : "Opening authenticated image source…"}
          </Text>
        )
      ) : null}
      <Cluster gap="0.3rem">
        <Button disabled={!edit.writable} onClick={() => setCropping(!cropping)}>
          {cropping ? "Close crop editor" : "Crop image"}
        </Button>
        <Button
          data-action={`${FILES_ID}.openRead`}
          onClick={() => {
            setRetry((value) => value + 1);
          }}
        >
          Reopen image source
        </Button>
      </Cluster>
      {!edit.writable ? (
        <Text tone="muted">Image arrangement is read-only at this home.</Text>
      ) : null}
      {cropping ? <CropEditor crop={crop} edit={edit} /> : null}
    </Stack>
  );
}

function CropEditor({
  crop,
  edit,
}: {
  crop: ByteImageCrop;
  edit: PortableElementEdit;
}): ReactElement {
  const [draft, setDraft] = useState(() => ({
    x: String(crop.x * 100),
    y: String(crop.y * 100),
    width: String(crop.width * 100),
    height: String(crop.height * 100),
  }));
  const [base, setBase] = useState(() => canonicalJobJson(crop));
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = base !== canonicalJobJson(crop);
  const parsed = ByteImageCropSchema.safeParse(
    Object.fromEntries(
      Object.entries(draft).map(([key, value]) => [
        key,
        value.trim() === "" ? NaN : Number(value) / 100,
      ]),
    ),
  );
  const apply = async (next: ByteImageCrop): Promise<void> => {
    if (busy || changed || !edit.writable) return;
    setBusy(true);
    setFailure(null);
    try {
      await edit.patch(imageCropPatch(next));
      setBase(canonicalJobJson(next));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Crop edit unavailable");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="0.25rem">
      <Text wrap>
        Crop original image, in percent. Width and height must be positive and the rectangle must
        remain inside 0–100%. Original bytes and hash are unchanged.
      </Text>
      {(["x", "y", "width", "height"] as const).map((key) => (
        <Input
          key={key}
          label={`Crop ${key} (%)`}
          value={draft[key]}
          disabled={!edit.writable || busy}
          onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))}
        />
      ))}
      {changed ? (
        <Text wrap role="alert">
          The shared crop changed. Your draft is retained; reload the current crop before applying.
        </Text>
      ) : null}
      {!parsed.success ? (
        <Text wrap tone="danger">
          Invalid crop: use finite numbers, positive size, and stay inside the image.
        </Text>
      ) : null}
      {failure ? (
        <Text wrap role="alert" tone="danger">
          {failure}
        </Text>
      ) : null}
      <Cluster gap="0.25rem">
        <Button
          disabled={busy || changed || !edit.writable || !parsed.success}
          onClick={() => {
            if (parsed.success) void apply(parsed.data);
          }}
        >
          Apply crop
        </Button>
        <Button
          disabled={busy || changed || !edit.writable}
          onClick={() => {
            void apply(FULL_IMAGE_CROP);
          }}
        >
          Show whole image
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setDraft({
              x: String(crop.x * 100),
              y: String(crop.y * 100),
              width: String(crop.width * 100),
              height: String(crop.height * 100),
            });
            setBase(canonicalJobJson(crop));
            setFailure(null);
          }}
        >
          Reload current crop
        </Button>
      </Cluster>
    </Stack>
  );
}

export const filesImagesWeb = {
  id: FILES_IMAGES_ID,
  panels: { insert: ImageInsertPanel },
  elements: { file_image: FileImage },
};
