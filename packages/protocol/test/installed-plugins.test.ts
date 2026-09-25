import { expect, test } from "bun:test";
import { ISOLATE_MAX_ARTIFACT_BYTES, InstalledPluginsSnapshotSchema } from "@manifold/protocol";

const MIB = 1024 * 1024;
const sha256 = "a".repeat(64);
const bundlePath = `plugins/example.large/${sha256}.manifold-plugin.json`;
const accepts = (bytes: string) =>
  InstalledPluginsSnapshotSchema.safeParse({
    format: 1,
    developerMode: false,
    plugins: [
      {
        row: {
          pluginId: "example.large",
          sha256,
          source: bundlePath,
          grantedCaps: [],
          installedBy: "principal-1",
          installedAt: 1,
          bundlePath,
          actions: [],
        },
        enabled: true,
        bytes,
      },
    ],
  }).success;

test("installed bundle bytes accept canonical base64 past JavaScriptCore's 8 MiB pattern limit (#844)", () => {
  // A whole-string base64 pattern stops matching valid input of 8 MiB and more in JavaScriptCore.
  const encoded = Buffer.alloc(9 * MIB, "manifold").toString("base64");
  expect(encoded.length).toBe(12 * MIB);
  expect(accepts(encoded)).toBe(true);
});

test("installed bundle bytes decode to at most the artifact cap the export reads", () => {
  const atCap = Buffer.alloc(ISOLATE_MAX_ARTIFACT_BYTES, "manifold");
  expect(accepts(atCap.toString("base64"))).toBe(true);
  // One byte more keeps the same encoded length; only its padding tells the two apart.
  const pastCap = Buffer.concat([atCap, Buffer.from("m")]).toString("base64");
  expect(pastCap.length).toBe(atCap.toString("base64").length);
  expect(accepts(pastCap)).toBe(false);
});

test("installed bundle bytes refuse invalid characters, bad padding and non-canonical encodings", () => {
  for (const valid of ["", "QQ==", "QUI=", "QUJD", "+/+/"]) expect(accepts(valid)).toBe(true);
  for (const invalid of [
    "QUJD\n",
    "QU JD",
    "QUJD-_8=",
    "Q\u00e9I=",
    "QQ",
    "QUI",
    "Q===",
    "====",
    "QQ=A",
    "QQ==QUJD",
    "QR==",
    "QUJ=",
  ])
    expect(accepts(invalid)).toBe(false);
  // Canonical means the encoding Buffer itself produces for the decoded bytes: every final
  // character before either padding is accepted exactly when its unused bits are zero.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (const last of alphabet)
    for (const encoded of [`Q${last}==`, `QU${last}=`])
      expect(accepts(encoded)).toBe(Buffer.from(encoded, "base64").toString("base64") === encoded);
  // The whole string is scanned, not a prefix: one bad character at the end of 12 MiB refuses it.
  const large = Buffer.alloc(9 * MIB, "manifold").toString("base64");
  for (const bad of ["-", "\n", "="])
    expect(accepts(`${large.slice(0, -5)}${bad}${large.slice(-4)}`)).toBe(false);
});
