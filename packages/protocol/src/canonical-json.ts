/** Canonical signing/digest encoding: sorted object keys, order-preserving arrays. */
export function canonicalJobJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJobJson).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
        .filter((k) => object[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJobJson(object[k])}`)
        .join(",")}}`;
}
