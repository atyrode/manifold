import { z } from "zod";
import { CapSchema, type Cap } from "./capabilities.ts";
import { LocalNameSchema, PluginIdSchema } from "./plugin.ts";
import { ManifoldRefSchema, type ManifoldRef } from "./uri.ts";

export const MAX_STREAM_DESCRIPTORS = 16;
export const MAX_STREAM_FRAME_BYTES = 65_536;
export const MAX_STREAM_RING_BYTES = 524_288;
export const MAX_STREAM_RING_FRAMES = 1024;
export const MAX_STREAM_INSTANCES = 64;
export const MAX_STREAM_SUBSCRIPTIONS_PER_CONNECTION = 64;
export const MAX_STREAM_BODY_DEPTH = 8;
export const MAX_STREAM_BODY_KEYS = 64;
export const MAX_STREAM_BODY_ITEMS = 1024;

/** Governed nodes cannot be exposed under an unrelated, weaker read requirement. */
export const STREAM_GOVERNED_READ_CAPABILITIES: Readonly<
  Partial<Record<ManifoldRef["kind"], Exclude<Cap, "*">>>
> = {
  job: "jobs:read",
  output: "jobs:read",
  location: "locations:read",
  operation: "operations:invoke",
};

export type StreamBody =
  string | number | boolean | null | StreamBody[] | { [key: string]: StreamBody };

const scalar = z.union([
  z.string().max(MAX_STREAM_FRAME_BYTES),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
function bodySchema(depth: number): z.ZodType<StreamBody> {
  if (depth === 0) return scalar;
  const child = bodySchema(depth - 1);
  return z.union([
    scalar,
    z.array(child).max(MAX_STREAM_BODY_ITEMS),
    z
      .record(z.string().min(1).max(128), child)
      .refine((value) => Object.keys(value).length <= MAX_STREAM_BODY_KEYS),
  ]);
}

/** JSON only, with finite depth and structural limits before transport byte accounting. */
export const StreamBodySchema = bodySchema(MAX_STREAM_BODY_DEPTH).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_STREAM_FRAME_BYTES,
  { message: "stream body exceeds maximum frame bytes" },
);

/** The supported JSON Schema dialect is closed; every variable-size shape declares a bound. */
export type StreamBodyJsonSchema =
  | { type: "string"; maxLength: number; minLength?: number | undefined }
  | { type: "number" | "integer"; minimum?: number | undefined; maximum?: number | undefined }
  | { type: "boolean" | "null" }
  | { type: "array"; items: StreamBodyJsonSchema; maxItems: number; minItems?: number | undefined }
  | {
      type: "object";
      properties: Record<string, StreamBodyJsonSchema>;
      required?: string[] | undefined;
      additionalProperties: false;
    };

function jsonSchema(depth: number): z.ZodType<StreamBodyJsonSchema> {
  const primitives = [
    z
      .strictObject({
        type: z.literal("string"),
        maxLength: z.int().min(0).max(MAX_STREAM_FRAME_BYTES),
        minLength: z.int().min(0).max(MAX_STREAM_FRAME_BYTES).optional(),
      })
      .refine((value) => (value.minLength ?? 0) <= value.maxLength),
    z
      .strictObject({
        type: z.enum(["number", "integer"]),
        minimum: z.number().finite().optional(),
        maximum: z.number().finite().optional(),
      })
      .refine(
        (value) =>
          value.minimum === undefined ||
          value.maximum === undefined ||
          value.minimum <= value.maximum,
      ),
    z.strictObject({ type: z.enum(["boolean", "null"]) }),
  ] as const;
  if (depth === 0) return z.union(primitives);
  const child = jsonSchema(depth - 1);
  return z.union([
    ...primitives,
    z
      .strictObject({
        type: z.literal("array"),
        items: child,
        maxItems: z.int().min(0).max(MAX_STREAM_BODY_ITEMS),
        minItems: z.int().min(0).max(MAX_STREAM_BODY_ITEMS).optional(),
      })
      .refine((value) => (value.minItems ?? 0) <= value.maxItems),
    z
      .strictObject({
        type: z.literal("object"),
        properties: z
          .record(z.string().min(1).max(128), child)
          .refine((value) => Object.keys(value).length <= MAX_STREAM_BODY_KEYS),
        required: z.array(z.string().min(1).max(128)).max(MAX_STREAM_BODY_KEYS).optional(),
        additionalProperties: z.literal(false),
      })
      .refine(
        (value) =>
          new Set(value.required).size === (value.required?.length ?? 0) &&
          (value.required ?? []).every((key) => Object.hasOwn(value.properties, key)),
      ),
  ]);
}
export const StreamBodyJsonSchemaSchema = jsonSchema(MAX_STREAM_BODY_DEPTH).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_STREAM_FRAME_BYTES,
  { message: "stream body schema exceeds maximum bytes" },
);

/** Compile only the dialect admitted by the manifest, without dynamic code or remote refs. */
export function compileStreamBodySchema(schema: StreamBodyJsonSchema): z.ZodType<StreamBody> {
  switch (schema.type) {
    case "string":
      return z
        .string()
        .min(schema.minLength ?? 0)
        .max(schema.maxLength);
    case "number":
    case "integer": {
      let result = schema.type === "integer" ? z.number().int() : z.number().finite();
      if (schema.minimum !== undefined) result = result.min(schema.minimum);
      if (schema.maximum !== undefined) result = result.max(schema.maximum);
      return result;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array":
      return z
        .array(compileStreamBodySchema(schema.items))
        .min(schema.minItems ?? 0)
        .max(schema.maxItems);
    case "object": {
      const properties: Record<string, z.ZodType<StreamBody | undefined>> = Object.create(null);
      for (const [key, value] of Object.entries(schema.properties)) {
        const child = compileStreamBodySchema(value);
        properties[key] = schema.required?.includes(key) === true ? child : child.optional();
      }
      return z.strictObject(properties) as z.ZodType<StreamBody>;
    }
  }
}

// Deferred plugin-name schemas avoid a module initialization cycle with contributes.streams.
export const StreamKindSchema = z.lazy(() =>
  z
    .string()
    .max(97)
    .refine((kind) => {
      const separator = kind.lastIndexOf(".");
      return (
        PluginIdSchema.safeParse(kind.slice(0, separator)).success &&
        separator > 0 &&
        LocalNameSchema.safeParse(kind.slice(separator + 1)).success
      );
    }),
);
export const StreamDescriptorSchema = z
  .strictObject({
    id: z.lazy(() => LocalNameSchema),
    title: z.string().min(1).max(64),
    body: StreamBodyJsonSchemaSchema,
    readCapability: CapSchema.exclude(["*"]),
    nodeKinds: z
      .array(z.union(ManifoldRefSchema.options.map((option) => option.shape.kind)))
      .min(1)
      .max(ManifoldRefSchema.options.length)
      .refine((kinds) => new Set(kinds).size === kinds.length),
    maxFrameBytes: z.int().min(1).max(MAX_STREAM_FRAME_BYTES),
    maxRingFrames: z.int().min(1).max(MAX_STREAM_RING_FRAMES),
    maxRingBytes: z.int().min(1).max(MAX_STREAM_RING_BYTES),
    maxInstances: z.int().min(1).max(MAX_STREAM_INSTANCES),
  })
  .refine((value) => value.maxRingBytes >= value.maxFrameBytes, {
    message: "stream ring must fit one maximum frame",
  })
  .refine(
    (value) =>
      value.nodeKinds.every((kind) => {
        const required = STREAM_GOVERNED_READ_CAPABILITIES[kind];
        return required === undefined || value.readCapability === required;
      }),
    { message: "stream read capability must match its governed node kinds" },
  );
export type StreamDescriptor = z.infer<typeof StreamDescriptorSchema>;

const token = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const sequence = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const reason = z.string().min(1).max(128);
export const StreamCursorSchema = z.strictObject({ epoch: token, seq: sequence });
export type StreamCursor = z.infer<typeof StreamCursorSchema>;
export const StreamOpenSchema = z.strictObject({
  type: z.literal("stream_open"),
  subscriptionId: token,
  kind: StreamKindSchema,
  node: ManifoldRefSchema,
  cursor: StreamCursorSchema.optional(),
});
export const StreamCloseSchema = z.strictObject({
  type: z.literal("stream_close"),
  subscriptionId: token,
});
export const StreamSnapshotSchema = z
  .strictObject({
    type: z.literal("stream_snapshot"),
    subscriptionId: token,
    kind: StreamKindSchema,
    node: ManifoldRefSchema,
    epoch: token,
    firstSeq: sequence,
    lastSeq: sequence,
    frames: z
      .array(z.strictObject({ seq: sequence.min(1), body: StreamBodySchema }))
      .max(MAX_STREAM_RING_FRAMES),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value.frames)).byteLength <= MAX_STREAM_RING_BYTES,
  );
export const StreamFrameSchema = z.strictObject({
  type: z.literal("stream_frame"),
  subscriptionId: token,
  epoch: token,
  seq: sequence.min(1),
  body: StreamBodySchema,
});
export const StreamGapSchema = z
  .strictObject({
    type: z.literal("stream_gap"),
    subscriptionId: token,
    epoch: token,
    fromSeq: sequence,
    toSeq: sequence,
  })
  .refine((value) => value.fromSeq <= value.toSeq);
export const StreamResetSchema = z.strictObject({
  type: z.literal("stream_reset"),
  subscriptionId: token,
  epoch: token,
  reason,
});
export const StreamRefusedSchema = z.strictObject({
  type: z.literal("stream_refused"),
  subscriptionId: token,
  reason,
});
export const StreamClosedSchema = z.strictObject({
  type: z.literal("stream_closed"),
  subscriptionId: token,
  reason,
});
export const STREAM_CLIENT_BODIES = {
  stream_open: StreamOpenSchema,
  stream_close: StreamCloseSchema,
} as const;
export const STREAM_SERVER_BODIES = {
  stream_snapshot: StreamSnapshotSchema,
  stream_frame: StreamFrameSchema,
  stream_gap: StreamGapSchema,
  stream_reset: StreamResetSchema,
  stream_refused: StreamRefusedSchema,
  stream_closed: StreamClosedSchema,
} as const;
export const StreamClientMessageSchema = z.discriminatedUnion("type", [
  StreamOpenSchema,
  StreamCloseSchema,
]);
export const StreamServerMessageSchema = z.discriminatedUnion("type", [
  StreamSnapshotSchema,
  StreamFrameSchema,
  StreamGapSchema,
  StreamResetSchema,
  StreamRefusedSchema,
  StreamClosedSchema,
]);
export type StreamOpen = z.infer<typeof StreamOpenSchema>;
export type StreamClose = z.infer<typeof StreamCloseSchema>;
export type StreamSnapshot = z.infer<typeof StreamSnapshotSchema>;
export type StreamFrame = z.infer<typeof StreamFrameSchema>;
export type StreamGap = z.infer<typeof StreamGapSchema>;
export type StreamReset = z.infer<typeof StreamResetSchema>;
export type StreamRefused = z.infer<typeof StreamRefusedSchema>;
export type StreamClosed = z.infer<typeof StreamClosedSchema>;
export type StreamClientMessage = z.infer<typeof StreamClientMessageSchema>;
export type StreamServerMessage = z.infer<typeof StreamServerMessageSchema>;

export function streamVocabulary(): Record<string, unknown> {
  return {
    maxDescriptors: MAX_STREAM_DESCRIPTORS,
    maxFrameBytes: MAX_STREAM_FRAME_BYTES,
    maxRingBytes: MAX_STREAM_RING_BYTES,
    maxRingFrames: MAX_STREAM_RING_FRAMES,
    maxInstances: MAX_STREAM_INSTANCES,
    maxSubscriptionsPerConnection: MAX_STREAM_SUBSCRIPTIONS_PER_CONNECTION,
    maxBodyDepth: MAX_STREAM_BODY_DEPTH,
    maxBodyKeys: MAX_STREAM_BODY_KEYS,
    maxBodyItems: MAX_STREAM_BODY_ITEMS,
    governedReadCapabilities: STREAM_GOVERNED_READ_CAPABILITIES,
    descriptor: z.toJSONSchema(StreamDescriptorSchema),
    client: z.toJSONSchema(StreamClientMessageSchema),
    server: z.toJSONSchema(StreamServerMessageSchema),
  };
}
