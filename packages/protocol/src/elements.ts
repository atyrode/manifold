import { z } from "zod";

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_STROKE_POINT_VALUES = 8_192;
export const MAX_GESTURE_POINT_VALUES = 4_096;
export const MAX_DOC_UPDATE_BYTES = 524_288;
export const MAX_SESSION_FRAME_BYTES = 1_048_576;

/**
 * THE base64 ceiling for every frame that carries bytes as text: doc updates on the session
 * wire, terminal input, terminal output and terminal snapshots on the machine wire alike.
 *
 * It is measured against `MAX_DOC_UPDATE_BYTES`, which is the largest binary payload any of
 * those frames may carry. base64 spends four characters per three bytes, so the encoding of
 * a maximal doc update is `ceil(524288 / 3) * 4` = 699_052 characters, and this cap is that
 * figure rounded up to a number a human can read in a log line. The relationship is asserted
 * in the protocol's own tests rather than left as prose, so the cap can never fall below the
 * payload it exists to admit.
 *
 * It is ONE constant because it was five: the same literal sat at four schema sites and one
 * pool guard, which is four chances for a wire bound to drift away from itself and no door
 * at which the drift would be noticed.
 */
export const MAX_SESSION_BASE64_CHARS = 700_000;

/**
 * How many payload keys one element record may carry beside the envelope. Generous against
 * every kind in the tree (the widest carries three) and small enough that a record cannot
 * become a document: the bound exists so that loosening the schema opens a vocabulary, not a
 * blob channel (ADR 0013 §16 clause 3).
 */
export const MAX_ELEMENT_PAYLOAD_KEYS = 16;

/** A payload key is a property name, held to the same length as a contributed type name. */
export const MAX_ELEMENT_PAYLOAD_KEY_LENGTH = 64;

/**
 * THE envelope table: the geometry every renderer, every placement rule and every fingerprint
 * reads without caring what the record MEANS.
 *
 * It is one table with one exported question, because the payload is defined by SUBTRACTION —
 * every key in the record that is not in here — and a second statement of this set (a list
 * beside the lookup, a hand-written membership test at a call site) would be a second
 * definition of where the boundary runs, which is the whole thing this envelope exists to
 * make unambiguous.
 */
const IS_ENVELOPE_KEY = {
  id: true,
  type: true,
  x: true,
  y: true,
  width: true,
  height: true,
  zIndex: true,
} as const satisfies Readonly<Record<string, true>>;

export type ElementEnvelopeKey = keyof typeof IS_ENVELOPE_KEY;

/** Whether a record key is envelope (the floor's to read) or payload (its owner's). */
export function isElementEnvelopeKey(key: string): boolean {
  return Object.hasOwn(IS_ENVELOPE_KEY, key);
}

/**
 * What a payload value may be: a JSON scalar, or a flat array of them. Depth ONE, deliberately
 * — an object graph inside a record is a second document plane nobody arbitrates, and the two
 * shapes the tree actually stores (a string of prose, a flat run of stroke coordinates) are
 * both inside this vocabulary. A plugin needing structure encodes it, and pays the bound.
 */
const PayloadScalarSchema = z.union([
  z.string().max(MAX_TEXT_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const SceneElementPayloadValueSchema = z.union([
  PayloadScalarSchema,
  z.array(PayloadScalarSchema).max(MAX_STROKE_POINT_VALUES),
]);
export type SceneElementPayloadValue = z.infer<typeof SceneElementPayloadValueSchema>;

/**
 * The payload as its own schema, so the bounds have one statement. The ceilings are the UNION
 * of the ceilings the three retired union members carried (`MAX_TEXT_LENGTH` for prose,
 * `MAX_STROKE_POINT_VALUES` for a coordinate run), which is what makes this an opening rather
 * than a wire break: every record that validated against the discriminated union validates
 * against the envelope, and every document on disk validates unchanged.
 */
export const SceneElementPayloadSchema = z
  .record(z.string().min(1).max(MAX_ELEMENT_PAYLOAD_KEY_LENGTH), SceneElementPayloadValueSchema)
  .check((ctx) => {
    const keys = Object.keys(ctx.value);
    if (keys.length <= MAX_ELEMENT_PAYLOAD_KEYS) return;
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      message: `element payload carries ${String(keys.length)} keys, at most ${String(MAX_ELEMENT_PAYLOAD_KEYS)} are allowed`,
    });
  });
export type SceneElementPayload = z.infer<typeof SceneElementPayloadSchema>;

/**
 * A scene record, as the wire and the document plane carry it: a NEUTRAL ENVELOPE.
 *
 * This schema names no element type, and that is the whole point (ADR 0013 §16). It used to be
 * a `z.discriminatedUnion("type", …)` whose three members were `portal`, `text` and `draw` —
 * and two of those three are plugin-owned nouns (`text` is `core.notes`', `draw` is
 * `core.draw`'s) sitting inside the pillar whose admission verdict is "it names no plugin"
 * (AXIOMS.md §Foundation law, neutrality). The union also had a harder consequence than an
 * unclean registry: a `type` it did not list was REFUSED, so a canvas could not hold a record
 * whose owning plugin was merely absent from this build. That is the outcome ADR 0013 §4
 * forbids for panels and sections, reached through the document plane instead of the layout
 * plane.
 *
 * So `type` is a bounded string and the record is LOOSE: every key beside the envelope is
 * PAYLOAD — carried, bounded, persisted, synced, and unread here. The payload stays FLAT
 * rather than nesting under a `payload` key because nesting is a document rewrite and this is
 * a protocol edit: every element that exists lives in a `Y.Map` keyed by exactly these fields,
 * and `ScenePatch` patches them by name.
 *
 * WHO validates a payload, then. Its owning plugin declares the schema on its element
 * REGISTRATION, the assembly collects it beside the placement traits it already collects, and
 * one boundary parses it — the same shape an action's `input` already has, and for the same
 * reason: validation belongs where the assembly is in hand and a refusal can name the
 * offender. A stranger type has no schema to fail and round-trips on the envelope's bounds
 * alone; a known type with a malformed payload is refused at that boundary.
 *
 * The FLOOR keeps exactly one element kind of its own — `portal` ({@link PortalPayloadSchema}),
 * which is ADDRESSING rather than content: the projection of one container inside another, and
 * therefore A4's business rather than any plugin's. It is not an exception to neutrality, it is
 * what neutrality leaves behind: a kind no plugin contributes, named by a canon word (AXIOMS.md
 * §Lexicon), whose payload the floor validates because the floor is its owner.
 */
export const SceneElementSchema = z
  .looseObject({
    id: z.string().min(1).max(128),
    /**
     * The wire type, held to the same ceiling a manifest's `contributes.elements[].type`
     * declares (`packages/protocol/src/plugin.ts`), so a type nameable in a manifest is
     * exactly a type storable in a document.
     */
    type: z.string().min(1).max(32),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    zIndex: z.number().int(),
  })
  .check((ctx) => {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ctx.value)) {
      if (!isElementEnvelopeKey(key)) payload[key] = value;
    }
    const parsed = SceneElementPayloadSchema.safeParse(payload);
    if (parsed.success) return;
    /*
      ONE issue naming the offending keys, rather than zod's own issues re-pushed against a
      different input. A payload issue's `path` is relative to the payload object, so replaying
      it here would either lie about where it happened or need the envelope's shape grafted onto
      it; and what a reader of this refusal actually needs is which key broke the bound, which
      is exactly what a path's first segment says.
    */
    const offenders = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const key = issue.path[0];
          return typeof key === "string" ? key : "<payload>";
        }),
      ),
    ];
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      message: `element payload is out of bounds at ${offenders.join(", ")}`,
    });
  });
export type SceneElement = z.infer<typeof SceneElementSchema>;

/**
 * `portal` — THE floor's own element kind, and its payload.
 *
 * A portal is the projection of one container inside another (A4): live at depth <= 2, a
 * navigable card deeper. Reference cycles are legal because portals navigate rather than
 * recurse, and a portal onto a SOLO composition IS the item wearing the container's clothes,
 * which is why a renderer gives it the item's own chrome instead of a portal frame.
 *
 * It is floor because no plugin contributes it and none could: addressing is the axiom's, the
 * kind is named by a canon word, and the two renderers that paint one reach it as vocabulary
 * rather than as somebody's contribution. The type name is exported so the boundary that
 * validates payloads has ONE statement of the floor's kinds to consult — the alternative is a
 * literal `"portal"` at every such site, which is how `verify:axioms` came to carry a
 * hand-written floor-kind table that had drifted out of agreement with the tree.
 */
export const PORTAL_ELEMENT_TYPE = "portal";
export const PortalPayloadSchema = z.strictObject({
  containerId: z.string().min(1),
});

/**
 * One record's payload: every key that is not an envelope key. The floor calls this to CARRY a
 * payload (a re-write, a fingerprint, a projection), never to interpret one.
 */
export function elementPayload(element: SceneElement): SceneElementPayload {
  const payload: Record<string, SceneElementPayloadValue> = {};
  for (const [key, value] of Object.entries(element)) {
    if (isElementEnvelopeKey(key)) continue;
    const parsed = SceneElementPayloadValueSchema.safeParse(value);
    if (parsed.success) payload[key] = parsed.data;
  }
  return payload;
}

/**
 * A record's payload as ONE comparable string, for the instruments that have to decide whether
 * two projections of the same document agree.
 *
 * It lives here, beside the payload reader, because it has exactly two consumers on opposite
 * sides of a comparison — the browser's debug probe and the convergence gate's SDK-side
 * fingerprint — and a digest computed twice is a digest that eventually disagrees with itself
 * about a document that is actually fine. One definition, both sides.
 *
 * Keys are SORTED, so a record written field-by-field in one order and re-written in another
 * still compares equal; an array renders as its LENGTH, because a run of stroke coordinates is
 * megabytes of noise in a failure message and its length already moves when the stroke does.
 */
export function elementPayloadDigest(element: SceneElement): string {
  const payload = elementPayload(element);
  return Object.keys(payload)
    .sort()
    .map((key) => {
      const value = payload[key];
      return `${key}=${Array.isArray(value) ? `[${String(value.length)}]` : String(value)}`;
    })
    .join(",");
}

/**
 * The three typed readers a consumer that KNOWS a field needs.
 *
 * They answer `null` rather than throwing, and rather than being three casts: a payload field
 * is absent whenever the owning plugin is absent, an older client wrote an older shape, or a
 * document was hand-edited, and every one of those is an ordinary Tuesday in a shared
 * workspace rather than an exception. A caller that cannot proceed without the field refuses
 * on the `null`, which is a decision at the call site instead of a crash inside a getter.
 */
export function elementString(element: SceneElement, field: string): string | null {
  const value: unknown = element[field];
  return typeof value === "string" ? value : null;
}

export function elementNumber(element: SceneElement, field: string): number | null {
  const value: unknown = element[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function elementNumbers(element: SceneElement, field: string): readonly number[] | null {
  const value: unknown = element[field];
  if (!Array.isArray(value)) return null;
  const numbers: number[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    numbers.push(entry);
  }
  return numbers;
}

/** Canonical paint/persist order: explicit z-index, then id as deterministic tiebreak. */
export function compareElements(a: SceneElement, b: SceneElement): number {
  if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
