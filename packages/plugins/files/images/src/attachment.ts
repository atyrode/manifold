import type { PortableHostServices } from "@manifold/plugin";
import { FileDescriptorSchema, FILES_ID } from "@manifold-plugin/files/contract";
import {
  ReferenceAttachmentResultSchema,
  type PluginOwnedRef,
  type ReferenceAttachmentResult,
} from "@manifold/protocol";
import type { z } from "zod";
import { FILES_IMAGES_ID, FULL_IMAGE_CROP, type AttachFileImageInput } from "./index.ts";

type ImageActionHost = { readonly client: Pick<PortableHostServices["client"], "action"> };
export async function imageAction<T>(
  host: ImageActionHost,
  door: string,
  input: unknown,
  result: z.ZodType<T>,
): Promise<T> {
  let outcome;
  try {
    outcome = await host.client.action(door, input);
  } catch {
    throw new Error(
      "Connection interrupted; outcome unconfirmed. Retry this exact request, not a new upload.",
    );
  }
  if (!outcome.ok) throw new Error(outcome.denial.message);
  if (
    typeof outcome.result === "object" &&
    outcome.result !== null &&
    "refused" in outcome.result
  ) {
    throw new Error(
      typeof outcome.result.refused === "string" ? outcome.result.refused : "unavailable",
    );
  }
  const checked = result.safeParse(outcome.result);
  if (!checked.success) throw new Error("Response could not be verified; outcome unconfirmed.");
  return checked.data;
}

export interface ImageAttachmentSnapshot {
  readonly phase: "saved" | "attaching" | "refused" | "attached";
  readonly reason: string | null;
  readonly result: ReferenceAttachmentResult | null;
}

/** One published file and one stable element intent. Neither refusal nor retry uploads bytes. */
export class ImageAttachmentController {
  readonly elementId = globalThis.crypto.randomUUID();
  private live = true;
  private snapshot: ImageAttachmentSnapshot = { phase: "saved", reason: null, result: null };
  private readonly listeners = new Set<() => void>();
  private intent: AttachFileImageInput | null = null;
  constructor(
    private readonly host: ImageActionHost,
    readonly ref: PluginOwnedRef,
    readonly target: string,
    readonly point: Readonly<{ x: number; y: number }>,
    readonly published = false,
  ) {}
  readonly getSnapshot = (): ImageAttachmentSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: ImageAttachmentSnapshot): void {
    if (!this.live) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  async attach(): Promise<void> {
    if (!this.live || this.snapshot.phase === "attaching" || this.snapshot.phase === "attached")
      return;
    this.publish({ phase: "attaching", reason: null, result: null });
    try {
      if (this.intent === null) {
        const file = await imageAction(
          this.host,
          `${FILES_ID}.inspect`,
          { ref: this.ref },
          FileDescriptorSchema,
        );
        if (!this.live) return;
        if (!file.image)
          throw new Error(
            "unsupported_image: saved file is not a validated static image. It remains in Files; no image was attached.",
          );
        const scale = Math.min(320 / file.image.width, 240 / file.image.height);
        this.intent = {
          ref: this.ref,
          target: { kind: "container", containerId: this.target },
          elementId: this.elementId,
          x: this.point.x,
          y: this.point.y,
          width: file.image.width * scale,
          height: file.image.height * scale,
          crop: FULL_IMAGE_CROP,
        };
      }
      if (!this.live) return;
      const result = await imageAction(
        this.host,
        `${FILES_IMAGES_ID}.attach`,
        this.intent,
        ReferenceAttachmentResultSchema,
      );
      this.publish({ phase: "attached", reason: null, result });
    } catch (error) {
      this.publish({
        phase: "refused",
        reason: error instanceof Error ? error.message : "Attachment unavailable",
        result: null,
      });
    }
  }
  dispose(): void {
    this.live = false;
    this.listeners.clear();
  }
}
